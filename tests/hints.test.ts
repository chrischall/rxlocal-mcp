import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { createTestHarness } from './helpers.js';
import { stubClient, REFILLS, MESSAGES } from './stub-client.js';
import type { RxLocalClient } from '../src/client.js';
import { registerProfileTools } from '../src/tools/profile.js';
import { registerAgeTools } from '../src/tools/age.js';
import { registerNotificationTools } from '../src/tools/notifications.js';
import { registerLegalTools } from '../src/tools/legal.js';
import { registerPrescriptionTools } from '../src/tools/prescriptions.js';
import { registerRefillTools } from '../src/tools/refills.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerComposeTools } from '../src/tools/compose.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { briefLine } from '../src/tools/_hints.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host contract), read off the
 * served `tools/list` — what a host actually sees.
 */
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

function harness(client: RxLocalClient = stubClient()) {
  return createTestHarness((server: McpServer) => {
    registerProfileTools(server, client);
    registerAgeTools(server, client);
    registerNotificationTools(server, client);
    registerLegalTools(server, client);
    registerPrescriptionTools(server, client);
    registerRefillTools(server, client);
    registerMessageTools(server, client);
    registerComposeTools(server, client);
    registerHealthcheckTools(server, client);
  });
}

async function served(): Promise<Listed[]> {
  const h = await harness();
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as Listed[];
}

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  rxlocal_profile: 'lookup',
  rxlocal_age_gate: 'lookup',
  rxlocal_notifications: 'lookup',
  rxlocal_legal: 'lookup',
  rxlocal_list_prescriptions: 'whats-due',
  rxlocal_get_refill_options: 'lookup',
  rxlocal_list_messages: 'whats-new',
  rxlocal_request_refill: 'send',
  rxlocal_send_message: 'send',
};

describe('_meta.mint on tools/list', () => {
  it('names every served tool, so a new tool cannot skip the decision', async () => {
    const names = (await served()).map((t) => t.name).filter((n) => n !== 'rxlocal_healthcheck');
    expect(names.sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it('every tool except the healthcheck carries domain health and its intent', async () => {
    const tools = await served();
    expect(tools.map((t) => t.name)).toContain('rxlocal_healthcheck');
    for (const t of tools) {
      if (t.name === 'rxlocal_healthcheck') {
        expect(t._meta?.mint, t.name).toBeUndefined();
        continue;
      }
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(m!.domain, t.name).toBe('health');
      expect(m!.intent, t.name).toBe(EXPECTED_INTENT[t.name]);
    }
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of await served()) {
      const m = t._meta?.mint;
      if (!m) continue;
      expect(Object.keys(m).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(m.domain);
      expect(INTENTS, t.name).toContain(m.intent);
      const props = t.inputSchema.properties ?? {};
      if ('canonical' in m) {
        expect(m.canonical, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(CANONICAL_INTENTS, t.name).toContain(m.intent);
      }
      if ('subject' in m) expect(props, t.name).toHaveProperty(m.subject as string);
      if ('when' in m) {
        const when = m.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start);
        expect(props, t.name).toHaveProperty(when.end);
      }
      if ('aliases' in m) {
        const aliases = m.aliases as string[];
        expect(aliases.length, t.name).toBeGreaterThan(0);
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
          expect(a, t.name).not.toMatch(/^rxlocal_/);
        }
      }
    }
  });

  it('the confirm-gated writes carry their hint too (registerWrite takes no _meta)', async () => {
    const tools = await served();
    for (const name of ['rxlocal_request_refill', 'rxlocal_send_message']) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.annotations?.readOnlyHint, name).toBe(false);
      expect(t._meta?.mint, name).toMatchObject({ domain: 'health', intent: 'send' });
      expect(t._meta!.mint, name).not.toHaveProperty('canonical');
    }
  });

  it('marks one canonical read per intent: prescriptions (whats-due), pharmacy messages (whats-new)', async () => {
    const canonical = (await served())
      .filter((t) => t._meta?.mint?.canonical === true)
      .map((t) => [t.name, t._meta!.mint!.intent]);
    expect(canonical.sort()).toEqual([
      ['rxlocal_list_messages', 'whats-new'],
      ['rxlocal_list_prescriptions', 'whats-due'],
    ]);
    for (const intent of CANONICAL_INTENTS) {
      expect(canonical.filter(([, i]) => i === intent).length, intent).toBeLessThanOrEqual(1);
    }
  });

  it('every canonical read accepts view: brief and names no subject or range', async () => {
    for (const t of (await served()).filter((x) => x._meta?.mint?.canonical === true)) {
      expect(t.inputSchema.properties?.view?.enum, t.name).toContain('brief');
      // One account holder, no listable set of subjects; neither read takes a range.
      expect(t._meta!.mint, t.name).not.toHaveProperty('subject');
      expect(t._meta!.mint, t.name).not.toHaveProperty('when');
    }
  });
});

/** A brief line: `title — <ISO date | no date> — <status>`, at most 120 chars. */
const BRIEF = /^.+ — (\d{4}-\d{2}-\d{2}|no date) — .+$/;

/** Item lines are `BRIEF`; a `-- ` line is a note (the consolidated brief-view contract). */
function expectBrief(lines: string[], count: number): string[] {
  expect(lines).toHaveLength(count);
  for (const line of lines) {
    expect(line.length, line).toBeLessThanOrEqual(120);
    if (!line.startsWith('-- ')) expect(line, line).toMatch(BRIEF);
  }
  return lines;
}

function textOf(res: { content?: unknown }): string {
  return (res.content as { type: string; text: string }[])[0]!.text;
}

/**
 * The brief lines of a read, out of the fleet's untrusted-data envelope:
 * `{ untrusted_content, note, data: string[] }`, minified, note first —
 * drug names and sender names are text the pharmacy wrote.
 */
function briefData(res: { content?: unknown }, who: RegExp): string[] {
  const text = textOf(res);
  expect(text).not.toContain('\n');
  const env = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(env)).toEqual(['untrusted_content', 'note', 'data']);
  expect(env.untrusted_content).toBe(true);
  expect(env.note).toMatch(who);
  expect(Array.isArray(env.data)).toBe(true);
  return env.data as string[];
}

const RX_WHO = /pharmacy/i;
const MSG_WHO = /pharmacy/i;

describe('view: brief on the canonical reads', () => {
  it('prescriptions answer one line each: drug — runs out — refill status, soonest first', async () => {
    const refills = structuredClone(REFILLS);
    refills.data.refills.push({
      rxID: 'RX-4', rxNumber: 1000004, name: 'Drug D '.repeat(30), pharmacyName: 'Test Pharmacy',
      dateFilled: '2026-10-20T00:00:00', daysSupply: 7, refillsRemaining: 0, canRequestRefill: false,
      refillRequestStatus: 'Pending', dataExchangeIdentifier: 'DEI-1', rxLocalPatientID: 'P-1',
    } as never);
    const h = await harness(stubClient({ getRefills: async () => refills }));
    const res = await h.callTool('rxlocal_list_prescriptions', { view: 'brief' });
    await h.close();
    const lines = expectBrief(briefData(res, RX_WHO), 4);
    expect(lines[0]).toBe('Drug A 10mg Tablet — 2026-10-01 — can request a refill');
    expect(lines[1]).toMatch(/^Drug D .*… — 2026-10-27 — refill pending$/);
    expect(lines[2]).toBe('Drug B 5mg Capsule — no date — needs a prescriber renewal');
    expect(lines[3]).toBe('Drug C 1mg Tablet — no date — cannot refill now');
  });

  it('a prescription brief never repeats the pharmacy-written reason', async () => {
    const h = await harness();
    const text = textOf(await h.callTool('rxlocal_list_prescriptions', { view: 'brief' }));
    await h.close();
    expect(text).not.toContain('Too soon to refill');
  });

  it('a prescription with no refills left says so', async () => {
    const getRefills = async () => ({
      data: { refills: [{ name: 'Drug E', dateFilled: '2026-11-01', daysSupply: 30, refillsRemaining: 0, canRequestRefill: false }] },
    });
    const h = await harness(stubClient({ getRefills }));
    const res = await h.callTool('rxlocal_list_prescriptions', { view: 'brief' });
    await h.close();
    expect(expectBrief(briefData(res, RX_WHO), 1)).toEqual(['Drug E — 2026-12-01 — no refills left']);
  });

  it('a drug name that reads like a note, or starts with a backslash, is escaped with one backslash', async () => {
    const getRefills = async () => ({
      data: {
        refills: [
          { name: '-- none', dateFilled: '2026-11-01', daysSupply: 30, canRequestRefill: true },
          { name: '\\x Drug', dateFilled: '2026-11-02', daysSupply: 30, canRequestRefill: true },
          { name: '--not a note', dateFilled: '2026-11-03', daysSupply: 30, canRequestRefill: true },
        ],
      },
    });
    const h = await harness(stubClient({ getRefills }));
    const res = await h.callTool('rxlocal_list_prescriptions', { view: 'brief' });
    await h.close();
    expect(expectBrief(briefData(res, RX_WHO), 3)).toEqual([
      '\\-- none — 2026-12-01 — can request a refill',
      '\\\\x Drug — 2026-12-02 — can request a refill',
      '--not a note — 2026-12-03 — can request a refill',
    ]);
  });

  it('messages answer one line each, newest first, naming the sender but never the body', async () => {
    const h = await harness();
    const res = await h.callTool('rxlocal_list_messages', { view: 'brief' });
    await h.close();
    expect(expectBrief(briefData(res, MSG_WHO), 2)).toEqual([
      'Message from Jane Doe — 2026-10-05 — sent by you',
      'Message from Test Pharmacy Staff — 2026-10-01 — from the pharmacy',
    ]);
    // Bodies are pharmacy-written: they stay in compact/full, inside the untrusted envelope.
    expect(textOf(res)).not.toContain('Your order is ready.');
  });

  it('a message brief honours limit, says how many were shown, and flattens a multi-line sender name', async () => {
    const messages = structuredClone(MESSAGES);
    messages.data.messagesToAddUpdate[0]!.sender = { employeeID: 'E-1', displayName: 'Test\nPharmacy' } as never;
    messages.data.messagesToAddUpdate.push({ messageID: 'M-3', body: 'x', sender: {} } as never);
    const h = await harness(stubClient({ syncMessages: async () => messages }));
    const all = briefData(await h.callTool('rxlocal_list_messages', { view: 'brief' }), MSG_WHO);
    const one = briefData(await h.callTool('rxlocal_list_messages', { view: 'brief', limit: 1 }), MSG_WHO);
    const three = briefData(await h.callTool('rxlocal_list_messages', { view: 'brief', limit: 3 }), MSG_WHO);
    await h.close();
    expect(expectBrief(all, 3)).toEqual([
      'Message from Jane Doe — 2026-10-05 — sent by you',
      'Message from Test Pharmacy — 2026-10-01 — from the pharmacy',
      'Message — no date — sender unknown',
    ]);
    expect(expectBrief(one, 2)).toEqual(['Message from Jane Doe — 2026-10-05 — sent by you', '-- 1 of 3 shown']);
    expect(three).toHaveLength(3);
    expect(three.some((l) => l.startsWith('-- '))).toBe(false);
  });

  it('an empty brief is the single note line `-- none`, inside the envelope', async () => {
    const h = await harness(stubClient({ getRefills: async () => ({}), syncMessages: async () => ({}) }));
    expect(briefData(await h.callTool('rxlocal_list_prescriptions', { view: 'brief' }), RX_WHO)).toEqual(['-- none']);
    expect(briefData(await h.callTool('rxlocal_list_messages', { view: 'brief' }), MSG_WHO)).toEqual(['-- none']);
    await h.close();
  });

  it('the default view is still the compact untrusted envelope', async () => {
    const getRefills = vi.fn(async () => structuredClone(REFILLS));
    const h = await harness(stubClient({ getRefills }));
    const text = textOf(await h.callTool('rxlocal_list_prescriptions', {}));
    await h.close();
    expect(JSON.parse(text)).toMatchObject({ untrusted_content: true, count: 3 });
  });
});

describe('briefLine', () => {
  it('cuts the line as a WHOLE to 120 chars, title first, never only the title', () => {
    const line = briefLine('T'.repeat(200), '2026-11-04', 'S'.repeat(200));
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line).toMatch(/^T+… — 2026-11-04 — S+…$/);
  });

  it('shortens only the title while the status fits', () => {
    const line = briefLine('T'.repeat(200), undefined, 'can request a refill');
    expect(line.length).toBe(120);
    expect(line.endsWith(' — no date — can request a refill')).toBe(true);
  });
});
