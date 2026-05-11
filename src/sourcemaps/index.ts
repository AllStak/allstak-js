/**
 * Programmatic source-map pipeline — what the CLI used to do, now
 * exposed as a Node API so build-tool plugins (Vite, Webpack, Next)
 * can call it directly without spawning a subprocess.
 *
 * Typical use from a bundler plugin:
 *
 * ```ts
 * import { processBuildOutput } from '@allstak/js/sourcemaps';
 *
 * await processBuildOutput({
 *   dir: 'dist',
 *   release: 'web@1.4.2',
 *   token: process.env.ALLSTAK_UPLOAD_TOKEN!,
 * });
 * ```
 *
 * `injectPair`, `uploadPair`, and `findPairs` are exported individually
 * for callers that want finer control (e.g. tests or custom flows).
 */

export type { BundlePair } from './walk';
export { findPairs, walk } from './walk';
export type { InjectResult } from './inject';
export { injectPair, injectAll, readDebugIdFromMap } from './inject';
export type { UploadOptions, UploadResult } from './upload';
export { uploadPair, uploadAll, DEFAULT_HOST } from './upload';

import { resolve } from 'node:path';
import { findPairs } from './walk';
import { injectAll } from './inject';
import { uploadAll, type UploadOptions, type UploadResult } from './upload';

/** Options for {@link processBuildOutput}. */
export interface ProcessOptions extends UploadOptions {
  /** Build output directory to scan (e.g. `dist`, `.next/static`). */
  dir: string;
  /**
   * If true, only inject debug IDs and skip upload. Useful for sample
   * apps and CI dry-runs.
   */
  injectOnly?: boolean;
  /**
   * If true, suppress per-pair console output. Plugins in normal
   * builds keep this `false` so users see what's happening.
   */
  silent?: boolean;
}

/** What `processBuildOutput` reports back. */
export interface ProcessReport {
  /** Absolute output dir scanned. */
  dir: string;
  /** Pairs found. */
  pairs: number;
  /** Per-pair injection results (debugId + reused?). */
  injected: Array<{ bundleName: string; debugId: string; reused: boolean }>;
  /** Per-pair upload results, omitted when `injectOnly: true`. */
  uploaded?: UploadResult[];
}

/**
 * The high-level "do everything" entry point bundler plugins call:
 * walk the build output → inject debug IDs → upload artifacts.
 *
 * On `injectOnly: true` the upload step is skipped so the function
 * works in environments without an upload token (e.g. local dev).
 */
export async function processBuildOutput(opts: ProcessOptions): Promise<ProcessReport> {
  const dir = resolve(opts.dir);
  const pairs = findPairs(dir);
  const log = opts.silent ? () => undefined : (m: string) => console.log(`[allstak/sourcemaps] ${m}`);

  log(`scanning ${dir} — ${pairs.length} bundle/map pair(s)`);
  if (pairs.length === 0) {
    return { dir, pairs: 0, injected: [] };
  }

  const injectedRaw = injectAll(pairs);
  const injected = injectedRaw.map(({ pair, result }) => ({
    bundleName: pair.bundleName,
    debugId: result.debugId,
    reused: result.reused,
  }));
  for (const i of injected) {
    log(`  ${i.bundleName}  ${i.debugId}  ${i.reused ? '(reused)' : '(new)'}`);
  }

  if (opts.injectOnly || !opts.token) {
    if (!opts.injectOnly && !opts.token) {
      log('skipping upload — no token provided (set ALLSTAK_UPLOAD_TOKEN or pass `token`)');
    }
    return { dir, pairs: pairs.length, injected };
  }

  const uploaded = await uploadAll(pairs, opts);
  for (const u of uploaded) {
    if (u.ok) {
      log(`  ${u.bundleName}  uploaded debugId=${u.debugId}`);
    } else {
      const last = u.steps[u.steps.length - 1];
      log(`  ${u.bundleName}  FAIL status=${last?.status ?? '?'} body=${last?.body ?? ''}`);
    }
  }
  return { dir, pairs: pairs.length, injected, uploaded };
}
