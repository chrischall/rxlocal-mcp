// Pharmacy message write: send a plain-text secure message to your pharmacy.
// Confirm-gated (`defineWrite` + `registerWrite`): the pharmacy receives the
// message and there is no unsend.
//
// The shape (`POST Messaging/CreatePatientMessage`) is derived from the RxLocal
// SPA bundle and is UNVERIFIED on the wire: no message has been sent.
// Attachments are out of scope.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError, NonEmptyString, defineWrite, registerWrite } from '@chrischall/mcp-utils';
import type { RxLocalClient } from '../client.js';
import { WRITE, compactResult, sendOnce, writeDescription } from './_writes.js';

/** The `CreatePatientMessage` body, as the SPA builds it (no attachment). */
export function buildMessagePayload(input: {
  groupOwnerID: string;
  rxLocalPatientID: string;
  dataExchangeIdentifier: string;
  body: string;
}): Record<string, unknown> {
  return {
    GroupOwnerID: input.groupOwnerID,
    RxLocalPatientID: input.rxLocalPatientID,
    DataExchangeIdentifier: input.dataExchangeIdentifier,
    Body: input.body,
  };
}

export function registerComposeTools(server: McpServer, client: RxLocalClient): void {
  registerWrite(
    server,
    defineWrite({
      name: 'rxlocal_send_message',
      description: writeDescription(
        'Send a plain-text secure message to your RxLocal pharmacy (your primary pharmacy location). ' +
          'The pharmacy receives it and it cannot be unsent. Not for emergencies: the pharmacy may not ' +
          'read it promptly. No attachments. Check it afterwards with rxlocal_list_messages.',
      ),
      annotations: WRITE,
      inputSchema: z.object({
        body: NonEmptyString.max(2000).describe('Message text (plain text).'),
      }),
      async plan({ body }) {
        const text = body.trim();
        if (text === '') {
          throw new McpToolError('The message must contain text.', { hint: 'Nothing was sent.' });
        }
        const ctx = await client.accountContext();
        if (ctx.dataExchangeIdentifier === undefined) {
          throw new McpToolError('Your RxLocal account names no primary pharmacy location to message.', {
            hint: 'Message the pharmacy from the portal instead.',
          });
        }
        const payload = buildMessagePayload({
          groupOwnerID: ctx.groupOwnerID,
          rxLocalPatientID: ctx.rxLocalPatientID,
          dataExchangeIdentifier: ctx.dataExchangeIdentifier,
          body: text,
        });
        return {
          gate: {
            action: 'rxlocal.send_message',
            summary: 'Send a secure message to your RxLocal pharmacy',
            account: ctx.userId,
            target: ctx.dataExchangeIdentifier,
            request: { method: 'POST', path: 'Messaging/CreatePatientMessage', body: payload },
            willSend: { body: text },
            preview: {
              caveat:
                'This send is derived from the RxLocal web app and has not yet been verified against ' +
                'the live portal. Check rxlocal_list_messages afterwards.',
              disclaimer: 'Not for emergencies: call 911 or the pharmacy directly.',
            },
          },
          state: { payload },
        };
      },
      async execute({ payload }) {
        return sendOnce(
          async () => {
            await client.createMessage(payload);
            return { sent: true, note: 'Check it appears with rxlocal_list_messages.' };
          },
          'message',
          'rxlocal_list_messages',
        );
      },
      render: compactResult,
    }),
  );
}
