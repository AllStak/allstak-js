const registered = new Set<string>();
const SDK_NAME = 'allstak-js';
const SDK_VERSION = '0.2.4';

export interface RegisterRuntimeReleaseOptions {
  host: string;
  apiKey: string;
  release?: string;
  environment?: string;
  commitSha?: string;
  branch?: string;
  service?: string;
  enabled?: boolean;
  fetchImpl?: typeof fetch;
}

export function canRegisterRuntimeRelease(): boolean {
  return typeof window === 'undefined'
    && typeof process !== 'undefined'
    && !!process.versions?.node;
}

export function registerRuntimeRelease(options: RegisterRuntimeReleaseOptions): void {
  if (options.enabled === false) return;
  if (options.enabled !== true && isTestRuntime()) return;
  const release = options.release?.trim();
  if (options.enabled !== true && !canRegisterRuntimeRelease()) return;
  if (!options.apiKey || !release) return;
  const environment = options.environment || 'production';
  const key = `${options.host}|${options.apiKey}|${environment}|${release}`;
  if (registered.has(key)) return;
  registered.add(key);

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return;

  const payload: Record<string, unknown> = {
    version: release,
    environment,
    commitSha: options.commitSha,
    branch: options.branch,
    author: `${SDK_NAME}/${SDK_VERSION}`,
    message: 'Registered automatically by AllStak SDK at runtime',
  };
  if (options.service) payload.service = options.service;

  void fetchImpl(`${options.host.replace(/\/$/, '')}/ingest/v1/releases`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AllStak-Key': options.apiKey,
      'User-Agent': `${SDK_NAME}/${SDK_VERSION}`,
    },
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

function isTestRuntime(): boolean {
  try {
    return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  } catch {
    return false;
  }
}

/** @internal */
export function _resetRuntimeReleaseRegistrationForTest(): void {
  registered.clear();
}
