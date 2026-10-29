import { describe, it, expect, beforeAll } from 'vitest';
import { registerProfileTools } from '../src/tools/profile.js';
import { registerAgeTools } from '../src/tools/age.js';
import { registerNotificationTools } from '../src/tools/notifications.js';
import { registerLegalTools } from '../src/tools/legal.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerPrescriptionTools } from '../src/tools/prescriptions.js';
import { registerRefillTools } from '../src/tools/refills.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerComposeTools } from '../src/tools/compose.js';
import { createTestHarness, parseToolResult } from './helpers.js';
import { stubClient } from './stub-client.js';

const EXPECTED = [
  'rxlocal_profile',
  'rxlocal_age_gate',
  'rxlocal_notifications',
  'rxlocal_legal',
  'rxlocal_healthcheck',
  'rxlocal_list_prescriptions',
  'rxlocal_get_refill_options',
  'rxlocal_list_messages',
  'rxlocal_request_refill',
  'rxlocal_send_message',
];

describe('tool registry', () => {
  let harness: Awaited<ReturnType<typeof createTestHarness>>;
  let registered: string[];

  beforeAll(async () => {
    const client = stubClient();
    harness = await createTestHarness((server) => {
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
    registered = (await harness.listTools()).map((t) => t.name).sort();
  });

  it('registers exactly the expected tools', () => {
    expect(registered).toEqual([...EXPECTED].sort());
  });
});

describe('tool behavior', () => {
  async function harnessWith(client = stubClient()) {
    return createTestHarness((server) => {
      registerProfileTools(server, client);
      registerAgeTools(server, client);
      registerNotificationTools(server, client);
      registerLegalTools(server, client);
    });
  }

  it('profile compact merges name and exposes ids', async () => {
    const h = await harnessWith();
    const out = parseToolResult<{ name: string; patientId: string; userId: string }>(
      await h.callTool('rxlocal_profile', {}),
    );
    expect(out.name).toBe('Jane Doe');
    expect(out.patientId).toBe('P-1');
    expect(out.userId).toBe('U-1');
  });

  it('profile full returns the raw record', async () => {
    const h = await harnessWith();
    const out = parseToolResult<{ roles: string[]; entityStatus: string }>(
      await h.callTool('rxlocal_profile', { view: 'full' }),
    );
    expect(out.roles).toEqual(['patient']);
    expect(out.entityStatus).toBe('Active');
  });

  it('age gate returns the gate shape', async () => {
    const h = await harnessWith();
    const out = parseToolResult<{ minimumAge: number }>(await h.callTool('rxlocal_age_gate', {}));
    expect(out.minimumAge).toBe(18);
  });

  it('notifications resolves the patient id automatically', async () => {
    const h = await harnessWith();
    const out = parseToolResult<{ messageType: number }>(await h.callTool('rxlocal_notifications', {}));
    expect(out.messageType).toBe(1);
  });

  it('legal compact returns metadata and length, not the full html', async () => {
    const client = stubClient({
      getLegal: async () => ({ id: 2, content: 'x'.repeat(5000), userAcceptanceRequired: true }),
    });
    const h = await harnessWith(client);
    const out = parseToolResult<{ contentLength: number; content?: string }>(
      await h.callTool('rxlocal_legal', { document: 'termsofuse' }),
    );
    expect(out.contentLength).toBe(5000);
    expect(out.content).toBeUndefined();
  });

  it('legal full returns the document content', async () => {
    const h = await harnessWith();
    const out = parseToolResult<{ content: string }>(
      await h.callTool('rxlocal_legal', { document: 'privacypolicy', view: 'full' }),
    );
    expect(out.content).toBe('<p>x</p>');
  });
});
