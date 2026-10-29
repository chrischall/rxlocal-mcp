import { describe, it, expect, vi, afterEach } from 'vitest';

const readMock = vi.fn();
vi.mock('@chrischall/mcp-utils/fetchproxy', () => ({
  classifyBridgeError: (e: unknown) => ((e as { _down?: boolean })?._down ? 'bridge_down' : 'other'),
}));

import { resolveAuth, NO_AUTH_CONFIGURED, isNoAuthConfigured, isBridgeDown, BRIDGE_DOWN_PREFIX } from '../src/auth.js';

function jwt(expSeconds: number): string {
  return `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.s`;
}

afterEach(() => {
  readMock.mockReset();
  delete process.env.RXLOCAL_DISABLE_FETCHPROXY;
});

describe('resolveAuth', () => {
  it('reads accessToken from kc_authRes and decodes exp', async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    readMock.mockResolvedValue({ authRes: JSON.stringify({ accessToken: jwt(exp) }), sessionId: 'S-1' });
    const r = await resolveAuth(readMock);
    expect(r.source).toBe('fetchproxy');
    expect(r.expiresAt?.getTime()).toBe(exp * 1000);
    expect(r.sessionId).toBe('S-1');
  });

  it('throws NO_AUTH_CONFIGURED when disabled', async () => {
    process.env.RXLOCAL_DISABLE_FETCHPROXY = '1';
    await expect(resolveAuth(readMock)).rejects.toThrow(NO_AUTH_CONFIGURED);
    expect(isNoAuthConfigured(new Error(NO_AUTH_CONFIGURED))).toBe(true);
  });

  it('maps a bridge-down failure to the BRIDGE_DOWN prefix', async () => {
    readMock.mockRejectedValue(Object.assign(new Error('sw gone'), { _down: true, hint: 'click the icon' }));
    await expect(resolveAuth(readMock)).rejects.toThrow(BRIDGE_DOWN_PREFIX);
    expect(isBridgeDown(new Error(`${BRIDGE_DOWN_PREFIX} x`))).toBe(true);
  });

  it('throws a pointed error when kc_authRes is missing', async () => {
    readMock.mockResolvedValue({ sessionId: 'S-1' });
    await expect(resolveAuth(readMock)).rejects.toThrow(/kc_authRes.*missing/i);
  });

  it('throws a pointed error when the session-id cookie is missing', async () => {
    readMock.mockResolvedValue({ authRes: JSON.stringify({ accessToken: jwt(Math.floor(Date.now() / 1000) + 300) }) });
    await expect(resolveAuth(readMock)).rejects.toThrow(/session-id.*missing/i);
  });

  it('throws when kc_authRes has no accessToken', async () => {
    readMock.mockResolvedValue({ authRes: JSON.stringify({ refreshToken: 'r' }), sessionId: 'S-1' });
    await expect(resolveAuth(readMock)).rejects.toThrow(/no accessToken/i);
  });
});
