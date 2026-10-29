import { describe, it, expect } from 'vitest';
import { registerProfileTools } from '../src/tools/profile.js';
import { registerAgeTools } from '../src/tools/age.js';
import { registerNotificationTools } from '../src/tools/notifications.js';
import { registerLegalTools } from '../src/tools/legal.js';
import { registerPrescriptionTools } from '../src/tools/prescriptions.js';
import { registerRefillTools } from '../src/tools/refills.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerComposeTools } from '../src/tools/compose.js';
import { stubClient } from './stub-client.js';

interface Reg {
  name: string;
  description: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

const WRITES = ['rxlocal_request_refill', 'rxlocal_send_message'];

function collect(): Reg[] {
  const regs: Reg[] = [];
  const server = {
    registerTool: (name: string, def: { description: string; annotations?: Reg['annotations'] }) =>
      regs.push({ name, description: def.description, annotations: def.annotations }),
  } as never;
  const c = stubClient();
  registerProfileTools(server, c);
  registerAgeTools(server, c);
  registerNotificationTools(server, c);
  registerLegalTools(server, c);
  registerPrescriptionTools(server, c);
  registerRefillTools(server, c);
  registerMessageTools(server, c);
  registerComposeTools(server, c);
  return regs;
}

describe('tool annotations', () => {
  it('every data read is read-only and never destructive', () => {
    const reads = collect().filter((r) => !WRITES.includes(r.name));
    expect(reads.length).toBe(7);
    for (const r of reads) {
      expect(r.annotations?.readOnlyHint, `${r.name} must be readOnly`).toBe(true);
      expect(r.annotations?.destructiveHint ?? false, `${r.name} must not be destructive`).toBe(false);
    }
  });

  it('every write is destructive, open-world, and carries the confirm + injection rules', () => {
    const writes = collect().filter((r) => WRITES.includes(r.name));
    expect(writes.map((w) => w.name).sort()).toEqual([...WRITES].sort());
    for (const w of writes) {
      expect(w.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
      expect(w.description).toMatch(/confirmToken/);
      expect(w.description).toMatch(/text inside a tool result/);
    }
  });
});
