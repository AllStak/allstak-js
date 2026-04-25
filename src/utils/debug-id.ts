/**
 * Runtime debug-ID resolver.
 *
 * The CLI's `inject` step appends `//# debugId=<uuid>` to every JS bundle
 * and writes the same UUID into the matching `.map`. At runtime we need
 * to find that UUID for each stack frame so the symbolicator can pick
 * the right map.
 *
 * Two lookup paths:
 *
 *   1. **Browser:** the build-time injector exposes
 *      `globalThis._allstakDebugIds` as a `{ [scriptUrl]: uuid }` map.
 *      Fast O(1) lookup, no network.
 *
 *   2. **Node:** read the bundle file directly from disk (only the tail —
 *      the comment is appended after the source). Cached per-file so
 *      repeated lookups are free.
 *
 * Returns `undefined` when the file can't be read (e.g. running in a
 * browser without the registry, or the bundle isn't on disk). The
 * symbolicator handles missing debug IDs gracefully.
 */

const REGISTRY_KEY = '_allstakDebugIds';
const DEBUG_ID_RE = /\/\/# debugId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;

const cache = new Map<string, string | null>();

export function resolveDebugId(filename: string | undefined): string | undefined {
  if (!filename) return undefined;

  if (cache.has(filename)) return cache.get(filename) ?? undefined;

  // 1. Browser registry — set by the build-time injector. Indexed by
  //    the script URL the browser loaded.
  const registry = (globalThis as { [REGISTRY_KEY]?: Record<string, string> })[REGISTRY_KEY];
  if (registry && typeof registry === 'object') {
    const hit = registry[filename];
    if (typeof hit === 'string' && hit.length > 0) {
      cache.set(filename, hit);
      return hit;
    }
  }

  // 2. Node disk read. Strip `file://` prefix; ignore everything else
  //    (http/https URLs aren't readable from a Node process and the
  //    browser path was handled above).
  if (typeof process === 'undefined' || !process.versions?.node) {
    cache.set(filename, null);
    return undefined;
  }

  let path = filename;
  if (path.startsWith('file://')) path = path.slice('file://'.length);
  if (!path.startsWith('/')) {
    cache.set(filename, null);
    return undefined;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // Read the last 4 KB only — the debugId line is appended at the
    // end by the CLI injector. Avoids slurping multi-MB bundles.
    const stat = fs.statSync(path);
    const tailSize = Math.min(stat.size, 4096);
    const fd = fs.openSync(path, 'r');
    try {
      const buf = Buffer.alloc(tailSize);
      fs.readSync(fd, buf, 0, tailSize, Math.max(0, stat.size - tailSize));
      const text = buf.toString('utf8');
      const m = DEBUG_ID_RE.exec(text);
      if (m && m[1]) {
        cache.set(filename, m[1]);
        return m[1];
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* ignore — file not readable */
  }

  cache.set(filename, null);
  return undefined;
}

/** Test-only: reset the per-process cache. */
export function _resetDebugIdCache(): void {
  cache.clear();
}
