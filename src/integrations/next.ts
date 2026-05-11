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

import { AllStakWebpackPlugin, type AllStakWebpackPluginOptions } from './webpack';

/** Loose Next config shape — kept duck-typed so we don't peer-depend on `next`. */
type NextConfigLike = Record<string, unknown> & {
  productionBrowserSourceMaps?: boolean;
  webpack?: (config: unknown, ctx: unknown) => unknown;
};

/** Loose Webpack config shape. */
interface WebpackConfigLike {
  plugins?: unknown[];
  devtool?: string | false;
}

/** Loose Next webpack-callback context. */
interface WebpackContextLike {
  isServer?: boolean;
  dev?: boolean;
}

/**
 * Decorate a Next.js config with the AllStak Webpack plugin.
 *
 * @param allstakOpts source-map options forwarded to the Webpack plugin
 * @param nextConfig the user's existing Next config (may be omitted)
 */
export function withAllStak(
  allstakOpts: AllStakWebpackPluginOptions,
  nextConfig: NextConfigLike = {},
): NextConfigLike {
  const userWebpack = nextConfig.webpack;

  return {
    ...nextConfig,
    // Browser source maps are off by default in Next; we need them on
    // for the client bundles our SDK actually instruments.
    productionBrowserSourceMaps:
      nextConfig.productionBrowserSourceMaps ?? true,

    webpack(config: unknown, ctx: unknown): unknown {
      const webpackConfig = (config as WebpackConfigLike) ?? {};
      const webpackCtx = (ctx as WebpackContextLike) ?? {};
      const plugins = webpackConfig.plugins ?? (webpackConfig.plugins = []);

      // Only attach to the client compilation. Server bundles ship to a
      // Node runtime, where stack traces are already symbolicated.
      if (!webpackCtx.isServer && !webpackCtx.dev) {
        plugins.push(new AllStakWebpackPlugin(allstakOpts));
      }

      return userWebpack ? userWebpack(webpackConfig, ctx) : webpackConfig;
    },
  };
}
