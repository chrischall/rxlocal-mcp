// Prescriptions on file: `GET refill/<groupOwnerID>/v2` (verified live,
// read-only, 2026-10-29 — it needs the `portalid` header the client sends).
// This is medication data: the compact default keeps to what a person asks
// about (what, how many refills, can I request one); NDC, imprint and person
// ids stay in `full`. `unAvailableMessage` is written by the pharmacy, so every
// view comes back inside an untrusted envelope.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  UNTRUSTED_CONTENT_RULE,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  resolveView,
  untrustedResult,
} from '@chrischall/mcp-utils';
import type { Refill, RxLocalClient } from '../client.js';
import { READ, asRecordArray, tidy } from './_shared.js';
import { briefLine, briefResult, briefViewParam, flat, healthMeta, isoDay } from './_hints.js';

const RX_VIEWS = ['compact', 'full', 'raw'] as const;
const RX_NOTE = `The pharmacy writes unAvailableMessage (why a refill cannot be requested). ${UNTRUSTED_CONTENT_RULE}`;

/** The compact projection of one prescription row. */
export function projectRefill(r: Refill): Record<string, unknown> {
  return tidy({
    rxID: r.rxID,
    rxNumber: r.rxNumber,
    name: r.name,
    dispensedAs: r.dispensedAs,
    pharmacyName: r.pharmacyName,
    dateFilled: r.dateFilled,
    refillsRemaining: r.refillsRemaining,
    daysSupply: r.daysSupply,
    expirationDate: r.expirationDate,
    canRequestRefill: r.canRequestRefill,
    requiresRenewal: r.requiresRenewal,
    refillRequestStatus: r.refillRequestStatus,
    unAvailableMessage: r.unAvailableMessage,
    prescriber: r.prescriber,
    dataExchangeIdentifier: r.dataExchangeIdentifier,
    rxLocalPatientID: r.rxLocalPatientID,
  });
}

/**
 * The day a fill runs out: `dateFilled` + `daysSupply`, as `YYYY-MM-DD`, or
 * `undefined` when either is missing. This is the date a "what's due at the
 * pharmacy?" question is about.
 */
export function runsOut(r: Refill): string | undefined {
  const filled = isoDay(r.dateFilled);
  const days = typeof r.daysSupply === 'number' && Number.isFinite(r.daysSupply) ? r.daysSupply : undefined;
  if (filled === undefined || days === undefined) return undefined;
  const d = new Date(`${filled}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A prescription's refill status in a few words, from the portal's own flags.
 * The pharmacy-written `unAvailableMessage` is never repeated: a brief line
 * stays a few words, not the pharmacy's sentence.
 */
export function refillStatus(r: Refill): string {
  const requested = flat(r.refillRequestStatus);
  if (requested !== undefined) return `refill ${requested.toLowerCase().slice(0, 30)}`;
  if (r.canRequestRefill === true) return r.requiresRenewal ? 'needs a prescriber renewal' : 'can request a refill';
  if (r.refillsRemaining === 0) return 'no refills left';
  return 'cannot refill now';
}

/** One prescription as a brief line: drug — runs out — refill status. */
export function briefRefill(r: Refill): string {
  return briefLine(flat(r.name) ?? flat(r.dispensedAs) ?? '(unnamed prescription)', runsOut(r), refillStatus(r));
}

/** The prescription rows of a refill-list response (empty when absent). */
export function refillRows(raw: unknown): Refill[] {
  const data = (raw as { data?: { refills?: unknown } } | undefined)?.data;
  return asRecordArray(data?.refills) as Refill[];
}

export function registerPrescriptionTools(server: McpServer, client: RxLocalClient): void {
  server.registerTool(
    'rxlocal_list_prescriptions',
    {
      description:
        'List the prescriptions on file at your RxLocal pharmacy (the refill list): drug name, Rx ' +
        'number, rxID, pharmacy, last fill date, refills remaining, days supply, expiration, prescriber, ' +
        'and whether a refill can be requested now (canRequestRefill) or needs a prescriber renewal ' +
        '(requiresRenewal). The rxID is what rxlocal_request_refill takes. Compact by default; ' +
        "view:'full' returns every field per prescription (NDC, imprint, ids), view:'raw' the whole " +
        'portal response, view:\'brief\' one line per prescription (drug, run-out day, refill status). ' +
        'Changes nothing. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: READ,
      _meta: healthMeta('whats-due', {
        canonical: true,
        aliases: ['prescriptions', 'refills', 'meds', 'medications', 'pharmacy', 'pills', 'running out'],
      }),
      inputSchema: z.object({
        view: briefViewParam(
          RX_VIEWS,
          'A brief line is the drug, the day the last fill runs out (fill date + days supply), and its refill status; soonest first.',
        ),
      }),
    },
    async ({ view }) => {
      const ctx = await client.accountContext();
      const raw = await client.getRefills(ctx.groupOwnerID, ctx.userId);
      if (view === 'brief') {
        const rows = refillRows(raw)
          .map((r) => ({ r, out: runsOut(r) }))
          .sort((a, b) => (a.out ?? '9999').localeCompare(b.out ?? '9999'));
        return briefResult(
          rows.map(({ r }) => briefRefill(r)),
          'Drug names and refill request statuses come from the pharmacy\'s records.',
        );
      }
      const v = resolveView(view, RX_VIEWS);
      if (v === 'raw') return untrustedResult(raw, { note: RX_NOTE });
      const rows = refillRows(raw);
      return untrustedResult(
        { count: rows.length, prescriptions: v === 'full' ? rows : rows.map(projectRefill) },
        { note: RX_NOTE },
      );
    },
  );
}
