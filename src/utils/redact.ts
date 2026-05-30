/**
 * @internal — Privacy / redaction primitive for @allstak/js.
 *
 * Same default deny-list and shape as the redactors shipped in
 *   - allstak/sdk-php (Privacy\Sanitizer)
 *   - github.com/AllStak/allstak-go (Redactor)
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
 *
 * VALUE-PATTERN scrubbing (value-pattern data-scrubbing) layers on top of the
 * key-based deny-list above. It scans string VALUES for PII that leaks into
 * free text (credit-card numbers, SSNs, emails, IPs) and is applied only when
 * the caller opts in via {@link RedactOptions.scrubValues}. The layering is:
 *
 *   A) ALWAYS scrub (regardless of sendDefaultPii) — high-risk financial /
 *      identity data never legitimately wanted in telemetry:
 *        • Luhn-valid credit-card numbers (13–19 digits, space/hyphen seps).
 *        • US SSN in dashed form `\d{3}-\d{2}-\d{4}`.
 *   B) Scrub UNLESS sendDefaultPii === true:
 *        • Email addresses.
 *        • IPv4 addresses (octets validated 0–255). IPv6 best-effort.
 *
 * Conservative by design: a digit run that FAILS the Luhn checksum is left
 * intact (so order ids / timestamps are not nuked), and bare 9-digit numbers
 * are NOT treated as SSNs (the hyphens are required).
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
  /cookie$/i,
  /(^|\.)set-cookie$/i,
  /set[._-]?cookie$/i,
  /(^|\.)x-api-key$/i,
  /(^|\.)x-auth-token$/i,
  /(^|\.)x-access-token$/i,
  /(^|\.)x-allstak-key$/i,
  /(^|[._-])token$/i,
  /token$/i,
  /(^|[._-])api[._-]?key$/i,
  /(^|[._-])password$/i,
  /password$/i,
  /(^|[._-])passwd$/i,
  /passwd$/i,
  /(^|[._-])secret$/i,
  /secret$/i,
  /(^|[._-])session[._-]?id$/i,
  /(^|[._-])csrf$/i,
  /(^|[._-])jwt$/i,
  /jwt$/i,
  /(^|[._-])bearer$/i,
  /bearer$/i,
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

// ─── Value-pattern PII scrubbing (value-pattern data-scrubbing) ──────────────
//
// Compiled once at module load. These run on the wire path, so they must be
// cheap and never throw. We cap the per-string length we scan to keep a
// hostile/huge string from turning the regex engine into a hot loop.

/** Max chars we scan in a single string value. Longer strings are passed through. */
const MAX_SCAN_LEN = 16_384;

/**
 * Candidate credit-card run: 13–19 digits with optional single space/hyphen
 * separators between groups. Bounded by non-digit edges so we don't bite into
 * a longer number. Luhn-validated below before redacting — a run that fails
 * Luhn is preserved (avoids nuking order ids / timestamps / long counters).
 */
const CC_CANDIDATE = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;

/** US SSN — REQUIRE the dashes. Bare 9-digit numbers are intentionally NOT matched. */
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

/** Standard email. Conservative local/domain charset; requires a dotted TLD. */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** IPv4 with every octet validated to 0–255 (avoids matching e.g. `999.1.1.1`). */
const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

/** IPv6 — best-effort. Matches full + common compressed forms. */
const IPV6 =
  /\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{0,4}(?:%[0-9A-Za-z]+)?\b|\b::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}\b/g;

/** Bearer-style auth token in free text. */
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

/** Compact JWT-like token in free text. */
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/** Luhn checksum — true only for a genuine card-number candidate. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' === 48
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Apply the always-on (A) value scrubbers to a single string: Luhn-valid
 * credit cards + dashed SSNs. Returns the (possibly) scrubbed string. Never
 * throws — on any internal error the original string is returned unchanged.
 */
function scrubAlwaysPii(value: string): string {
  try {
    let out = value.replace(CC_CANDIDATE, (match) => {
      const digits = match.replace(/[ -]/g, '');
      if (digits.length < 13 || digits.length > 19) return match; // length re-check
      return passesLuhn(digits) ? REDACTED : match;
    });
    out = out.replace(SSN, REDACTED);
    out = out.replace(BEARER_VALUE, REDACTED);
    out = out.replace(JWT_VALUE, REDACTED);
    return out;
  } catch {
    return value;
  }
}

/**
 * Apply the sendDefaultPii-gated (B) value scrubbers: email + IP addresses.
 * Only invoked when sendDefaultPii is false. Never throws.
 */
function scrubDefaultPii(value: string): string {
  try {
    let out = value.replace(EMAIL, REDACTED);
    out = out.replace(IPV4, REDACTED);
    out = out.replace(IPV6, REDACTED);
    return out;
  } catch {
    return value;
  }
}

/**
 * Scrub a single string value according to the active layering. `scrubValues`
 * false → no-op (key-based redaction only). `sendDefaultPii` true disables the
 * (B) email/IP scrubbers; the (A) financial/identity scrubbers are always on.
 * Very large strings are skipped (returned unchanged) for performance.
 */
export function scrubStringValue(value: string, opts: ValueScrubOptions): string {
  if (!opts.scrubValues) return value;
  if (value.length === 0 || value.length > MAX_SCAN_LEN) return value;
  let out = scrubAlwaysPii(value);
  if (!opts.sendDefaultPii) out = scrubDefaultPii(out);
  return out;
}

export interface ValueScrubOptions {
  /**
   * Turn on value-pattern scrubbing of string VALUES (CC/SSN always, email/IP
   * unless sendDefaultPii). Off by default so the primitive stays a pure
   * key-based redactor unless a caller opts in.
   */
  scrubValues?: boolean;
  /**
   * When true, the email/IP value scrubbers are disabled (the user opted into
   * PII). The Luhn-CC + SSN scrubbers stay on regardless. Default false.
   * Ignored unless {@link scrubValues} is true.
   */
  sendDefaultPii?: boolean;
}

export interface RedactOptions extends ValueScrubOptions {
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
  try {
    const extra = compileExtraPatterns(options.extraKeys);
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const seen = new WeakMap<object, unknown>();
    return walk(input, extra, 0, maxDepth, seen, options) as T;
  } catch {
    // Fail-open: a scrubber bug must never break/drop an event. The key-based
    // header/body redactors elsewhere already removed the highest-risk
    // secrets; returning the input here preserves that guarantee.
    return input;
  }
}

/**
 * Same shape but for a value of unknown type (typed entry point used by
 * the SDK when serialising free-form contexts). When value scrubbing is on,
 * scalar string inputs are scrubbed too.
 */
export function redactValue(
  input: unknown,
  options: RedactOptions = {},
): unknown {
  if (input == null) return input;
  if (typeof input !== 'object') {
    return typeof input === 'string' ? scrubStringValue(input, options) : input;
  }
  try {
    const extra = compileExtraPatterns(options.extraKeys);
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const seen = new WeakMap<object, unknown>();
    return walk(input, extra, 0, maxDepth, seen, options);
  } catch {
    return input; // fail-open
  }
}

function walk(
  node: unknown,
  extra: RegExp[],
  depth: number,
  maxDepth: number,
  seen: WeakMap<object, unknown>,
  valueOpts: ValueScrubOptions,
): unknown {
  if (node == null) return node;
  const t = typeof node;
  if (t === 'string') return scrubStringValue(node as string, valueOpts);
  if (t !== 'object') return node;
  if (depth >= maxDepth) return '[MaxDepth]';

  const asObj = node as object;
  if (seen.has(asObj)) return '[Circular]';

  if (Array.isArray(node)) {
    const out: unknown[] = new Array(node.length);
    seen.set(asObj, out);
    for (let i = 0; i < node.length; i++) {
      out[i] = walk(node[i], extra, depth + 1, maxDepth, seen, valueOpts);
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
    out[k] = walk(v, extra, depth + 1, maxDepth, seen, valueOpts);
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
export const __test = { DEFAULT_REDACTED_KEY_PATTERNS, passesLuhn, scrubAlwaysPii, scrubDefaultPii };
