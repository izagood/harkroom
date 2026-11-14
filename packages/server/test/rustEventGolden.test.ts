// Rust 코어(`crates/harkroom-server/src/core`)가 WS 로 이벤트를 나누는 규칙의 정본은 TS 다 — 누가 받나(`wsPlugin.ts::EVENT_VISIBILITY`)와
// outbox 에서 받아들이는 꼴(`eventBus.ts` 의 종류 집합). Rust 는 `golden/events.json` 을 읽고, 이 시험이 그 파일이 TS 값과 같은지 본다 —
// 이벤트 종류를 TS 에 더하고 골든을 안 고치면 여기서 빨개진다(Rust 만 옛 표로 거르는 일을 막는다).
// 고칠 때: `UPDATE_RUST_EVENT_GOLDEN=1 pnpm --filter @harkroom/server exec vitest run test/rustEventGolden.test.ts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ACCOUNT_TYPES, AUDIENCE_TYPES, EVENT_BUS_TYPES } from '../src/eventBus.js';
import { EVENT_VISIBILITY } from '../src/ws/wsPlugin.js';

const GOLDEN = fileURLToPath(new URL('../../../crates/harkroom-server/golden/events.json', import.meta.url));

export function rustEventGolden(): string {
  const sorted = (s: ReadonlySet<string>) => [...s].sort();
  const visibility = Object.fromEntries(Object.entries(EVENT_VISIBILITY).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify({
    visibility,
    bus: { all: sorted(EVENT_BUS_TYPES), audience: sorted(AUDIENCE_TYPES), account: sorted(ACCOUNT_TYPES) },
  }, null, 2)}\n`;
}

it('Rust 코어의 이벤트 표가 TS 정본과 같다', () => {
  const text = rustEventGolden();
  if (process.env.UPDATE_RUST_EVENT_GOLDEN === '1') writeFileSync(GOLDEN, text);
  expect(readFileSync(GOLDEN, 'utf8')).toBe(text);
});
