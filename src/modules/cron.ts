import { HttpTransport } from '../transport/http';

export interface HeartbeatOptions {
  /** The cron monitor slug as configured in the AllStak dashboard */
  slug: string;
  /** Whether the job run succeeded or failed */
  status: 'success' | 'failed';
  /** How long the job took to run, in milliseconds */
  durationMs: number;
  /** Optional message or error description */
  message?: string;
}

// Matches backend HeartbeatRequest DTO exactly
interface HeartbeatPayload {
  slug: string;
  status: 'success' | 'failed';
  durationMs: number;
  message?: string;
}

const INGEST_PATH = '/ingest/v1/heartbeat';

export class CronModule {
  constructor(private transport: HttpTransport) {}

  /**
   * Report a cron job execution to AllStak.
   * The cron monitor must already exist in the dashboard with the matching slug.
   *
   * @example
   * const start = Date.now();
   * try {
   *   await runJob();
   *   AllStak.heartbeat({ slug: 'daily-report', status: 'success', durationMs: Date.now() - start });
   * } catch (err) {
   *   AllStak.heartbeat({ slug: 'daily-report', status: 'failed', durationMs: Date.now() - start, message: err.message });
   * }
   */
  heartbeat(options: HeartbeatOptions): void {
    const payload: HeartbeatPayload = {
      slug: options.slug,
      status: options.status,
      durationMs: options.durationMs,
      message: options.message,
    };
    this.transport.send(INGEST_PATH, payload);
  }
}
