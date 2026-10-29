import { createApiClient, type ApiClient, loadDotenvSafely } from '@chrischall/mcp-utils';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveAuth, type ResolvedAuth } from './auth.js';
import { SERVER_NAME } from './version.js';

try {
  const dir = dirname(fileURLToPath(import.meta.url));
  await loadDotenvSafely({ path: join(dir, '..', '.env') });
} catch {
  // .env is optional; this server's only auth path is the browser bridge.
}

export const BASE_URL = 'https://patient.rxlocal.com/api';
/** Re-read the token this many ms before its `exp` to avoid a mid-call expiry. */
const TOKEN_SKEW_MS = 60_000;
/** Fallback lifetime when the token carries no decodable `exp`. */
const TOKEN_FALLBACK_TTL_MS = 120_000;

export interface UserInfo {
  globalUserID: string;
  userName: string;
  firstName: string;
  lastName: string;
  emailAddress: string;
  smsPhone: string;
  accountType: number;
  rxLocalPatientID: string;
  primaryPersonID: string;
  roles: string[];
  entityStatus: string;
  passwordExpired: boolean;
  termsAcceptanceRequired: boolean;
}

export interface AgeGate {
  underMinimumAge: boolean;
  minimumAge: number;
}

export interface Notification {
  messageType: number;
}

export interface LegalDoc {
  id: number;
  content: string;
  userAcceptanceRequired?: boolean;
  createdOn?: string;
  updatedOn?: string;
}

export type LegalKind = 'termsofuse' | 'privacypolicy';

export interface CredentialStatus {
  source: ResolvedAuth['source'];
  expiresAt?: Date;
}

/**
 * RxLocal API client. The bearer is read from the signed-in browser tab
 * (see {@link resolveAuth}) and cached until just before its `exp`; a single
 * in-flight resolve is shared across concurrent callers.
 */
export class RxLocalClient {
  private readonly api: ApiClient;
  private readonly authResolver: () => Promise<ResolvedAuth>;
  private cached: { token: string; expMs: number; source: ResolvedAuth['source'] } | undefined;
  private inflight: Promise<string> | undefined;

  constructor(opts?: { resolveAuth?: () => Promise<ResolvedAuth> }) {
    this.authResolver = opts?.resolveAuth ?? resolveAuth;
    this.api = createApiClient({
      baseUrl: BASE_URL,
      serviceName: SERVER_NAME,
      retry: { count: 1, delayMs: 1500 },
      timeout: 30_000,
      getToken: () => this.getToken(),
      onUnauthorized: () =>
        new Error(
          'RxLocal returned 401 — the signed-in session is stale. Reload your patient.rxlocal.com tab and retry.',
        ),
    });
  }

  /** Current token, read from the browser tab and cached until near expiry. */
  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expMs - TOKEN_SKEW_MS > now) return this.cached.token;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const { token, expiresAt, source } = await this.authResolver();
        const expMs = expiresAt ? expiresAt.getTime() : Date.now() + TOKEN_FALLBACK_TTL_MS;
        this.cached = { token, expMs, source };
        return token;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  /** Non-secret credential status for the healthcheck. Resolves a token if none is cached. */
  async credentialStatus(): Promise<CredentialStatus> {
    await this.getToken();
    return { source: this.cached!.source, ...(this.cached ? { expiresAt: new Date(this.cached.expMs) } : {}) };
  }

  async getUserInfo(): Promise<UserInfo> {
    return this.api.fetchJson<UserInfo>('GET', '/account/getuserinfo');
  }

  async getAge(): Promise<AgeGate> {
    return this.api.fetchJson<AgeGate>('GET', '/account/accountholderage');
  }

  async getNotifications(groupOwnerID: string): Promise<Notification> {
    return this.api.fetchJson<Notification>(
      'GET',
      `/notifications/most-relevant/v1?groupOwnerID=${encodeURIComponent(groupOwnerID)}`,
    );
  }

  async getLegal(kind: LegalKind): Promise<LegalDoc> {
    return this.api.fetchJson<LegalDoc>('GET', `/account/legal/${kind}`);
  }
}
