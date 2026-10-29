import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RxLocalClient } from '../src/client.js';
import { decodeJwtExpMs } from '../src/auth.js';

function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `h.${payload}.s`;
}

describe('decodeJwtExpMs', () => {
  it('reads exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    expect(decodeJwtExpMs(jwt(exp))).toBe(exp * 1000);
  });
  it('returns undefined for a malformed token', () => {
    expect(decodeJwtExpMs('not-a-jwt')).toBeUndefined();
  });
});

describe('RxLocalClient token cache', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('getuserinfo')) {
        return new Response(JSON.stringify({ rxLocalPatientID: 'P-1', globalUserID: 'U-1' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('coalesces concurrent token resolves into one call', async () => {
    const resolve = vi.fn(async () => ({
      token: jwt(Math.floor(Date.now() / 1000) + 300),
      source: 'fetchproxy' as const,
      expiresAt: new Date(Date.now() + 300_000),
    }));
    const client = new RxLocalClient({ resolveAuth: resolve });
    await Promise.all([client.getUserInfo(), client.getAge(), client.getLegal('termsofuse')]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('re-resolves after the cached token nears expiry', async () => {
    let n = 0;
    const resolve = vi.fn(async () => {
      n += 1;
      // first token already within the 60s skew → forces a re-resolve next call
      const exp = Math.floor(Date.now() / 1000) + (n === 1 ? 30 : 300);
      return { token: jwt(exp), source: 'fetchproxy' as const, expiresAt: new Date(exp * 1000) };
    });
    const client = new RxLocalClient({ resolveAuth: resolve });
    await client.getAge();
    await client.getAge();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('builds the /api base path (keeps /api segment)', async () => {
    const resolve = async () => ({
      token: jwt(Math.floor(Date.now() / 1000) + 300), source: 'fetchproxy' as const,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const client = new RxLocalClient({ resolveAuth: resolve });
    await client.getAge();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe('https://patient.rxlocal.com/api/account/accountholderage');
  });

  it('credentialStatus reports the source without the token value', async () => {
    const resolve = async () => ({
      token: jwt(Math.floor(Date.now() / 1000) + 300), source: 'fetchproxy' as const,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const client = new RxLocalClient({ resolveAuth: resolve });
    const status = await client.credentialStatus();
    expect(status.source).toBe('fetchproxy');
    expect(JSON.stringify(status)).not.toContain('eyJ');
  });
});
