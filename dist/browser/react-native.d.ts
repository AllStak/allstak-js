export { AllStak } from './index.js';
import './database-BconFy9O.js';
import './auto-breadcrumbs-DRB0ieVv.js';

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

interface ReactNativeInstallOptions {
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
 * Drain any native crash stashed by AllStakCrashHandler (Android Java /
 * iOS Obj-C) on the previous launch and ship it to /ingest/v1/errors.
 *
 * Requires the native modules to be linked; no-op when `NativeModules.AllStakNative`
 * is not present (bare JS testing, Expo Go without plugins, etc).
 */
declare function drainPendingNativeCrashes(release?: string): Promise<void>;
declare function installReactNative(options?: ReactNativeInstallOptions): void;

export { type ReactNativeInstallOptions, drainPendingNativeCrashes, installReactNative };
