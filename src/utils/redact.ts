/**
 * @internal — Privacy / redaction primitive for @allstak/js.
 *
 * Same default deny-list and shape as the redactors shipped in
 *   - allstak/sdk-php (Privacy\Sanitizer)
 *   - github.com/allstak-io/allstak-go (Redactor)
 *   - @allstak/nestjs (src/redaction.ts)
 *   - @allstak/fastify (src/redaction.ts)
 *   - @allstak/otel (src/redaction.ts)
 *
 * Rules (kept in lock-step across SDKs):
 *   1. Match keys case-insensitively against the built-in deny-list and any
 *      caller-supplied extras.
 *   2. Walk nested objects and arrays. Slices of objects are walked too.
 *   3. Never mutate the caller-owned input. Always return a fresh object.
 *   4. Detect cycles and short-circuit to '[Circular]' rather than throwing.
 *   5. Hard-cap recursion depth so a hostile input can't crash the SDK.
 */

export const REDACTED = '[REDACTED]';

/**
 * Built-in deny-list. Keep parity with sibling SDKs — patterns added here
 * should be added there too.
 *
 * The patterns intentionally use word/separator boundaries so that an
 * unrelated key like `topic` does not match `*token`.
 */
const DEFAULT_REDACTED_KEY_PATTERNS: RegExp[] = [
  /(^|\.)authorization$/i,
  /(^|\.)proxy-authorization$/i,
  /(^|\.)cookie$/i,
  /(^|\.)set-cookie$/i,
  /(^|\.)x-api-key$/i,
  /(^|\.)x-auth-token$/i,
  /(^|\.)x-access-token$/i,
  /(^|\.)x-allstak-key$/i,
  /(^|[._-])token$/i,
  /(^|[._-])api[._-]?key$/i,
  /(^|[._-])password$/i,
  /(^|[._-])passwd$/i,
  /(^|[._-])secret$/i,
  /(^|[._-])session[._-]?id$/i,
  /(^|[._-])csrf$/i,
  /(^|[._-])jwt$/i,
  /(^|[._-])bearer$/i,
];

const DEFAULT_MAX_DEPTH = 12;

export function isSensitiveKey(key: string, extra: RegExp[] = []): boolean {
  for (const p of DEFAULT_REDACTED_KEY_PATTERNS) if (p.test(key)) return true;
  for (const p of extra) if (p.test(key)) return true;
  return false;
}

export function compileExtraPatterns(extra: (string | RegExp)[] | undefined): RegExp[] {
  if (!extra) return [];
  const out: RegExp[] = [];
  for (const p of extra) {
    if (!p) continue;
    if (p instanceof RegExp) {
      out.push(p);
      continue;
    }
    try {
      out.push(new RegExp(escapeRegex(p), 'i'));
    } catch {
      // fail-safe: a bad caller pattern must not break redaction
    }
  }
  return out;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RedactOptions {
  /** Extra key patterns added to the built-in deny-list (string or RegExp). */
  extraKeys?: (string | RegExp)[];
  /** Hard recursion ceiling. Default 12. */
  maxDepth?: number;
}

/**
 * Recursively redact sensitive values from an object. Returns a fresh
 * object — the input is never mutated. Cycle-safe.
 */
export function redactObject<T extends Record<string, unknown>>(
  input: T | undefined,
  options: RedactOptions = {},
): T | undefined {
  if (input == null) return input;
  const extra = compileExtraPatterns(options.extraKeys);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seen = new WeakMap<object, unknown>();
  return walk(input, extra, 0, maxDepth, seen) as T;
}

/**
 * Same shape but for a value of unknown type (typed entry point used by
 * the SDK when serialising free-form contexts).
 */
export function redactValue(
  input: unknown,
  options: RedactOptions = {},
): unknown {
  if (input == null) return input;
  if (typeof input !== 'object') return input;
  const extra = compileExtraPatterns(options.extraKeys);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seen = new WeakMap<object, unknown>();
  return walk(input, extra, 0, maxDepth, seen);
}

function walk(
  node: unknown,
  extra: RegExp[],
  depth: number,
  maxDepth: number,
  seen: WeakMap<object, unknown>,
): unknown {
  if (node == null) return node;
  const t = typeof node;
  if (t !== 'object') return node;
  if (depth >= maxDepth) return '[MaxDepth]';

  const asObj = node as object;
  if (seen.has(asObj)) return '[Circular]';

  if (Array.isArray(node)) {
    const out: unknown[] = new Array(node.length);
    seen.set(asObj, out);
    for (let i = 0; i < node.length; i++) {
      out[i] = walk(node[i], extra, depth + 1, maxDepth, seen);
    }
    return out;
  }

  // Skip non-plain objects (Date, Error, Map, Set, Buffer, etc.) — passing
  // them through unchanged preserves serialisation behaviour and avoids
  // touching framework-internal types.
  const proto = Object.getPrototypeOf(node);
  if (proto !== Object.prototype && proto !== null) {
    return node;
  }

  const out: Record<string, unknown> = {};
  seen.set(asObj, out);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (isSensitiveKey(k, extra)) {
      out[k] = REDACTED;
      continue;
    }
    out[k] = walk(v, extra, depth + 1, maxDepth, seen);
  }
  return out;
}

/**
 * Header-name helper: an http.Header-style record (string → string|string[])
 * with sensitive header values replaced.
 */
export function redactHeaderRecord(
  headers: Record<string, string | string[] | undefined> | undefined,
  options: RedactOptions = {},
): Record<string, string | string[]> | undefined {
  if (!headers) return headers;
  const extra = compileExtraPatterns(options.extraKeys);
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    out[k] = isSensitiveKey(k, extra) ? REDACTED : v;
  }
  return out;
}

/** Test/internal-only hooks. Not exported via the package root. */
export const __test = { DEFAULT_REDACTED_KEY_PATTERNS };
