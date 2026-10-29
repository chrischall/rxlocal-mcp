// The browser bridge, used for EVERY RxLocal call.
//
// The bearer alone is not enough: the patient-data endpoints (prescriptions,
// messages) also need the portal's own session cookies — the SPA's axios sends
// `withCredentials: true` — and the one that matters is HttpOnly, so it cannot
// be read and replayed from Node. Verified live 2026-10-29: the same fresh
// bearer + `portalid` from the tab answers 200 with the browser's cookies and
// 401 without them (`credentials: 'omit'`), while `account/getuserinfo` passes
// either way. So requests are relayed through the signed-in tab, which attaches
// its own cookies; this server never holds them.
//
// `fetch` is a `typeof fetch` so it plugs into createApiClient's `fetchImpl`,
// keeping its retry, redirect and write-outcome semantics unchanged.

import type { FetchproxyFetchInit } from '@chrischall/mcp-utils/fetchproxy';

const HOST = 'patient.rxlocal.com';
const DOMAIN = 'rxlocal.com';
const SUBDOMAIN = 'patient';
const AUTH_KEY = 'kc_authRes';

/** The slice of the mcp-utils fetchproxy transport this module uses. */
export interface TabTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  fetch(init: FetchproxyFetchInit): Promise<{ status: number; body: string; url: string }>;
  server: {
    readLocalStorage(opts: { domain?: string; subdomain?: string; keys: string[] }): Promise<Record<string, string>>;
  };
}

export interface RxBridge {
  /** The raw `localStorage.kc_authRes` of the signed-in tab, or undefined when absent. */
  readAuthRes(): Promise<string | undefined>;
  /** A fetch that runs inside the signed-in tab (same-origin, so it carries the tab's cookies). */
  fetch: typeof fetch;
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
    ...fp.createBootstrapOpts({ domains: [DOMAIN], bootstrap: { localStorageKeys: [AUTH_KEY] } }),
  });
}
/* v8 ignore stop */

function headerRecord(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...h };
}

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

  const bridgeFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== HOST) throw new Error(`RxLocal bridge only relays requests to ${HOST}, not ${url.host}.`);
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
      throw new Error('RxLocal bridge relays text bodies only.');
    }
    init.signal?.throwIfAborted();
    const method = (init.method ?? 'GET').toUpperCase() as FetchproxyFetchInit['method'];
    const t = await ready();
    init.signal?.throwIfAborted();
    const req: FetchproxyFetchInit = {
      method,
      path: url.pathname + url.search,
      headers: headerRecord(init.headers),
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      // A POST may be a write: never re-send it after a bridge timeout.
      ...(method === 'GET' ? {} : { retryOnTimeout: false }),
    };
    const res = await t.fetch(req);
    const bodiless = res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(bodiless ? null : res.body, {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    async readAuthRes() {
      const t = await ready();
      const ls = await t.server.readLocalStorage({ domain: DOMAIN, subdomain: SUBDOMAIN, keys: [AUTH_KEY] });
      return ls[AUTH_KEY];
    },
    fetch: bridgeFetch as typeof fetch,
    async close() {
      const t = await started?.catch(() => undefined);
      await t?.close();
    },
  };
}
