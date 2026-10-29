import { describe, it, expect, vi } from 'vitest';
import { createRxBridge, type TabTransport } from '../src/bridge.js';

function fakeTransport(over: Partial<TabTransport> = {}): TabTransport & {
  fetch: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    fetch: vi.fn(async () => ({ status: 200, body: '{"ok":true}', url: 'https://patient.rxlocal.com/api/x' })),
    server: { readLocalStorage: vi.fn(async () => ({ kc_authRes: '{"accessToken":"t"}' })) },
    ...over,
  } as never;
}

describe('createRxBridge', () => {
  it('relays a request through the tab: path + query, method, headers, body', async () => {
    const t = fakeTransport();
    const bridge = createRxBridge({ version: '0', createTransport: () => t });
    const res = await bridge.fetch('https://patient.rxlocal.com/api/refill/P-1/v2?a=1', {
      method: 'POST',
      headers: { authorization: 'Bearer t', portalid: 'X' },
      body: '{"b":2}',
    });
    expect(t.fetch).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/refill/P-1/v2?a=1',
      headers: { authorization: 'Bearer t', portalid: 'X' },
      body: '{"b":2}',
      retryOnTimeout: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('accepts a Headers instance and lets a GET keep the bridge default retry', async () => {
    const t = fakeTransport();
    const bridge = createRxBridge({ version: '0', createTransport: () => t });
    await bridge.fetch('https://patient.rxlocal.com/api/account/getuserinfo', {
      headers: new Headers({ Accept: 'application/json' }),
    });
    expect(t.fetch).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/account/getuserinfo',
      headers: { accept: 'application/json' },
    });
  });

  it('passes a 401 through as a 401 response', async () => {
    const t = fakeTransport({ fetch: vi.fn(async () => ({ status: 401, body: '', url: '' })) as never });
    const bridge = createRxBridge({ version: '0', createTransport: () => t });
    expect((await bridge.fetch('https://patient.rxlocal.com/api/x')).status).toBe(401);
  });

  it('returns a bodiless response for 204', async () => {
    const t = fakeTransport({ fetch: vi.fn(async () => ({ status: 204, body: '', url: '' })) as never });
    const bridge = createRxBridge({ version: '0', createTransport: () => t });
    const res = await bridge.fetch('https://patient.rxlocal.com/api/x');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('refuses any host other than patient.rxlocal.com', async () => {
    const t = fakeTransport();
    const bridge = createRxBridge({ version: '0', createTransport: () => t });
    await expect(bridge.fetch('https://evil.example/api/x')).rejects.toThrow(/patient\.rxlocal\.com/);
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it('does not send when the signal is already aborted', async () => {
    const t = fakeTransport();
    const bridge = createRxBridge({ version: '0', createTransport: () => t });
    const ac = new AbortController();
    ac.abort();
    await expect(bridge.fetch('https://patient.rxlocal.com/api/x', { signal: ac.signal })).rejects.toThrow();
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it('rejects a non-string body (the bridge relays text only)', async () => {
    const t = fakeTransport();
    const bridge = createRxBridge({ version: '0', createTransport: () => t });
    await expect(
      bridge.fetch('https://patient.rxlocal.com/api/x', { method: 'POST', body: new Uint8Array([1]) }),
    ).rejects.toThrow(/text/);
  });

  it('starts the transport once, and retries a failed start on the next call', async () => {
    let n = 0;
    const t = fakeTransport({
      start: vi.fn(async () => {
        if (n++ === 0) throw new Error('identity unreadable');
      }) as never,
    });
    const make = vi.fn(() => t);
    const bridge = createRxBridge({ version: '0', createTransport: make });
    await expect(bridge.fetch('https://patient.rxlocal.com/api/x')).rejects.toThrow(/identity/);
    await bridge.fetch('https://patient.rxlocal.com/api/x');
    await bridge.fetch('https://patient.rxlocal.com/api/x');
    expect(make).toHaveBeenCalledTimes(1);
    expect(t.start).toHaveBeenCalledTimes(2);
  });

  it('reads kc_authRes from the tab', async () => {
    const t = fakeTransport();
    const bridge = createRxBridge({ version: '0', createTransport: () => t });
    expect(await bridge.readAuthRes()).toBe('{"accessToken":"t"}');
    expect(t.server.readLocalStorage).toHaveBeenCalledWith({
      domain: 'rxlocal.com',
      subdomain: 'patient',
      keys: ['kc_authRes'],
    });
  });

  it('close() is a no-op before start and closes a started transport', async () => {
    const t = fakeTransport();
    const bridge = createRxBridge({ version: '0', createTransport: () => t });
    await bridge.close();
    expect(t.close).not.toHaveBeenCalled();
    await bridge.readAuthRes();
    await bridge.close();
    expect(t.close).toHaveBeenCalledTimes(1);
  });
});
