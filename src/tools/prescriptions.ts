// Prescriptions on file: `GET refill/<groupOwnerID>/v2` (verified live,
// read-only, 2026-10-29 — it needs the `portalid` header the client sends).
// This is medication data: the compact default keeps to what a person asks
// about (what, how many refills, can I request one); NDC, imprint and person
// ids stay in `full`.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, resolveView, viewParam } from '@chrischall/mcp-utils';
import type { Refill, RxLocalClient } from '../client.js';
import { READ, asRecordArray, tidy } from './_shared.js';

const RX_VIEWS = ['compact', 'full', 'raw'] as const;

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
        'portal response. Changes nothing.',
      annotations: READ,
      inputSchema: z.object({ view: viewParam(RX_VIEWS) }),
    },
    async ({ view }) => {
      const ctx = await client.accountContext();
      const raw = await client.getRefills(ctx.groupOwnerID, ctx.userId);
      const v = resolveView(view, RX_VIEWS);
      if (v === 'raw') return minifiedResult(raw);
      const rows = refillRows(raw);
      return minifiedResult({
        count: rows.length,
        prescriptions: v === 'full' ? rows : rows.map(projectRefill),
      });
    },
  );
}
