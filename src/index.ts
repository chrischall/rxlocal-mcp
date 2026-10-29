import { runMcp } from '@chrischall/mcp-utils';
import { SERVER_NAME, VERSION } from './version.js';
import { RxLocalClient } from './client.js';
import { registerProfileTools } from './tools/profile.js';
import { registerAgeTools } from './tools/age.js';
import { registerNotificationTools } from './tools/notifications.js';
import { registerLegalTools } from './tools/legal.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';

// Build the client once in the caller: runMcp constructs a server instance per
// served connection, so anything built inside a registrar would be rebuilt.
const client = new RxLocalClient();

await runMcp({
  name: SERVER_NAME,
  version: VERSION,
  banner: '[rxlocal-mcp] This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: [
    registerProfileTools,
    registerAgeTools,
    registerNotificationTools,
    registerLegalTools,
    registerHealthcheckTools,
  ],
});
