/**
 * File-system walking utilities for the source-map pipeline.
 *
 * Pure Node 18+ (built-in `node:fs` only) so it works in every supported
 * runtime without dependencies. Browser builds never import this file —
 * the source-map work is build-time only.
 */
/** A bundle and its companion source map on disk. */
interface BundlePair {
    /** Absolute path to the JS bundle (`.js` / `.mjs` / `.cjs`). */
    jsPath: string;
    /** Absolute path to the matching `.map` file. */
    mapPath: string;
    /** Bare filename of the bundle (no directory), for log lines. */
    bundleName: string;
}
/** Recursively list every file under `dir`. Symlinks are followed. */
declare function walk(dir: string, out?: string[]): string[];
/**
 * Returns every `(bundle, sourcemap)` pair under `root`.
 *
 * A pair is a `.js` / `.mjs` / `.cjs` file with a sibling file of the
 * same name plus a `.map` suffix — the convention every modern bundler
 * (Vite, Webpack, esbuild, Rollup, tsup) follows.
 */
declare function findPairs(root: string): BundlePair[];

/**
 * Debug-ID injection.
 *
 * For each `(bundle.js, bundle.js.map)` pair we:
 *
 *   - Generate a stable per-bundle UUID (one already on the bundle is
 *     reused so re-running is idempotent — repeated builds don't churn
 *     the registry).
 *   - Append `//# debugId=<uuid>` to the JS so the runtime resolver in
 *     `src/utils/debug-id.ts` can read it back.
 *   - Write a top-level `debugId` field into the `.map` JSON so the
 *     symbolicator on the backend can join `bundle.js` ↔ `bundle.js.map`
 *     by ID rather than by guessing from filenames.
 *
 * Bundlers re-write hashed filenames on every build, so joining by ID
 * (instead of by URL or path) is what makes resolved stack frames
 * survive across releases.
 */

/** Outcome of injecting one pair. */
interface InjectResult {
    /** UUID injected (or reused) for this bundle. */
    debugId: string;
    /** True if the bundle already had a debugId — we reused it. */
    reused: boolean;
}
/**
 * Inject (or reuse) the debug ID for a single bundle/sourcemap pair.
 *
 * Mutates both files on disk. Pure synchronous Node — safe to call from
 * a Vite `closeBundle` or Webpack `afterEmit` hook.
 */
declare function injectPair(p: BundlePair): InjectResult;
/** Inject every pair under `root`. Returns one record per pair. */
declare function injectAll(pairs: BundlePair[]): Array<{
    pair: BundlePair;
    result: InjectResult;
}>;
/**
 * Read a debug ID back from a `.map` file.
 * Used by the upload step to join the in-memory state to disk artifacts.
 */
declare function readDebugIdFromMap(mapPath: string): string | null;

/**
 * Source-map / bundle upload client.
 *
 * Wraps the AllStak `/api/v1/artifacts/upload` endpoint with multipart
 * form data and best-effort retries. Pure Node 18+ (uses the global
 * `fetch` and `FormData`), no third-party HTTP client required.
 */

/** Default ingest host — overridden via `host` option or `ALLSTAK_HOST`. */
declare const DEFAULT_HOST = "https://api.allstak.sa";
/** Options for {@link uploadAll} / {@link uploadPair}. */
interface UploadOptions {
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
interface UploadResult {
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
/**
 * Upload one bundle/sourcemap pair. Reads the debugId off the .map
 * (which must have already been processed by {@link injectPair}).
 */
declare function uploadPair(pair: BundlePair, opts: UploadOptions): Promise<UploadResult>;
/** Upload every pair sequentially. Returns one result per pair. */
declare function uploadAll(pairs: BundlePair[], opts: UploadOptions): Promise<UploadResult[]>;

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

/** Options for {@link processBuildOutput}. */
interface ProcessOptions extends UploadOptions {
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
interface ProcessReport {
    /** Absolute output dir scanned. */
    dir: string;
    /** Pairs found. */
    pairs: number;
    /** Per-pair injection results (debugId + reused?). */
    injected: Array<{
        bundleName: string;
        debugId: string;
        reused: boolean;
    }>;
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
declare function processBuildOutput(opts: ProcessOptions): Promise<ProcessReport>;

export { type BundlePair, DEFAULT_HOST, type InjectResult, type ProcessOptions, type ProcessReport, type UploadOptions, type UploadResult, findPairs, injectAll, injectPair, processBuildOutput, readDebugIdFromMap, uploadAll, uploadPair, walk };
