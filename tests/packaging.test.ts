import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const pkg = read('package.json') as {
  name: string; version: string; files: string[];
  repository?: { url?: string }; publishConfig?: { access?: string };
};

describe('package.json', () => {
  it('declares a repository url (npm --provenance validates it)', () => {
    expect(pkg.repository?.url).toBe('git+https://github.com/chrischall/rxlocal-mcp.git');
  });
  it('ships dist, skills, mint.yaml and the manifests', () => {
    for (const f of ['dist', 'skills', 'mint.yaml', 'server.json', '.mcp.json']) {
      expect(pkg.files, `files must include ${f}`).toContain(f);
    }
  });
});

describe('plugin manifest', () => {
  const plugin = read('.claude-plugin/plugin.json') as Record<string, unknown>;
  it('declares mcpServers, not the ignored mcp key', () => {
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin.mcpServers).toBe('./.mcp.json');
  });
  it('points skills at the directory, which exists', () => {
    expect(plugin.skills).toBe('./skills/');
    expect(existsSync(join(ROOT, 'skills'))).toBe(true);
  });
});

describe('.mcp.json launches the published package', () => {
  it('runs npx -y <package>', () => {
    const mcp = read('.mcp.json') as { mcpServers: Record<string, { command: string; args: string[] }> };
    const s = mcp.mcpServers['rxlocal'];
    expect(s?.command).toBe('npx');
    expect(s?.args).toEqual(['-y', pkg.name]);
  });
});

describe('version consistency across manifests', () => {
  it('every manifest carries the package version', () => {
    const v = pkg.version;
    expect((read('manifest.json') as { version: string }).version).toBe(v);
    expect((read('server.json') as { version: string }).version).toBe(v);
    expect((read('server.json') as { packages: { version: string }[] }).packages[0].version).toBe(v);
    expect((read('.claude-plugin/plugin.json') as { version: string }).version).toBe(v);
    expect((read('.claude-plugin/marketplace.json') as { metadata: { version: string } }).metadata.version).toBe(v);
  });
  it('server.json description is within the registry 100-char limit', () => {
    expect((read('server.json') as { description: string }).description.length).toBeLessThanOrEqual(100);
  });
});

describe('manifest.json tool roster matches the registered tools', () => {
  it('lists exactly the served tools with non-empty descriptions', () => {
    const tools = (read('manifest.json') as { tools: { name: string; description: string }[] }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'rxlocal_age_gate', 'rxlocal_get_refill_options', 'rxlocal_healthcheck', 'rxlocal_legal',
      'rxlocal_list_messages', 'rxlocal_list_prescriptions', 'rxlocal_notifications', 'rxlocal_profile',
      'rxlocal_request_refill', 'rxlocal_send_message',
    ]);
    for (const t of tools) expect(t.description.length, `${t.name} needs a description`).toBeGreaterThan(0);
  });
});
