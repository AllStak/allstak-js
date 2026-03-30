import { AllStakClient, AllStakConfig } from './client';
import type { HttpRequestItem } from './modules/http-requests';
import type { HeartbeatOptions } from './modules/cron';

export type { AllStakConfig } from './client';
export type { ErrorEvent } from './modules/errors';
export type { LogEvent, LogLevel } from './modules/logs';
export type { ReplayEvent, DOMEvent } from './modules/session-replay';
export type { HttpRequestItem } from './modules/http-requests';
export type { HeartbeatOptions } from './modules/cron';

let instance: AllStakClient | null = null;

export const AllStak = {
  init(config: AllStakConfig): AllStakClient {
    if (instance) {
      instance.destroy();
    }
    instance = new AllStakClient(config);
    return instance;
  },

  captureException(error: Error, context?: Record<string, unknown>): void {
    ensureInit().captureException(error, context);
  },

  captureMessage(
    message: string,
    level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
  ): void {
    ensureInit().captureMessage(message, level);
  },

  /**
   * Report an HTTP request (inbound or outbound) to AllStak.
   * Batches internally and flushes every 5s or when 20 items accumulate.
   */
  captureRequest(item: HttpRequestItem): void {
    ensureInit().captureRequest(item);
  },

  /**
   * Report a cron job execution to AllStak.
   * The slug must match a cron monitor configured in the AllStak dashboard.
   */
  heartbeat(options: HeartbeatOptions): void {
    ensureInit().heartbeat(options);
  },

  get log() {
    return ensureInit().log;
  },

  setUser(user: { id?: string; email?: string }): void {
    ensureInit().setUser(user);
  },

  setTag(key: string, value: string): void {
    ensureInit().setTag(key, value);
  },

  getSessionId(): string {
    return ensureInit().getSessionId();
  },

  destroy(): void {
    instance?.destroy();
    instance = null;
  },

  /** @internal — exposed for testing */
  _getInstance(): AllStakClient | null {
    return instance;
  },
};

function ensureInit(): AllStakClient {
  if (!instance) {
    throw new Error('AllStak.init() must be called before using the SDK');
  }
  return instance;
}
