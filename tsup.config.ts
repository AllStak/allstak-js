import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    platform: 'browser',
    outDir: 'dist/browser',
    clean: true,
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    platform: 'node',
    outDir: 'dist/node',
    clean: true,
    define: {
      'globalThis.__ALLSTAK_NODE__': 'true',
    },
  },
]);
