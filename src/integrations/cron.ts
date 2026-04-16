/**
 * Drop-in cron monitoring helper for Node.
 *
 * Wraps any callable that runs on a schedule (node-cron, node-schedule,
 * cron, BullMQ, Agenda, plain setInterval — anything) and emits an AllStak
 * heartbeat with `slug`, `status` (success|failed), and real `durationMs`.
 *
 * @example node-cron
 * ```ts
 * import cron from 'node-cron';
 * import { AllStak } from 'allstak-js';
 * import { monitor } from 'allstak-js/cron';
 *
 * AllStak.init({ apiKey: 'ask_live_…' });
 *
 * cron.schedule('* /5 * * * *', monitor('housekeeping', async () => {
 *   await runHousekeeping();
 * }));
 * ```
 *
 * @example BullMQ worker
 * ```ts
 * worker.on('completed', (job) => {
 *   AllStak.heartbeat({ slug: 'email-queue', status: 'success', durationMs: job.processedOn! - job.timestamp });
 * });
 * ```
 */

import { AllStak } from '../index';

const SLUG_RE = /^[a-z0-9-]+$/;

function normalizeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 64);
}

/**
 * Wrap a callable so every invocation emits an AllStak heartbeat.
 * The wrapper preserves the original return value and re-throws on error
 * (so the host scheduler still sees the failure).
 *
 * @param slug Stable cron monitor slug. Must match `^[a-z0-9-]+$`. Spaces and
 *             other characters are normalized to dashes.
 * @param fn   The original task function. Sync or async.
 * @returns    A wrapped function with the same signature.
 */
export function monitor<TArgs extends unknown[], TReturn>(
  slug: string,
  fn: (...args: TArgs) => TReturn | Promise<TReturn>,
): (...args: TArgs) => Promise<TReturn> {
  const safeSlug = normalizeSlug(slug);
  if (!SLUG_RE.test(safeSlug)) {
    throw new Error(`AllStak.monitor: invalid slug '${slug}' — must match ${SLUG_RE}`);
  }

  return async function monitored(this: unknown, ...args: TArgs): Promise<TReturn> {
    const start = Date.now();
    try {
      const result = await fn.apply(this, args);
      try {
        AllStak.heartbeat({
          slug: safeSlug,
          status: 'success',
          durationMs: Date.now() - start,
        });
      } catch {
        /* never break the host scheduler */
      }
      return result;
    } catch (err) {
      try {
        AllStak.heartbeat({
          slug: safeSlug,
          status: 'failed',
          durationMs: Date.now() - start,
          message: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* never break the host scheduler */
      }
      throw err;
    }
  };
}

export default { monitor };
