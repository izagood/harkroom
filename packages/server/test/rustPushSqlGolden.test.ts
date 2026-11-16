// Rust 푸시 루프(`crates/harkroom-server/src/loops/push.rs`, S5.3 C5e-2)는 TS sweeper(`services/push/pushJobs.ts`)의 문장을 그대로 쓴다.
// 이 시험이 그 문장들을 `golden/push_sql.json` 으로 두고, Rust 가 `include_str!` 로 읽는다. 글자 하나라도 다르면 실패한다.
// 고칠 때: `UPDATE_RUST_PUSH_GOLDEN=1 pnpm --filter @harkroom/server exec vitest run test/rustPushSqlGolden.test.ts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { PUSH_AGENT_REPLY_DELAY_SEC, PUSH_RETRY_DELAYS_SEC, PUSH_SQL } from '../src/services/push/pushJobs.js';
import { LEAK_NEEDLES_SQL } from '../src/services/secretLeakGuard.js';

const GOLDEN = fileURLToPath(new URL('../../../crates/harkroom-server/golden/push_sql.json', import.meta.url));

it('push sweeper SQL golden matches TS', () => {
  const want = `${JSON.stringify({
    sql: { ...PUSH_SQL, leakNeedles: LEAK_NEEDLES_SQL },
    retryDelaysSec: PUSH_RETRY_DELAYS_SEC,
    agentReplyDelaySec: PUSH_AGENT_REPLY_DELAY_SEC,
  }, null, 2)}\n`;
  if (process.env.UPDATE_RUST_PUSH_GOLDEN === '1') writeFileSync(GOLDEN, want);
  expect(readFileSync(GOLDEN, 'utf8')).toBe(want);
});
