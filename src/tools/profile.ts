import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, pruneUndefined, resolveView, viewParam } from '@chrischall/mcp-utils';
import type { RxLocalClient } from '../client.js';

const PROFILE_VIEWS = ['compact', 'full'] as const;

export function registerProfileTools(server: McpServer, client: RxLocalClient): void {
  server.registerTool(
    'rxlocal_profile',
    {
      description:
        "Get the signed-in RxLocal account holder's profile: name, email, phone, account type, and the RxLocal patient + user IDs. The compact default returns name (first + last joined), email, phone, accountType and patientId; pass view:'full' for the raw record including roles, primaryPersonID, entityStatus and the password/terms flags.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({ view: viewParam(PROFILE_VIEWS) }),
    },
    async ({ view }) => {
      const u = await client.getUserInfo();
      if (resolveView(view, PROFILE_VIEWS) === 'full') return minifiedResult(u);
      return minifiedResult(
        pruneUndefined({
          name: `${u.firstName} ${u.lastName}`.trim(),
          email: u.emailAddress,
          phone: u.smsPhone,
          accountType: u.accountType,
          patientId: u.rxLocalPatientID,
          userId: u.globalUserID,
        }),
      );
    },
  );
}
