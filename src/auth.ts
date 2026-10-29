// Auth resolution for RxLocal.
//
// RxLocal Patient (PioneerRx / RedSail) is a single-page app whose `/api`
// backend is a Keycloak-protected Bearer API. There is NO env-var credential
// format and no server-side password login, so the only auth path is the
// browser bridge: read the access token the signed-in SPA holds in
// `localStorage.kc_authRes` and the tab's `session-id` cookie, then call the
// API from Node. Patient data needs the bearer, the SPA's public `portalid`
// header AND that cookie (see bridge.ts).
//
// The token is short-lived (~5 min) and the running SPA refreshes it, so each
// renewal re-runs this read rather than doing an OAuth refresh grant (which
// would rotate RedSail's refresh token and risk signing the user out).

import { parseBoolEnv } from '@chrischall/mcp-utils';
import type { TabSession } from './bridge.js';
import { classifyBridgeError, type FetchproxyBridgeDownError } from '@chrischall/mcp-utils/fetchproxy';

/** Result of resolving auth. `source` is for diagnostics only. */
export interface ResolvedAuth {
  token: string;
  /** The tab's `session-id` cookie, sent as `Cookie` on every call. */
  sessionId: string;
  /** Best-effort expiry decoded from the access token's `exp` claim. */
  expiresAt?: Date;
  source: 'fetchproxy';
}

/** True if the user has disabled the fetchproxy path. */
function fetchproxyDisabled(): boolean {
  return parseBoolEnv('RXLOCAL_DISABLE_FETCHPROXY');
}

/**
 * Message raised when the one auth path is turned off. Exported with
 * {@link isNoAuthConfigured} so the healthcheck can tell "nothing is set up"
 * apart from "the bridge is down" — the two need opposite advice.
 */
export const NO_AUTH_CONFIGURED =
  'RxLocal auth: install ContextMint Bridge and sign into patient.rxlocal.com ' +
  '(RXLOCAL_DISABLE_FETCHPROXY is set — unset it to enable session capture).';

/** Prefix of the bridge-unreachable message (the upstream `.hint` is appended). */
export const BRIDGE_DOWN_PREFIX = 'RxLocal auth: ContextMint Bridge is down';

export function isBridgeDown(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith(BRIDGE_DOWN_PREFIX);
}
export function isNoAuthConfigured(e: unknown): boolean {
  return e instanceof Error && e.message === NO_AUTH_CONFIGURED;
}

/** Decode a JWT's `exp` (seconds) without verifying. Returns undefined on any failure. */
export function decodeJwtExpMs(jwt: string): number | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the RxLocal access token and session cookie from the signed-in browser tab. Throws
 * {@link NO_AUTH_CONFIGURED} when disabled, {@link BRIDGE_DOWN_PREFIX} when the
 * extension is unreachable, and a pointed error when the tab holds no token.
 */
export async function resolveAuth(readSession: () => Promise<TabSession>): Promise<ResolvedAuth> {
  if (fetchproxyDisabled()) throw new Error(NO_AUTH_CONFIGURED);
  let session: TabSession;
  try {
    session = await readSession();
  } catch (e) {
    if (classifyBridgeError(e) === 'bridge_down') {
      const down = e as FetchproxyBridgeDownError;
      throw new Error(`${BRIDGE_DOWN_PREFIX} (extension service worker unreachable after retry). ${down.hint}`);
    }
    throw new Error(`RxLocal auth: reading the signed-in tab failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const raw = session.authRes;
  if (!raw) {
    throw new Error(
      'localStorage["kc_authRes"] missing on patient.rxlocal.com. ' +
        'Sign into RxLocal in your browser (with ContextMint Bridge installed) and keep the tab open, then retry.',
    );
  }
  let token: string | undefined;
  try {
    token = (JSON.parse(raw) as { accessToken?: string }).accessToken;
  } catch {
    throw new Error('kc_authRes on patient.rxlocal.com is not valid JSON — reload the signed-in tab and retry.');
  }
  if (!token) {
    throw new Error('kc_authRes has no accessToken — reload the signed-in RxLocal tab and retry.');
  }
  if (!session.sessionId) {
    throw new Error(
      'The session-id cookie is missing on patient.rxlocal.com (prescriptions and messages need it). ' +
        'Reload your signed-in RxLocal tab, then retry.',
    );
  }
  const expMs = decodeJwtExpMs(token);
  return { token, sessionId: session.sessionId, source: 'fetchproxy', ...(expMs ? { expiresAt: new Date(expMs) } : {}) };
}
