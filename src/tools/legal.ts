import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, pruneUndefined, resolveView, viewParam } from '@chrischall/mcp-utils';
import type { RxLocalClient, LegalKind } from '../client.js';

const LEGAL_VIEWS = ['compact', 'full'] as const;

export function registerLegalTools(server: McpServer, client: RxLocalClient): void {
  server.registerTool(
    'rxlocal_legal',
    {
      description:
        "Get an RxLocal legal document: the Terms of Use or the Privacy Policy. The compact default returns id, whether acceptance is required, dates and the content length; pass view:'full' for the full document HTML (large).",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        document: z.enum(['termsofuse', 'privacypolicy']).describe('Which legal document to fetch'),
        view: viewParam(LEGAL_VIEWS),
      }),
    },
    async ({ document, view }) => {
      const doc = await client.getLegal(document as LegalKind);
      if (resolveView(view, LEGAL_VIEWS) === 'full') return minifiedResult(doc);
      return minifiedResult(
        pruneUndefined({
          id: doc.id,
          document,
          userAcceptanceRequired: doc.userAcceptanceRequired,
          createdOn: doc.createdOn,
          updatedOn: doc.updatedOn,
          contentLength: doc.content?.length ?? 0,
        }),
      );
    },
  );
}
