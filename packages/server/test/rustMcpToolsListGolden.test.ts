// Rust 코어가 MCP `tools/list`(P2b)를 답할 때 싣는 목록의 정본은 TS `buildMcpServer` 의 등록(zod 스키마 → SDK)이다. Rust 는
// `golden/mcp_tools_list.json` 을 읽고, 이 시험이 그 파일이 TS 값과 같은지 본다 — 도구·설명·스키마를 고치고 골든을 안 고치면 여기서
// 빨개진다(Rust 만 옛 목록을 주는 일을 막는다). 값은 SDK 가 내는 글자 그대로라 문자열로 싣는다(키 순서까지 같아야 한다).
// 고칠 때: `UPDATE_RUST_MCP_TOOLS_LIST_GOLDEN=1 pnpm --filter @harkroom/server exec vitest run test/rustMcpToolsListGolden.test.ts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { mcpToolsListResult } from '../src/mcp/mcpPlugin.js';

const GOLDEN = fileURLToPath(new URL('../../../crates/harkroom-server/golden/mcp_tools_list.json', import.meta.url));

async function rustMcpToolsListGolden(): Promise<string> {
  return `${JSON.stringify({
    base: await mcpToolsListResult(false),
    delegation_v2: await mcpToolsListResult(true),
  }, null, 2)}\n`;
}

it('Rust 코어의 tools/list 목록이 TS 정본과 같다', async () => {
  const text = await rustMcpToolsListGolden();
  if (process.env.UPDATE_RUST_MCP_TOOLS_LIST_GOLDEN === '1') writeFileSync(GOLDEN, text);
  expect(readFileSync(GOLDEN, 'utf8')).toBe(text);
});

it('조건부 등록은 delegation.close 하나로만 갈린다', async () => {
  const names = (s: string) => (JSON.parse(s) as { tools: { name: string }[] }).tools.map((t) => t.name);
  const base = names(await mcpToolsListResult(false));
  const v2 = names(await mcpToolsListResult(true));
  expect(base).not.toContain('delegation.close');
  expect(v2.filter((n) => !base.includes(n))).toEqual(['delegation.close']);
  expect(base.filter((n) => !v2.includes(n))).toEqual([]);
});
