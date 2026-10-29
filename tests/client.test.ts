import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WriteOutcomeUnknownError } from '@chrischall/mcp-utils';
import { RxLocalClient, PORTAL_ID } from '../src/client.js';
import { decodeJwtExpMs } from '../src/auth.js';

/** Defer to the (stubbed) global fetch at call time. */
const viaGlobalFetch: typeof fetch = (input, init) => fetch(input, init);

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
    const client = new RxLocalClient({ fetchImpl: viaGlobalFetch, resolveAuth: resolve });
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
    const client = new RxLocalClient({ fetchImpl: viaGlobalFetch, resolveAuth: resolve });
    await client.getAge();
    await client.getAge();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('builds the /api base path (keeps /api segment)', async () => {
    const resolve = async () => ({
      token: jwt(Math.floor(Date.now() / 1000) + 300), source: 'fetchproxy' as const,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const client = new RxLocalClient({ fetchImpl: viaGlobalFetch, resolveAuth: resolve });
    await client.getAge();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe('https://patient.rxlocal.com/api/account/accountholderage');
  });

  it('credentialStatus reports the source without the token value', async () => {
    const resolve = async () => ({
      token: jwt(Math.floor(Date.now() / 1000) + 300), source: 'fetchproxy' as const,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const client = new RxLocalClient({ fetchImpl: viaGlobalFetch, resolveAuth: resolve });
    const status = await client.credentialStatus();
    expect(status.source).toBe('fetchproxy');
    expect(JSON.stringify(status)).not.toContain('eyJ');
  });
});

describe('RxLocalClient headers and the single-attempt write path', () => {
  const tok = () => ({
    token: jwt(Math.floor(Date.now() / 1000) + 300), source: 'fetchproxy' as const,
    expiresAt: new Date(Date.now() + 300_000),
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const headerOf = (call: unknown[], name: string) => new Headers((call[1] as RequestInit).headers).get(name);
  let fetchMock: ReturnType<typeof vi.fn>;
  afterEach(() => vi.unstubAllGlobals());

  function withFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
    fetchMock = vi.fn(async (url: string, init: RequestInit) => impl(String(url), init));
    vi.stubGlobal('fetch', fetchMock);
  }

  it('sends the public portalid header on every request, reads and writes alike', async () => {
    withFetch((url) => (url.includes('getuserinfo')
      ? json({ rxLocalPatientID: 'P-1', globalUserID: 'U-1', firstName: 'Jane', lastName: 'Doe', primaryDataExchangeIdentifier: 'DEI-1' })
      : json([])));
    const client = new RxLocalClient({ fetchImpl: viaGlobalFetch, resolveAuth: async () => tok() });
    const ctx = await client.accountContext();
    expect(ctx).toEqual({ groupOwnerID: 'P-1', rxLocalPatientID: 'P-1', dataExchangeIdentifier: 'DEI-1', userId: 'U-1', displayName: 'Jane Doe' });
    await client.getAge();
    await client.getRefills('P-1', 'U-1');
    await client.getConveyanceOptions('DEI-1', 'P-1', 'P-1', 'U-1');
    await client.syncMessages(ctx);
    await client.requestRefills('P-1', 'U-1', { Requests: [] });
    await client.createMessage({ Body: 'x' });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    for (const call of fetchMock.mock.calls) {
      expect(headerOf(call, 'portalid')).toBe(PORTAL_ID);
      expect(headerOf(call, 'authorization')).toMatch(/^Bearer /);
    }
    expect(PORTAL_ID).toBe('370549AF-06A2-4E64-B17D-4040EF57D233');
  });

  it('builds the patient-data paths, query and rxlocaluserid header the SPA uses', async () => {
    withFetch(() => json({}));
    const client = new RxLocalClient({ fetchImpl: viaGlobalFetch, resolveAuth: async () => tok() });
    await client.getRefills('P-1', 'U-1');
    await client.getConveyanceOptions('DEI-1', 'P-1', 'P-2', 'U-1');
    await client.syncMessages({ groupOwnerID: 'P-1', rxLocalPatientID: 'P-1', dataExchangeIdentifier: undefined });
    await client.requestRefills('P-1', 'U-1', { Requests: [1] });
    await client.createMessage({ Body: 'x' });
    const [refills, options, messages, refillPost, msgPost] = fetchMock.mock.calls;
    expect(refills![0]).toBe('https://patient.rxlocal.com/api/refill/P-1/v2');
    expect(headerOf(refills!, 'rxlocaluserid')).toBe('U-1');
    expect(options![0]).toBe('https://patient.rxlocal.com/api/refill/location/DEI-1/conveyanceOptions?groupOwnerID=P-1&rxlocalPatientID=P-2');
    expect(headerOf(options!, 'rxlocaluserid')).toBe('U-1');
    expect(messages![0]).toBe('https://patient.rxlocal.com/api/Messaging/SyncPatientMessages');
    expect(JSON.parse(String((messages![1] as RequestInit).body))).toEqual({
      GroupOwnerID: 'P-1', RxLocalPatientID: 'P-1', DataExchangeIdentifier: null, EndDate: null,
      GetXMostRecentMessagesForDateRange: true, IsFirstDownloadOfMessages: false,
    });
    expect(refillPost![0]).toBe('https://patient.rxlocal.com/api/refill/P-1/v1');
    expect((refillPost![1] as RequestInit).method).toBe('POST');
    expect(headerOf(refillPost!, 'rxlocaluserid')).toBe('U-1');
    expect(msgPost![0]).toBe('https://patient.rxlocal.com/api/Messaging/CreatePatientMessage');
  });

  it('accountContext leaves a blank location undefined', async () => {
    withFetch(() => json({ rxLocalPatientID: 'P-1', globalUserID: 'U-1', primaryDataExchangeIdentifier: '' }));
    const client = new RxLocalClient({ fetchImpl: viaGlobalFetch, resolveAuth: async () => tok() });
    expect(await client.accountContext()).toMatchObject({ dataExchangeIdentifier: undefined, displayName: '' });
  });

  it('a write answered 401 is sent once: no token re-read, no replay', async () => {
    withFetch(() => json({ title: 'Unauthorized' }, 401));
    const resolve = vi.fn(async () => tok());
    const client = new RxLocalClient({ fetchImpl: viaGlobalFetch, resolveAuth: resolve });
    await expect(client.requestRefills('P-1', 'U-1', {})).rejects.toThrow(/401.*nothing was sent/);
    await expect(client.createMessage({})).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('a write answered 429 is not retried', async () => {
    withFetch(() => json({}, 429));
    const client = new RxLocalClient({ fetchImpl: viaGlobalFetch, resolveAuth: async () => tok() });
    await expect(client.createMessage({})).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a write answered 5xx or dropped is WriteOutcomeUnknownError, never retried', async () => {
    withFetch(() => json({}, 502));
    const client = new RxLocalClient({ fetchImpl: viaGlobalFetch, resolveAuth: async () => tok() });
    await expect(client.requestRefills('P-1', 'U-1', {})).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    withFetch(() => { throw new TypeError('fetch failed'); });
    const fresh = new RxLocalClient({ fetchImpl: viaGlobalFetch, resolveAuth: async () => tok() });
    await expect(fresh.createMessage({})).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the messages read is a POST but not a write: a 5xx is a plain error', async () => {
    withFetch(() => json({}, 502));
    const client = new RxLocalClient({ fetchImpl: viaGlobalFetch, resolveAuth: async () => tok() });
    const err = await client.syncMessages({ groupOwnerID: 'P-1', rxLocalPatientID: 'P-1', dataExchangeIdentifier: 'D' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
  });
});
