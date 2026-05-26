import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseGitRelease,
  detectGitRelease,
  __resetGitReleaseCacheForTest,
  isNodeRuntime,
  type GitRunner,
} from '../src/release-detect';
import { applyReleaseAutodetect, SDK_VERSION, type AllStakConfig } from '../src/client';

/** Build a fake git runner from a map of joined-args → output. */
function fakeRunner(map: Record<string, string>): GitRunner {
  return (args) => {
    const key = args.join(' ');
    if (!(key in map)) return '';
    return map[key];
  };
}

const DESCRIBE = 'describe --tags --always --dirty';
const REVPARSE = 'rev-parse --short HEAD';
const STATUS = 'status --porcelain';

// vitest may run under `npm`/`pnpm`, which sets `npm_package_version` — that
// would be picked up by the env-var step and mask the git/version-fallback
// behavior these tests assert. Stash + clear it around the whole suite, and
// restore afterward.
let savedNpmVersion: string | undefined;
beforeEach(() => {
  __resetGitReleaseCacheForTest();
  savedNpmVersion = process.env.npm_package_version;
  delete process.env.npm_package_version;
});
afterEach(() => {
  __resetGitReleaseCacheForTest();
  if (savedNpmVersion === undefined) delete process.env.npm_package_version;
  else process.env.npm_package_version = savedNpmVersion;
});

describe('parseGitRelease (pure)', () => {
  it('prefers git describe output (tag form)', () => {
    expect(parseGitRelease('v1.2.3', 'abc1234', '')).toBe('v1.2.3');
  });

  it('uses describe with commit-distance + dirty suffix verbatim', () => {
    expect(parseGitRelease('v1.2.3-4-gabc1234-dirty')).toBe('v1.2.3-4-gabc1234-dirty');
  });

  it('falls back to short sha when describe empty', () => {
    expect(parseGitRelease('', 'abc1234', '')).toBe('abc1234');
  });

  it('appends -dirty to sha fallback when porcelain non-empty', () => {
    expect(parseGitRelease(undefined, 'abc1234', ' M src/x.ts')).toBe('abc1234-dirty');
  });

  it('does NOT append -dirty when porcelain is blank', () => {
    expect(parseGitRelease(undefined, 'abc1234', '   \n  ')).toBe('abc1234');
  });

  it('returns undefined when nothing usable', () => {
    expect(parseGitRelease('', '', '')).toBeUndefined();
    expect(parseGitRelease(undefined, undefined, undefined)).toBeUndefined();
  });

  it('trims and takes the first line only', () => {
    expect(parseGitRelease('v9.9.9\nextra')).toBe('v9.9.9');
    expect(parseGitRelease('   v9.9.9  \n')).toBe('v9.9.9');
  });
});

describe('detectGitRelease (seamed runner)', () => {
  it('returns describe output via injected runner', () => {
    const run = fakeRunner({ [DESCRIBE]: 'v2.0.0-dirty' });
    expect(detectGitRelease(run)).toBe('v2.0.0-dirty');
  });

  it('falls back to sha+dirty when describe yields nothing', () => {
    const run = fakeRunner({ [DESCRIBE]: '', [REVPARSE]: 'deadbee', [STATUS]: ' M a.ts' });
    expect(detectGitRelease(run)).toBe('deadbee-dirty');
  });

  it('is graceful when the runner throws', () => {
    const run: GitRunner = () => { throw new Error('git not found'); };
    expect(detectGitRelease(run)).toBeUndefined();
  });

  it('is graceful when the runner returns empty (no git / no .git)', () => {
    expect(detectGitRelease(fakeRunner({}))).toBeUndefined();
  });

  it('skips cleanly when runner is null (browser/RN guard)', () => {
    expect(detectGitRelease(null)).toBeUndefined();
  });

  it('caches the result (runner invoked once across calls)', () => {
    let calls = 0;
    const run: GitRunner = (args) => { calls++; return args[0] === 'describe' ? 'v3.3.3' : ''; };
    expect(detectGitRelease(run)).toBe('v3.3.3');
    expect(detectGitRelease(run)).toBe('v3.3.3');
    expect(calls).toBe(1);
  });
});

describe('isNodeRuntime guard (jsdom => browser-like)', () => {
  it('reports false under jsdom (window is defined)', () => {
    // vitest runs with environment: jsdom, so window exists → not Node runtime.
    expect(isNodeRuntime()).toBe(false);
  });
});

describe('applyReleaseAutodetect resolution order', () => {
  it('1. explicit release always wins', () => {
    const cfg: AllStakConfig = { apiKey: 'k', release: 'my-explicit', autoDetectRelease: true };
    applyReleaseAutodetect(cfg, fakeRunner({ [DESCRIBE]: 'v9.9.9' }));
    expect(cfg.release).toBe('my-explicit');
  });

  it('2. env var beats git + version', () => {
    process.env.ALLSTAK_RELEASE = 'env-release';
    try {
      const cfg: AllStakConfig = { apiKey: 'k' };
      applyReleaseAutodetect(cfg, fakeRunner({ [DESCRIBE]: 'v9.9.9' }));
      expect(cfg.release).toBe('env-release');
    } finally {
      delete process.env.ALLSTAK_RELEASE;
    }
  });

  it('3. git beats version fallback when no explicit/env', () => {
    const cfg: AllStakConfig = { apiKey: 'k' };
    applyReleaseAutodetect(cfg, fakeRunner({ [DESCRIBE]: 'v7.7.7' }));
    expect(cfg.release).toBe('v7.7.7');
  });

  it('4. SDK version fallback when git yields nothing', () => {
    const cfg: AllStakConfig = { apiKey: 'k' };
    applyReleaseAutodetect(cfg, fakeRunner({}));
    expect(cfg.release).toBe(SDK_VERSION);
  });

  it('opt-out: autoDetectRelease=false disables git AND version fallback', () => {
    const cfg: AllStakConfig = { apiKey: 'k', autoDetectRelease: false };
    applyReleaseAutodetect(cfg, fakeRunner({ [DESCRIBE]: 'v7.7.7' }));
    expect(cfg.release).toBeUndefined();
  });

  it('opt-out still honors env vars', () => {
    process.env.ALLSTAK_RELEASE = 'env-only';
    try {
      const cfg: AllStakConfig = { apiKey: 'k', autoDetectRelease: false };
      applyReleaseAutodetect(cfg, fakeRunner({ [DESCRIBE]: 'v7.7.7' }));
      expect(cfg.release).toBe('env-only');
    } finally {
      delete process.env.ALLSTAK_RELEASE;
    }
  });

  it('browser/RN guard: a null runner falls through env→version', () => {
    const cfg: AllStakConfig = { apiKey: 'k' };
    applyReleaseAutodetect(cfg, null);
    expect(cfg.release).toBe(SDK_VERSION);
  });
});
