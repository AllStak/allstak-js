import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SDK_VERSION } from '../src/client';

describe('Version consistency', () => {
  it('SDK_VERSION matches package.json version', () => {
    const pkgPath = resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
