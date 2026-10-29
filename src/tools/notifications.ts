import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult } from '@chrischall/mcp-utils';
import type { RxLocalClient } from '../client.js';

export function registerNotificationTools(server: McpServer, client: RxLocalClient): void {
  server.registerTool(
    'rxlocal_notifications',
    {
      description:
        "Get the RxLocal most-relevant notification banner for the signed-in account. Returns { messageType } — the portal's current banner state (e.g. a pending action or none). The account's RxLocal patient id is resolved automatically.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const { rxLocalPatientID } = await client.getUserInfo();
      return minifiedResult(await client.getNotifications(rxLocalPatientID));
    },
  );
}
