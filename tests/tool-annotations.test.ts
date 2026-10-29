import { describe, it, expect } from 'vitest';
import { registerProfileTools } from '../src/tools/profile.js';
import { registerAgeTools } from '../src/tools/age.js';
import { registerNotificationTools } from '../src/tools/notifications.js';
import { registerLegalTools } from '../src/tools/legal.js';
import { stubClient } from './stub-client.js';

interface Reg { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }

function collect(): Reg[] {
  const regs: Reg[] = [];
  const server = { registerTool: (name: string, def: { annotations?: Reg['annotations'] }) => regs.push({ name, annotations: def.annotations }) } as never;
  const c = stubClient();
  registerProfileTools(server, c);
  registerAgeTools(server, c);
  registerNotificationTools(server, c);
  registerLegalTools(server, c);
  return regs;
}

describe('tool annotations', () => {
  it('every data tool is read-only and never destructive', () => {
    for (const r of collect()) {
      expect(r.annotations?.readOnlyHint, `${r.name} must be readOnly`).toBe(true);
      expect(r.annotations?.destructiveHint ?? false, `${r.name} must not be destructive`).toBe(false);
    }
  });
});
