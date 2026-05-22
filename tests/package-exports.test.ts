import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('package export contract', () => {
  it('keeps public subpath exports backed by tsup entrypoints', () => {
    const root = path.resolve(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const tsup = fs.readFileSync(path.join(root, 'tsup.config.ts'), 'utf8');

    const expected = [
      '.',
      './browser',
      './express',
      './cron',
      './db',
      './react',
      './react-native',
      './sourcemaps',
      './vite',
      './webpack',
      './next',
    ];

    expect(Object.keys(pkg.exports).sort()).toEqual(expected.sort());
    for (const subpath of expected) {
      const entryName = subpath === '.' || subpath === './browser'
        ? 'index'
        : subpath.slice(2);
      expect(tsup).toMatch(new RegExp(`['"]?${entryName}['"]?\\s*:`));
      expect(pkg.exports[subpath]).toMatchObject({
        types: expect.stringMatching(/^\.\/dist\/.+\.d\.ts$/),
        import: expect.stringMatching(/^\.\/dist\/.+\.mjs$/),
        require: expect.stringMatching(/^\.\/dist\/.+\.js$/),
      });
    }
  });

  it('does not expose undocumented runtime subpaths', () => {
    const root = path.resolve(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const exported = Object.keys(pkg.exports);

    expect(exported).not.toContain('./internal');
    expect(exported).not.toContain('./test');
    expect(exported).not.toContain('./src');
  });
});
