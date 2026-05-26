/**
 * Local-git RUNTIME release auto-detection (no CI/CD required).
 *
 * This module provides a *pure*, testable parse layer plus a fully-guarded
 * Node-only git runner. It is consumed by `applyReleaseAutodetect` in
 * `client.ts` as the step that sits *below* explicit config and env-var
 * detection, and *above* the SDK-version fallback.
 *
 * Resolution order for `release` (highest priority first):
 *   1. Explicit `config.release`            — always wins (handled in client.ts).
 *   2. Env vars (ALLSTAK_RELEASE, VERCEL_GIT_COMMIT_SHA, …) — handled in client.ts.
 *   3. Local git at init (NODE ONLY)        — this module, `detectGitRelease`.
 *   4. SDK version constant                 — never-empty fallback (client.ts).
 *
 * CRITICAL — environment safety: steps 3 must NEVER run or throw in a browser,
 * React Native, edge, or any non-Node runtime (there is no `child_process`
 * there). We detect Node via `typeof process`, `process.versions?.node`, and a
 * *guarded dynamic* require of `child_process`. The require is intentionally
 * NOT a static `import` so browser/RN bundlers do not try to resolve it.
 */

/** A function that runs a git command and returns its trimmed stdout (or '' / throws on failure). */
export type GitRunner = (args: string[]) => string;

/**
 * Parse raw git output into a release string. PURE — no I/O, no spawning. This
 * is the seam tests target so they never need a real repo or to spawn git.
 *
 * @param describeOut Output of `git describe --tags --always --dirty` (preferred).
 * @param revParseOut Output of `git rev-parse --short HEAD` (fallback).
 * @param porcelainOut Output of `git status --porcelain` (used to add `-dirty`
 *                     to the rev-parse fallback when the working tree is dirty).
 * @returns A trimmed release string, or `undefined` when nothing usable was found.
 */
export function parseGitRelease(
  describeOut: string | undefined,
  revParseOut?: string | undefined,
  porcelainOut?: string | undefined,
): string | undefined {
  // Preferred: `git describe --tags --always --dirty` already encodes tag,
  // commit-distance, short sha, and a `-dirty` suffix in one token.
  const describe = normalizeLine(describeOut);
  if (describe) return describe;

  // Fallback: short sha + manual `-dirty` from porcelain status.
  const sha = normalizeLine(revParseOut);
  if (!sha) return undefined;
  const dirty = typeof porcelainOut === 'string' && porcelainOut.trim().length > 0;
  return dirty ? `${sha}-dirty` : sha;
}

/** Collapse to the first non-empty line, trimmed. Returns undefined if empty. */
function normalizeLine(out: string | undefined): string | undefined {
  if (!out) return undefined;
  const first = out.split('\n')[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/**
 * Is the current runtime a Node-like environment that *could* spawn git?
 * Returns false in browsers, React Native, Deno-without-node-compat, edge, etc.
 */
export function isNodeRuntime(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      !!process.versions &&
      typeof process.versions.node === 'string' &&
      // No `window`/`document` → not a DOM/browser host.
      typeof (globalThis as any).window === 'undefined' &&
      // React Native sets navigator.product === 'ReactNative'.
      !(typeof navigator !== 'undefined' && (navigator as any).product === 'ReactNative')
    );
  } catch {
    return false;
  }
}

/**
 * Build a real git runner backed by `child_process.execFileSync`, obtained via
 * a *guarded dynamic require* so browser/RN bundlers never try to resolve
 * `child_process`. Returns `null` when not in Node or child_process is absent.
 */
export function createNodeGitRunner(timeoutMs = 1500): GitRunner | null {
  if (!isNodeRuntime()) return null;
  let cp: any;
  try {
    // Indirect require avoids static analysis by bundlers (no literal import).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req: ((id: string) => any) | undefined =
      typeof require === 'function'
        ? require
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (typeof module !== 'undefined' && (module as any).require) || undefined;
    if (!req) return null;
    cp = req('child_process');
  } catch {
    return null;
  }
  if (!cp || typeof cp.execFileSync !== 'function') return null;
  return (args: string[]): string => {
    try {
      const out = cp.execFileSync('git', args, {
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        windowsHide: true,
      });
      return typeof out === 'string' ? out : '';
    } catch {
      return '';
    }
  };
}

let cachedRelease: string | undefined | null = null;

/** @internal — reset memoized git release for tests. */
export function __resetGitReleaseCacheForTest(): void {
  cachedRelease = null;
}

/**
 * Detect a release string from the local git repo at init time. NODE ONLY and
 * fully guarded: in a browser / React Native / edge runtime, or when git / the
 * `.git` dir / `child_process` is unavailable, this returns `undefined`
 * silently. Runs at most once per process; the result is cached.
 *
 * @param runner Optional injected git runner (test seam). When omitted, a
 *               guarded Node runner is created — and is `null` off-Node.
 */
export function detectGitRelease(runner?: GitRunner | null): string | undefined {
  if (cachedRelease !== null) return cachedRelease ?? undefined;

  const run = runner === undefined ? createNodeGitRunner() : runner;
  if (!run) {
    cachedRelease = undefined;
    return undefined;
  }

  try {
    const describe = run(['describe', '--tags', '--always', '--dirty']);
    let release = parseGitRelease(describe);
    if (!release) {
      const sha = run(['rev-parse', '--short', 'HEAD']);
      const porcelain = run(['status', '--porcelain']);
      release = parseGitRelease(undefined, sha, porcelain);
    }
    cachedRelease = release;
    return release;
  } catch {
    cachedRelease = undefined;
    return undefined;
  }
}
