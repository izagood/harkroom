// Rust 코어가 MCP `workspace.guide`(S5.3 C4a-3)를 답할 때 싣는 글의 정본은 TS `guideFor` 다. Rust 는 `golden/mcp_guide.json` 을 읽고,
// 이 시험이 그 파일이 TS 값과 같은지 본다 — 가이드를 고치고 골든을 안 고치면 여기서 빨개진다(Rust 만 옛 글을 주는 일을 막는다).
// 고칠 때: `UPDATE_RUST_MCP_GUIDE_GOLDEN=1 pnpm --filter @harkroom/server exec vitest run test/rustMcpGuideGolden.test.ts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { guideFor } from '../src/mcp/guide.js';

const GOLDEN = fileURLToPath(new URL('../../../crates/harkroom-server/golden/mcp_guide.json', import.meta.url));

export function rustMcpGuideGolden(): string {
  return `${JSON.stringify({
    resident: guideFor('resident', { avcs: true }),
    resident_no_avcs: guideFor('resident', { avcs: false }),
    turn: guideFor('turn', { avcs: true }),
    turn_no_avcs: guideFor('turn', { avcs: false }),
  }, null, 2)}\n`;
}

it('Rust 코어의 workspace.guide 글이 TS 정본과 같다', () => {
  const text = rustMcpGuideGolden();
  if (process.env.UPDATE_RUST_MCP_GUIDE_GOLDEN === '1') writeFileSync(GOLDEN, text);
  expect(readFileSync(GOLDEN, 'utf8')).toBe(text);
});
