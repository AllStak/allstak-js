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
declare function monitor<TArgs extends unknown[], TReturn>(slug: string, fn: (...args: TArgs) => TReturn | Promise<TReturn>): (...args: TArgs) => Promise<TReturn>;
declare const _default: {
    monitor: typeof monitor;
};

export { _default as default, monitor };
