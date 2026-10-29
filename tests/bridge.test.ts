import { describe, it, expect, vi } from 'vitest';
import { createRxBridge, type TabTransport } from '../src/bridge.js';

function fakeTransport(over: Partial<TabTransport['server']> = {}, start?: () => Promise<void>): TabTransport & {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(start ?? (async () => {})),
    close: vi.fn(async () => {}),
    server: {
      readLocalStorage: vi.fn(async () => ({ kc_authRes: '{"accessToken":"t"}' })),
      readCookies: vi.fn(async () => 'session-id=S-1'),
      ...over,
    },
  } as never;
}

describe('createRxBridge', () => {
  it('reads kc_authRes and the session-id cookie from the tab', async () => {
    const t = fakeTransport();
    const bridge = createRxBridge({ version: '0', createTransport: () => t });
    expect(await bridge.readSession()).toEqual({ authRes: '{"accessToken":"t"}', sessionId: 'S-1' });
    expect(t.server.readLocalStorage).toHaveBeenCalledWith({
      domain: 'rxlocal.com',
      subdomain: 'patient',
      keys: ['kc_authRes'],
    });
    expect(t.server.readCookies).toHaveBeenCalledWith({
      domain: 'rxlocal.com',
      subdomain: 'patient',
      keys: ['session-id'],
    });
  });

  it('omits what the tab does not hold', async () => {
    const t = fakeTransport({
      readLocalStorage: vi.fn(async () => ({})),
      readCookies: vi.fn(async () => ''),
    });
    const bridge = createRxBridge({ version: '0', createTransport: () => t });
    expect(await bridge.readSession()).toEqual({});
  });

  it('starts the transport once, and retries a failed start on the next call', async () => {
    let n = 0;
    const t = fakeTransport({}, async () => {
      if (n++ === 0) throw new Error('identity unreadable');
    });
    const make = vi.fn(() => t);
    const bridge = createRxBridge({ version: '0', createTransport: make });
    await expect(bridge.readSession()).rejects.toThrow(/identity/);
    await bridge.readSession();
    await bridge.readSession();
    expect(make).toHaveBeenCalledTimes(1);
    expect(t.start).toHaveBeenCalledTimes(2);
  });

  it('close() is a no-op before start and closes a started transport', async () => {
    const t = fakeTransport();
    const bridge = createRxBridge({ version: '0', createTransport: () => t });
    await bridge.close();
    expect(t.close).not.toHaveBeenCalled();
    await bridge.readSession();
    await bridge.close();
    expect(t.close).toHaveBeenCalledTimes(1);
  });
});
