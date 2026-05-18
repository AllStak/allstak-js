import { createRequire as __allstakCreateRequire } from 'node:module';
const require = __allstakCreateRequire(import.meta.url);
import {
  AllStakWebpackPlugin
} from "./chunk-MF3YILRX.mjs";
import "./chunk-OAYU6RNO.mjs";
import "./chunk-6GVGKK5H.mjs";

// src/integrations/next.ts
function withAllStak(allstakOpts, nextConfig = {}) {
  const userWebpack = nextConfig.webpack;
  return {
    ...nextConfig,
    // Browser source maps are off by default in Next; we need them on
    // for the client bundles our SDK actually instruments.
    productionBrowserSourceMaps: nextConfig.productionBrowserSourceMaps ?? true,
    webpack(config, ctx) {
      const webpackConfig = config ?? {};
      const webpackCtx = ctx ?? {};
      const plugins = webpackConfig.plugins ?? (webpackConfig.plugins = []);
      if (!webpackCtx.isServer && !webpackCtx.dev) {
        plugins.push(new AllStakWebpackPlugin(allstakOpts));
      }
      return userWebpack ? userWebpack(webpackConfig, ctx) : webpackConfig;
    }
  };
}
export {
  withAllStak
};
//# sourceMappingURL=next.mjs.map