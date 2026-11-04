// Pharmacy messages: `POST Messaging/SyncPatientMessages` (verified live,
// read-only, 2026-10-29). A POST, but a read — it does not mark anything read
// (that is `Messaging/UpdatePatientMessageStatus`, never called here). Bodies
// are written by pharmacy staff, so the result is an untrusted envelope, and
// recipient contact details (email, phone, SMS carrier) are never returned.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  UNTRUSTED_CONTENT_RULE,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  resolveView,
  untrustedResult,
} from '@chrischall/mcp-utils';
import type { RxLocalClient } from '../client.js';
import { READ, asRecord, asRecordArray, tidy } from './_shared.js';
import { briefLine, briefResult, briefViewParam, flat, healthMeta, isoDay } from './_hints.js';

const MESSAGE_VIEWS = ['compact', 'full'] as const;

/** Contact-detail keys removed from every message, at any depth. */
const CONTACT_KEYS = new Set(['emailAddress', 'email', 'phoneNumber', 'phone', 'smsPhone', 'carrierDomain']);

/** A copy of `value` with every contact-detail key removed, at any depth. */
export function stripContactPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripContactPii);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!CONTACT_KEYS.has(k)) out[k] = stripContactPii(v);
    return out;
  }
  return value;
}

/** The compact projection of one message. */
export function projectMessage(m: Record<string, unknown>): Record<string, unknown> {
  const to = asRecordArray(m.recipients)
    .map((r) => r.displayName)
    .filter((n): n is string => typeof n === 'string' && n !== '');
  return tidy({
    messageID: m.messageID,
    sentOn: m.sentOn,
    from: asRecord(m.sender).displayName,
    to: to.length > 0 ? to : undefined,
    body: m.body,
    type: m.type,
    statusType: m.statusType,
  });
}

/**
 * One message as a brief line: who sent it — when — which way it went. The
 * body is written by pharmacy staff and a brief line is plain text, outside
 * the untrusted envelope, so the body is never in it (compact/full carry it).
 * Staff messages carry the sender's `employeeID`; the account holder's own
 * carry only a `messageUserID`.
 */
export function briefMessage(m: Record<string, unknown>): string {
  const sender = asRecord(m.sender);
  const name = flat(sender.displayName);
  const status =
    sender.employeeID !== undefined && sender.employeeID !== null
      ? 'from the pharmacy'
      : sender.messageUserID !== undefined && sender.messageUserID !== null
        ? 'sent by you'
        : 'sender unknown';
  return briefLine(name ? `Message from ${name}` : 'Message', isoDay(m.sentOn), status);
}

export function registerMessageTools(server: McpServer, client: RxLocalClient): void {
  server.registerTool(
    'rxlocal_list_messages',
    {
      description:
        'List recent secure messages between you and your RxLocal pharmacy, newest first: who sent ' +
        "it, when, and the text. Reading does NOT mark anything read. Compact by default; view:'full' " +
        'returns every field per message (recipient email/phone/carrier are always removed); ' +
        "view:'brief' one line per message (sender, day, direction; no body). " +
        `Changes nothing. ${UNTRUSTED_DESCRIPTION_SUFFIX}`,
      annotations: READ,
      _meta: healthMeta('whats-new', {
        canonical: true,
        aliases: ['pharmacy messages', 'messages', 'pharmacist', 'pharmacy', 'order ready'],
      }),
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(25).describe('Most messages to return (default 25).'),
        view: briefViewParam(
          MESSAGE_VIEWS,
          'A brief line is the sender, the day, and whether it came from the pharmacy or from you; never the body.',
        ),
      }),
    },
    async ({ limit, view }) => {
      const ctx = await client.accountContext();
      const raw = await client.syncMessages(ctx);
      const rows = asRecordArray(raw.data?.messagesToAddUpdate)
        .slice()
        .sort((a, b) => String(b.sentOn ?? '').localeCompare(String(a.sentOn ?? '')));
      const shown = rows.slice(0, limit);
      if (view === 'brief') return briefResult(shown.map(briefMessage));
      const full = resolveView(view, MESSAGE_VIEWS) === 'full';
      return untrustedResult(
        {
          count: shown.length,
          total: rows.length,
          messages: full ? shown.map(stripContactPii) : shown.map(projectMessage),
        },
        { note: `Message bodies are written by pharmacy staff. ${UNTRUSTED_CONTENT_RULE}` },
      );
    },
  );
}
