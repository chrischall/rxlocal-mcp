/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`, spec 2026-11-03 D4), and the `view: "brief"` rung the
 * canonical reads answer a group's question in. Inert data to any other
 * client: a host that does not read them sees an extra `_meta` key.
 *
 * The shape is fixed by the host's contract, so it is restated here rather
 * than imported — this server takes no dependency on mcp-host. `aliases` are
 * the words a person says, lowercase, at most 8, each at most 40 chars. No
 * tool here names a `subject` (one signed-in account holder, no listable set
 * of people to fan out over) or a `when` (neither canonical read takes a range).
 */
import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { UNTRUSTED_CONTENT_RULE, untrustedResult, viewParam, type View } from '@chrischall/mcp-utils';

export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'health';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for an RxLocal tool: every tool here is in the `health` group. */
export function healthMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {},
): { mint: MintHint } {
  return { mint: { domain: 'health', intent, ...extra } };
}

/**
 * `server`, with `_meta` added to every tool registered through it. For the
 * confirm-gated writes: `registerWrite` builds the `registerTool` config
 * itself and takes no `_meta`, so the hint is attached on the way through.
 */
export function withMeta(server: McpServer, meta: Record<string, unknown>): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, config: Record<string, unknown>, cb: unknown) =>
          (target.registerTool as (...a: unknown[]) => unknown).call(
            target,
            name,
            { ...config, _meta: { ...(config._meta as Record<string, unknown> | undefined), ...meta } },
            cb,
          );
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** The longest a brief line may be. */
export const BRIEF_MAX = 120;

const BRIEF_NOTE =
  '"brief": one line per item, `title — <YYYY-MM-DD or "no date"> — <status>`, at most 120 chars each, ' +
  'as the untrusted envelope\'s `data`; a line starting "-- " is a note ("-- none", "-- N of M shown").';

/**
 * The `view` parameter of a canonical read: the tool's own rungs plus
 * `brief`. Absent still means compact.
 */
export function briefViewParam(rungs: readonly View[], note: string) {
  const base = viewParam(rungs);
  return z
    .enum([...rungs, 'brief'] as readonly string[] as [string, ...string[]])
    .optional()
    .describe(`${base.description ?? ''} ${BRIEF_NOTE} ${note}`.trim());
}

/** Whitespace collapsed, so one item stays one line; `undefined` when empty. */
export function flat(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const out = s.replace(/\s+/g, ' ').trim();
  return out ? out : undefined;
}

/** `YYYY-MM-DD` of an ISO-ish date string, or `undefined`. */
export function isoDay(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

/** The shortest a title is cut to before the status gives way too. */
const TITLE_FLOOR = 24;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(n - 1, 0))}…` : s);

/**
 * `title — date — status`, cut to ≤ 120 chars as a WHOLE, title first: the
 * title shortens until the line fits, and only once it is at its floor does
 * the status give way too. A title starting with `-- ` (a note) or `\` is
 * escaped with one leading `\`, which the host strips after its note check,
 * so an item can never read as a note (the consolidated brief-view contract).
 */
export function briefLine(rawTitle: string, date: string | undefined, status: string): string {
  const title = rawTitle.startsWith('-- ') || rawTitle.startsWith('\\') ? `\\${rawTitle}` : rawTitle;
  const sep = ` — ${date ?? 'no date'} — `;
  const room = BRIEF_MAX - sep.length;
  if (title.length + status.length <= room) return `${title}${sep}${status}`;
  const shownTitle = cut(title, Math.max(room - status.length, Math.min(title.length, TITLE_FLOOR)));
  return `${shownTitle}${sep}${cut(status, room - shownTitle.length)}`;
}

/**
 * The brief answer: the lines inside the fleet's untrusted-data envelope as
 * `{ untrusted_content, note, data: string[] }`, minified — drug and sender
 * names are text the pharmacy wrote. Nothing to show is the one note line
 * `-- none`; a host composing a group answer unwraps `data`.
 */
export function briefResult(lines: string[], whoWrote: string): CallToolResult {
  return untrustedResult(lines.length > 0 ? lines : ['-- none'], { note: `${whoWrote} ${UNTRUSTED_CONTENT_RULE}` });
}
