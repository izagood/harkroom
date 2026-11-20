// Rust 앞단의 `GET /collab/proposals`(`crates/harkroom-server/src/core/collab_read.rs`)는 저장소 줄을 TS 와 같은 순서로 세워야 한다.
// 그 순서의 정본은 `routes/collabRoutes.ts` 의 `a.localeCompare(b)`(ICU)다 — 이 시험이 GitHub 이름에 쓰는 ASCII 글자
// (`A-Z a-z 0-9 _ . - /`)로 지은 이름들을 같은 식으로 세운 결과를 `golden/collab_repo_order.json` 에 굽고,
// Rust 시험(`collab_read::tests`)이 자기 비교 함수로 같은 순서를 내는지 본다. 그 밖의 글자가 든 이름은 Rust 가 TS 로 넘긴다.
// 고칠 때: `UPDATE_RUST_COLLAB_ORDER_GOLDEN=1 pnpm --filter @harkroom/server exec vitest run test/rustCollabRepoOrderGolden.test.ts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const GOLDEN = fileURLToPath(new URL('../../../crates/harkroom-server/golden/collab_repo_order.json', import.meta.url));
const ROUTE = fileURLToPath(new URL('../src/routes/collabRoutes.ts', import.meta.url));

const ALL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-/';
/** 두세 글자 조합에 쓰는 줄인 글자 모음 — 글자 종류(소문자·대문자·숫자·기호 넷)마다 양 끝. */
const FEW = 'abzABZ09_.-/';
/** 실제 이름 꼴. 늘릴 때는 끝에 더한다. */
const REAL = [
  'izagood/harkroom',
  'izagood/harkroom-gate',
  'izagood/harkroom-internal',
  'izagood/harkroom_gate',
  'izagood/harkroom.gate',
  'izagood/Harkroom',
  'Izagood/harkroom',
  'IZAGOOD/HARKROOM',
  'izagood/harkroom2',
  'izagood/harkroom10',
  'izagood/harkRoom',
  'izagood/HARKroom',
  'octo-org/Hello_World',
  'octo-org/hello_world',
  'octo-org/hello-world',
  'octo-org/hello.world',
  'octo-org/helloworld',
  'octo_org/hello-world',
  'octo.org/hello-world',
  'octoorg/hello-world',
  'o/r',
  'O/r',
  'o/R',
  'O/R',
  'o/r-1',
  'o/r_1',
  'o/r.1',
  'o/r/1',
  'o/r1',
  'o/aB',
  'o/Ab',
  'o/AB',
  'o/ab',
  'o/abC',
  'o/aBc',
];

function names(): string[] {
  const out = new Set<string>(REAL);
  for (const a of ALL) out.add(a);
  for (const a of FEW) {
    for (const b of FEW) {
      out.add(a + b);
      for (const c of 'aA_-') out.add(a + b + c);
    }
  }
  return [...out];
}

it('협업 화면 저장소 순서(localeCompare)가 골든과 같다', () => {
  // 골든이 재는 식이 라우트가 쓰는 식 그대로인지 — 라우트가 줄 세우는 법을 바꾸면 여기서 먼저 깨진다.
  expect(readFileSync(ROUTE, 'utf8')).toContain('.sort(([a], [b]) => a.localeCompare(b))');
  const sorted = names().sort((a, b) => a.localeCompare(b));
  // 같은 자리로 치는 서로 다른 이름이 있으면 순서가 입력 순서에 달린다 — 골든이 순서를 확정하려면 없어야 한다.
  for (let i = 1; i < sorted.length; i++) expect(sorted[i - 1]!.localeCompare(sorted[i]!)).toBeLessThan(0);
  const text = `${JSON.stringify({ sorted }, null, 1)}\n`;
  if (process.env.UPDATE_RUST_COLLAB_ORDER_GOLDEN === '1') writeFileSync(GOLDEN, text);
  expect(readFileSync(GOLDEN, 'utf8')).toBe(text);
});
