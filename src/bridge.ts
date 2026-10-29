// The browser bridge: reads the signed-in tab's session, nothing more.
//
// Patient data (prescriptions, messages) needs three things together: the
// short-lived Keycloak bearer (`localStorage.kc_authRes`), the SPA's public
// `portalid` header (client.ts), and the tab's `session-id` cookie. Without the
// cookie those endpoints answer 401 while `account/getuserinfo` passes. Verified
// live 2026-10-29 from Node: same bearer + header, no cookie → 401, with the
// tab's `session-id` → 200.
//
// The cookie is READ from the tab, never minted. `PUT auth/session` (the SPA's
// createSession) hands out a fresh `session-id`, but the portal keeps one
// session per user: minting one from Node signed the browser tab out (seen live
// 2026-10-29). Never call it from this server.

import { parseCookieHeader } from '@chrischall/mcp-utils';

const DOMAIN = 'rxlocal.com';
const SUBDOMAIN = 'patient';
export const AUTH_KEY = 'kc_authRes';
export const SESSION_COOKIE = 'session-id';

/** The slice of the mcp-utils fetchproxy transport this module uses. */
export interface TabTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  server: {
    readLocalStorage(opts: { domain?: string; subdomain?: string; keys: string[] }): Promise<Record<string, string>>;
    readCookies(opts: { domain?: string; subdomain?: string; keys?: string[] }): Promise<string>;
  };
}

/** What the signed-in tab holds; either may be absent (signed out, mid-login). */
export interface TabSession {
  /** Raw `localStorage.kc_authRes` (JSON string). */
  authRes?: string;
  /** The `session-id` cookie value. */
  sessionId?: string;
}

export interface RxBridge {
  readSession(): Promise<TabSession>;
  close(): Promise<void>;
}

export interface RxBridgeOptions {
  serverName?: string;
  version: string;
  /** Test seam; the real mcp-utils fetchproxy transport otherwise. */
  createTransport?: () => TabTransport | Promise<TabTransport>;
}

/* v8 ignore start -- the real transport is exercised live, not under vitest */
async function defaultTransport(serverName: string, version: string): Promise<TabTransport> {
  // Lazy: @fetchproxy/server loads only when a tool first needs the bridge.
  const fp = await import('@chrischall/mcp-utils/fetchproxy');
  return fp.createFetchproxyTransport<TabTransport>({
    serverName,
    version,
    defaultSubdomain: SUBDOMAIN,
    ...fp.createBootstrapOpts({
      domains: [DOMAIN],
      bootstrap: { localStorageKeys: [AUTH_KEY], cookieKeys: [SESSION_COOKIE] },
    }),
  });
}
/* v8 ignore stop */

export function createRxBridge(opts: RxBridgeOptions): RxBridge {
  const serverName = opts.serverName ?? 'rxlocal-mcp';
  /* v8 ignore next */
  const make = opts.createTransport ?? (() => defaultTransport(serverName, opts.version));
  let built: Promise<TabTransport> | undefined;
  let started: Promise<TabTransport> | undefined;

  // Build once; start single-flight, forgetting a failed start so the next call retries it.
  const ready = (): Promise<TabTransport> =>
    (started ??= (built ??= Promise.resolve().then(make))
      .then(async (t) => {
        await t.start();
        return t;
      })
      .catch((e: unknown) => {
        started = undefined;
        throw e;
      }));

  return {
    async readSession() {
      const t = await ready();
      const [ls, cookieHeader] = await Promise.all([
        t.server.readLocalStorage({ domain: DOMAIN, subdomain: SUBDOMAIN, keys: [AUTH_KEY] }),
        t.server.readCookies({ domain: DOMAIN, subdomain: SUBDOMAIN, keys: [SESSION_COOKIE] }),
      ]);
      const sessionId = parseCookieHeader(cookieHeader ?? '')[SESSION_COOKIE];
      return {
        ...(ls[AUTH_KEY] ? { authRes: ls[AUTH_KEY] } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
    },
    async close() {
      const t = await started?.catch(() => undefined);
      await t?.close();
    },
  };
}
