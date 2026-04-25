/**
 * Structured stack-frame parser.
 *
 * The runtime passes us an `Error.stack` string whose format depends on
 * the engine: V8 (Chrome / Node), JSC (Safari), SpiderMonkey (Firefox),
 * and Hermes (React Native) all differ. Producing a uniform, structured
 * frame array on the SDK side means the backend doesn't have to guess.
 *
 * The output shape mirrors the backend `ErrorIngestRequest.Frame`
 * record: filename, function, lineno, colno, plus `inApp` heuristic.
 *
 * No external dependency: a single-purpose parser is small and avoids
 * pulling `error-stack-parser` (12 KB minified) into customer bundles.
 */

export interface StackFrame {
  filename?: string;
  absPath?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  inApp?: boolean;
  platform?: string;
}

// V8 / Hermes:  "    at fn (file:line:col)"  or  "    at file:line:col"
// `eval at fn (file:line:col), file:line:col` is collapsed to the inner.
const V8_FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?((?:.+?):(\d+):(\d+))\)?\s*$/;

// Firefox / Safari:  "fn@file:line:col"  or  "@file:line:col"
const GECKO_FRAME_RE = /^\s*(?:(.*?)@)?(.+?):(\d+):(\d+)\s*$/;

const NODE_INTERNAL_RE = /^(node:|internal\/|node_modules\/)/;

/**
 * Parse an Error.stack string into a list of structured frames.
 * Returns an empty list if the stack is missing or unparseable.
 */
export function parseStack(stack: string | undefined | null): StackFrame[] {
  if (!stack || typeof stack !== 'string') return [];
  const lines = stack.split('\n');
  const frames: StackFrame[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Skip the leading "ErrorClass: message" line that V8 prints.
    // We rely on the `at ` / `@` prefix to identify frame lines and
    // anything else is metadata.
    let m = V8_FRAME_RE.exec(line);
    if (m) {
      const fn = m[1] ? m[1].trim() : undefined;
      const loc = m[2];
      const lineno = parseInt(m[3], 10);
      const colno = parseInt(m[4], 10);
      const filename = stripQueryHash(loc.replace(/:\d+:\d+$/, ''));
      frames.push({
        filename,
        absPath: filename,
        function: fn,
        lineno,
        colno,
        inApp: isInApp(filename),
      });
      continue;
    }

    m = GECKO_FRAME_RE.exec(line);
    if (m && m[2]) {
      const fn = m[1] ? m[1].trim() : undefined;
      const filename = stripQueryHash(m[2]);
      frames.push({
        filename,
        absPath: filename,
        function: fn || undefined,
        lineno: parseInt(m[3], 10),
        colno: parseInt(m[4], 10),
        inApp: isInApp(filename),
      });
    }
  }

  return frames;
}

/** Drop ?query and #hash so URLs match between SDK and source-map upload. */
function stripQueryHash(url: string): string {
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  let cut = url.length;
  if (q >= 0) cut = Math.min(cut, q);
  if (h >= 0) cut = Math.min(cut, h);
  return url.slice(0, cut);
}

/**
 * Heuristic for whether a frame is application code or third-party.
 * Conservative: only marks things in `node:` builtins and `node_modules`
 * as out-of-app; everything else (including unknown URLs) is in-app so
 * the dashboard surfaces it by default rather than hiding it under a
 * "show third-party frames" toggle.
 */
function isInApp(filename: string | undefined): boolean {
  if (!filename) return true;
  if (NODE_INTERNAL_RE.test(filename)) return false;
  if (filename.includes('/node_modules/')) return false;
  return true;
}
