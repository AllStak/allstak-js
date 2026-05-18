import { createRequire as __allstakCreateRequire } from 'node:module';
const require = __allstakCreateRequire(import.meta.url);
import {
  processBuildOutput
} from "./chunk-OAYU6RNO.mjs";

// src/integrations/webpack.ts
var AllStakWebpackPlugin = class {
  constructor(opts = {}) {
    this.opts = opts;
    /** Last successful report — exposed for tests / programmatic inspection. */
    this.lastReport = null;
  }
  apply(compiler) {
    if (this.opts.disabled) return;
    compiler.hooks.afterEmit.tapPromise("AllStakWebpackPlugin", async (compilation) => {
      const dir = this.opts.dir ?? compilation.compiler?.outputPath ?? compiler.outputPath ?? compiler.options?.output?.path ?? process.cwd();
      try {
        this.lastReport = await processBuildOutput({
          ...this.opts,
          dir,
          silent: this.opts.silent ?? false
        });
      } catch (e) {
        console.error(`[allstak/webpack] failed: ${e.message}`);
      }
    });
  }
};

export {
  AllStakWebpackPlugin
};
//# sourceMappingURL=chunk-MF3YILRX.mjs.map