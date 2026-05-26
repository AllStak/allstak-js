import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AllStak,
  _resetRuntimeReleaseRegistrationForTest,
  registerRuntimeRelease,
} from '../src';

afterEach(() => {
  AllStak.destroy();
  _resetRuntimeReleaseRegistrationForTest();
  vi.restoreAllMocks();
});

describe('runtime release registration', () => {
  it('posts the resolved release once from the server runtime', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true })) as any;
    vi.stubGlobal('fetch', fetchSpy);

    AllStak.init({
      apiKey: 'ask_test',
      host: 'https://api.example.test',
      environment: 'production',
      release: 'web@1.2.3',
      autoRegisterRelease: true,
    });
    AllStak.init({
      apiKey: 'ask_test',
      host: 'https://api.example.test',
      environment: 'production',
      release: 'web@1.2.3',
      autoRegisterRelease: true,
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.test/ingest/v1/releases',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-AllStak-Key': 'ask_test' }),
        body: expect.stringContaining('"version":"web@1.2.3"'),
      }),
    );
  });

  it('can be disabled explicitly', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true })) as any;
    vi.stubGlobal('fetch', fetchSpy);

    AllStak.init({
      apiKey: 'ask_test',
      host: 'https://api.example.test',
      release: 'web@1.2.3',
      autoRegisterRelease: false,
    });

    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows manual registration for framework wrappers', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true })) as any;
    registerRuntimeRelease({
      host: 'https://api.example.test/',
      apiKey: 'ask_test',
      environment: 'staging',
      release: 'api@2.0.0',
      commitSha: 'abc123',
      enabled: true,
      fetchImpl: fetchSpy,
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({
      version: 'api@2.0.0',
      environment: 'staging',
      commitSha: 'abc123',
    });
  });
});
