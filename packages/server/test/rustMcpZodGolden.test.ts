// Rust 앞단은 TS 로 넘기기 전에 도구 인자를 `tools/list` 의 입력 스키마(golden/mcp_tools_list.json)로 검증하고, SDK 가 zod 로 거절할
// 인자면 SDK 와 같은 글자(`MCP error -32602: Input validation error: …`, isError)로 답한다(`crates/harkroom-server/src/core/mcp/zod_gate.rs`).
// 그 글자의 정본은 TS 다 — 이 시험이 도구마다 틀린 인자 꼴을 지어 **실제 등록된 zod 스키마**를 SDK 와 같은 함수로 돌린 결과를
// `golden/mcp_zod_cases.json` 에 굽는다. Rust 시험(`zod_gate::tests`)은 같은 꼴에서 같은 글자를 내는지(또는 모르면 TS 로 넘기는지) 본다.
// 고칠 때: `UPDATE_RUST_MCP_ZOD_GOLDEN=1 pnpm --filter @harkroom/server exec vitest run test/rustMcpZodGolden.test.ts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getParseErrorMessage, normalizeObjectSchema, safeParseAsync } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { expect, it } from 'vitest';
import { mcpSnapshotServer, mcpToolsListResult } from '../src/mcp/mcpPlugin.js';

const GOLDEN = fileURLToPath(new URL('../../../crates/harkroom-server/golden/mcp_zod_cases.json', import.meta.url));

type Schema = Record<string, unknown>;
const UUID = '11111111-1111-4111-8111-111111111111';
const PATTERN_SAMPLES: Record<string, string> = {
  '^s[1-9][0-9]{0,3}$': 's1',
  '^g[1-9][0-9]{0,3}$': 'g1',
  '^[sg][1-9][0-9]{0,3}$': 's1',
  '^([01]\\d|2[0-3]):[0-5]\\d$': '09:00',
  '^[a-z0-9][a-z0-9_-]{0,63}$': 'a',
  '^[0-9a-f]{40}$': '0'.repeat(40),
};

function resolve(root: Schema, s: Schema): Schema {
  const ref = s.$ref;
  if (typeof ref !== 'string') return s;
  let cur: unknown = root;
  for (const seg of ref.replace(/^#\//, '').split('/')) cur = (cur as Record<string, unknown>)[seg];
  return resolve(root, cur as Schema);
}

/** 스키마를 통과할 법한 값(못 지으면 아무 값 — 그 꼴도 골든에 실린다). */
function sample(root: Schema, s0: Schema): unknown {
  const s = resolve(root, s0);
  if (Array.isArray(s.anyOf)) {
    const opt = (s.anyOf as Schema[]).find((o) => resolve(root, o).type !== 'null');
    return opt ? sample(root, opt) : null;
  }
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case 'string': {
      if (s.format === 'uuid') return UUID;
      if (s.format === 'date-time') return '2026-01-01T00:00:00.000Z';
      if (s.format === 'uri') return 'https://example.com/';
      if (typeof s.pattern === 'string') return PATTERN_SAMPLES[s.pattern] ?? 'a/b';
      return 'a'.repeat(Math.max(Number(s.minLength ?? 1), 1));
    }
    case 'integer':
    case 'number':
      if (typeof s.minimum === 'number') return s.minimum;
      if (typeof s.exclusiveMinimum === 'number') return s.exclusiveMinimum + 1;
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return Array.from({ length: Number(s.minItems ?? 0) }, () => sample(root, (s.items ?? {}) as Schema));
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = (s.properties ?? {}) as Record<string, Schema>;
      for (const k of (s.required ?? []) as string[]) if (props[k]) out[k] = sample(root, props[k]);
      return out;
    }
    case 'null':
      return null;
    default:
      return 1;
  }
}

/** 이 칸에 넣어 볼 틀린(또는 경계) 값들. */
function junk(root: Schema, s0: Schema, depth: number): unknown[] {
  const s = resolve(root, s0);
  const out: unknown[] = [null, true, 1.5, -1, 'x', [], {}];
  if (Array.isArray(s.anyOf)) for (const o of s.anyOf as Schema[]) out.push(...junk(root, o, depth).slice(7));
  if (Array.isArray(s.enum) || 'const' in s) out.push('zzz');
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'string') {
    out.push('');
    if (typeof s.maxLength === 'number' && s.maxLength <= 2000) out.push('a'.repeat(s.maxLength + 1));
    if (s.format === 'uuid') out.push('not-a-uuid', UUID.toUpperCase());
    if (s.format === 'date-time') out.push('2026-01-01T00:00:00Z', '2026-01-01T09:00:00+09:00', 'yesterday');
    if (s.format === 'uri') out.push('not a url');
    if (typeof s.pattern === 'string') out.push('!!');
  }
  if (type === 'integer' || type === 'number') {
    out.push(0, 2 ** 31);
    if (typeof s.minimum === 'number') out.push(s.minimum - 1);
    if (typeof s.maximum === 'number') out.push(s.maximum + 1, s.maximum + 0.5);
    if (typeof s.exclusiveMinimum === 'number') out.push(s.exclusiveMinimum);
  }
  if (type === 'array') {
    const item = (s.items ?? {}) as Schema;
    out.push([null], ['x', 1]);
    if (typeof s.maxItems === 'number') out.push(Array.from({ length: s.maxItems + 1 }, () => sample(root, item)));
    if (depth < 1) for (const j of junk(root, item, depth + 1).slice(0, 9)) out.push([sample(root, item), j]);
  }
  if (type === 'object' && depth < 1) {
    const base = sample(root, s) as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const [k, p] of Object.entries(props)) for (const j of junk(root, p, depth + 1).slice(0, 9)) out.push({ ...base, [k]: j });
    if (s.additionalProperties && typeof s.additionalProperties === 'object') out.push({ a: 1 }, { a: null, b: 'x' });
  }
  return out;
}

function cases(name: string, root: Schema): { tool: string; args: unknown }[] {
  const out: { tool: string; args: unknown }[] = [{ tool: name, args: {} }];
  const base = sample(root, root) as Record<string, unknown>;
  out.push({ tool: name, args: base });
  const props = (root.properties ?? {}) as Record<string, Schema>;
  for (const [k, p] of Object.entries(props)) {
    for (const j of junk(root, p, 0)) out.push({ tool: name, args: { ...base, [k]: j } });
    out.push({ tool: name, args: { [k]: null } }, { tool: name, args: { [k]: sample(root, p) } });
  }
  return out;
}

async function rustMcpZodGolden(): Promise<string> {
  const listed = JSON.parse(await mcpToolsListResult(true)) as { tools: { name: string; inputSchema: Schema }[] };
  const server = mcpSnapshotServer(true) as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> };
  const rows: { tool: string; args: unknown; text: string | null }[] = [];
  for (const t of listed.tools) {
    const reg = server._registeredTools[t.name];
    for (const c of cases(t.name, t.inputSchema)) {
      let text: string | null = null;
      if (reg?.inputSchema) {
        // SDK `McpServer.validateToolInput` 와 같은 순서·같은 함수.
        const schema = (normalizeObjectSchema(reg.inputSchema as never) ?? reg.inputSchema) as never;
        const r = await safeParseAsync(schema, c.args);
        if (!r.success) {
          const err = 'error' in r ? r.error : 'Unknown error';
          text = `MCP error -32602: Input validation error: Invalid arguments for tool ${t.name}: ${getParseErrorMessage(err)}`;
        }
      }
      rows.push({ ...c, text });
    }
  }
  return `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`;
}

it('Rust 앞단 인자 검증 골든이 TS(zod·SDK) 결과와 같다', async () => {
  const text = await rustMcpZodGolden();
  if (process.env.UPDATE_RUST_MCP_ZOD_GOLDEN === '1') writeFileSync(GOLDEN, text);
  expect(readFileSync(GOLDEN, 'utf8')).toBe(text);
});
