import { describe, it, expect, vi } from 'vitest';
import { ApiError, WriteOutcomeUnknownError } from '@chrischall/mcp-utils';
import { registerRefillTools, buildRefillRequest, readRefillResults } from '../src/tools/refills.js';
import { registerComposeTools, buildMessagePayload } from '../src/tools/compose.js';
import { createTestHarness, parseToolResult } from './helpers.js';
import { stubClient, OPTIONS, REFILLS } from './stub-client.js';
import type { RxLocalClient } from '../src/client.js';

type Json = Record<string, unknown>;

async function rig(overrides: Partial<Record<keyof RxLocalClient, unknown>> = {}) {
  const requestRefills = vi.fn(async () => [{ succeeded: true, number: 1 }]);
  const createMessage = vi.fn(async () => ({ succeeded: true }));
  const client = stubClient({ requestRefills, createMessage, ...overrides });
  const h = await createTestHarness((server) => {
    registerRefillTools(server, client);
    registerComposeTools(server, client);
  });
  const call = (name: string, args: Json) => h.callTool(name, args);
  /** Phase 1, then phase 2 with the issued token. */
  const confirmed = async (name: string, args: Json) => {
    const preview = parseToolResult<{ confirmToken: string }>(await call(name, args));
    return call(name, { ...args, confirmToken: preview.confirmToken });
  };
  return { call, confirmed, requestRefills: (overrides.requestRefills ?? requestRefills) as ReturnType<typeof vi.fn>,
    createMessage: (overrides.createMessage ?? createMessage) as ReturnType<typeof vi.fn> };
}

const errText = (res: { content: unknown }) => JSON.stringify(res.content);

describe('pure builders', () => {
  it('builds a refill Request entry as the SPA does (Status 2 for a renewal)', () => {
    const [a, b] = REFILLS.data.refills;
    expect(
      buildRefillRequest({
        rxLocalPatientID: 'P-1', dataExchangeIdentifier: 'DEI-1', refills: [a!, b!], patientName: 'Jane Doe',
        conveyance: 1, pickupTime: 1, pickupDate: null, comment: null,
      }),
    ).toEqual({
      RxLocalPatientID: 'P-1',
      DataExchangeIdentifier: 'DEI-1',
      DetailList: [
        { PioneerRxID: 'RX-1', RxNumber: 1000001, DisplayName: 'Drug A 10mg Tablet', Status: 1, PharmacyName: 'Test Pharmacy', PatientName: 'Jane Doe' },
        { PioneerRxID: 'RX-2', RxNumber: 1000002, DisplayName: 'Drug B 5mg Capsule', Status: 2, PharmacyName: 'Test Pharmacy', PatientName: 'Jane Doe' },
      ],
      ConveyanceType: 1,
      UserPickupTimeOption: 1,
      PickupLaterDate: null,
      Comments: null,
    });
  });

  it('reads per-item results: !succeeded or number -1 is not requested', () => {
    expect(readRefillResults({ x: 1 }, [])).toBeUndefined();
    expect(
      readRefillResults(
        [{ succeeded: true, number: 5 }, { succeeded: true, number: -1 }, { succeeded: false, message: 'no' }, null],
        ['a', 'b', 'c', 'd'],
      ),
    ).toEqual([{ requested: true, name: 'a' }, { requested: false, name: 'b' }, { requested: false, name: 'c', message: 'no' }, { requested: false, name: 'd' }]);
    // misaligned → no names guessed
    expect(readRefillResults([{ succeeded: true }], ['a', 'b'])).toEqual([{ requested: true }]);
  });

  it('builds the CreatePatientMessage body', () => {
    expect(buildMessagePayload({ groupOwnerID: 'P-1', rxLocalPatientID: 'P-1', dataExchangeIdentifier: 'DEI-1', body: 'Hi' }))
      .toEqual({ GroupOwnerID: 'P-1', RxLocalPatientID: 'P-1', DataExchangeIdentifier: 'DEI-1', Body: 'Hi' });
  });
});

describe('rxlocal_request_refill', () => {
  const pickup = { rx_ids: ['RX-1', 'RX-2'], conveyance: 'pickup', pickup_time: 'asap' };

  it('previews the validated request (with untrusted disclaimers) and sends nothing', async () => {
    const r = await rig();
    const out = parseToolResult<{ status: string; confirmToken: string; preview: Json }>(
      await r.call('rxlocal_request_refill', pickup),
    );
    expect(out.status).toBe('confirmation-required');
    expect(out.confirmToken).toEqual(expect.any(String));
    expect(out.preview).toMatchObject({
      method: 'POST',
      path: 'refill/P-1/v1',
      willSend: {
        prescriptions: [
          { name: 'Drug A 10mg Tablet', rxNumber: 1000001, kind: 'refill' },
          { name: 'Drug B 5mg Capsule', rxNumber: 1000002, kind: 'renewal' },
        ],
        pharmacy: 'Test Pharmacy',
        conveyance: 'pickup',
        pickupTime: 'As soon as possible',
      },
      pharmacyDisclaimers: { untrusted_content: true },
    });
    expect(JSON.stringify(out.preview)).toMatch(/not yet been verified/);
    expect(r.requestRefills).not.toHaveBeenCalled();
  });

  it('on confirm sends the SPA body once, with the user id header argument', async () => {
    const r = await rig({ requestRefills: vi.fn(async () => [{ succeeded: true, number: 1 }, { succeeded: true, number: -1 }]) });
    const out = parseToolResult<Json>(
      await r.confirmed('rxlocal_request_refill', { ...pickup, comment: '  please call  ' }),
    );
    expect(r.requestRefills).toHaveBeenCalledTimes(1);
    const [owner, user, body] = r.requestRefills.mock.calls[0]!;
    expect(owner).toBe('P-1');
    expect(user).toBe('U-1');
    expect(body).toMatchObject({
      Requests: [{ RxLocalPatientID: 'P-1', DataExchangeIdentifier: 'DEI-1', ConveyanceType: 1, UserPickupTimeOption: 1,
        PickupLaterDate: null, Comments: 'please call' }],
    });
    expect(out).toMatchObject({
      status: 'partial', pharmacy: 'Test Pharmacy',
      results: [{ requested: true, name: 'Drug A 10mg Tablet' }, { requested: false, name: 'Drug B 5mg Capsule' }],
    });
  });

  it('reports requested when every item succeeded', async () => {
    const r = await rig({ requestRefills: vi.fn(async () => [{ succeeded: true, number: 1 }, { succeeded: true, number: 2 }]) });
    const out = parseToolResult<Json>(await r.confirmed('rxlocal_request_refill', pickup));
    expect(out).toMatchObject({ status: 'requested', results: [{ requested: true, name: 'Drug A 10mg Tablet' }, { requested: true, name: 'Drug B 5mg Capsule' }] });
  });

  it('a "later" pickup sends the date; delivery sends no pickup time', async () => {
    const r = await rig();
    await r.confirmed('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'pickup', pickup_time: 'later', pickup_date: '2026-11-10' });
    expect(r.requestRefills.mock.calls[0]![2]).toMatchObject({ Requests: [{ UserPickupTimeOption: 4, PickupLaterDate: '2026-11-10' }] });
    const d = await rig();
    await d.confirmed('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'delivery' });
    expect(d.requestRefills.mock.calls[0]![2]).toMatchObject({ Requests: [{ ConveyanceType: 2, UserPickupTimeOption: null, Comments: null }] });
  });

  it('pickup with no pickup-time options needs no time', async () => {
    const opts = structuredClone(OPTIONS);
    opts.data.pickupTimeOptions = [];
    const r = await rig({ getConveyanceOptions: async () => opts });
    await r.confirmed('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'pickup' });
    expect(r.requestRefills).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ rx_ids: ['RX-9'], conveyance: 'pickup', pickup_time: 'asap' }, /not on your refill list/],
    [{ rx_ids: ['RX-3'], conveyance: 'pickup', pickup_time: 'asap' }, /cannot be refilled.*unAvailableMessage/s],
    [{ rx_ids: ['RX-1'], conveyance: 'mail' }, /does not offer mail.*pickup, delivery/],
    [{ rx_ids: ['RX-1'], conveyance: 'delivery', pickup_time: 'asap' }, /pickup only/],
    [{ rx_ids: ['RX-1'], conveyance: 'pickup' }, /Choose a pickup time.*asap, later/],
    [{ rx_ids: ['RX-1'], conveyance: 'pickup', pickup_time: 'tomorrow' }, /does not offer the \\"tomorrow\\"/],
    [{ rx_ids: ['RX-1'], conveyance: 'pickup', pickup_time: 'later' }, /needs a pickup_date/],
    [{ rx_ids: ['RX-1'], conveyance: 'pickup', pickup_time: 'later', pickup_date: '2026-12-25' }, /outside.*2026-11-02 to 2026-11-30/],
    [{ rx_ids: ['RX-1'], conveyance: 'pickup', pickup_time: 'later', pickup_date: '2026-11-01' }, /outside/],
    [{ rx_ids: ['RX-1'], conveyance: 'pickup', pickup_time: 'later', pickup_date: '2026-11-26' }, /closed on 2026-11-26/],
    [{ rx_ids: ['RX-1'], conveyance: 'pickup', pickup_time: 'asap', pickup_date: '2026-11-10' }, /only to pickup_time \\"later\\"/],
  ])('refuses %j before sending', async (args, msg) => {
    const r = await rig();
    const res = await r.call('rxlocal_request_refill', args as Json);
    expect(res.isError).toBe(true);
    expect(errText(res)).toMatch(msg);
    expect(r.requestRefills).not.toHaveBeenCalled();
  });

  it('never puts the pharmacy-written unAvailableMessage into the refusal text', async () => {
    const r = await rig();
    const res = await r.call('rxlocal_request_refill', { rx_ids: ['RX-3'], conveyance: 'pickup', pickup_time: 'asap' });
    expect(res.isError).toBe(true);
    expect(errText(res)).not.toContain('Too soon to refill');
  });

  it('refuses a prescription that cannot be refilled even with no pharmacy message', async () => {
    const refills = structuredClone(REFILLS);
    refills.data.refills[2]!.unAvailableMessage = null as never;
    const r = await rig({ getRefills: async () => refills });
    const res = await r.call('rxlocal_request_refill', { rx_ids: ['RX-3'], conveyance: 'pickup', pickup_time: 'asap' });
    expect(errText(res)).toMatch(/cannot be refilled.*rxlocal_send_message/);
  });

  it('refuses another patient\'s prescription and a mix of locations', async () => {
    const other = structuredClone(REFILLS);
    other.data.refills[1]!.rxLocalPatientID = 'P-2';
    const r = await rig({ getRefills: async () => other });
    expect(errText(await r.call('rxlocal_request_refill', { rx_ids: ['RX-2'], conveyance: 'delivery' }))).toMatch(/your own/);
    const mixed = structuredClone(REFILLS);
    mixed.data.refills[1]!.dataExchangeIdentifier = 'DEI-2';
    const m = await rig({ getRefills: async () => mixed });
    expect(errText(await m.call('rxlocal_request_refill', { rx_ids: ['RX-1', 'RX-2'], conveyance: 'delivery' }))).toMatch(/different pharmacy locations/);
  });

  it('falls back to the account ids and tolerates a sparse options answer', async () => {
    const sparse = { data: { refills: [{ rxID: 'RX-1', name: 'Drug A', canRequestRefill: true }] } };
    const r = await rig({ getRefills: async () => sparse, getConveyanceOptions: async () => ({ data: { conveyanceOptions: [2] } }) });
    const out = parseToolResult<{ preview: Json }>(await r.call('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'delivery' }));
    expect(out.preview).toMatchObject({ willSend: { pharmacy: 'your pharmacy' } });
    const none = await rig({ getConveyanceOptions: async () => ({}) });
    expect(errText(await none.call('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'pickup' }))).toMatch(/Offered: none/);
    const noTimes = await rig({ getConveyanceOptions: async () => ({ data: { conveyanceOptions: [1], pickupTimeOptions: [{ timeOptionType: 1 }] } }) });
    expect(errText(await noTimes.call('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'pickup', pickup_time: 'later' }))).toMatch(/Offered: asap/);
    const noCal = await rig({ getConveyanceOptions: async () => ({ data: { conveyanceOptions: [1], pickupTimeOptions: [{ timeOptionType: 4, label: 9 }] } }) });
    const ok = parseToolResult<{ preview: Json }>(
      await noCal.call('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'pickup', pickup_time: 'later', pickup_date: '2030-01-01' }),
    );
    expect(ok.preview).toMatchObject({ willSend: { pickupTime: 'later', pickupDate: '2030-01-01' } });
    const halfCal = await rig({ getConveyanceOptions: async () => ({ data: { conveyanceOptions: [1], pickupTimeOptions: [{ timeOptionType: 4 }], locationCalendar: { maxDate: '2026-11-30' } } }) });
    expect(errText(await halfCal.call('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'pickup', pickup_time: 'later', pickup_date: '2027-01-01' }))).toMatch(/from \? to 2026-11-30/);
    const minOnly = await rig({ getConveyanceOptions: async () => ({ data: { conveyanceOptions: [1], pickupTimeOptions: [{ timeOptionType: 4 }], locationCalendar: { minDate: '2026-11-02' } } }) });
    expect(errText(await minOnly.call('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'pickup', pickup_time: 'later', pickup_date: '2026-01-01' }))).toMatch(/from 2026-11-02 to \?/);
    const noLoc = await rig({
      accountContext: async () => ({ groupOwnerID: 'P-1', rxLocalPatientID: 'P-1', dataExchangeIdentifier: undefined, userId: 'U-1', displayName: 'J' }),
      getRefills: async () => sparse,
    });
    expect(errText(await noLoc.call('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'delivery' }))).toMatch(/different pharmacy locations \(or none\)/);
  });

  it('hints name unknown enum values and nameless prescriptions as-is', async () => {
    const r = await rig({
      getRefills: async () => ({ data: { refills: [{ rxID: 'RX-1', canRequestRefill: true }, { rxID: 'RX-4', canRequestRefill: false }] } }),
      getConveyanceOptions: async () => ({ data: { conveyanceOptions: [9, 1], pickupTimeOptions: [{ timeOptionType: 8 }, { timeOptionType: 1 }] } }),
    });
    expect(errText(await r.call('rxlocal_request_refill', { rx_ids: ['RX-4'], conveyance: 'pickup' }))).toMatch(/RX-4 cannot be refilled/);
    expect(errText(await r.call('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'mail' }))).toMatch(/Offered: 9, pickup/);
    expect(errText(await r.call('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'pickup' }))).toMatch(/Offered: 8, asap/);
    const noTimes = await rig({ getConveyanceOptions: async () => ({ data: { conveyanceOptions: [1] } }) });
    expect(errText(await noTimes.call('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'pickup', pickup_time: 'asap' }))).toMatch(/Offered: none/);
  });

  it('a 2xx with every item refused throws "nothing was requested", naming the pharmacy\'s reason', async () => {
    const r = await rig({ requestRefills: vi.fn(async () => [{ succeeded: false, message: 'Rx on hold.' }]) });
    const res = await r.confirmed('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'delivery' });
    expect(res.isError).toBe(true);
    expect(errText(res)).toMatch(/did not accept/);
    expect(errText(res)).toMatch(/Rx on hold/);
    const bare = await rig({ requestRefills: vi.fn(async () => [{ number: -1 }]) });
    expect(errText(await bare.confirmed('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'delivery' }))).toMatch(/Contact the pharmacy/);
  });

  it('an answer that is not the per-item array is "unconfirmed", not success', async () => {
    const r = await rig({ requestRefills: vi.fn(async () => ({ ok: true })) });
    const out = parseToolResult<Json>(await r.confirmed('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'delivery' }));
    expect(out.status).toBe('unconfirmed');
  });

  it('a sent-then-unknown outcome reports status unknown, never a retry-safe error, and sends once', async () => {
    const requestRefills = vi.fn(async () => {
      throw new WriteOutcomeUnknownError('rxlocal-mcp', 'POST', { cause: new ApiError(502, 'bad gateway') });
    });
    const r = await rig({ requestRefills });
    const res = await r.confirmed('rxlocal_request_refill', { rx_ids: ['RX-1'], conveyance: 'delivery' });
    const out = parseToolResult<Json>(res);
    expect(out.status).toBe('unknown');
    expect(String(out.warning)).toMatch(/do not resend blindly/);
    expect(requestRefills).toHaveBeenCalledTimes(1);
  });

  it('a spent token cannot send twice', async () => {
    const r = await rig();
    const args = { rx_ids: ['RX-1'], conveyance: 'delivery' };
    const preview = parseToolResult<{ confirmToken: string }>(await r.call('rxlocal_request_refill', args));
    await r.call('rxlocal_request_refill', { ...args, confirmToken: preview.confirmToken });
    const again = await r.call('rxlocal_request_refill', { ...args, confirmToken: preview.confirmToken });
    expect(again.isError).toBe(true);
    expect(r.requestRefills).toHaveBeenCalledTimes(1);
  });
});

describe('rxlocal_send_message', () => {
  it('previews the message and sends nothing', async () => {
    const r = await rig();
    const out = parseToolResult<{ preview: Json }>(await r.call('rxlocal_send_message', { body: 'Is my order ready?' }));
    expect(out.preview).toMatchObject({ path: 'Messaging/CreatePatientMessage', willSend: { body: 'Is my order ready?' } });
    expect(r.createMessage).not.toHaveBeenCalled();
  });

  it('on confirm posts the SPA body once', async () => {
    const r = await rig();
    const out = parseToolResult<Json>(await r.confirmed('rxlocal_send_message', { body: ' Is my order ready? ' }));
    expect(r.createMessage).toHaveBeenCalledTimes(1);
    expect(r.createMessage).toHaveBeenCalledWith({ GroupOwnerID: 'P-1', RxLocalPatientID: 'P-1', DataExchangeIdentifier: 'DEI-1', Body: 'Is my order ready?' });
    expect(out).toMatchObject({ sent: true });
  });

  it('refuses a blank message and an account with no pharmacy location', async () => {
    const r = await rig();
    expect(errText(await r.call('rxlocal_send_message', { body: '   ' }))).toMatch(/must contain text/);
    const n = await rig({
      accountContext: async () => ({ groupOwnerID: 'P-1', rxLocalPatientID: 'P-1', dataExchangeIdentifier: undefined, userId: 'U-1', displayName: 'J' }),
    });
    expect(errText(await n.call('rxlocal_send_message', { body: 'hi' }))).toMatch(/no primary pharmacy location/);
    expect(r.createMessage).not.toHaveBeenCalled();
  });

  it('a sent-then-unknown outcome reports status unknown', async () => {
    const createMessage = vi.fn(async () => {
      throw new WriteOutcomeUnknownError('rxlocal-mcp', 'POST', { timeoutMs: 30000 });
    });
    const r = await rig({ createMessage });
    const out = parseToolResult<Json>(await r.confirmed('rxlocal_send_message', { body: 'hi' }));
    expect(out).toMatchObject({ status: 'unknown' });
    expect(String(out.warning)).toMatch(/rxlocal_list_messages/);
  });
});
