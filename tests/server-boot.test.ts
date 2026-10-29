import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = [
  'rxlocal_profile', 'rxlocal_age_gate', 'rxlocal_notifications', 'rxlocal_legal', 'rxlocal_healthcheck',
  'rxlocal_list_prescriptions', 'rxlocal_get_refill_options', 'rxlocal_list_messages',
  'rxlocal_request_refill', 'rxlocal_send_message',
];

describe('server boots from the bundle with no node_modules', () => {
  let dir: string;

  beforeAll(() => {
    if (!existsSync(join(ROOT, 'dist', 'bundle.js'))) {
      spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
    }
    // Copy the bundle + a minimal package.json into a scratch dir with NO
    // node_modules — the .mcpb runtime — so an eager import of an external dep
    // would crash at load.
    dir = mkdtempSync(join(tmpdir(), 'rxlocal-boot-'));
    cpSync(join(ROOT, 'dist', 'bundle.js'), join(dir, 'bundle.js'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  });

  it('answers initialize + tools/list over stdio', async () => {
    const client = new Client({ name: 'boot-test', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(dir, 'bundle.js')],
      env: { ...process.env, RXLOCAL_DISABLE_FETCHPROXY: '1' },
    });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();
    expect(tools.length).toBeGreaterThanOrEqual(EXPECTED.length);
    for (const name of EXPECTED) expect(tools).toContain(name);
  }, 30_000);
});
