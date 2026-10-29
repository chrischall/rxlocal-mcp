import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult } from '@chrischall/mcp-utils';
import type { RxLocalClient } from '../client.js';

export function registerAgeTools(server: McpServer, client: RxLocalClient): void {
  server.registerTool(
    'rxlocal_age_gate',
    {
      description:
        "Get the RxLocal account-holder age gate: whether the account holder is under the portal's minimum age, and what that minimum is. Returns { underMinimumAge, minimumAge }.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({}),
    },
    async () => minifiedResult(await client.getAge()),
  );
}
