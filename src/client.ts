import { createApiClient, type ApiClient, loadDotenvSafely } from '@chrischall/mcp-utils';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveAuth, type ResolvedAuth } from './auth.js';
import { createRxBridge, type RxBridge } from './bridge.js';
import { SERVER_NAME, VERSION } from './version.js';

try {
  const dir = dirname(fileURLToPath(import.meta.url));
  await loadDotenvSafely({ path: join(dir, '..', '.env') });
} catch {
  // .env is optional; this server's only auth path is the browser bridge.
}

export const BASE_URL = 'https://patient.rxlocal.com/api';
/**
 * The web portal's public `patientPortalID`. The SPA's axios instance sends it
 * as a `portalid` header on EVERY API call, and the patient-data endpoints
 * (prescriptions, messages) answer 401 without it — verified live 2026-10-29
 * (same bearer: no header → 401, header → 200). They ALSO need the tab's own
 * session cookies, which is why every call runs through the bridge (see
 * bridge.ts) rather than from Node. It is a constant baked into the
 * SPA bundle, not a secret. (The native app uses a different id; do not.)
 */
export const PORTAL_ID = '370549AF-06A2-4E64-B17D-4040EF57D233';
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
  /** The account's primary pharmacy location id ("DEI"). */
  primaryDataExchangeIdentifier?: string;
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

/** One prescription row from `GET refill/<groupOwnerID>/v2` (fields seen live; all loosely typed). */
export interface Refill {
  rxID?: string;
  rxNumber?: number;
  name?: string;
  dispensedAs?: string;
  pharmacyName?: string;
  rxLocalPatientID?: string;
  dataExchangeIdentifier?: string;
  canRequestRefill?: boolean;
  requiresRenewal?: boolean;
  [key: string]: unknown;
}

export interface RefillsResponse {
  serviceResult?: number;
  data?: { refills?: Refill[]; reportCards?: unknown };
}

/** `GET refill/location/<DEI>/conveyanceOptions` — the pickup/delivery choices for one location. */
export interface ConveyanceOptionsResponse {
  data?: {
    conveyanceOptions?: number[];
    pickupTimeOptions?: { timeOptionType: number; label?: string; sortOrder?: number }[];
    refillDisclaimers?: { text?: string; area?: unknown; type?: unknown; typeDescription?: string; displaySequence?: number }[];
    location?: Record<string, unknown>;
    locationCalendar?: { nextOpen?: string; minDate?: string; maxDate?: string; closed?: unknown };
    isPickupAvailable?: boolean;
    isDeliveryAvailable?: boolean;
    [key: string]: unknown;
  };
  result?: unknown;
  message?: unknown;
  succeeded?: boolean;
}

export interface MessagesResponse {
  serviceResult?: number;
  data?: { messagesToAddUpdate?: Record<string, unknown>[]; [key: string]: unknown };
}

/** Who a patient-scoped call is about: the account holder's ids. */
export interface AccountContext {
  /** The group owner — the account holder's own rxLocalPatientID. */
  groupOwnerID: string;
  /** The patient the call is about (the account holder). */
  rxLocalPatientID: string;
  /** The primary pharmacy location id. */
  dataExchangeIdentifier: string | undefined;
  /** The account holder's globalUserID (sent as `rxlocaluserid`). */
  userId: string;
  /** "First Last", as the refill request's PatientName. */
  displayName: string;
}

export interface CredentialStatus {
  source: ResolvedAuth['source'];
  expiresAt?: Date;
}

/**
 * RxLocal API client. The bearer is read from the signed-in browser tab
 * (see {@link resolveAuth}), every request is relayed through that tab (see
 * bridge.ts), and the bearer is cached until just before its `exp`; a single
 * in-flight resolve is shared across concurrent callers.
 */
export class RxLocalClient {
  private readonly api: ApiClient;
  /**
   * The single-attempt client every WRITE goes through: no 429 retry, and (as
   * for reads) a 401 throws instead of re-resolving and replaying. A sent
   * write that times out, drops, or answers 5xx throws
   * `WriteOutcomeUnknownError` (createApiClient's default), never a
   * retry-safe-looking error.
   */
  private readonly writeApi: ApiClient;
  private readonly authResolver: () => Promise<ResolvedAuth>;
  private cached: { token: string; expMs: number; source: ResolvedAuth['source'] } | undefined;
  private inflight: Promise<string> | undefined;

  private readonly bridge: RxBridge | undefined;

  /**
   * Defaults: one bridge, used both to read the bearer and to send every
   * request through the signed-in tab. Tests inject `resolveAuth` + `fetchImpl`.
   */
  constructor(opts?: { resolveAuth?: () => Promise<ResolvedAuth>; fetchImpl?: typeof fetch; bridge?: RxBridge }) {
    const needsBridge = !opts?.resolveAuth || !opts?.fetchImpl;
    this.bridge = opts?.bridge ?? (needsBridge ? createRxBridge({ serverName: SERVER_NAME, version: VERSION }) : undefined);
    const bridge = this.bridge;
    this.authResolver = opts?.resolveAuth ?? (() => resolveAuth(() => bridge!.readAuthRes()));
    const common = {
      fetchImpl: opts?.fetchImpl ?? bridge!.fetch,
      baseUrl: BASE_URL,
      serviceName: SERVER_NAME,
      timeout: 30_000,
      baseHeaders: { portalid: PORTAL_ID },
      getToken: () => this.getToken(),
    };
    this.api = createApiClient({
      ...common,
      retry: { count: 1, delayMs: 1500 },
      onUnauthorized: () =>
        new Error(
          'RxLocal returned 401 — the signed-in session is stale. Reload your patient.rxlocal.com tab and retry.',
        ),
    });
    this.writeApi = createApiClient({
      ...common,
      retry: { count: 0, delayMs: 0 },
      writeOutcomeHint:
        'RxLocal may already have received this. Check rxlocal_list_prescriptions / rxlocal_list_messages before retrying; do not resend blindly.',
      onUnauthorized: () =>
        new Error(
          'RxLocal returned 401 — the signed-in session is stale, and nothing was sent. Reload your ' +
            'patient.rxlocal.com tab, then preview the write again.',
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

  /** The account holder's ids, read from `account/getuserinfo`. */
  async accountContext(): Promise<AccountContext> {
    const u = await this.getUserInfo();
    return {
      groupOwnerID: u.rxLocalPatientID,
      rxLocalPatientID: u.rxLocalPatientID,
      dataExchangeIdentifier: u.primaryDataExchangeIdentifier || undefined,
      userId: u.globalUserID,
      displayName: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(),
    };
  }

  /** Prescriptions on file for the group (verified live, read-only). */
  async getRefills(groupOwnerID: string, userId: string): Promise<RefillsResponse> {
    return this.api.fetchJson<RefillsResponse>('GET', `/refill/${encodeURIComponent(groupOwnerID)}/v2`, {
      headers: { rxlocaluserid: userId },
    });
  }

  /** Pickup/delivery choices, pickup times, hours and disclaimers for one pharmacy location. */
  async getConveyanceOptions(
    dataExchangeIdentifier: string,
    groupOwnerID: string,
    rxLocalPatientID: string,
    userId: string,
  ): Promise<ConveyanceOptionsResponse> {
    return this.api.fetchJson<ConveyanceOptionsResponse>(
      'GET',
      `/refill/location/${encodeURIComponent(dataExchangeIdentifier)}/conveyanceOptions`,
      { query: { groupOwnerID, rxlocalPatientID: rxLocalPatientID }, headers: { rxlocaluserid: userId } },
    );
  }

  /**
   * Pharmacy messages. A POST, but a read: it does NOT mark anything read
   * (that is `Messaging/UpdatePatientMessageStatus`, which this server never
   * calls), so it is flagged idempotent and retried like a GET.
   */
  async syncMessages(ctx: {
    groupOwnerID: string;
    rxLocalPatientID: string;
    dataExchangeIdentifier: string | undefined;
  }): Promise<MessagesResponse> {
    return this.api.fetchJson<MessagesResponse>('POST', '/Messaging/SyncPatientMessages', {
      idempotent: true,
      body: {
        GroupOwnerID: ctx.groupOwnerID,
        RxLocalPatientID: ctx.rxLocalPatientID,
        DataExchangeIdentifier: ctx.dataExchangeIdentifier ?? null,
        EndDate: null,
        GetXMostRecentMessagesForDateRange: true,
        IsFirstDownloadOfMessages: false,
      },
    });
  }

  /** WRITE, sent once: request refills/renewals (`POST refill/<groupOwnerID>/v1`). UNVERIFIED on the wire. */
  async requestRefills(groupOwnerID: string, userId: string, body: unknown): Promise<unknown> {
    return this.writeApi.fetchJson<unknown>('POST', `/refill/${encodeURIComponent(groupOwnerID)}/v1`, {
      body,
      headers: { rxlocaluserid: userId },
    });
  }

  /** WRITE, sent once: a plain-text message to the pharmacy. UNVERIFIED on the wire. */
  async createMessage(body: unknown): Promise<unknown> {
    return this.writeApi.fetchJson<unknown>('POST', '/Messaging/CreatePatientMessage', { body });
  }
}
