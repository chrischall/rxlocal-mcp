import { describe, it, expect, vi } from 'vitest';
import { registerPrescriptionTools } from '../src/tools/prescriptions.js';
import { registerRefillTools } from '../src/tools/refills.js';
import { registerMessageTools, stripContactPii } from '../src/tools/messages.js';
import { createTestHarness, parseToolResult } from './helpers.js';
import { stubClient, REFILLS, OPTIONS } from './stub-client.js';
import type { RxLocalClient } from '../src/client.js';

async function harness(client: RxLocalClient = stubClient()) {
  return createTestHarness((server) => {
    registerPrescriptionTools(server, client);
    registerRefillTools(server, client);
    registerMessageTools(server, client);
  });
}

type Json = Record<string, unknown>;

describe('rxlocal_list_prescriptions', () => {
  it('compact projects each prescription and keeps NDC, imprint and person ids out', async () => {
    const getRefills = vi.fn(async () => structuredClone(REFILLS));
    const h = await harness(stubClient({ getRefills }));
    const out = parseToolResult<{ count: number; prescriptions: Json[] }>(
      await h.callTool('rxlocal_list_prescriptions', {}),
    );
    expect(getRefills).toHaveBeenCalledWith('P-1', 'U-1');
    expect(out.count).toBe(3);
    expect(out.prescriptions[0]).toMatchObject({
      rxID: 'RX-1', rxNumber: 1000001, name: 'Drug A 10mg Tablet', refillsRemaining: 3,
      canRequestRefill: true, requiresRenewal: false, prescriber: 'Dr. Example',
    });
    const text = JSON.stringify(out);
    for (const hidden of ['ndc', 'imprintDescription', 'personID', 'refillStatusKey']) expect(text).not.toContain(hidden);
    // empty strings and nulls are dropped, false is kept
    expect(out.prescriptions[0]).not.toHaveProperty('refillRequestStatus');
    expect(out.prescriptions[0]).not.toHaveProperty('unAvailableMessage');
    expect(out.prescriptions[2]).toMatchObject({ canRequestRefill: false, unAvailableMessage: 'Too soon to refill' });
  });

  it('full returns every field; raw returns the whole response', async () => {
    const h = await harness();
    const full = parseToolResult<{ prescriptions: Json[] }>(
      await h.callTool('rxlocal_list_prescriptions', { view: 'full' }),
    );
    expect(full.prescriptions[0]).toMatchObject({ ndc: '00000-0000-01', personID: 'PERSON-1' });
    const raw = parseToolResult<Json>(await h.callTool('rxlocal_list_prescriptions', { view: 'raw' }));
    expect(raw).toHaveProperty('serviceResult', 0);
    expect(raw).toHaveProperty('data.reportCards');
  });

  it('tolerates a response with no refill list', async () => {
    const h = await harness(stubClient({ getRefills: async () => ({}) }));
    const out = parseToolResult<{ count: number }>(await h.callTool('rxlocal_list_prescriptions', {}));
    expect(out.count).toBe(0);
  });
});

describe('rxlocal_get_refill_options', () => {
  it('compact lists choices, pharmacy and disclaimers in an untrusted envelope, without patient PII', async () => {
    const getConveyanceOptions = vi.fn(async () => structuredClone(OPTIONS));
    const h = await harness(stubClient({ getConveyanceOptions }));
    const out = parseToolResult<Json>(await h.callTool('rxlocal_get_refill_options', {}));
    expect(getConveyanceOptions).toHaveBeenCalledWith('DEI-1', 'P-1', 'P-1', 'U-1');
    expect(out.untrusted_content).toBe(true);
    expect(out.conveyanceOptions).toEqual(['pickup', 'delivery']);
    expect(out.pickupTimeOptions).toEqual([
      { value: 'asap', label: 'As soon as possible' },
      { value: 'later', label: 'Later' },
    ]);
    expect(out.pharmacy).toMatchObject({ name: 'Test Pharmacy', phone: '555-0199', timeZone: 'Eastern' });
    expect((out.disclaimers as Json[]).map((d) => d.type)).toEqual(['General', 'Delivery']);
    expect(out.calendar).toMatchObject({ minDate: '2026-11-02T00:00:00' });
    const text = JSON.stringify(out);
    expect(text).not.toContain('1 Example St');
    expect(text).not.toContain('555-0100');
  });

  it('takes an explicit location; full and raw include the rest', async () => {
    const getConveyanceOptions = vi.fn(async () => structuredClone(OPTIONS));
    const h = await harness(stubClient({ getConveyanceOptions }));
    const full = parseToolResult<Json>(
      await h.callTool('rxlocal_get_refill_options', { data_exchange_identifier: 'DEI-9', view: 'full' }),
    );
    expect(getConveyanceOptions).toHaveBeenCalledWith('DEI-9', 'P-1', 'P-1', 'U-1');
    expect(full).toHaveProperty('patientPhone', '555-0100');
    expect(full.untrusted_content).toBe(true);
    const raw = parseToolResult<Json>(await h.callTool('rxlocal_get_refill_options', { view: 'raw' }));
    expect(raw).toHaveProperty('succeeded', true);
  });

  it('maps unknown enum values through and tolerates empty data', async () => {
    const h = await harness(
      stubClient({
        getConveyanceOptions: async () => ({
          data: { conveyanceOptions: [9], pickupTimeOptions: [{ timeOptionType: 7 }, { timeOptionType: 1 }],
            refillDisclaimers: [{ text: 'b' }, { text: 'a', displaySequence: 0 }, { text: 'c' }] },
        }),
      }),
    );
    const out = parseToolResult<Json>(await h.callTool('rxlocal_get_refill_options', {}));
    expect(out.conveyanceOptions).toEqual([9]);
    expect(out.pickupTimeOptions).toEqual([{ value: 7 }, { value: 'asap' }]);
    const empty = await harness(stubClient({ getConveyanceOptions: async () => ({}) }));
    const e = parseToolResult<Json>(await empty.callTool('rxlocal_get_refill_options', {}));
    expect(e.conveyanceOptions).toEqual([]);
    const emptyFull = parseToolResult<Json>(await empty.callTool('rxlocal_get_refill_options', { view: 'full' }));
    expect(emptyFull.untrusted_content).toBe(true);
  });

  it('errors with a hint when the account has no primary location', async () => {
    const h = await harness(
      stubClient({
        accountContext: async () => ({ groupOwnerID: 'P-1', rxLocalPatientID: 'P-1', dataExchangeIdentifier: undefined,
          userId: 'U-1', displayName: 'Jane Doe' }),
      }),
    );
    const res = await h.callTool('rxlocal_get_refill_options', {});
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/data_exchange_identifier/);
  });
});

describe('rxlocal_list_messages', () => {
  it('returns newest first in an untrusted envelope with no recipient contact details', async () => {
    const syncMessages = vi.fn(async () => (await stubClient().syncMessages({} as never)));
    const h = await harness(stubClient({ syncMessages }));
    const out = parseToolResult<{ untrusted_content: boolean; note: string; count: number; messages: Json[] }>(
      await h.callTool('rxlocal_list_messages', {}),
    );
    expect(syncMessages).toHaveBeenCalledWith(expect.objectContaining({ groupOwnerID: 'P-1', dataExchangeIdentifier: 'DEI-1' }));
    expect(out.untrusted_content).toBe(true);
    expect(out.note).toMatch(/pharmacy staff/);
    expect(out.messages.map((m) => m.messageID)).toEqual(['M-2', 'M-1']);
    expect(out.messages[1]).toMatchObject({ from: 'Test Pharmacy Staff', to: ['Jane Doe'], body: 'Your order is ready.' });
    expect(out.messages[0]).not.toHaveProperty('to');
    const text = JSON.stringify(out);
    for (const pii of ['jane@example.com', '555-0100', 'sms.example.com']) expect(text).not.toContain(pii);
  });

  it('full keeps the structure but still strips contact details; limit caps the list', async () => {
    const h = await harness();
    const out = parseToolResult<{ count: number; total: number; messages: Json[] }>(
      await h.callTool('rxlocal_list_messages', { view: 'full', limit: 1 }),
    );
    expect(out.count).toBe(1);
    expect(out.total).toBe(2);
    const all = parseToolResult<{ messages: Json[] }>(await h.callTool('rxlocal_list_messages', { view: 'full' }));
    expect(all.messages[1]).toHaveProperty('recipients.0.messageUserID', 'MU-2');
    const text = JSON.stringify(all);
    for (const pii of ['jane@example.com', '555-0100', 'sms.example.com']) expect(text).not.toContain(pii);
  });

  it('tolerates an empty answer and messages with no dates', async () => {
    const h = await harness(stubClient({ syncMessages: async () => ({}) }));
    const out = parseToolResult<{ count: number }>(await h.callTool('rxlocal_list_messages', {}));
    expect(out.count).toBe(0);
    const h2 = await harness(
      stubClient({ syncMessages: async () => ({ data: { messagesToAddUpdate: [{ messageID: 'a' }, { messageID: 'b', sentOn: '2026-01-01' }, { messageID: 'c' }] } }) }),
    );
    const out2 = parseToolResult<{ messages: Json[] }>(await h2.callTool('rxlocal_list_messages', {}));
    expect(out2.messages.map((m) => m.messageID)).toEqual(['b', 'a', 'c']);
  });

  it('stripContactPii removes contact keys at any depth', () => {
    expect(stripContactPii({ a: [{ email: 'x', phone: 'y', smsPhone: 'z', keep: 1 }], n: null })).toEqual({
      a: [{ keep: 1 }],
      n: null,
    });
  });
});
