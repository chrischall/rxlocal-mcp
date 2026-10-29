// Refill requests: the pickup/delivery options read, and the confirm-gated
// request itself.
//
// The options read (`GET refill/location/<DEI>/conveyanceOptions`) was verified
// live, read-only, on 2026-10-29. The request (`POST refill/<groupOwnerID>/v1`)
// is derived from the RxLocal SPA bundle and is UNVERIFIED on the wire: no
// request has been sent. The SPA reads the response as an array of per-item
// results where `!succeeded || number === -1` means that item was NOT
// requested; re-read rxlocal_list_prescriptions to confirm.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  McpToolError,
  NonEmptyString,
  UNTRUSTED_CONTENT_RULE,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  defineWrite,
  registerWrite,
  resolveView,
  untrustedEnvelope,
  untrustedResult,
  viewParam,
} from '@chrischall/mcp-utils';
import type { ConveyanceOptionsResponse, Refill, RxLocalClient } from '../client.js';
import {
  CONVEYANCE,
  PICKUP_TIME,
  READ,
  asRecord,
  asRecordArray,
  enumName,
  tidy,
  type ConveyanceName,
  type PickupTimeName,
} from './_shared.js';
import { refillRows } from './prescriptions.js';
import { WRITE, compactResult, sendOnce, writeDescription } from './_writes.js';

const OPTION_VIEWS = ['compact', 'full', 'raw'] as const;

const DISCLAIMER_NOTE = `The pharmacy writes the disclaimer text. ${UNTRUSTED_CONTENT_RULE}`;

type OptionsData = NonNullable<ConveyanceOptionsResponse['data']>;

/** The pharmacy's refill disclaimers, in display order. */
export function projectDisclaimers(data: OptionsData): Record<string, unknown>[] {
  return asRecordArray(data.refillDisclaimers)
    .slice()
    .sort((a, b) => Number(a.displaySequence ?? 0) - Number(b.displaySequence ?? 0))
    .map((d) => tidy({ type: d.typeDescription, area: d.area, text: d.text }));
}

/**
 * The compact options view: what can be chosen, the pharmacy's own details
 * and hours, and its disclaimers. The PATIENT's addresses and phone are left
 * out (they are only in `full`/`raw`).
 */
export function projectOptions(data: OptionsData): Record<string, unknown> {
  const loc = asRecord(data.location);
  return tidy({
    pharmacy: tidy({
      name: loc.name,
      addressLine1: loc.addressLine1,
      city: loc.city,
      state: loc.state,
      zip: loc.zip,
      phone: loc.phone,
      hours: loc.hours,
      timeZone: loc.timeZone,
    }),
    conveyanceOptions: (data.conveyanceOptions ?? []).map((v) => enumName(CONVEYANCE, v) ?? v),
    pickupTimeOptions: asRecordArray(data.pickupTimeOptions)
      .slice()
      .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0))
      .map((o) => tidy({ value: enumName(PICKUP_TIME, o.timeOptionType) ?? o.timeOptionType, label: o.label })),
    calendar: data.locationCalendar,
    isPickupAvailable: data.isPickupAvailable,
    isDeliveryAvailable: data.isDeliveryAvailable,
    disclaimers: projectDisclaimers(data),
  });
}

/** `YYYY-MM-DD` of an ISO-ish date string, or `undefined`. */
function day(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

/** One entry of the `Requests` array the SPA posts (one per patient + location). */
export function buildRefillRequest(input: {
  rxLocalPatientID: string;
  dataExchangeIdentifier: string;
  refills: Refill[];
  patientName: string;
  conveyance: number;
  pickupTime: number | null;
  pickupDate: string | null;
  comment: string | null;
}): Record<string, unknown> {
  return {
    RxLocalPatientID: input.rxLocalPatientID,
    DataExchangeIdentifier: input.dataExchangeIdentifier,
    DetailList: input.refills.map((r) => ({
      PioneerRxID: r.rxID,
      RxNumber: r.rxNumber,
      DisplayName: r.name,
      // 2 = renewal (needs a new authorization from the prescriber), 1 = refill.
      Status: r.requiresRenewal ? 2 : 1,
      PharmacyName: r.pharmacyName,
      PatientName: input.patientName,
    })),
    ConveyanceType: input.conveyance,
    UserPickupTimeOption: input.pickupTime,
    PickupLaterDate: input.pickupDate,
    Comments: input.comment,
  };
}

/** Read the per-item results the SPA reads; `undefined` when the answer is not that shape. */
export function readRefillResults(
  res: unknown,
  names: (string | undefined)[],
): { requested: boolean; name?: string; message?: string }[] | undefined {
  if (!Array.isArray(res)) return undefined;
  const aligned = res.length === names.length;
  return res.map((item, i) => {
    const r = asRecord(item);
    const requested = r.succeeded === true && r.number !== -1;
    return tidy({
      requested,
      name: aligned ? names[i] : undefined,
      message: typeof r.message === 'string' ? r.message : undefined,
    }) as { requested: boolean; name?: string; message?: string };
  });
}

export function registerRefillTools(server: McpServer, client: RxLocalClient): void {
  server.registerTool(
    'rxlocal_get_refill_options',
    {
      description:
        'Get what a refill request at your RxLocal pharmacy can choose: the conveyance options it ' +
        'offers (pickup / delivery / mail), the pickup-time options (asap, later_today, tomorrow, later), ' +
        'the pickup calendar (first and last date a "later" pickup may name), the pharmacy name, address, ' +
        'phone and hours, and the pharmacy\'s refill disclaimers. Defaults to your primary pharmacy ' +
        "location. Compact by default (your own addresses and phone left out); view:'full' adds them, " +
        `view:'raw' is the whole portal response. Changes nothing. ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: READ,
      inputSchema: z.object({
        data_exchange_identifier: NonEmptyString.max(64)
          .optional()
          .describe(
            'Pharmacy location id (a prescription\'s dataExchangeIdentifier). Default: your primary location.',
          ),
        view: viewParam(OPTION_VIEWS),
      }),
    },
    async ({ data_exchange_identifier, view }) => {
      const ctx = await client.accountContext();
      const dei = data_exchange_identifier ?? ctx.dataExchangeIdentifier;
      if (dei === undefined) {
        throw new McpToolError('Your RxLocal account names no primary pharmacy location.', {
          hint: 'Pass data_exchange_identifier from a prescription in rxlocal_list_prescriptions.',
        });
      }
      const raw = await client.getConveyanceOptions(dei, ctx.groupOwnerID, ctx.rxLocalPatientID, ctx.userId);
      const v = resolveView(view, OPTION_VIEWS);
      const payload = v === 'raw' ? raw : v === 'full' ? asRecord(raw.data) : projectOptions(raw.data ?? {});
      return untrustedResult(payload, { note: DISCLAIMER_NOTE });
    },
  );

  registerWrite(
    server,
    defineWrite({
      name: 'rxlocal_request_refill',
      description: writeDescription(
        'Request a refill (or, for a prescription that needs one, a prescriber renewal) of one or ' +
          'more of your prescriptions at your RxLocal pharmacy (rxIDs from rxlocal_list_prescriptions; ' +
          'each must show canRequestRefill). Choose how to get it (pickup / delivery / mail, from ' +
          'rxlocal_get_refill_options) and, for pickup, when. The pharmacy receives the request; this ' +
          'server cannot withdraw it. Confirm it afterwards with rxlocal_list_prescriptions ' +
          '(refillRequestStatus). All prescriptions in one request must be yours and at one pharmacy location.',
      ),
      annotations: WRITE,
      inputSchema: z.object({
        rx_ids: z
          .array(NonEmptyString.max(64))
          .min(1)
          .max(20)
          .describe('rxID of each prescription to refill, from rxlocal_list_prescriptions.'),
        conveyance: z
          .enum(['pickup', 'delivery', 'mail'])
          .describe('How to get it; must be one the location offers (rxlocal_get_refill_options).'),
        pickup_time: z
          .enum(['asap', 'later_today', 'tomorrow', 'later'])
          .optional()
          .describe('Pickup only, and required for pickup when the location offers pickup times.'),
        pickup_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
          .optional()
          .describe('YYYY-MM-DD; required with pickup_time "later", within the location\'s pickup calendar.'),
        comment: z.string().max(500).optional().describe('Note for the pharmacy (optional, plain text).'),
      }),
      async plan(args) {
        const ctx = await client.accountContext();
        const rows = refillRows(await client.getRefills(ctx.groupOwnerID, ctx.userId));
        const chosen = args.rx_ids.map((id) => {
          const rx = rows.find((r) => r.rxID !== undefined && String(r.rxID) === id);
          if (rx === undefined) {
            throw new McpToolError(`Prescription ${id} is not on your refill list.`, {
              hint: 'Use an rxID from rxlocal_list_prescriptions.',
            });
          }
          if (rx.canRequestRefill !== true) {
            throw new McpToolError(`${rx.name ?? id} cannot be refilled through the portal right now.`, {
              hint:
                (typeof rx.unAvailableMessage === 'string' && rx.unAvailableMessage
                  ? `The pharmacy says: "${rx.unAvailableMessage}". `
                  : '') + 'Contact the pharmacy (rxlocal_send_message) instead.',
            });
          }
          return rx;
        });
        const patients = new Set(chosen.map((r) => String(r.rxLocalPatientID ?? ctx.rxLocalPatientID)));
        if (patients.size !== 1 || !patients.has(ctx.rxLocalPatientID)) {
          throw new McpToolError('Only your own prescriptions can be requested here.', {
            hint: 'This server requests refills for the account holder only; request a family member\'s in the portal.',
          });
        }
        const locations = new Set(chosen.map((r) => r.dataExchangeIdentifier ?? ctx.dataExchangeIdentifier));
        const dei = [...locations][0];
        if (locations.size !== 1 || dei === undefined) {
          throw new McpToolError('These prescriptions are at different pharmacy locations (or none).', {
            hint: 'Request each location\'s prescriptions in a separate call.',
          });
        }
        const options = await client.getConveyanceOptions(dei, ctx.groupOwnerID, ctx.rxLocalPatientID, ctx.userId);
        const data = options.data ?? {};
        const offered = data.conveyanceOptions ?? [];
        const conveyance = CONVEYANCE[args.conveyance as ConveyanceName];
        if (!offered.includes(conveyance)) {
          throw new McpToolError(`This pharmacy location does not offer ${args.conveyance}.`, {
            hint: `Offered: ${offered.map((v) => enumName(CONVEYANCE, v) ?? v).join(', ') || 'none'}.`,
          });
        }
        const times = asRecordArray(data.pickupTimeOptions)
          .slice()
          .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0));
        const timesOffered = times.map((t) => enumName(PICKUP_TIME, t.timeOptionType) ?? t.timeOptionType).join(', ');
        let pickupTime: number | null = null;
        let pickupLabel: string | undefined;
        if (args.conveyance !== 'pickup') {
          if (args.pickup_time !== undefined || args.pickup_date !== undefined) {
            throw new McpToolError('pickup_time and pickup_date apply to pickup only.', {
              hint: `Drop them for ${args.conveyance}.`,
            });
          }
        } else if (args.pickup_time === undefined) {
          if (times.length > 0) {
            throw new McpToolError('Choose a pickup time.', {
              hint: `Offered: ${timesOffered}.`,
            });
          }
        } else {
          pickupTime = PICKUP_TIME[args.pickup_time as PickupTimeName];
          const match = times.find((t) => t.timeOptionType === pickupTime);
          if (match === undefined) {
            throw new McpToolError(`This pharmacy location does not offer the "${args.pickup_time}" pickup time.`, {
              hint: `Offered: ${timesOffered || 'none'}.`,
            });
          }
          pickupLabel = typeof match.label === 'string' ? match.label : undefined;
        }
        let pickupDate: string | null = null;
        if (args.pickup_time === 'later') {
          if (args.pickup_date === undefined) {
            throw new McpToolError('A "later" pickup needs a pickup_date.', {
              hint: 'Pass pickup_date as YYYY-MM-DD within the calendar from rxlocal_get_refill_options.',
            });
          }
          const cal = data.locationCalendar ?? {};
          const min = day(cal.minDate);
          const max = day(cal.maxDate);
          const closed = Array.isArray(cal.closed) ? cal.closed.map(day) : [];
          if ((min !== undefined && args.pickup_date < min) || (max !== undefined && args.pickup_date > max)) {
            throw new McpToolError(`${args.pickup_date} is outside the pharmacy's pickup calendar.`, {
              hint: `Choose a date from ${min ?? '?'} to ${max ?? '?'}.`,
            });
          }
          if (closed.includes(args.pickup_date)) {
            throw new McpToolError(`The pharmacy is closed on ${args.pickup_date}.`, {
              hint: 'Choose another date (see rxlocal_get_refill_options).',
            });
          }
          pickupDate = args.pickup_date;
        } else if (args.pickup_date !== undefined) {
          throw new McpToolError('pickup_date applies only to pickup_time "later".', {
            hint: 'Drop pickup_date, or set pickup_time to "later".',
          });
        }
        const comment = args.comment?.trim() ? args.comment.trim() : null;
        const body = {
          Requests: [
            buildRefillRequest({
              rxLocalPatientID: ctx.rxLocalPatientID,
              dataExchangeIdentifier: dei,
              refills: chosen,
              patientName: ctx.displayName,
              conveyance,
              pickupTime,
              pickupDate,
              comment,
            }),
          ],
        };
        const pharmacy = String(asRecord(data.location).name ?? chosen[0]!.pharmacyName ?? 'your pharmacy');
        const names = chosen.map((r) => r.name);
        return {
          gate: {
            action: 'rxlocal.request_refill',
            summary: `Request ${chosen.length === 1 ? 'a refill' : `${chosen.length} refills`} (${names.join(', ')}) from ${pharmacy} by ${args.conveyance}`,
            account: ctx.userId,
            target: dei,
            request: { method: 'POST', path: `refill/${ctx.groupOwnerID}/v1`, body },
            willSend: tidy({
              prescriptions: chosen.map((r) =>
                tidy({ name: r.name, rxNumber: r.rxNumber, kind: r.requiresRenewal ? 'renewal' : 'refill' }),
              ),
              pharmacy,
              conveyance: args.conveyance,
              pickupTime: pickupLabel ?? args.pickup_time,
              pickupDate,
              comment,
            }),
            preview: {
              caveat:
                'This request shape is derived from the RxLocal web app and has not yet been verified ' +
                'against the live portal. Confirm it with rxlocal_list_prescriptions afterwards.',
              pharmacyDisclaimers: untrustedEnvelope({ disclaimers: projectDisclaimers(data) }, { note: DISCLAIMER_NOTE }),
            },
          },
          state: { groupOwnerID: ctx.groupOwnerID, userId: ctx.userId, body, names, pharmacy },
        };
      },
      async execute({ groupOwnerID, userId, body, names, pharmacy }) {
        return sendOnce(
          async () => {
            const res = await client.requestRefills(groupOwnerID, userId, body);
            const results = readRefillResults(res, names);
            if (results === undefined) {
              return {
                status: 'unconfirmed',
                pharmacy,
                note:
                  'RxLocal accepted the request but did not answer in the expected shape. Check ' +
                  'rxlocal_list_prescriptions (refillRequestStatus) before trying again.',
              };
            }
            const ok = results.filter((r) => r.requested).length;
            if (ok === 0) {
              throw new McpToolError('RxLocal did not accept the refill request.', {
                hint:
                  'Nothing was requested. ' +
                  (results.map((r) => r.message).filter(Boolean).join(' ') || 'Contact the pharmacy instead.'),
              });
            }
            return {
              status: ok === results.length ? 'requested' : 'partial',
              pharmacy,
              results,
              note: 'Confirm with rxlocal_list_prescriptions (refillRequestStatus).',
            };
          },
          'refill request',
          'rxlocal_list_prescriptions (refillRequestStatus)',
        );
      },
      render: compactResult,
    }),
  );
}
