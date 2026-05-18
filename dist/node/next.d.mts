import { AllStakWebpackPluginOptions } from './webpack.mjs';
import './sourcemaps.mjs';

/**
 * Next.js wrapper — `withAllStak(nextConfig)` decorates a project's
 * `next.config.js` so the AllStak Webpack plugin runs on every build.
 *
 * Usage:
 *
 * ```js
 * // next.config.js
 * const { withAllStak } = require('@allstak/js/next');
 *
 * module.exports = withAllStak({
 *   release: process.env.RELEASE ?? 'dev',
 *   token: process.env.ALLSTAK_UPLOAD_TOKEN,
 *   dist: 'web',
 * }, {
 *   reactStrictMode: true,
 *   // …rest of your Next config…
 * });
 * ```
 *
 * The wrapper:
 *   - sets `productionBrowserSourceMaps: true` so Next emits .map files
 *     for the client bundles (the only ones we can symbolicate).
 *   - chains any user-provided `webpack(config, ctx)` so we don't
 *     stomp existing customizations.
 */

/** Loose Next config shape — kept duck-typed so we don't peer-depend on `next`. */
type NextConfigLike = Record<string, unknown> & {
    productionBrowserSourceMaps?: boolean;
    webpack?: (config: unknown, ctx: unknown) => unknown;
};
/**
 * Decorate a Next.js config with the AllStak Webpack plugin.
 *
 * @param allstakOpts source-map options forwarded to the Webpack plugin
 * @param nextConfig the user's existing Next config (may be omitted)
 */
declare function withAllStak(allstakOpts: AllStakWebpackPluginOptions, nextConfig?: NextConfigLike): NextConfigLike;

export { withAllStak };
