import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';


let KIND = 'openclaw';
// The following are the shared disk-scan utilities and import engine inlined in this file (originally MemoryPanel/scripts/asset-import/*).
// Depends only on Node built-in modules; behavior is kept consistent with the public CLI.
// ════════════════════════════════════════════════════════════════════════════

// ── Types ──
type AgentKind = string;
interface ScannedSkill {
  name: string;
  content: string;
  resources: { path: string; content: string }[];
  sourceKey: string;
}
interface ScannedMemoryFile {
  messages: { role: 'user'; content: string }[];
  sourceKey: string;
  origin: string;
}
/** Extract the time range and project path from session text (field names adapt automatically; left empty if not found). */
function extractSessionMeta(text: string): { timeRange: string; projectPath: string } {
  const ts: number[] = [];
  let cwd = '';
  const TS_KEYS = new Set(['ts', 'timestamp', 'time', 'created_at', 'starttime', 'endtime', 'sentat', 't']);
  const CWD_KEYS = new Set(['cwd', 'project', 'projectpath', 'workingdir', 'workingdirectory', 'repo', 'workspace']);
  const walk = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (TS_KEYS.has(key)) {
        let d = NaN;
        if (typeof v === 'string') d = Date.parse(v);
        else if (typeof v === 'number') d = v < 1e12 ? v * 1000 : v;
        if (!Number.isNaN(d)) ts.push(d);
      }
      if (!cwd && CWD_KEYS.has(key) && typeof v === 'string' && v.trim()) cwd = v.trim();
      if (typeof v === 'object' && v !== null) walk(v);
    }
  };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { walk(JSON.parse(t)); } catch { /* skip non-JSON lines */ }
  }
  let timeRange = '';
  if (ts.length) {
    ts.sort((a, b) => a - b);
    const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    timeRange = ts.length === 1 ? fmt(ts[0]) : `${fmt(ts[0])} ~ ${fmt(ts[ts.length - 1])}`;
  }
  return { timeRange, projectPath: cwd };
}

interface ScannedSession {
  sessionId: string;
  messages: { role: string; content: string; ts?: number; hasToolUse?: boolean }[];
  sourceKey: string;
  origin: string;
}
interface ScanOptions {
  workspace?: string;
}

// ── Cross-source shared disk-scan utilities (originally scan-util.ts) ──
export function workspaceRoot(opts?: ScanOptions): string | undefined {
  if (!opts?.workspace?.trim()) return undefined;
  const ws = resolve(opts.workspace.trim());
  if (!existsSync(ws) || !statSync(ws).isDirectory()) {
    throw new Error(`--workspace is not a valid directory: ${ws}`);
  }
  return ws;
}

export function projectCwd(opts?: ScanOptions): string {
  return workspaceRoot(opts) ?? process.cwd();
}

export function gitRootOrCwd(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function dirsFromRepoRootToCwd(cwd: string): string[] {
  const root = gitRootOrCwd(cwd);
  const acc: string[] = [];
  let dir = resolve(cwd);
  while (true) {
    acc.push(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return acc.reverse();
}

export function home(): string {
  return homedir();
}

export function expandHomePath(p: string): string {
  return resolve(p.replace(/^~(?=\/|$)/, home()));
}

export function readIfExists(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

export function listMd(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

export function walkFiles(dir: string, pred: (name: string) => boolean): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkFiles(full, pred));
    else if (st.isFile() && pred(name)) out.push(full);
  }
  return out;
}

export function listMdRecursive(dir: string): string[] {
  return walkFiles(dir, (name) => name.endsWith('.md'));
}

export function listJsonlRecursive(dir: string): string[] {
  return walkFiles(dir, (name) => name.endsWith('.jsonl'));
}

export function skillNameFromContent(fallback: string, content: string): string {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const n = fm?.[1].match(/^name:\s*(.+)\s*$/m);
  if (!n) return fallback;
  return n[1].trim().replace(/^['"]|['"]$/g, '') || fallback;
}

export function collectSubfiles(skillDir: string, rel: string, acc: { path: string; content: string }[]): void {
  const full = join(skillDir, rel);
  if (!existsSync(full)) return;
  const st = statSync(full);
  if (st.isDirectory()) {
    for (const child of readdirSync(full)) {
      collectSubfiles(skillDir, join(rel, child), acc);
    }
  } else if (st.isFile()) {
    const text = readFileSync(full, 'utf-8');
    acc.push({ path: rel.split('\\').join('/'), content: text });
  }
}

const DEFAULT_SKILL_SUBDIRS = ['scripts', 'references', 'assets', 'agents'];

/** One level of `<name>/SKILL.md` directory (name uses the directory name; frontmatter is not read). */
export function collectSkillDirs(kind: AgentKind, roots: string[], subdirs = DEFAULT_SKILL_SUBDIRS): ScannedSkill[] {
  const out: ScannedSkill[] = [];
  const seenRoots = new Set<string>();
  for (const root of roots) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('.')) continue;
      const skillDir = join(root, entry);
      if (!statSync(skillDir).isDirectory()) continue;
      const text = readIfExists(join(skillDir, 'SKILL.md'));
      if (text == null) continue;
      const resources: { path: string; content: string }[] = [];
      for (const sub of subdirs) collectSubfiles(skillDir, sub, resources);
      out.push({ name: entry, content: text, resources, sourceKey: `skill:${kind}:${join(root, entry)}` });
    }
  }
  return out;
}

export function memoryFilesFromPaths(kind: AgentKind, files: string[]): ScannedMemoryFile[] {
  const out: ScannedMemoryFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readIfExists(f);
    if (text == null || !text.trim()) continue;
    out.push({ messages: [{ role: 'user', content: text }], sourceKey: `memory:${kind}:${f}`, origin: f });
  }
  return out;
}

export function isHarnessNoise(role: string, content: string): boolean {
  if (role === 'developer' || role === 'system') return true;
  const t = content.trimStart();
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('<permissions') ||
    t.startsWith('<plugins_instructions>') ||
    t.startsWith('<skills_instructions>') ||
    t.startsWith('<turn_aborted>') ||
    t.startsWith('# AGENTS.md instructions') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('Current runtime context')
  );
}

/**
 * Convert a tool-input object into a string (used as structured content in the skill chain; also for flat text in the memory chain).
 */
function argsToString(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/** Extract plain text from a tool_result's content (string / block array / nested object). */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join('\n');
  if (content && typeof content === 'object') {
    const c = (content as Record<string, unknown>).content;
    if (c !== undefined) return blockText(c);
    const tx = (content as Record<string, unknown>).text;
    if (typeof tx === 'string') return tx;
  }
  return '';
}

const strVal = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * A content fragment (structured, used by the skill chain /v3/skill/conversation/add).
 * - When role is omitted, the caller fills in user/assistant according to the record role;
 * - tool_call / tool_result carry their own role and tool_call_id (the pairing anchor required by core; if missing it is rejected with 40001).
 */
interface ContentFrag {
  role?: string;
  content: string;
  tool_call_id?: string;
  tool_name?: string;
}

/** Expand a single content block; nested content arrays recurse. */
function expandBlock(b: unknown): ContentFrag[] {
  if (typeof b === 'string') return [{ content: b }];
  if (b && typeof b === 'object') {
    const bb = b as Record<string, unknown>;
    const type = typeof bb.type === 'string' ? bb.type : '';
    switch (type) {
      // openclaw tool call: {type:'toolCall', id, name, arguments}
      case 'toolCall':
        return [{ role: 'tool_call', tool_call_id: strVal(bb.id), tool_name: strVal(bb.name) || 'unknown', content: (argsToString(bb.arguments ?? bb.input) as string) ?? '' }];
      // anthropic / claude / codex / dsh / hermes tool call: {type:'tool_use', id, name, input}
      case 'tool_use':
        return [{ role: 'tool_call', tool_call_id: strVal(bb.id), tool_name: strVal(bb.name) || 'unknown', content: (argsToString(bb.input ?? bb.arguments) as string) ?? '' }];
      // openai responses tool call: {type:'function_call', name, arguments(string), call_id?}
      case 'function_call':
        return [{ role: 'tool_call', tool_call_id: strVal(bb.call_id) || strVal(bb.id), tool_name: strVal(bb.name) || 'unknown', content: typeof bb.arguments === 'string' ? (bb.arguments as string) : ((argsToString(bb.arguments) as string) ?? '') }];
      // openai message-level tool_calls array (may also appear as block.type==='tool_calls')
      case 'tool_calls': {
        const arr: unknown[] = Array.isArray(bb.tool_calls)
          ? (bb.tool_calls as unknown[])
          : Array.isArray(bb.content)
            ? (bb.content as unknown[])
            : [];
        return arr.map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = (t.function ?? t) as Record<string, unknown>;
          return {
            role: 'tool_call',
            tool_call_id: strVal(t.id),
            tool_name: strVal(fn.name) || 'unknown',
            content: typeof fn.arguments === 'string' ? (fn.arguments as string) : ((argsToString(fn.arguments) as string) ?? ''),
          } as ContentFrag;
        });
      }
      // anthropic tool_result (inside user content) / openai tool output
      case 'tool_result':
        return [{ role: 'tool_result', tool_call_id: strVal(bb.tool_use_id) || strVal(bb.tool_call_id) || strVal(bb.id), tool_name: strVal(bb.toolName) || strVal(bb.name), content: blockText(bb.content) }];
      // openclaw top-level toolResult record (content is the result block)
      case 'toolResult':
        return [{ role: 'tool_result', tool_call_id: strVal(bb.id) || strVal(bb.callId) || strVal(bb.toolCallId), tool_name: strVal(bb.toolName) || strVal(bb.name), content: blockText(bb.content) }];
      default:
        if (typeof bb.text === 'string') return [{ content: bb.text }];
        if (bb.content !== undefined) return expandContent(bb.content);
        return [];
    }
  }
  return [];
}

/** Expand a content (string / block array / nested object) into ordered fragments. */
export function expandContent(content: unknown): ContentFrag[] {
  if (typeof content === 'string') return [{ content }];
  if (Array.isArray(content)) return content.flatMap(expandBlock);
  if (content && typeof content === 'object') {
    const c = (content as Record<string, unknown>).content;
    if (c !== undefined) return expandContent(c);
  }
  return [];
}

/** Flat text for the memory chain (restoring the old behavior: tools are merged into the conversation flow as [tool_call] / [tool_result] text). */
function fragFlatText(f: ContentFrag): string {
  if (f.role === 'tool_call') {
    const one = f.content.replace(/\s+/g, ' ').trim();
    const capped = one.length > 4000 ? `${one.slice(0, 4000)}…` : one;
    return `[tool_call] ${f.tool_name || 'unknown'}(${capped})`;
  }
  if (f.role === 'tool_result') {
    const inner = f.content.replace(/\s+/g, ' ').trim();
    const capped = inner.length > 4000 ? `${inner.slice(0, 4000)}…` : inner;
    return `[tool_result${f.tool_name ? `:${f.tool_name}` : ''}] ${capped}`;
  }
  return f.content;
}

/** Backward compatible with old callers: return the whole flat text (tools merged in as [tool_call]/[tool_result]). */
export function extractText(content: unknown): string {
  return expandContent(content).map(fragFlatText).filter(Boolean).join('\n');
}

/** Determine whether a raw message record contains tool_use/tool_calls (the reverse of the proxy's isFinalAnswer: if it does, it is an intermediate state, not a final answer). */
function recordHasToolUse(rec: Record<string, unknown>, nested?: Record<string, unknown>): boolean {
  for (const src of [rec, nested]) {
    if (!src) continue;
    const s = src as Record<string, unknown>;
    const tc = s.tool_calls;
    if (Array.isArray(tc) && tc.length > 0) return true;
    const c = s.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === 'object') {
          const t = (b as Record<string, unknown>).type;
          if (t === 'tool_use' || t === 'toolCall' || t === 'function_call' || t === 'tool_calls') return true;
        }
      }
    }
  }
  return false;
}

/** Extract a timestamp (milliseconds) from a record object. Compatible with strings and numbers, recognizes common field names; second-level timestamps are automatically converted to milliseconds. */
function extractTimestamp(...cands: unknown[]): number | undefined {
  for (const c of cands) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    for (const k of ['ts', 'timestamp', 'time', 'created_at', 'createdAt', 'datetime', 'date']) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        return v < 1e12 ? Math.round(v * 1000) : v;
      }
      if (typeof v === 'string' && v.trim()) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) return t;
      }
    }
  }
  return undefined;
}

export function parseJsonlLines(text: string): ImportMessage[] {
  const msgs: ImportMessage[] = [];
  let recIdx = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      let rec: Record<string, unknown> = obj;
      if (obj.type === 'event_msg' || obj.type === 'session_meta' || obj.type === 'turn_context' || obj.type === 'world_state') {
        continue;
      }
      if (obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object') {
        rec = obj.payload as Record<string, unknown>;
        if (rec.type && rec.type !== 'message') continue;
      }
      const nested = rec.message && typeof rec.message === 'object' ? (rec.message as Record<string, unknown>) : undefined;
      const role =
        typeof rec.role === 'string'
          ? rec.role
          : typeof nested?.role === 'string'
            ? nested.role
            : rec.type === 'user' || rec.type === 'assistant'
              ? rec.type
              : '';
      // toolResult / tool are treated as part of the user turn (consistent with tool_result entering the user turn in claude/codex).
      // Its structured form is expressed by the fragment role (tool_result); here we only decide the "conversation flow role".
      const outRole = role === 'toolResult' || role === 'tool' ? 'user' : role;
      if (outRole !== 'user' && outRole !== 'assistant') continue;
      const ts = extractTimestamp(rec, nested, obj);
      const frags = expandContent(rec.content ?? nested?.content);
      // openai message-level tool_calls (tool calls when content is null, stored in message.tool_calls)
      const msgToolCalls = (rec.tool_calls ?? nested?.tool_calls) as unknown[] | undefined;
      if (Array.isArray(msgToolCalls)) {
        for (const tc of msgToolCalls) frags.push(expandBlock({ type: 'tool_calls', tool_calls: [tc] })[0]);
      }
      const hasTool = recordHasToolUse(rec, nested);
      let pushedAny = false;
      for (const f of frags) {
        if (f.role === undefined) {
          // Plain text fragment: merged into the conversation flow by record role
          if (f.content && !isHarnessNoise(outRole, f.content)) {
            msgs.push({
              role: outRole,
              content: f.content,
              ts,
              recIdx,
              memRole: outRole,
              ...(outRole === 'assistant' && hasTool ? { hasToolUse: true } : {}),
            });
            pushedAny = true;
          }
        } else {
          // Tool fragment: kept structured (role=tool_call/tool_result, carrying its own tool_call_id pairing anchor)
          msgs.push({
            role: f.role,
            content: f.content,
            ts,
            recIdx,
            memRole: outRole,
            ...(f.tool_call_id ? { tool_call_id: f.tool_call_id } : {}),
            ...(f.tool_name ? { tool_name: f.tool_name } : {}),
          });
          pushedAny = true;
        }
      }
      if (pushedAny) recIdx++;
    } catch {
      // skip non-JSON lines
    }
  }
  return msgs;
}

export function normalizeResponsesJson(path: string): ImportMessage[] {
  const msgs: ImportMessage[] = [];
  // Defensive: a session scan passes in all *.json under the directory, but the same directory may contain non-session config files
  // (such as ~/.workbuddy/argv.json — VS Code-style JSONC with // comments); standard JSON.parse
  // throws on comments/invalid JSON and would crash the whole import. Here a parse failure is treated as "not a session file",
  // returning an empty array (callers all have `if (!msgs.length) continue` which naturally skips it), without affecting normal sessions.
  let obj: unknown;
  try {
    obj = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    console.warn(`[warn] skipping non-session/invalid JSON file: ${path} (${(e as Error).message})`);
    return msgs;
  }
  const input =
    (obj as Record<string, unknown>)?.input ??
    (obj as Record<string, unknown>)?.messages ??
    ((obj as Record<string, unknown>)?.response as Record<string, unknown>)?.output;
  const arr = Array.isArray(input) ? input : [];
  let recIdx = 0;
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const role = typeof it.role === 'string' ? it.role : (typeof it.type === 'string' && it.type !== 'function_call' ? it.type : '');
    let frags: ContentFrag[] = [];
    if (it.type === 'function_call') {
      frags = expandBlock(it); // openai responses top-level tool call
    } else if (role === 'tool' || role === 'toolResult' || role === 'tool_result') {
      // openai native tool-role message: content is a string result with a tool_call_id, should be treated as tool_result
      // kept as a structured pair (rather than degrading to plain user text), otherwise the skill chain gets no tool_result and the memory chain does not mark [tool_result].
      // Note expandBlock returns an array; assign it directly (consistent with the function_call branch; do not wrap it in another []).
      frags = expandBlock({ type: 'tool_result', tool_use_id: it.tool_call_id ?? it.toolCallId, name: it.name ?? it.toolName, content: it.content });
    } else if (Array.isArray(it.content)) {
      frags = expandContent(it.content);
    } else if (typeof it.content === 'string') {
      frags = [{ content: it.content }];
    } else if (typeof it.text === 'string') {
      frags = [{ content: it.text }];
    }
    // openai message-level tool_calls
    if (Array.isArray(it.tool_calls)) {
      for (const tc of it.tool_calls) frags.push(expandBlock({ type: 'tool_calls', tool_calls: [tc] })[0]);
    }
    if (frags.length === 0) continue;
    const outRole = role === 'tool' || role === 'toolResult' ? 'user' : role || 'assistant';
    const hasTool = frags.some((f) => f.role === 'tool_call');
    let pushed = false;
    for (const f of frags) {
      if (f.role === undefined) {
        if (f.content && !isHarnessNoise(outRole, f.content)) {
          msgs.push({
            role: outRole,
            content: f.content,
            recIdx,
            memRole: outRole,
            ...(outRole === 'assistant' && hasTool ? { hasToolUse: true } : {}),
          });
          pushed = true;
        }
      } else {
        msgs.push({
          role: f.role,
          content: f.content,
          recIdx,
          memRole: outRole,
          ...(f.tool_call_id ? { tool_call_id: f.tool_call_id } : {}),
          ...(f.tool_name ? { tool_name: f.tool_name } : {}),
        });
        pushed = true;
      }
    }
    if (pushed) recIdx++;
  }
  return msgs;
}

export function extractCodexSessionId(full: string, text: string): string {
  for (const line of text.split('\n').slice(0, 8)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.type !== 'session_meta') continue;
      const payload = obj.payload && typeof obj.payload === 'object' ? (obj.payload as Record<string, unknown>) : undefined;
      const sid = payload?.session_id ?? payload?.id ?? obj.session_id;
      if (typeof sid === 'string' && sid.trim()) return sid.trim();
    } catch {
      // continue scanning subsequent lines
    }
  }
  const base = basename(full, '.jsonl');
  const uuid = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return uuid ? uuid[0] : base;
}

/** Generic override scan when `--sessions` points to an existing directory/file (jsonl + Responses json). */


export function readJsonObject(p: string): Record<string, unknown> | null {
  const text = readIfExists(p);
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── Import engine: config and HTTP client ──
interface PanelEnvelope<T = unknown> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T;
}

interface ClientConfig {
  /** panel base address, e.g. http://127.0.0.1:8123 */
  panelUrl: string;
  /** Instance spaceId */
  serviceId: string;
  /** per-user apikey (X-Tdai-User-Key) */
  userKey: string;
}

/** Read config from environment variables; error out if missing (no silent defaults). */
export async function loadConfigFromEnv(interactive: boolean = true): Promise<ClientConfig> {
  const panelUrl = process.env.PANEL_URL?.trim();
  const serviceId = process.env.TDAI_SERVICE_ID?.trim();
  const userKey = process.env.TDAI_USER_KEY?.trim();
  const missing: string[] = [];
  if (!panelUrl) missing.push('PANEL_URL');
  if (!serviceId) missing.push('TDAI_SERVICE_ID');
  if (!userKey) missing.push('TDAI_USER_KEY');
  if (missing.length > 0) {
    // None of the three environment variables is set and we are in an interactive terminal: ask the user for each one
    if (missing.length === 3 && interactive && process.stdin.isTTY) {
      console.log('Required environment variables not detected; please enter them one by one (leaving blank will exit with an error):');
      const inputPanel = (await question('PANEL_URL (panel address, e.g. http://127.0.0.1:8123): ')).trim();
      const inputService = (await question('TDAI_SERVICE_ID (spaceId): ')).trim();
      const inputKey = (await question('TDAI_USER_KEY (sk-mem-...): ')).trim();
      process.env.PANEL_URL = inputPanel;
      process.env.TDAI_SERVICE_ID = inputService;
      process.env.TDAI_USER_KEY = inputKey;
      if (!inputPanel || !inputService || !inputKey) {
        throw new Error('PANEL_URL / TDAI_SERVICE_ID / TDAI_USER_KEY must all be non-empty; please re-run and enter them completely');
      }
      return { panelUrl: inputPanel, serviceId: inputService, userKey: inputKey };
    }
    throw new Error(`Missing required environment variables: ${missing.join(', ')} (you can export them before the command, or use --env-file to specify a .env)`);
  }
  return { panelUrl: panelUrl!, serviceId: serviceId!, userKey: userKey! };
}

export class PanelClient {
  private readonly cfg: ClientConfig;
  constructor(cfg: ClientConfig) {
    this.cfg = cfg;
  }

  /** The only DB-write switch is controlled by the caller (post should not be called in dryRun). */
  async post<T = unknown>(path: string, body: unknown): Promise<PanelEnvelope<T>> {
    // panel routes are uniformly mounted under /api/v1; if the caller's path has no prefix it is added automatically.
    const normPath = path.startsWith('/api/v1') ? path : `/api/v1${path.startsWith('/') ? '' : '/'}${path}`;
    const url = `${this.cfg.panelUrl.replace(/\/$/, '')}${normPath}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tdai-Service-Id': this.cfg.serviceId,
        'X-Tdai-User-Key': this.cfg.userKey,
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json: PanelEnvelope<T>;
    try {
      json = JSON.parse(text) as PanelEnvelope<T>;
    } catch {
      throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }
    if (typeof json.code !== 'number') {
      throw new Error(`Response missing code field (${res.status}): ${text.slice(0, 200)}`);
    }
    // Business envelope (including numeric code) is always returned to the caller to judge; no throw here.
    return json;
  }

  /** Expose serviceId, for endpoints that need space_id such as /skill/conversation/add. */
  get serviceId(): string {
    return this.cfg.serviceId;
  }
}

/** Read the optional --env-file (dotenv style). */
export function loadEnvFile(path: string): void {
  try {
    const raw = readFileSync(path, 'utf-8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (err) {
    throw new Error(`Failed to read env-file: ${(err as Error).message}`);
  }
}

// ── team / agent resolution (iron rule: a single userKey throughout) ──
interface AgentRef {
  agentId: string;
  ownerUserId: string;
}

interface PublicUser {
  user_id?: string;
  id?: string;
  username?: string;
  user?: { user_id?: string; id?: string; username?: string };
}

/** Use userKey to look up the real user_id (auth/verify is exempt from user-key validation; the body carries user_key). */
async function resolveUserId(client: PanelClient, userKey: string): Promise<string> {
  const env = await client.post<PublicUser>('/meta/auth/verify', {
    user_key: userKey,
  });
  if (env.code !== 0 || !env.data) {
    throw new Error(`auth/verify failed code==${env.code} msg=${env.message ?? ''}`);
  }
  const uid =
    (env.data as { user_id?: string }).user_id ??
    (env.data as { id?: string }).id ??
    (env.data as { user?: { user_id?: string } }).user?.user_id;
  if (!uid) throw new Error('auth/verify did not return user_id');
  return uid;
}

/** Resolve the target team: if id is given, verify it exists; if name is given, look it up; if neither, error (never auto-create). */
async function resolveTeam(
  client: PanelClient,
  userId: string,
  opts: { teamId?: string; teamName?: string },
): Promise<string> {
  if (opts.teamId) {
    const env = await client.post<{ items?: Array<{ team_id: string }> }>('/meta/team/list', {
      user_id: userId,
    });
    if (env.code !== 0) throw new Error(`team/list failed code==${env.code} msg=${env.message ?? ''}`);
    const found = (env.data?.items ?? []).find((t) => t.team_id === opts.teamId);
    if (!found) throw new Error(`team_id ${opts.teamId} does not exist or no permission`);
    return opts.teamId!;
  }
  if (opts.teamName) {
    const env = await client.post<{ items?: Array<{ team_id: string; name: string }> }>('/meta/team/list', {
      user_id: userId,
    });
    if (env.code !== 0) throw new Error(`team/list failed code==${env.code} msg=${env.message ?? ''}`);
    const found = (env.data?.items ?? []).find((t) => t.name === opts.teamName);
    if (!found) throw new Error(`team "${opts.teamName}" does not exist; please create it first or use --team-id`);
    return found.team_id;
  }
  throw new Error('Must provide --team-id or --team-name');
}

interface ResolveAgentOpts {
  userId: string;
  teamId: string;
  agentId?: string;
  agentName?: string;
}

/** Resolve the target agent: if id is given, verify existence + owner; if name is given, look it up; if neither, error. */
async function resolveAgent(client: PanelClient, opts: ResolveAgentOpts): Promise<AgentRef> {
  const { userId, teamId } = opts;
  if (opts.agentId) {
    const env = await client.post<AgentRaw>('/meta/agent/get', { agent_id: opts.agentId });
    if (env.code === 404 || (env.code === 0 && !env.data)) {
      throw new Error(`agent_id ${opts.agentId} does not exist`);
    }
    if (env.code !== 0) throw new Error(`agent/get failed code==${env.code} msg=${env.message ?? ''}`);
    const agent = env.data!;
    if (agent.team_id !== teamId) throw new Error(`agent ${opts.agentId} does not belong to team ${teamId}`);
    if (agent.owner_user_id !== userId) {
      throw new Error(
        `agent ${opts.agentId} owner(${agent.owner_user_id}) does not match the user (${userId}) looked up from the current userKey`,
      );
    }
    return { agentId: opts.agentId!, ownerUserId: userId };
  }
  if (opts.agentName) {
    const env = await client.post<{ items?: AgentRaw[] }>('/meta/agent/list', {
      team_id: teamId,
      owner_user_id: userId,
      status: 'active',
    });
    if (env.code !== 0) throw new Error(`agent/list failed code==${env.code} msg=${env.message ?? ''}`);
    const found = (env.data?.items ?? []).find((a) => a.name === opts.agentName);
    if (!found) throw new Error(`agent "${opts.agentName}" does not exist; please create it first or use --agent-id`);
    return { agentId: found.agent_id, ownerUserId: userId };
  }
  throw new Error('Must provide --agent-id or --agent-name');
}

interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
}

// ── Message batching + checkpoint ──
const MAX_MESSAGES_PER_REQUEST = 100;
const MAX_MESSAGE_CHARS = 8192;

interface ImportMessage {
  role: string;
  content: string;
  /** Original source identifier, used for dedup */
  sourceKey?: string;
  /** Message timestamp (milliseconds). Optional; when missing the backend falls back to import order. */
  ts?: number;
  /** Whether this assistant message contains tool_use/tool_calls (intermediate state, not a final answer). Used to align with the proxy's isFinalAnswer split. */
  hasToolUse?: boolean;
  /** Structured field of the skill chain: core /v3/skill/conversation/add requires tool_call/tool_result to carry tool_call_id (the pairing anchor). */
  tool_call_id?: string;
  tool_name?: string;
  /** Source record index, used by the memory chain to restore the old behavior of "one flat message per record". */
  recIdx?: number;
  /** Conversation-flow role used by the memory chain (a tool fragment takes the role of its record). */
  memRole?: string;
}

/** Slice over-long content by code unit, avoiding UTF-16 surrogate pair boundaries (borrowed from TDAI proxy's chunkConversationMessages). */
function splitLongContent(content: string): string[] {
  if (content.length <= MAX_MESSAGE_CHARS) return [content];
  const parts: string[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + MAX_MESSAGE_CHARS, content.length);
    if (end < content.length && isHighSurrogate(content.charCodeAt(end - 1)) && isLowSurrogate(content.charCodeAt(end))) {
      end -= 1;
    }
    parts.push(content.slice(start, end));
    start = end;
  }
  return parts;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}

/** Merge messages with the same sourceKey, slice over-long ones, and split into batches of 100 messages. Returns the batch list. */
function batchMessages(messages: ImportMessage[]): ImportMessage[][] {
  const valid = messages.filter((m) => m.role && m.content.trim());
  const flat: ImportMessage[] = [];
  for (const m of valid) {
    for (const piece of splitLongContent(m.content)) {
      flat.push({
        role: m.role,
        content: piece,
        sourceKey: m.sourceKey,
        ts: m.ts,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_name ? { tool_name: m.tool_name } : {}),
      });
    }
  }
  const batches: ImportMessage[][] = [];
  for (let i = 0; i < flat.length; i += MAX_MESSAGES_PER_REQUEST) {
    batches.push(flat.slice(i, i + MAX_MESSAGES_PER_REQUEST));
  }
  return batches;
}

interface Checkpoint {
  done: string[];
}

function loadCheckpoint(path: string): Checkpoint {
  if (!existsSync(path)) return { done: [] };
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8'));
    if (Array.isArray(obj?.done)) return { done: obj.done };
  } catch {
    // A corrupted checkpoint is treated as empty and not silently ignored — warn, then continue
  }
  return { done: [] };
}

function isDone(cp: Checkpoint, sourceKey: string): boolean {
  return cp.done.includes(sourceKey);
}

/** Checkpoint dedup key: isolated per agent, to avoid wrongly skipping after switching agents. */
function scopedCheckpointKey(agentId: string, sourceKey: string): string {
  return `${agentId}::${sourceKey}`;
}

function markDone(cp: Checkpoint, sourceKey: string): void {
  if (!cp.done.includes(sourceKey)) cp.done.push(sourceKey);
}

function saveCheckpoint(path: string, cp: Checkpoint): void {
  writeFileSync(path, JSON.stringify(cp, null, 2), { mode: 0o600 });
}

/** Stable string hash (non-cryptographic, used only as a dedup key). */
function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// ── skill / memory write and extraction ──
interface WriteCtx {
  teamId: string;
  agentId: string;
  userId: string;
  /**
   * Import target dimension.
   * - 'agent' (default): the skill is bound to the specified agent (agent_id = ctx.agentId).
   * - 'team': import directly into the team asset pool (agent_id = ctx.userId as fallback, aligned with the UI
   *   ImportSkillDialog's target='team' semantics). Supported only for skill import.
   */
  target: 'agent' | 'team';
}

/** Resolve the agent_id a skill actually belongs to: the team pool falls back to userId, aligned with UI semantics. */
function resolveSkillAgentId(ctx: WriteCtx): string {
  return ctx.target === 'team' ? ctx.userId : ctx.agentId;
}

/** Parse name from SKILL.md frontmatter (if present). */
function parseFrontmatterName(content: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const nameLine = fm[1].match(/^name:\s*(.+)\s*$/m);
  if (!nameLine) return null;
  return nameLine[1].trim().replace(/^['"]|['"]$/g, '') || null;
}

interface BatchInput {
  msgs: ImportMessage[];
  sourceKey: string;
  /** Real session_id: shared by all batches, avoiding splitting one conversation into multiple pseudo sessions. */
  sessionId: string;
}

/**
 * Restore structured fragments into the "one flat message per record" needed by the memory chain (consistent with the pre-change behavior:
 * tools are merged into the conversation flow as [tool_call] / [tool_result] text, and no tool_call/tool_result roles appear,
 * because the memory chain /chat-memory/import → core /v3/conversation/add schema accepts only user/assistant/system).
 */
function toMemoryMessages(msgs: ImportMessage[]): ImportMessage[] {
  const groups = new Map<number, ImportMessage[]>();
  for (const m of msgs) {
    const key = m.recIdx ?? -1;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  const out: ImportMessage[] = [];
  for (const [, group] of groups) {
    const role = group[0].memRole || group[0].role;
    const text = group
      .map((m) => {
        if (m.role === 'tool_call') {
          const one = m.content.replace(/\s+/g, ' ').trim();
          const capped = one.length > 4000 ? `${one.slice(0, 4000)}…` : one;
          return `[tool_call] ${m.tool_name || 'unknown'}(${capped})`;
        }
        if (m.role === 'tool_result') {
          const inner = m.content.replace(/\s+/g, ' ').trim();
          const capped = inner.length > 4000 ? `${inner.slice(0, 4000)}…` : inner;
          return `[tool_result${m.tool_name ? `:${m.tool_name}` : ''}] ${capped}`;
        }
        return m.content;
      })
      .filter(Boolean)
      .join('\n');
    if (text.trim()) {
      out.push({
        role,
        content: text,
        sourceKey: inputSourceKey(msgs),
        ...(group[0].ts !== undefined ? { ts: group[0].ts } : {}),
      });
    }
  }
  return out;
}

// Used only by toMemoryMessages to backfill sourceKey (the memory chain body does not depend on it, but keep the structure consistent)
function inputSourceKey(msgs: ImportMessage[]): string | undefined {
  return msgs[0]?.sourceKey;
}

/**
 * Upload the whole session to /chat-memory/import (split into batches of 100 messages).
 * The panel side forwards to core /v3/conversation/add → writes L0 + asynchronously triggers L1 memory extraction.
 * This is the only entry point for memory extraction (independent of the skill chain).
 */
async function uploadBatches(client: PanelClient, ctx: WriteCtx, input: BatchInput): Promise<void> {
  const mem = toMemoryMessages(input.msgs);
  const batches = batchMessages(mem);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const body = {
      team_id: ctx.teamId,
      agent_id: ctx.agentId,
      session_id: input.sessionId,
      messages: batch.map((m) =>
        m.ts !== undefined ? { role: m.role, content: m.content, ts: m.ts } : { role: m.role, content: m.content },
      ),
    };
    const env = await client.post('/chat-memory/import', body);
    if (env.code !== 0) {
      throw new Error(`chat-memory/import failed code==${env.code} msg=${env.message ?? ''}`);
    }
  }
}

/**
 * Split the normalized session messages into multiple rounds by "each real human conversation turn", strictly aligned with the proxy's
 * final-answer splitting rules (handler-glue.ts + normalize-conversation.ts):
 *   - The proxy uses isFinalAnswer(msg) to judge final: only an assistant without tool_use/tool_calls is a final answer;
 *   - Each time a final answer is met, a round is closed; this round = from after the previous final answer to this final answer
 *     (user input + intermediate tool loop + final answer), consistent with the slice semantics of the proxy's findLastFinalAssistant.
 *   - Intermediate tool-state assistants (hasToolUse) do not close a round and stay in the same round.
 * Only rounds containing an assistant (i.e. containing a final answer or a tool-state assistant) are kept, to avoid submitting invalid increments.
 */
function splitIntoRounds(msgs: ImportMessage[]): ImportMessage[][] {
  const rounds: ImportMessage[][] = [];
  let current: ImportMessage[] = [];
  for (const m of msgs) {
    current.push(m);
    // Close a round only upon a final answer (an assistant without tool_use); intermediate tool states do not close (equivalent to the proxy's isFinalAnswer)
    if (m.role === 'assistant' && !m.hasToolUse) {
      rounds.push(current);
      current = [];
    }
  }
  // When the end is not a final answer, send the leftover as a fallback round (the proxy's real-time stream would not trigger it, but offline import must ensure it is sent)
  if (current.length > 0) rounds.push(current);
  // Keep rounds containing an assistant / tool state (tool_call/tool_result); only pure-user noise rounds are discarded
  return rounds.filter((r) => r.some((m) => m.role === 'assistant' || m.role === 'tool_call' || m.role === 'tool_result'));
}

/**
 * Upload the session (skill chain): slice into multiple rounds by final-answer, calling /skill/conversation/add incrementally round by round.
 * Triggers skill extraction (archive + SkillConversationExtractWorker). When a single round exceeds the batch limit, split further by batchMessages.
 *
 * Aligned with the proxy's real-time stream:
 *  - Tool messages are sent as a structured 5-role (tool_call/tool_result + tool_call_id pairing anchor), no longer flattened into text;
 *  - Before import, first force-archive to clear the session's existing real-time stream buffer, to avoid duplicates stacking with the offline full replay
 *    (core's conversation-add buffer does not dedupe).
 */
async function uploadViaConversationAdd(client: PanelClient, ctx: WriteCtx, input: BatchInput): Promise<void> {
  // Fix 2: before import, first force-archive the session's existing buffer (best-effort; failure does not block the import)
  try {
    await client.post('/skill/conversation/force-archive', {
      space_id: client.serviceId,
      user_id: ctx.userId,
      team_id: ctx.teamId,
      agent_id: resolveSkillAgentId(ctx),
      session_id: input.sessionId,
      reason: 'offline import pre-flush',
    });
  } catch (e) {
    console.warn(`[warn] force-archive precheck failed (ignored, continuing import): ${(e as Error).message}`);
  }

  const rounds = splitIntoRounds(input.msgs);
  if (rounds.length === 0) return;
  for (let r = 0; r < rounds.length; r++) {
    const subBatches = batchMessages(rounds[r]);
    for (const batch of subBatches) {
      const body = {
        space_id: client.serviceId,
        user_id: ctx.userId,
        team_id: ctx.teamId,
        agent_id: resolveSkillAgentId(ctx),
        session_id: input.sessionId,
        messages: batch.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.ts !== undefined ? { ts: m.ts } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.tool_name ? { tool_name: m.tool_name } : {}),
        })),
        // Cold start always uses strict mode: when bulk-ingesting historical sessions, capture only high-value SOPs (v1 five-category + four-dimension scoring gate),
        // to avoid the lenient v2 prompt extracting hundreds or thousands of low-value Background/Preference skills that flood the library.
        // Server-side fallback: SkillTaskEntry.mode='strict' → Worker → SkillExtractor STRICT prompt.
        strict_mode: true,
      };
      const env = await client.post('/skill/conversation/add', body);
      if (env.code !== 0) {
        throw new Error(`skill/conversation/add failed code==${env.code} msg=${env.message ?? ''}`);
      }
    }
  }
}



/** Gateway `skill/create` JSON body limit 1 MiB. */
export const GATEWAY_MAX_BODY_BYTES = 1024 * 1024;

export type OversizedSkill = { name: string; bytes: number };
export type UploadSkillResult = 'created' | 'skipped' | { oversized: OversizedSkill };

function skillCreateBodyBytes(body: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

export function formatSkillBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)}MB`;
  return `${Math.max(1, Math.ceil(n / 1024))}KB`;
}

function buildSkillCreateBody(ctx: WriteCtx, skill: ScannedSkill): { name: string; body: Record<string, unknown> } {
  const name = parseFrontmatterName(skill.content) || skill.name;
  const body: Record<string, unknown> = {
    name,
    content: skill.content,
    team_id: ctx.teamId,
    agent_id: resolveSkillAgentId(ctx),
  };
  if (skill.resources.length > 0) {
    body.resources = skill.resources.map((r) => ({
      path: r.path,
      content: r.content,
      encoding: 'utf-8',
    }));
  }
  return { name, body };
}

/** Estimate the `skill/create` JSON size; a whole skill over the limit should be skipped. */
export function measureSkillCreate(ctx: WriteCtx, skill: ScannedSkill): OversizedSkill {
  const { name, body } = buildSkillCreateBody(ctx, skill);
  return { name, bytes: skillCreateBodyBytes(body) };
}

/** Create a skill (including resources). Same name with same owner returns 42201 → idempotent skip. Over 1MB the whole skill is skipped and no request is made. */
export async function uploadSkill(
  client: PanelClient,
  ctx: WriteCtx,
  skill: ScannedSkill,
): Promise<UploadSkillResult> {
  const { name: skillName, body } = buildSkillCreateBody(ctx, skill);
  const bytes = skillCreateBodyBytes(body);
  if (bytes > GATEWAY_MAX_BODY_BYTES) {
    return { oversized: { name: skillName, bytes } };
  }
  const env = await client.post('/skill/create', body);
  if (env.code === 0) return 'created';
  if (env.code === 42201) return 'skipped'; // NAME_DUPLICATE
  throw new Error(`skill/create failed name==${skillName} code=${env.code} msg=${env.message ?? ''}`);
}

interface SessionInput {
  session: ScannedSession;
  /** Extraction scope when importing a session: memory = persist only, skill = extract skills only, both = do both. */
  extract: 'memory' | 'skill' | 'both';
}

/**
 * Import a session: dual chains aligned with the proxy's real-time stream.
 *  1) /chat-memory/import (whole) → writes L0 + asynchronous L1 memory extraction
 *  2) /skill/conversation/add (incremental by final-answer slices) → skill extraction
 * memory and skill are two independent extraction chains in core, so both run (unless extract specifies only one).
 *
 * Handling of tool messages (the two chains differ, see below):
 *  - skill chain (uploadViaConversationAdd): downstream core /v3/skill/conversation/add accepts
 *    5-role; tool_call/tool_result must carry a tool_call_id pairing anchor (missing → 40001). So it is passed through structured.
 *  - memory chain (uploadBatches → toMemoryMessages): the downstream core /v3/conversation/add schema
 *    accepts only user/assistant/system, with no tool role. So toMemoryMessages restores tool_call/tool_result
 *    to text ([tool_call] name(...) / [tool_result:name] ...) merged into the conversation flow; what the memory system cares about is
 *    the "content" of the tool calls, not the structured anchor.
 *  Therefore uploadSession must not filter by user/assistant: tool role messages must be preserved as is, and then each of the two chains
 *  handles them (one structured, one flattened). Otherwise the skill chain's tool_call_id passthrough would be bypassed, and the memory chain's
 *  tool content would be lost entirely.
 */
export async function uploadSession(client: PanelClient, ctx: WriteCtx, input: SessionInput): Promise<void> {
  const { session } = input;
  // Do not filter by user/assistant here: session.messages comes from parseJsonlLines /
  // normalizeResponsesJson and already contains tool_call/tool_result roles (with the tool_call_id pairing anchor).
  // The skill chain sends them structured (see uploadViaConversationAdd), and the memory chain flattens them to text via toMemoryMessages
  // — both depend on tool messages being preserved as is up to here. So pass through all roles and fill in the tool fields.
  const raw = session.messages as unknown as ImportMessage[];
  const msgs: ImportMessage[] = raw.map((m) => ({
    role: m.role,
    content: m.content,
    sourceKey: session.sourceKey,
    ts: m.ts,
    hasToolUse: m.hasToolUse,
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_name ? { tool_name: m.tool_name } : {}),
    ...(m.recIdx !== undefined ? { recIdx: m.recIdx } : {}),
    // memRole is key: the memory chain toMemoryMessages uses group[0].memRole || group[0].role to decide
    // the role sent to /chat-memory/import. If not passed through, tool messages would fall back to the raw tool_call/tool_result roles,
    // while core /v3/conversation/add accepts only user/assistant/system → 400. The skill chain uses m.role as is,
    // so it is unaffected.
    ...(m.memRole ? { memRole: m.memRole } : {}),
  }));
  if (msgs.length === 0) return;
  const batchInput = { msgs, sourceKey: session.sourceKey, sessionId: session.sessionId };
  // 1) memory chain: import the whole session to trigger L1 extraction (runs when extract !== 'skill')
  if (input.extract !== 'skill') {
    await uploadBatches(client, ctx, batchInput);
  }
  // 2) skill chain: trigger skill extraction incrementally by final-answer slices (runs when extract !== 'memory')
  if (input.extract !== 'memory') {
    await uploadViaConversationAdd(client, ctx, batchInput);
  }
}

// ── CLI parsing and main flow ──
interface CliOpts {
  command: 'import';
  agentId?: string;
  teamId?: string;
  teamName?: string;
  agentName?: string;
  target: 'agent' | 'team';
  sessions?: string;

  force: boolean;
  userKey?: string;
  envFile?: string;
  stateFile: string;
  interactive: boolean;
  yes: boolean;
  /** Extraction scope when importing a session: memory = persist only, skill = extract skills only, both = do both (default). */
  extract: 'memory' | 'skill' | 'both';
  /** Specify which agent/ide to scan; auto detects from the current workspace/./. */
  source: string;
  workspace?: string;
}

function parseCli(argv: string[]): CliOpts {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'agent-id': { type: 'string' },
      'team-id': { type: 'string' },
      'team-name': { type: 'string' },
      'agent-name': { type: 'string' },
      sessions: { type: 'string' },

      target: { type: 'string', default: 'agent' },
      force: { type: 'boolean', default: false },
      'user-key': { type: 'string' },
      'env-file': { type: 'string' },
      'state-file': { type: 'string', default: '.asset-import-state.json' },
      workspace: { type: 'string' },
      interactive: { type: 'string' },
      y: { type: 'boolean' },
      yes: { type: 'boolean' },
      extract: { type: 'string', default: 'both' },
      source: { type: 'string', default: 'auto' },
    },
  });
  const command: CliOpts['command'] = 'import';

  const target = values.target === 'team' ? 'team' : 'agent';
  const yes = values.y === true || values.yes === true;
  return {
    command,
    agentId: values['agent-id'],
    teamId: values['team-id'],
    teamName: values['team-name'],
    agentName: values['agent-name'],
    target,
    sessions: values.sessions,

    force: values.force === true,
    userKey: values['user-key'],
    envFile: values['env-file'],
    stateFile: values['state-file'] as string,
    interactive: values.interactive !== 'false' && !yes,
    yes,
    extract:
      values.extract === 'memory' || values.extract === 'skill'
        ? (values.extract as 'memory' | 'skill')
        : 'both',
    source: (values.source as string) || 'auto',
    workspace: values.workspace as string | undefined,
  };
}

async function question(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Interactively select the items to import: list first, then let the user choose among "import all / import none / import some".
 * - interactive=false (--yes / CI): return everything directly, equivalent to a full import.
 * - Non-TTY (piped input): cannot interact, safely skip (return empty).
 * - Partial import: enter multiple ids (comma or space separated), filter by id.
 *
 * @param getId     get the id used for partial filtering (skill uses name, session uses sessionId)
 * @param getLabel  display text when listing
 */
/** Extract a description from SKILL.md content (prefer the frontmatter description, otherwise take the first paragraph of the body). */
function skillDescription(content: string): string {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fm) {
    const m = fm[1].match(/^\s*description\s*:\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  for (const ln of content.split('\n')) {
    const t = ln.trim();
    if (!t || t.startsWith('#') || t.startsWith('---') || t.startsWith('>')) continue;
    return t.slice(0, 120);
  }
  return '';
}

async function selectItems<T>(
  label: string,
  items: T[],
  getId: (item: T) => string,
  getLabel: (item: T) => string,
  interactive: boolean,
  getDetail?: (item: T) => string[],
): Promise<T[]> {
  if (items.length === 0) return [];
  // Non-interactive (--yes / CI): import all by default
  if (!interactive) return items;
  // Non-TTY (piped input) cannot interact: safely skip
  if (!process.stdin.isTTY) {
    console.log(`[notice] non-interactive terminal, skipping: ${label}`);
    return [];
  }
  // List first
  console.log(`\n[list] ${label} (${items.length} in total):`);
  items.forEach((it, i) => {
    console.log(`  ${String(i + 1).padStart(3)}. [${getId(it)}] ${getLabel(it)}`);
    if (getDetail) for (const d of getDetail(it)) console.log(`       ${d}`);
  });
  const choice = (await question(`Choose an import mode: 1=import all 2=import none 3=import some ? `)).trim();
  if (choice === '2') {
    console.log(`[skip] ${label}`);
    return [];
  }
  if (choice === '3') {
    const raw = (await question('Enter the number/id to import (comma/space separated, multiple allowed): ')).trim();
    const wanted = new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
    if (wanted.size === 0) {
      console.log(`[skip] ${label} (no valid number/id entered)`);
      return [];
    }
    // Either a number (1-based index) or an id (name) can match
    const picked = items.filter((it, i) => wanted.has(getId(it)) || wanted.has(String(i + 1)));
    const missed = [...wanted].filter(
      (id) => !items.some((it, i) => id === getId(it) || id === String(i + 1)),
    );
    if (missed.length) console.warn(`[warn] The following numbers/ids were not matched: ${missed.join(', ')}`);
    console.log(`[partial import] ${label}: selected ${picked.length}/${items.length}`);
    return picked;
  }
  // 1 or default: import all
  return items;
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  KIND = resolveSource(opts.source, opts.workspace);
  if (opts.envFile) loadEnvFile(opts.envFile);
  if (opts.userKey) process.env.TDAI_USER_KEY = opts.userKey;

  const cfg = await loadConfigFromEnv(opts.interactive);
  const client = new PanelClient(cfg);
  // Single-file-specific source: lock directly to its own KIND
  const kind: string = KIND;

  // Single userKey: look up user_id, align the owner
  const userId = await resolveUserId(client, cfg.userKey);
  const teamId = await resolveTeam(client, userId, { teamId: opts.teamId, teamName: opts.teamName });
  const agent = await resolveAgent(client, {
    userId,
    teamId,
    agentId: opts.agentId,
    agentName: opts.agentName,
  });
  const ctx: WriteCtx = { teamId, agentId: agent.agentId, userId, target: opts.target };

  const cp: Checkpoint = loadCheckpoint(opts.stateFile);
  const ck = (sourceKey: string) => scopedCheckpointKey(agent.agentId, sourceKey);
  const results = {
    created: 0,
    skipped: 0,
    imported: 0,
    failed: 0,
    oversized: [] as OversizedSkill[],
    errors: [] as string[],
  };
  const scanOpts = opts.workspace ? { workspace: opts.workspace } : undefined;
  const workspaceLabel = opts.workspace ? ` workspace=${opts.workspace}` : '';

  // ── Stage 1: choose the skills to import (list first, then import all / none / some) ──
  const skills = await selectItems(
    `Import skills to agent ${agent.agentId}`,
    scanSkills(scanOpts),
    (s) => s.name,
    (s) => s.name,
    opts.interactive,
    (s) => [
      `Description: ${skillDescription(s.content)}`,
      `Source: ${s.sourceKey.replace(`skill:${KIND}:`, '')}`,
      `Related scripts: ${s.resources.length}`,
    ],
  );

  if (skills.length > 0) {
    for (const s of skills) {
      if (!opts.force && isDone(cp, ck(s.sourceKey))) {
        results.skipped++;
        continue;
      }
      try {
        const r = await uploadSkill(client, ctx, s);
        if (typeof r === 'object' && r.oversized) {
          results.skipped++;
          results.oversized.push(r.oversized);
          continue;
        }
        if (r === 'created') results.created++;
        else results.skipped++;
        markDone(cp, ck(s.sourceKey));
      } catch (e) {
        results.failed++;
        results.errors.push(`skill ${s.name}: ${(e as Error).message}`);
      }
    }
    saveCheckpoint(opts.stateFile, cp);
  }

  // ── Stage 2: choose the sessions to import (list first, then import all / none / some) ──
  // `--sessions` has two semantics:
  //   1) An existing directory → generic override scan entry
  //   2) Comma-separated session ids → filter by id on top of the default scan results
  const sessionsDir =
    opts.sessions && existsSync(opts.sessions) && statSync(opts.sessions).isDirectory()
      ? opts.sessions
      : undefined;
  let sessions = scanSessions(sessionsDir, scanOpts);
  if (opts.sessions && !sessionsDir) {
    const ids = new Set(opts.sessions.split(',').map((s) => s.trim()).filter(Boolean));
    if (ids.size) sessions = sessions.filter((s) => ids.has(s.sessionId));
  }
  console.log(`[detect] kind=${kind}${workspaceLabel} skills=${skills.length} sessions=${sessions.length}`);
  if (sessions.length > 0) {
    console.log(
      '[skill extraction mode] Cold start always uses strict mode (strict_mode=true) — captures only high-value SOPs,\n' +
      '                 reducing low-value skill noise of the Background/Preference kind. ' +
      'Real-time extraction (daily proxy calls) still uses the lenient default mode.',
    );
  }
  sessions = await selectItems(
    `Upload session to agent ${agent.agentId}`,
    sessions,
    (s) => s.sessionId,
    (s) => s.sessionId,
    opts.interactive,
    (s) => {
      let timeRange = 'unknown';
      try {
        const meta = extractSessionMeta(readFileSync(s.origin, 'utf-8'));
        if (meta.timeRange) timeRange = meta.timeRange;
      } catch {
        /* on read failure keep unknown */
      }
      const isWarmup = (c: string) => c.trim().toLowerCase() === 'warmup';
      const isBlank = (c: string) => !c || !c.trim();
      const firstUser = s.messages.find(
        (m) => m.role === 'user' && !isWarmup(m.content ?? '') && !isBlank(m.content ?? ''),
      );
      const summary = firstUser
        ? firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 120)
        : (() => {
            const fb = s.messages.find((m) => !isWarmup(m.content ?? '') && !isBlank(m.content ?? ''));
            return fb ? fb.content.replace(/\s+/g, ' ').trim().slice(0, 120) : '(no actual content)';
          })();
      return [`Path: ${s.origin}`, `Time range: ${timeRange}`, `Summary: ${summary}`];
    },
  );

  if (sessions.length > 0) {
    for (const s of sessions) {
      if (!opts.force && isDone(cp, ck(s.sourceKey))) continue;
      try {
        await uploadSession(client, ctx, { session: s, extract: opts.extract });
        results.imported++;
        markDone(cp, ck(s.sourceKey));
      } catch (e) {
        results.failed++;
        results.errors.push(`session ${s.sessionId}: ${(e as Error).message}`);
      }
    }
    saveCheckpoint(opts.stateFile, cp);
  }

  if (results.oversized.length > 0) {
    console.log(`\n[skip] ${results.oversized.length} skills exceed the gateway 1MB limit and were not imported:`);
    for (const s of results.oversized) {
      console.log(`- ${s.name} (${formatSkillBytes(s.bytes)})`);
    }
  }
  console.log('\n=== Results ===');
  console.log(
    JSON.stringify(
      {
        ...results,
        oversized: results.oversized.map((s) => ({ name: s.name, bytes: s.bytes, size: formatSkillBytes(s.bytes) })),
      },
      null,
      2,
    ),
  );
  if (results.failed > 0) process.exitCode = 1;
}

/** Run the main flow when this file is run directly (tsx agents/asset-import.ts --source <ide>). */
function runIfMain(metaUrl: string): void {
  const self = fileURLToPath(metaUrl);
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  if (entry !== self) return;
  main().catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  });
}



// ── Per-IDE adapters ──
interface IdeAdapter {
  kind: string;
  scanSkills(opts?: ScanOptions): ScannedSkill[];
  scanSessions(sessionsDir?: string, opts?: ScanOptions): ScannedSession[];
  scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[];
  detect(): boolean;
}

function make_openclawAdapter(): IdeAdapter {
const KIND = 'openclaw' as const;

function openclawHome(): string {
  const env = process.env.OPENCLAW_STATE_DIR?.trim();
  return env ? resolve(env) : join(home(), '.openclaw');
}

function openclawConfig(): Record<string, unknown> | null {
  return readJsonObject(join(openclawHome(), 'openclaw.json'));
}

function looksLikeOpenClawWorkspace(dir: string): boolean {
  return ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'skills'].some((n) => existsSync(join(dir, n)));
}

/** Collect agent workspace directories from openclaw.json (including nested workspace/ subdirectories). */
function openclawAgentWorkspaces(opts?: ScanOptions): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw?: string): void => {
    if (!raw) return;
    const key = resolve(raw);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key);
    const nested = join(key, 'workspace');
    const nestedKey = resolve(nested);
    if (!seen.has(nestedKey) && existsSync(nested) && statSync(nested).isDirectory() && looksLikeOpenClawWorkspace(nested)) {
      seen.add(nestedKey);
      out.push(nestedKey);
    }
  };
  add(process.env.OPENCLAW_WORKSPACE_DIR);
  // Default workspace directory
  add(join(openclawHome(), 'workspace'));
  const agents = openclawConfig()?.agents;
  if (agents && typeof agents === 'object' && !Array.isArray(agents)) {
    const rec = agents as Record<string, unknown>;
    const defaults = rec.defaults && typeof rec.defaults === 'object' ? (rec.defaults as Record<string, unknown>) : undefined;
    if (defaults && typeof defaults.workspace === 'string') add(defaults.workspace);
    const list = Array.isArray(rec.list) ? rec.list : [];
    for (const item of list) {
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).workspace === 'string') {
        add((item as Record<string, unknown>).workspace as string);
      }
    }
  }
  return out;
}

function openclawBundledSkillsDir(): string {
  return join(home(), 'npm-global', 'lib', 'node_modules', 'openclaw', 'skills');
}

/** One level of skill root: <name>/SKILL.md + scripts/references/assets/agents. */
function collectOpenClawSkillsFromRoot(root: string): ScannedSkill[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: ScannedSkill[] = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.')) continue;
    const skillDir = join(root, entry);
    let st;
    try {
      st = statSync(skillDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const text = readIfExists(join(skillDir, 'SKILL.md'));
    if (text == null) continue;
    const resources: { path: string; content: string }[] = [];
    for (const sub of ['scripts', 'references', 'assets', 'agents']) collectSubfiles(skillDir, sub, resources);
    out.push({ name: skillNameFromContent(entry, text), content: text, resources, sourceKey: `skill:${KIND}:${skillDir}` });
  }
  return out;
}

/**
 * OpenClaw skills in two layers (same-name user-defined overrides system built-in):
 *  1 user-defined  ~/.agents/skills
 *  2 system built-in    ~/npm-global/lib/node_modules/openclaw/skills
 */
function collectOpenClawSkills(): ScannedSkill[] {
  const ranked = [join(home(), '.agents', 'skills'), openclawBundledSkillsDir()];
  const out: ScannedSkill[] = [];
  const seen = new Set<string>();
  const seenRoots = new Set<string>();
  for (const root of ranked) {
    const key = resolve(root);
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    for (const skill of collectOpenClawSkillsFromRoot(root)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out;
}

function collectOpenClawMemoryFiles(opts?: ScanOptions): string[] {
  const files: string[] = [];
  const daily = /^\d{4}-\d{2}-\d{2}\.md$/;
  for (const w of openclawAgentWorkspaces(opts)) {
    for (const f of ['MEMORY.md', 'DREAMS.md']) {
      const p = join(w, f);
      if (readIfExists(p)?.trim()) files.push(p);
    }
    const memDir = join(w, 'memory');
    if (!existsSync(memDir) || !statSync(memDir).isDirectory()) continue;
    for (const name of readdirSync(memDir)) {
      if (!daily.test(name)) continue;
      const p = join(memDir, name);
      if (readIfExists(p)?.trim()) files.push(p);
    }
  }
  return files;
}

function detect(): boolean {
  return existsSync(join(home(), '.openclaw'));
}

function scanSkills(_opts?: ScanOptions): ScannedSkill[] {
  return collectOpenClawSkills();
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const files: string[] = [...collectOpenClawMemoryFiles(opts)];
  return memoryFilesFromPaths(KIND, files);
}

function scanSessions(sessionsDir?: string, _opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  const out: ScannedSession[] = [];
  const sessionsRoot = join(home(), '.openclaw', 'agents');
  if (!existsSync(sessionsRoot)) return out;
  for (const agentId of readdirSync(sessionsRoot)) {
    const dir = join(sessionsRoot, agentId);
    if (!statSync(dir).isDirectory()) continue;
    const sessionsDirPath = join(dir, 'sessions');
    if (!existsSync(sessionsDirPath)) continue;
    for (const f of listJsonlRecursive(sessionsDirPath)) {
      if (f.endsWith('.lock') || f.endsWith('.trajectory.jsonl')) continue;
      const msgs = parseJsonlLines(readFileSync(f, 'utf-8'));
      if (msgs.length) out.push({ sessionId: `${agentId}/${basename(f, '.jsonl')}`, messages: msgs, sourceKey: `session:${KIND}:${f}`, origin: f });
    }
  }
  return out;
}


function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}
function make_codebuddyAdapter(): IdeAdapter {
const KIND = 'codebuddy' as const;

function detect(): boolean {
  // Only look at home / environment variables; cwd detection is handled uniformly by resolveSource's detectByCwdMarker
  return Boolean(process.env.CODEBUDDY_HOME) || existsSync(join(home(), '.codebuddy'));
}

function scanSkills(opts?: ScanOptions): ScannedSkill[] {
  const cwd = projectCwd(opts);
  const h = home();
  return collectSkillDirs(KIND, [join(h, '.codebuddy', 'skills'), join(cwd, '.codebuddy', 'skills')]);
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const cwd = projectCwd(opts);
  const h = home();
  const files: string[] = [];
  const push = (p: string) => files.push(p);
  push(join(h, '.codebuddy', 'CODEBUDDY.md'));
  if (existsSync(join(cwd, 'CODEBUDDY.md'))) push(join(cwd, 'CODEBUDDY.md'));
  // codebuddy memory directory: memories/ (compatible with the misspelling memery/), expand all .md files beneath it
  for (const base of [join(h, '.codebuddy'), join(cwd, '.codebuddy')]) {
    for (const dirName of ['memories', 'memery']) {
      const mem = join(base, dirName);
      if (existsSync(mem)) files.push(...listMdRecursive(mem));
    }
  }
  return memoryFilesFromPaths(KIND, files);
}

function scanSessions(sessionsDir?: string, _opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  const out: ScannedSession[] = [];
  // Real session location: ~/.codebuddy/projects/<project>/*.jsonl
  const root = join(home(), '.codebuddy', 'projects');
  if (existsSync(root)) {
    for (const proj of readdirSync(root)) {
      const dir = join(root, proj);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of listJsonlRecursive(dir)) {
        const msgs = parseJsonlLines(readFileSync(f, 'utf-8'));
        if (msgs.length) out.push({ sessionId: `${proj}/${basename(f, '.jsonl')}`, messages: msgs, sourceKey: `session:${KIND}:${f}`, origin: f });
      }
    }
  }
  // Fallback: legacy ~/.codebuddy/sessions/*.jsonl
  const legacy = join(home(), '.codebuddy', 'sessions');
  if (existsSync(legacy)) {
    for (const f of listJsonlRecursive(legacy)) {
      const msgs = parseJsonlLines(readFileSync(f, 'utf-8'));
      if (msgs.length) out.push({ sessionId: basename(f, '.jsonl'), messages: msgs, sourceKey: `session:${KIND}:${f}`, origin: f });
    }
  }
  return out;
}


function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}
function make_codexAdapter(): IdeAdapter {
const KIND = 'codex' as const;

function detect(): boolean {
  return Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_HOME || process.env.CODEX_HOME_DIR);
}

function scanSkills(opts?: ScanOptions): ScannedSkill[] {
  const cwd = projectCwd(opts);
  const h = home();
  const roots: string[] = [];
  // codex official user-level skill: ~/.agents/skills
  roots.push(join(h, '.agents', 'skills'));
  roots.push('/etc/codex/skills');
  // Repo-level .agents/skills: layer by layer from the git root to cwd (overrides take priority over base)
  for (const d of dirsFromRepoRootToCwd(cwd)) {
    roots.push(join(d, '.agents', 'skills'));
  }
  return collectSkillDirs(KIND, roots);
}

function codexHome(): string {
  const env = process.env.CODEX_HOME?.trim();
  return env ? resolve(env) : join(home(), '.codex');
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const cwd = projectCwd(opts);
  const co = codexHome();
  const files: string[] = [];
  const push = (p: string) => files.push(p);
  const globalOverride = join(co, 'AGENTS.override.md');
  if (readIfExists(globalOverride)?.trim()) push(globalOverride);
  else push(join(co, 'AGENTS.md'));
  const memRoot = join(co, 'memories');
  if (existsSync(memRoot)) files.push(...listMdRecursive(memRoot));
  for (const d of dirsFromRepoRootToCwd(cwd)) {
    const localOverride = join(d, 'AGENTS.override.md');
    if (readIfExists(localOverride)?.trim()) push(localOverride);
    else push(join(d, 'AGENTS.md'));
  }
  return memoryFilesFromPaths(KIND, files);
}

function scanSessions(sessionsDir?: string, _opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  const out: ScannedSession[] = [];
  const sessionsRoot = join(codexHome(), 'sessions');
  if (!existsSync(sessionsRoot)) return out;
  for (const full of listJsonlRecursive(sessionsRoot)) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({ sessionId: extractCodexSessionId(full, text), messages: msgs, sourceKey: `session:${KIND}:${full}`, origin: full });
  }
  return out;
}


function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}
function make_claude_codeAdapter(): IdeAdapter {
const KIND = 'claude-code' as const;

function detect(): boolean {
  return Boolean(process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CODE_ENTRY);
}

function scanSkills(opts?: ScanOptions): ScannedSkill[] {
  const cwd = projectCwd(opts);
  const h = home();
  return collectSkillDirs(KIND, [join(h, '.claude', 'skills'), join(cwd, '.claude', 'skills')]);
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const cwd = projectCwd(opts);
  const h = home();
  const files: string[] = [];
  const push = (p: string) => files.push(p);
  push(join(h, '.claude', 'CLAUDE.md'));
  push(join(cwd, 'CLAUDE.md'));
  const memDir = join(h, '.claude', 'projects');
  if (existsSync(memDir)) {
    for (const proj of readdirSync(memDir)) {
      files.push(...listMd(join(memDir, proj, 'memory')));
    }
  }
  return memoryFilesFromPaths(KIND, files);
}

function scanSessions(sessionsDir?: string, _opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  const out: ScannedSession[] = [];
  const root = join(home(), '.claude', 'projects');
  if (!existsSync(root)) return out;
  for (const proj of readdirSync(root)) {
    const pd = join(root, proj);
    if (!statSync(pd).isDirectory()) continue;
    for (const f of readdirSync(pd)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(pd, f);
      const msgs = parseJsonlLines(readFileSync(full, 'utf-8'));
      if (msgs.length) {
        out.push({ sessionId: f.replace('.jsonl', ''), messages: msgs, sourceKey: `session:${KIND}:${full}`, origin: full });
      }
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════

function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}
function make_dshAdapter(): IdeAdapter {
const KIND = 'dsh' as const;

function readZstdUtf8(path: string): string | null {
  try {
    const r = spawnSync('zstd', ['-d', '-c', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) return r.stdout;
    const fallback = spawnSync('unzstd', ['-c', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (fallback.status === 0) return fallback.stdout;
    return null;
  } catch {
    return null;
  }
}

/** Parse a dsh session (after zstd decompression it is an event-stream jsonl: each line type + data). */
function parseDshSessionLines(text: string): ScannedSession['messages'] {
  const msgs: ScannedSession['messages'] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const data = obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : undefined;
      if (obj.type === 'user/message' && data) {
        const role = typeof data.role === 'string' ? data.role : 'user';
        const content = extractText(data.content);
        if (content && !isHarnessNoise(role, content)) msgs.push({ role, content });
        continue;
      }
      if (obj.type === 'assistant/message' && data) {
        const nested = data.message && typeof data.message === 'object' ? (data.message as Record<string, unknown>) : data;
        const role = typeof nested.role === 'string' ? nested.role : 'assistant';
        const content = extractText(nested.content);
        if (content && !isHarnessNoise(role, content)) msgs.push({ role, content });
      }
    } catch {
      // skip non-JSON lines
    }
  }
  return msgs;
}

function dshHome(): string {
  const env = process.env.DSH_HOME?.trim();
  return env ? resolve(env) : join(home(), '.dsh');
}
function dshAgentsHome(): string {
  const env = process.env.DSH_AGENTS_HOME?.trim();
  return env ? resolve(env) : join(home(), '.agents');
}
function dshCustomSkillDirs(): string[] {
  const fromEnv = (process.env.DSH_CUSTOM_SKILL_DIRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.map((p) => resolve(p.replace(/^~(?=\/|$)/, home())));
}

const DSH_INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;
const DSH_LOCAL_INSTRUCTION_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const;

function sha1Trimmed(text: string): string {
  return createHash('sha1').update(text.trim()).digest('hex');
}

function readYamlStringList(text: string | null, key: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const listRe = new RegExp(`^\\s*${key}\\s*:\\s*\\n(\\s*-\\s*.+(\\n|$))+`, 'm');
  const listMatch = text.match(listRe);
  if (listMatch) {
    for (const m of listMatch[0].matchAll(/\n\s*-\s*(.+)/g)) out.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
    return out;
  }
  const scalarRe = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm');
  const m = text.match(scalarRe);
  if (m) out.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
  return out;
}

/** DSH skill root: directory-style name/SKILL.md or flat name.md (one level, not recursive). */
function collectSkillsFromDshRoot(root: string, skipSystem = false): ScannedSkill[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: ScannedSkill[] = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.') || (skipSystem && entry === '.system')) continue;
    const full = join(root, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const skillMd = join(full, 'SKILL.md');
      const text = readIfExists(skillMd);
      if (text == null) continue;
      const resources: { path: string; content: string }[] = [];
      for (const sub of ['scripts', 'references', 'assets', 'agents']) collectSubfiles(full, sub, resources);
      out.push({ name: skillNameFromContent(entry, text), content: text, resources, sourceKey: `skill:${KIND}:${full}` });
    } else if (st.isFile() && entry.endsWith('.md') && entry !== 'SKILL.md') {
      const text = readIfExists(full);
      if (text == null || !text.trim()) continue;
      const fallback = entry.replace(/\.md$/i, '');
      out.push({ name: skillNameFromContent(fallback, text), content: text, resources: [], sourceKey: `skill:${KIND}:${full}` });
    }
  }
  return out;
}

function collectDshInstructionFilesInDir(dir: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...DSH_INSTRUCTION_CANDIDATES, ...DSH_LOCAL_INSTRUCTION_CANDIDATES]) {
    const full = join(dir, name);
    const text = readIfExists(full);
    if (text == null || !text.trim()) continue;
    const digest = sha1Trimmed(text);
    if (seen.has(digest)) continue;
    seen.add(digest);
    out.push(full);
  }
  return out;
}

function dshBundledSkillDir(): string | undefined {
  const env = process.env.DSH_BUNDLED_SKILL_DIR?.trim();
  if (env) return resolve(env);
  const fromYaml = readYamlStringList(readIfExists(join(dshHome(), 'settings.yaml')), 'bundledSkillDir');
  if (fromYaml[0]) return resolve(fromYaml[0].replace(/^~(?=\/|$)/, home()));
  return undefined;
}

function detect(): boolean {
  return existsSync(join(dshHome(), 'skills')) || existsSync(join(dshHome(), 'AGENTS.md')) || existsSync(join(dshHome(), 'sessions'));
}

function scanSkills(opts?: ScanOptions): ScannedSkill[] {
  const cwd = projectCwd(opts);
  const projectRoot = gitRootOrCwd(cwd);
  const ranked: { path: string; skipSystem?: boolean }[] = [
    { path: join(projectRoot, '.dsh', 'skills') },
    { path: join(projectRoot, '.agents', 'skills') },
    ...dshCustomSkillDirs().map((path) => ({ path })),
    { path: join(dshHome(), 'skills'), skipSystem: true },
    { path: join(dshAgentsHome(), 'skills') },
  ];
  const bundled = dshBundledSkillDir();
  if (bundled) ranked.push({ path: bundled });
  const out: ScannedSkill[] = [];
  const seen = new Set<string>();
  const seenRoots = new Set<string>();
  for (const r of ranked) {
    const key = resolve(r.path);
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    for (const skill of collectSkillsFromDshRoot(r.path, r.skipSystem === true)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out;
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const cwd = projectCwd(opts);
  const files: string[] = [];
  const globalAgents = join(dshHome(), 'AGENTS.md');
  if (readIfExists(globalAgents)?.trim()) files.push(globalAgents);
  for (const dir of dirsFromRepoRootToCwd(cwd)) {
    files.push(...collectDshInstructionFilesInDir(dir));
  }
  return memoryFilesFromPaths(KIND, files);
}

function scanSessions(sessionsDir?: string, _opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  const out: ScannedSession[] = [];
  const sessionsRoot = join(dshHome(), 'sessions');
  if (!existsSync(sessionsRoot)) return out;
  for (const full of walkFiles(sessionsRoot, (n) => n === 'session.jsonl.zstd' || n === 'session.jsonl')) {
    const text = full.endsWith('.zstd') ? readZstdUtf8(full) : readFileSync(full, 'utf-8');
    if (!text) continue;
    const msgs = parseDshSessionLines(text);
    if (!msgs.length) continue;
    out.push({ sessionId: basename(dirname(full)), messages: msgs, sourceKey: `session:${KIND}:${full}`, origin: full });
  }
  return out;
}


function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}
function make_hermesAdapter(): IdeAdapter {
const KIND = 'hermes' as const;

const HERMES_EXCLUDED_SKILL_DIRS = new Set([
  'node_modules', '.git', '.turbo', 'dist', 'build', 'out',
  '.next', '.nuxt', '.svelte-kit', 'coverage', '.cache',
  '.venv', 'venv', '__pycache__', 'target', 'bin', 'obj',
  '.idea', '.vscode', '.DS_Store',
]);
const HERMES_SKILL_SUPPORT_DIRS = new Set(['support', '_support']);
const HERMES_SKILL_RESOURCE_DIRS = new Set(['scripts', 'references', 'assets', 'agents']);

function hermesHome(): string {
  return process.env.HERMES_HOME || join(home(), '.hermes');
}

function walkHermesSkillMd(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  if (HERMES_EXCLUDED_SKILL_DIRS.has(basename(dir))) return;
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (HERMES_EXCLUDED_SKILL_DIRS.has(name)) continue;
      if (name.startsWith('.')) continue;
      walkHermesSkillMd(full, out);
    } else if (name === 'SKILL.md' && !isHermesSupportSkillMd(full)) {
      out.push(full);
    }
  }
}

function isHermesSupportSkillMd(p: string): boolean {
  const parent = basename(dirname(p));
  const grand = basename(dirname(dirname(p)));
  return HERMES_SKILL_SUPPORT_DIRS.has(parent) || HERMES_SKILL_SUPPORT_DIRS.has(grand);
}

/** Find all SKILL.md recursively within a skill root (skipping support etc.); <name>/SKILL.md is attributed to <name>. */
function collectHermesSkillsFromRoot(root: string): ScannedSkill[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: ScannedSkill[] = [];
  const seen = new Set<string>();
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.')) continue;
    const dir = join(root, entry);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const mdPaths: string[] = [];
    walkHermesSkillMd(dir, mdPaths);
    if (mdPaths.length === 0) continue;
    const skillMd = join(dir, 'SKILL.md');
    const text = readIfExists(skillMd) ?? readIfExists(mdPaths[0]);
    if (text == null) continue;
    const name = skillNameFromContent(entry, text);
    if (seen.has(name)) continue;
    seen.add(name);
    const resources: { path: string; content: string }[] = [];
    for (const sub of HERMES_SKILL_RESOURCE_DIRS) collectSubfiles(dir, sub, resources);
    out.push({ name, content: text, resources, sourceKey: `skill:${KIND}:${dir}` });
  }
  return out;
}

function hermesAgentRepo(): string | null {
  const root = process.env.HERMES_AGENT_ROOT?.trim();
  if (root) return resolve(root);
  const candidate = join(hermesHome(), 'hermes-agent');
  return existsSync(candidate) ? candidate : null;
}

function hermesBundledSkillRoots(): string[] {
  const roots: string[] = [];
  const envRoots = [
    process.env.HERMES_BUNDLED_SKILLS?.trim(),
    process.env.HERMES_OPTIONAL_SKILLS?.trim(),
  ].filter(Boolean) as string[];
  for (const e of envRoots) {
    for (const part of e.split(',')) {
      const p = part.trim();
      if (p) roots.push(resolve(p));
    }
  }
  const repo = hermesAgentRepo();
  if (repo) {
    roots.push(join(repo, 'skills'));
    roots.push(join(repo, 'optional-skills'));
  }
  return roots;
}

/** Hermes skill in two layers (user-defined overrides system built-in): HOME/skills + repo skills/optional-skills. */
function collectHermesSkills(): ScannedSkill[] {
  const ranked = [join(hermesHome(), 'skills'), ...hermesBundledSkillRoots()];
  const out: ScannedSkill[] = [];
  const seen = new Set<string>();
  const seenRoots = new Set<string>();
  for (const root of ranked) {
    const key = resolve(root);
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    for (const skill of collectHermesSkillsFromRoot(root)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out;
}

function detect(): boolean {
  return existsSync(join(home(), '.hermes'));
}

function scanSkills(_opts?: ScanOptions): ScannedSkill[] {
  return collectHermesSkills();
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const h = home();
  const hermesHome = process.env.HERMES_HOME || join(h, '.hermes');
  const out: ScannedMemoryFile[] = [];
  const push = (p: string) => {
    const text = readIfExists(p);
    if (text == null || !text.trim()) return;
    out.push({ messages: [{ role: 'user', content: text }], sourceKey: `memory:${KIND}:${p}`, origin: p });
  };
  push(join(hermesHome, 'USER.md'));
  const mem = join(hermesHome, 'memories');
  if (existsSync(mem)) for (const f of listMdRecursive(mem)) push(f);
  return out;
}

function scanSessions(sessionsDir?: string, _opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  const out: ScannedSession[] = [];
  const hermesHome = process.env.HERMES_HOME || join(home(), '.hermes');
  const dbPath = join(hermesHome, 'state.db');
  if (!existsSync(dbPath)) return out;
  let db: unknown;
  try {
    const require = createRequire(import.meta.url);
    let sqlite: { DatabaseSync?: unknown; Database?: unknown; default?: { Database?: unknown } };
    try {
      sqlite = require('node:sqlite');
    } catch {
      // node:sqlite is an experimental built-in module of Node >= 22.5; older versions lack it,
      // so db session scanning is skipped directly (skills/memory unaffected) and no warning is printed.
      return out;
    }
    const Database = sqlite.DatabaseSync ?? sqlite.Database ?? sqlite.default?.Database;
    db = new Database(dbPath, { readOnly: true });
  } catch (e) {
    console.warn(`[warn] Unable to open state.db (${dbPath}): ${(e as Error).message}`);
    return out;
  }
  try {
    const rows = (db as { prepare: (s: string) => { all: () => unknown[] } }).prepare(
      'SELECT session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp FROM messages ORDER BY session_id, id'
    ).all() as Array<{ session_id: string; role: string; content: unknown; tool_call_id?: string | null; tool_calls?: string | null; tool_name?: string | null; timestamp?: number | null }>;
    const bySession = new Map<string, ImportMessage[]>();
    for (const r of rows) {
      const msgs = hermesRowToMessages(r);
      if (!msgs.length) continue;
      if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
      bySession.get(r.session_id)!.push(...msgs);
    }
    for (const [sid, msgs] of bySession) {
      // Backfill recIdx: otherwise toMemoryMessages would collapse all messages into one by recIdx ?? -1.
      msgs.forEach((m, i) => { m.recIdx = i; });
      if (msgs.length) out.push({ sessionId: sid, messages: msgs, sourceKey: `session:${KIND}:${dbPath}#${sid}`, origin: dbPath });
    }
  } catch (e) {
    console.warn(`[warn] Failed to read state.db (${dbPath}): ${(e as Error).message}`);
  } finally {
    try { (db as { close?: () => void }).close?.(); } catch { /* ignore */ }
  }
  return out;
}

/**
 * Normalize one row of hermes state.db messages into the pipeline-internal ImportMessage[].
 * Key point: hermes stores tool results as role='tool' (OpenAI style) and stores the pairing info separately in the
 * tool_call_id / tool_calls / tool_name columns. It must be normalized into tool_call/tool_result + tool_call_id pairing, otherwise:
 *  - the skill chain receives a bare 'tool' role (not in user/assistant/tool_call/tool_result/system) → 40001;
 *  - the memory chain receives a bare 'tool' role (not in user/assistant/system) → 400.
 * Also fill in memRole so that the memory chain maps to legal roles (tool_result→user, tool_call→assistant).
 */
function hermesRowToMessages(r: {
  role: string;
  content: unknown;
  tool_call_id?: string | null;
  tool_calls?: string | null;
  tool_name?: string | null;
  timestamp?: number | null;
}): ImportMessage[] {
  const content = extractText(r.content);
  if (!content) return [];
  const ts = typeof r.timestamp === 'number' ? Math.round(r.timestamp * 1000) : undefined;

  // assistant with tool_calls: split into assistant text + several tool_calls
  if (r.role === 'assistant' && r.tool_calls) {
    let calls: any[] = [];
    try { calls = JSON.parse(r.tool_calls); } catch { /* ignore */ }
    if (Array.isArray(calls) && calls.length) {
      const out: ImportMessage[] = [];
      if (content.trim()) out.push({ role: 'assistant', content, ts, memRole: 'assistant', hasToolUse: true });
      for (const c of calls) {
        const args = c?.arguments ?? c?.input ?? c?.function?.arguments ?? c;
        out.push({
          role: 'tool_call',
          content: typeof args === 'string' ? args : JSON.stringify(args ?? ''),
          tool_call_id: c?.id ?? c?.tool_call_id ?? undefined,
          tool_name: c?.name ?? c?.function?.name ?? undefined,
          ts,
          memRole: 'assistant',
          hasToolUse: true,
        });
      }
      return out;
    }
  }

  // Tool result: hermes stores as role='tool' → normalize to tool_result (with the pairing anchor)
  if (r.role === 'tool') {
    return [{
      role: 'tool_result',
      content,
      tool_call_id: r.tool_call_id ?? undefined,
      tool_name: r.tool_name ?? undefined,
      ts,
      memRole: 'user',
    }];
  }

  // user / assistant / system kept as is, and memRole filled in
  const memRole = r.role === 'system' ? 'system' : r.role === 'assistant' ? 'assistant' : 'user';
  return [{ role: r.role, content, ts, memRole }];
}


function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}
function make_workbuddyAdapter(): IdeAdapter {
const KIND = 'workbuddy' as const;

function wbRoot(): string {
  return join(home(), '.workbuddy');
}

function detect(): boolean {
  return existsSync(join(home(), '.workbuddy'));
}

function scanSkills(opts?: ScanOptions): ScannedSkill[] {
  const cwd = projectCwd(opts);
  const h = home();
  const roots = [join(h, '.workbuddy', 'skills'), join(cwd, '.workbuddy', 'skills'), join(cwd, 'workbuddy', 'skills')];
  return collectSkillDirs(KIND, roots);
}

function scanMemoryFiles(opts?: ScanOptions): ScannedMemoryFile[] {
  const cwd = projectCwd(opts);
  const h = home();
  const files: string[] = [];
  const names = ['SOUL.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md'];
  for (const f of names) {
    for (const base of [join(h, '.workbuddy'), join(cwd, '.workbuddy'), join(cwd, 'workbuddy')]) {
      files.push(join(base, f));
    }
  }
  for (const base of [join(h, '.workbuddy'), join(cwd, '.workbuddy'), join(cwd, 'workbuddy')]) {
    const mem = join(base, 'memory');
    if (existsSync(mem)) files.push(...listMd(mem));
  }
  const out: ScannedMemoryFile[] = [];
  for (const p of files) {
    const text = readIfExists(p);
    if (text == null || !text.trim()) continue;
    out.push({ messages: [{ role: 'user', content: text }], sourceKey: `memory:${KIND}:${p}`, origin: p });
  }
  return out;
}

function scanWbSessions(root: string, _opts?: ScanOptions): ScannedSession[] {
  const out: ScannedSession[] = [];
  for (const f of readdirSync(root)) {
    if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
    const full = join(root, f);
    const text = readFileSync(full, 'utf-8');
    const msgs = f.endsWith('.json') ? normalizeResponsesJson(full) : parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({ sessionId: basename(f, f.endsWith('.json') ? '.json' : '.jsonl'), messages: msgs, sourceKey: `session:${KIND}:${full}`, origin: full });
  }
  const projectsRoot = join(root, 'projects');
  if (existsSync(projectsRoot)) {
    for (const proj of readdirSync(projectsRoot)) {
      const dir = join(projectsRoot, proj);
      if (!statSync(dir).isDirectory()) continue;
      for (const full of listJsonlRecursive(dir)) {
        const msgs = parseJsonlLines(readFileSync(full, 'utf-8'));
        if (!msgs.length) continue;
        out.push({ sessionId: `${proj}/${basename(full, '.jsonl')}`, messages: msgs, sourceKey: `session:${KIND}:${full}`, origin: full });
      }
    }
  }
  return out;
}

function scanSessions(sessionsDir?: string, opts?: ScanOptions): ScannedSession[] {
  if (sessionsDir) return scanSessionsOverride(KIND, sessionsDir);
  return scanWbSessions(wbRoot(), opts);
}


function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  const out: ScannedSession[] = [];
  if (!existsSync(sessionsDir)) return out;
  const st = statSync(sessionsDir);
  const jsonlFiles = st.isDirectory()
    ? listJsonlRecursive(sessionsDir)
    : sessionsDir.endsWith('.jsonl')
      ? [sessionsDir]
      : [];
  const jsonFiles = st.isDirectory()
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(sessionsDir, f))
    : sessionsDir.endsWith('.json')
      ? [sessionsDir]
      : [];
  for (const full of jsonlFiles) {
    const text = readFileSync(full, 'utf-8');
    const msgs = parseJsonlLines(text);
    if (!msgs.length) continue;
    out.push({
      sessionId: extractCodexSessionId(full, text),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  for (const full of jsonFiles) {
    const msgs = normalizeResponsesJson(full);
    if (!msgs.length) continue;
    out.push({
      sessionId: basename(full, '.json'),
      messages: msgs,
      sourceKey: `session:${kind}:${full}`,
      origin: full,
    });
  }
  return out;
}
  return { kind: KIND, scanSkills, scanSessions, scanSessionsOverride, detect };
}

export const ADAPTERS: Record<string, IdeAdapter> = {
  openclaw: make_openclawAdapter(), codebuddy: make_codebuddyAdapter(), codex: make_codexAdapter(), 'claude-code': make_claude_codeAdapter(), dsh: make_dshAdapter(), hermes: make_hermesAdapter(), workbuddy: make_workbuddyAdapter(),
};

/** Marker directory specific to each adapter under the project directory (cwd) (used for the "project-local first" decision). */
const CWD_MARKER_DIRS: Record<string, string[]> = {
  openclaw: ['.openclaw'],
  codebuddy: ['.codebuddy'],
  codex: ['.agents'],
  'claude-code': ['.claude'],
  dsh: ['.dsh'],
  hermes: ['.hermes'],
  workbuddy: ['.workbuddy', 'workbuddy'],
};

/** First priority: whether a marker directory specific to some adapter exists in the current project directory (cwd, or the directory specified by --workspace) (home not considered). */
function detectByCwdMarker(workspace?: string): string | undefined {
  const cwd = projectCwd(workspace ? { workspace } : undefined);
  for (const k of Object.keys(ADAPTERS)) {
    const markers = CWD_MARKER_DIRS[k];
    if (markers && markers.some((m) => existsSync(join(cwd, m)))) return k;
  }
  return undefined;
}

/** auto: first detect the project-specific directory of "the current path (cwd, or the directory specified by --workspace)", then fall back to "home directory / environment variables". */
export function resolveSource(source: string, workspace?: string): string {
  const s = (source || 'auto').trim();
  if (s !== 'auto' && ADAPTERS[s]) return s;
  // Level 1: the project-specific marker directory of the current path (cwd / --workspace)
  const byCwd = detectByCwdMarker(workspace);
  if (byCwd) return byCwd;
  // Level 2: home directory / environment variables marker (detect no longer includes cwd detection)
  for (const k of Object.keys(ADAPTERS)) {
    const a = ADAPTERS[k];
    if (a.detect && a.detect()) return k;
  }
  return 'openclaw';
}

function currentAdapter(): IdeAdapter {
  return ADAPTERS[KIND] ?? ADAPTERS.openclaw;
}

export function scanSkills(opts?: ScanOptions): ScannedSkill[] {
  return currentAdapter().scanSkills(opts);
}
export function scanSessions(sessionsDir?: string, opts?: ScanOptions): ScannedSession[] {
  return currentAdapter().scanSessions(sessionsDir, opts);
}
export function scanSessionsOverride(kind: AgentKind, sessionsDir: string): ScannedSession[] {
  return currentAdapter().scanSessionsOverride(kind, sessionsDir);
}

runIfMain(import.meta.url);
