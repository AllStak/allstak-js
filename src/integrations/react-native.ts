/**
 * React Native integration for AllStak.
 *
 * Call `installReactNative()` right after `AllStak.init(...)` to:
 *  - hook the global JS error handler (ErrorUtils) to capture unhandled
 *    JS exceptions with a `platform=react-native` tag.
 *  - hook unhandled promise rejections (via the global
 *    HermesInternal / unhandled rejection tracking when available).
 *  - attach device metadata (Platform.OS, Platform.Version, appState) as
 *    tags on every subsequent event.
 *
 * Depends on react-native at runtime (imported lazily) so it can be imported
 * from regular JS bundles without pulling RN modules.
 */
import { AllStak } from '../index';
import { SDK_VERSION } from '../client';

type ErrorUtilsShape = {
  getGlobalHandler: () => (error: Error, isFatal?: boolean) => void;
  setGlobalHandler: (handler: (error: Error, isFatal?: boolean) => void) => void;
};

export interface ReactNativeInstallOptions {
  /** Automatically capture unhandled JS exceptions via ErrorUtils. Default: true */
  autoErrorHandler?: boolean;
  /** Automatically capture unhandled promise rejections. Default: true */
  autoPromiseRejections?: boolean;
  /** Automatically attach Platform.* info as tags. Default: true */
  autoDeviceTags?: boolean;
  /** Automatically emit breadcrumbs on AppState change (foreground/background). Default: true */
  autoAppStateBreadcrumbs?: boolean;
  /** Automatically patch XMLHttpRequest so every fetch / native HTTP call is captured as outbound. Default: true */
  autoNetworkCapture?: boolean;
}

/**
 * Patch the global `XMLHttpRequest` so any HTTP call (RN's `fetch` is XHR-based,
 * many third-party libraries use XHR directly) is captured as an outbound
 * HTTP request and recorded as a breadcrumb. Idempotent.
 *
 * Skips requests to AllStak's own ingest host so we don't recurse.
 */
function instrumentXmlHttpRequest(): void {
  const flag = '__allstak_xhr_patched__';
  const X: any = (globalThis as any).XMLHttpRequest;
  if (!X || X.prototype[flag]) return;

  const ownHost = (() => {
    try {
      const cfg = (AllStak as any).getConfig?.();
      return cfg?.dsn?.split('@').pop()?.replace(/\/$/, '') ?? '';
    } catch { return ''; }
  })();

  const origOpen = X.prototype.open;
  const origSend = X.prototype.send;

  X.prototype.open = function (method: string, url: string, ...rest: unknown[]) {
    (this as any).__allstak_method__ = method;
    (this as any).__allstak_url__ = url;
    return origOpen.call(this, method, url, ...rest);
  };

  X.prototype.send = function (body?: unknown) {
    const start = Date.now();
    const method = (this as any).__allstak_method__ || 'GET';
    const url: string = (this as any).__allstak_url__ || '';
    let host = '';
    let path = url;
    try {
      const u = new URL(url);
      host = u.host;
      path = u.pathname;
    } catch { /* relative URL; keep as-is */ }
    const isOwnIngest = ownHost && url.startsWith(ownHost);

    const onDone = (status: number) => {
      const durationMs = Date.now() - start;
      try {
        AllStak.addBreadcrumb('http', `${method} ${path} -> ${status}`,
          status >= 400 ? 'error' : 'info',
          { method, url: path, statusCode: status, durationMs });
      } catch { /* never break */ }
      if (!isOwnIngest) {
        try {
          AllStak.captureRequest({
            direction: 'outbound',
            method: method.toUpperCase() as any,
            host,
            path,
            statusCode: status,
            durationMs,
          });
        } catch { /* never break */ }
      }
    };

    this.addEventListener?.('load', () => onDone(this.status || 0));
    this.addEventListener?.('error', () => onDone(0));
    this.addEventListener?.('abort', () => onDone(0));
    this.addEventListener?.('timeout', () => onDone(0));

    return origSend.call(this, body);
  };

  X.prototype[flag] = true;
}

/**
 * Drain any native crash stashed by AllStakCrashHandler (Android Java /
 * iOS Obj-C) on the previous launch and ship it to /ingest/v1/errors.
 *
 * Requires the native modules to be linked; no-op when `NativeModules.AllStakNative`
 * is not present (bare JS testing, Expo Go without plugins, etc).
 */
export async function drainPendingNativeCrashes(release?: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native');
    const native: any = rn?.NativeModules?.AllStakNative;
    if (!native) return;
    if (typeof native.install === 'function') {
      try { await native.install(release ?? ''); } catch { /* ignore */ }
    }
    if (typeof native.drainPendingCrash === 'function') {
      const json: string | null = await native.drainPendingCrash();
      if (json && json !== '') {
        try {
          const payload = JSON.parse(json);
          // Re-submit via the JS client's sendRaw path. The payload is
          // already DTO-compatible; use captureException for the public
          // surface when only a message is available.
          const message: string = payload?.message ?? 'Native crash';
          const err = new Error(message);
          err.name = payload?.exceptionClass ?? 'NativeCrash';
          // Preserve the native stack as-is — splitting into frames was
          // already done on the native side.
          (err as any).stack = Array.isArray(payload?.stackTrace)
            ? payload.stackTrace.join('\n')
            : String(payload?.stackTrace ?? '');
          AllStak.captureException(err, {
            ...(payload?.metadata || {}),
            'native.crash': 'true',
          });
        } catch { /* swallow */ }
      }
    }
  } catch {
    // react-native not available in this runtime
  }
}

export function installReactNative(options: ReactNativeInstallOptions = {}): void {
  const autoError = options.autoErrorHandler !== false;
  const autoPromise = options.autoPromiseRejections !== false;
  const autoDevice = options.autoDeviceTags !== false;
  const autoAppState = options.autoAppStateBreadcrumbs !== false;
  const autoNetwork = options.autoNetworkCapture !== false;

  AllStak.setTag('platform', 'react-native');

  // Phase 3 — SDK identity + auto-detected dist. The resulting wire
  // payload reaches the AllStak ingest API with sdk_name=allstak-react-native
  // and dist=ios-hermes / android-hermes (or -jsc for the legacy engine).
  try {
    const hermes = typeof (globalThis as { HermesInternal?: unknown }).HermesInternal !== 'undefined';
    let dist: string | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rn = require('react-native');
      const os = rn?.Platform?.OS as string | undefined;
      if (os === 'ios' || os === 'android') {
        dist = `${os}-${hermes ? 'hermes' : 'jsc'}`;
      }
    } catch { /* not running under RN */ }
    AllStak.setIdentity({
      sdkName: 'allstak-react-native',
      sdkVersion: SDK_VERSION,
      platform: 'react-native',
      dist,
    });
  } catch { /* never break init */ }

  if (autoNetwork) {
    try { instrumentXmlHttpRequest(); } catch { /* not in JS env */ }
  }

  if (autoDevice) {
    try {
      // RN's Platform module — guarded for non-RN bundles.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rn = require('react-native');
      const Platform: any = rn?.Platform;
      if (Platform) {
        AllStak.setTag('device.os', String(Platform.OS ?? ''));
        AllStak.setTag('device.osVersion', String(Platform.Version ?? ''));
        if (Platform.constants?.Model) {
          AllStak.setTag('device.model', String(Platform.constants.Model));
        }
      }
    } catch {
      /* not running under RN — ignore */
    }
  }

  if (autoAppState) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rn = require('react-native');
      const AppState: any = rn?.AppState;
      if (AppState && typeof AppState.addEventListener === 'function') {
        AppState.addEventListener('change', (next: string) => {
          try {
            AllStak.addBreadcrumb('navigation', `AppState → ${next}`, 'info', { appState: next });
          } catch { /* ignore */ }
        });
      }
    } catch {
      /* no RN available (e.g. unit test) */
    }
  }

  if (autoError) {
    const eu: ErrorUtilsShape | undefined = (globalThis as any).ErrorUtils;
    if (eu && typeof eu.setGlobalHandler === 'function') {
      const prev = eu.getGlobalHandler();
      eu.setGlobalHandler((error: Error, isFatal?: boolean) => {
        try {
          AllStak.captureException(error, {
            source: 'react-native-ErrorUtils',
            fatal: String(Boolean(isFatal)),
          });
        } catch {
          /* never break */
        }
        try { prev(error, isFatal); } catch { /* ignore */ }
      });
    }
  }

  if (autoPromise) {
    // Hermes promise tracking
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tracking = require('promise/setimmediate/rejection-tracking');
      tracking.enable({
        allRejections: true,
        onUnhandled: (_id: number, rejection: unknown) => {
          const err =
            rejection instanceof Error
              ? rejection
              : new Error(`Unhandled promise rejection: ${String(rejection)}`);
          try { AllStak.captureException(err, { source: 'unhandledRejection' }); }
          catch { /* ignore */ }
        },
        onHandled: () => {},
      });
    } catch {
      // Fallback for environments that expose `unhandledrejection` on globalThis
      if (typeof (globalThis as any).addEventListener === 'function') {
        (globalThis as any).addEventListener('unhandledrejection', (ev: any) => {
          const reason = ev?.reason;
          const err = reason instanceof Error ? reason : new Error(String(reason));
          try { AllStak.captureException(err, { source: 'unhandledrejection' }); }
          catch { /* ignore */ }
        });
      }
    }
  }
}

export { AllStak };
