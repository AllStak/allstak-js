import { ProcessOptions, ProcessReport } from './sourcemaps.js';

/**
 * Vite plugin — injects AllStak debug IDs into the build output and
 * (optionally) uploads source maps when the build finishes.
 *
 * Usage:
 *
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from 'vite';
 * import react from '@vitejs/plugin-react';
 * import { allstakVitePlugin } from '@allstak/js/vite';
 *
 * export default defineConfig({
 *   plugins: [
 *     react(),
 *     allstakVitePlugin({
 *       release: process.env.RELEASE ?? 'dev',
 *       token: process.env.ALLSTAK_UPLOAD_TOKEN,
 *       dist: 'web',
 *     }),
 *   ],
 *   build: { sourcemap: true },
 * });
 * ```
 *
 * The plugin runs in `closeBundle` (after Vite finishes writing every
 * file to disk) so it works for both library and application builds
 * and never blocks the dev server.
 */

/** Options for {@link allstakVitePlugin}. */
interface AllStakVitePluginOptions extends Omit<ProcessOptions, 'dir'> {
    /**
     * Build output directory, relative to the project root or absolute.
     * Defaults to Vite's `build.outDir` (resolved at config time).
     * Override only if you write maps to a non-default location.
     */
    dir?: string;
    /**
     * If true, plugin is skipped entirely. Handy for `if (mode !== 'production')`-style
     * gating without removing the plugin from the array.
     */
    disabled?: boolean;
}
/** Minimal Vite plugin shape — defined locally so we don't peer-depend on `vite` types. */
interface MinimalVitePlugin {
    name: string;
    apply?: 'build' | 'serve';
    enforce?: 'pre' | 'post';
    configResolved?: (config: {
        build?: {
            outDir?: string;
        };
        root?: string;
    }) => void;
    closeBundle?: () => void | Promise<void>;
}
/**
 * Returns a Vite plugin you spread into `plugins: []`. Doesn't import
 * from `vite` directly — Vite's plugin contract is a duck-typed object,
 * which keeps this package install-time light for users who only need
 * the runtime SDK.
 */
declare function allstakVitePlugin(opts?: AllStakVitePluginOptions): MinimalVitePlugin;
/** Test/inspection hook: returns the most recent processBuildOutput report. */
declare function _lastReport(plugin: MinimalVitePlugin): ProcessReport | null;

export { type AllStakVitePluginOptions, _lastReport, allstakVitePlugin };
