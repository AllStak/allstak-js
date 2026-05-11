import { defineConfig } from 'tsup';

// Banner for the Node ESM build: inject a real CJS-compatible `require`
// via createRequire. Without this, tsup's default __require polyfill just
// throws "Dynamic require of X is not supported" whenever the SDK tries
// to optional-require host deps like `pg`, `mysql2`, or `better-sqlite3`
// under ESM — silently disabling all DB auto-instrumentation.
const NODE_ESM_REQUIRE_BANNER = [
  "import { createRequire as __allstakCreateRequire } from 'node:module';",
  "const require = __allstakCreateRequire(import.meta.url);",
].join('\n');

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      express: 'src/integrations/express.ts',
      cron: 'src/integrations/cron.ts',
      db: 'src/integrations/db/index.ts',
      react: 'src/integrations/react.tsx',
      'react-native': 'src/integrations/react-native.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    platform: 'browser',
    outDir: 'dist/browser',
    clean: true,
    external: ['react', 'react-dom', 'react-native', 'promise/setimmediate/rejection-tracking'],
  },
  {
    entry: {
      index: 'src/index.ts',
      express: 'src/integrations/express.ts',
      cron: 'src/integrations/cron.ts',
      db: 'src/integrations/db/index.ts',
      // Build-time source-map tooling. Node-only — these entries must
      // never appear in the browser config above. Vite/Webpack/Next are
      // optional peer-deps and the plugin entries import them indirectly
      // through duck-typed config objects, so they're not bundled here.
      sourcemaps: 'src/sourcemaps/index.ts',
      vite: 'src/integrations/vite.ts',
      webpack: 'src/integrations/webpack.ts',
      next: 'src/integrations/next.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    platform: 'node',
    outDir: 'dist/node',
    clean: true,
    define: {
      'globalThis.__ALLSTAK_NODE__': 'true',
    },
    esbuildOptions(options, context) {
      if (context.format === 'esm') {
        options.banner = {
          js: NODE_ESM_REQUIRE_BANNER,
        };
      }
    },
  },
]);
