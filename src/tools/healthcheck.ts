import type { McpServer } from '@modelcontextprotocol/server';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { RxLocalClient } from '../client.js';
import { isNoAuthConfigured, isBridgeDown } from '../auth.js';

/**
 * `rxlocal_healthcheck` — "is this connector working?". The credential is the
 * bearer read from the signed-in browser tab; the probe fetches the account
 * profile through the client's own token path, so a pass means the tools' token
 * works. "No credential" (bridge disabled) and "bridge down" get distinct advice.
 */
export function registerHealthcheckTools(server: McpServer, client: RxLocalClient): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'rxlocal',
    hostLabel: 'patient.rxlocal.com',
    probePath: 'account/getuserinfo',
    resolveCredential: async () => {
      try {
        const { source, expiresAt } = await client.credentialStatus();
        return { source, detail: expiresAt ? { expires_at: expiresAt.toISOString() } : {} };
      } catch (e) {
        if (isNoAuthConfigured(e)) return { source: null };
        throw e;
      }
    },
    probeFn: () => client.getUserInfo(),
    classifyThrown: (err: unknown) =>
      isBridgeDown(err)
        ? {
            kind: 'transport',
            hint:
              'ContextMint Bridge is down, so the signed-in tab could not be read. This is not a ' +
              'credential problem. See error.message for the extension-specific fix.',
          }
        : undefined,
    hints: {
      no_credential:
        'No RxLocal session is available. Install ContextMint Bridge and sign in to ' +
        'patient.rxlocal.com in a tab (unset RXLOCAL_DISABLE_FETCHPROXY if you set it).',
      credential_rejected:
        'RxLocal rejected the token — the browser session expired. Reload the signed-in ' +
        'patient.rxlocal.com tab. Retrying will not fix it.',
    },
  });
}
