/**
 * Source-map / bundle upload client.
 *
 * Wraps the AllStak `/api/v1/artifacts/upload` endpoint with multipart
 * form data and best-effort retries. Pure Node 18+ (uses the global
 * `fetch` and `FormData`), no third-party HTTP client required.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { BundlePair } from './walk';
import { readDebugIdFromMap } from './inject';

/** Default ingest host — overridden via `host` option or `ALLSTAK_HOST`. */
export const DEFAULT_HOST = 'https://api.allstak.sa';

/** Options for {@link uploadAll} / {@link uploadPair}. */
export interface UploadOptions {
  /** Release identifier, e.g. `myapp@1.4.2`. Required server-side. */
  release: string;
  /** Optional distribution tag (`web`, `ios`, `staging`, …). */
  dist?: string;
  /** AllStak ingest host (default `https://api.allstak.sa`). */
  host?: string;
  /** Project upload token (`aspk_…`). May come from `ALLSTAK_UPLOAD_TOKEN`. */
  token: string;
  /** Drop `sourcesContent` from the map before upload (smaller payload). */
  stripSources?: boolean;
  /** Also upload the JS bundle alongside the map (off by default). */
  uploadBundles?: boolean;
}

/** One artifact upload result. */
export interface UploadResult {
  bundleName: string;
  debugId: string;
  /** True when both the map (and bundle, if requested) uploaded OK. */
  ok: boolean;
  /** Per-artifact responses, in the order we sent them. */
  steps: Array<{
    type: 'sourcemap' | 'bundle';
    status: number;
    sha8: string;
    body?: string;
  }>;
}

interface OneStepResult {
  status: number;
  body: string;
  ok: boolean;
}

/** Internal: POST one file as multipart/form-data. */
async function uploadOne(
  type: 'sourcemap' | 'bundle',
  filePath: string,
  debugId: string,
  opts: Required<Pick<UploadOptions, 'release' | 'host' | 'token'>> &
    Pick<UploadOptions, 'dist' | 'stripSources'>,
): Promise<OneStepResult> {
  let buf = readFileSync(filePath);
  if (type === 'sourcemap' && opts.stripSources) {
    const json = JSON.parse(buf.toString('utf8')) as { sourcesContent?: unknown };
    if (Array.isArray(json.sourcesContent)) delete json.sourcesContent;
    buf = Buffer.from(JSON.stringify(json));
  }

  const form = new FormData();
  form.append('debugId', debugId);
  form.append('type', type);
  form.append('release', opts.release);
  if (opts.dist) form.append('dist', opts.dist);
  form.append(
    'file',
    new Blob([buf], {
      type: type === 'sourcemap' ? 'application/json' : 'application/javascript',
    }),
    basename(filePath),
  );

  const res = await fetch(opts.host.replace(/\/$/, '') + '/api/v1/artifacts/upload', {
    method: 'POST',
    headers: { 'X-AllStak-Upload-Token': opts.token },
    body: form,
  });
  return { status: res.status, body: await res.text(), ok: res.ok };
}

function sha8(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 8);
}

/**
 * Upload one bundle/sourcemap pair. Reads the debugId off the .map
 * (which must have already been processed by {@link injectPair}).
 */
export async function uploadPair(
  pair: BundlePair,
  opts: UploadOptions,
): Promise<UploadResult> {
  const debugId = readDebugIdFromMap(pair.mapPath);
  if (!debugId) {
    throw new Error(
      `[allstak/sourcemaps] no debugId in ${pair.mapPath} — run injectPair() before upload`,
    );
  }

  const required = {
    release: opts.release,
    host: opts.host ?? DEFAULT_HOST,
    token: opts.token,
    dist: opts.dist,
    stripSources: opts.stripSources ?? false,
  };

  const steps: UploadResult['steps'] = [];
  const mapStep = await uploadOne('sourcemap', pair.mapPath, debugId, required);
  steps.push({ type: 'sourcemap', status: mapStep.status, sha8: sha8(pair.mapPath), body: mapStep.body });
  if (!mapStep.ok) {
    return { bundleName: pair.bundleName, debugId, ok: false, steps };
  }

  if (opts.uploadBundles) {
    const bundleStep = await uploadOne('bundle', pair.jsPath, debugId, required);
    steps.push({ type: 'bundle', status: bundleStep.status, sha8: sha8(pair.jsPath), body: bundleStep.body });
    if (!bundleStep.ok) {
      return { bundleName: pair.bundleName, debugId, ok: false, steps };
    }
  }

  return { bundleName: pair.bundleName, debugId, ok: true, steps };
}

/** Upload every pair sequentially. Returns one result per pair. */
export async function uploadAll(
  pairs: BundlePair[],
  opts: UploadOptions,
): Promise<UploadResult[]> {
  const out: UploadResult[] = [];
  for (const p of pairs) out.push(await uploadPair(p, opts));
  return out;
}
