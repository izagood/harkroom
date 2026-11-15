// Rust 푸시 페이로드(`crates/harkroom-server/src/push/payload.rs`, S5.3 C5e-2)의 정본은 TS `services/push/payload.ts` 다.
// 이 시험이 같은 입력들을 TS 로 돌린 결과를 `golden/push_payload.json` 으로 두고, Rust 시험(`tests/push_payload.rs`)이 한 줄씩 대조한다.
// 고칠 때: `UPDATE_RUST_PUSH_GOLDEN=1 pnpm --filter @harkroom/server exec vitest run test/rustPushPayloadGolden.test.ts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  buildPushPayload, classifyPush, pushCollapseId, pushThreadKey, type PushKind, type PushReason,
} from '../src/services/push/payload.js';

const GOLDEN = fileURLToPath(new URL('../../../crates/harkroom-server/golden/push_payload.json', import.meta.url));

const ACC = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const TEAM = 'team:55555555-5555-4555-8555-555555555555';
const GROUP = 'group:44444444-4444-4444-8444-444444444444';
const GONE = '66666666-6666-4666-8666-666666666666';
const CH = '77777777-7777-4777-8777-777777777777';
const MSG = '88888888-8888-4888-8888-888888888888';
const ROOT = '99999999-9999-4999-8999-999999999999';
const HANDLES: Record<string, string> = { [ACC]: 'alex', [AGENT]: 'forge', [TEAM]: 'devteam', [GROUP]: 'ops' };

const REASONS: PushReason[] = ['mention', 'thread_reply', 'dm', 'ask'];
const META: (string | null)[] = [null, 'ask', 'failure', 'report', 'other'];

const classify = [] as { input: Parameters<typeof classifyPush>[0]; kind: PushKind }[];
for (const reason of REASONS) for (const authorKind of ['human', 'agent'] as const) for (const metaKind of META)
  for (const failureCode of [null, 'account_gate', 'x']) for (const mineThread of [false, true]) {
    const input = { reason, authorKind, metaKind, failureCode, mineThread };
    classify.push({ input, kind: classifyPush(input) });
  }

const KINDS: PushKind[] = ['ask', 'fail', 'gate', 'done', 'agent_reply', 'mention', 'thread_reply', 'dm'];
const BODIES: (string | null)[] = [
  null, '', '   ', 'hello', `<@${AGENT}> 일 끝 <@${TEAM}> <@${GROUP}> <@${GONE}>`,
  'a\n\n b\t　c﻿ d\u0085e', 'x'.repeat(119), 'x'.repeat(120), 'y'.repeat(121), '가'.repeat(130), '😀'.repeat(125),
];
const payloads = [] as { input: Record<string, unknown>; out: unknown }[];
let n = 0;
for (const kind of KINDS) for (const channelName of ['general', null, ''] as (string | null)[])
  for (const authorHandle of ['forge', null, ''] as (string | null)[]) for (const sound of [true, false]) {
    const previewBody = BODIES[n % BODIES.length]!;
    const input = {
      kind, accountId: ACC, messageId: MSG, channelId: CH, threadRootId: n % 3 === 0 ? null : ROOT,
      authorHandle, channelName, badge: n % 4 === 0 ? null : n, previewBody,
      replyCount: n % 5 - 1, optionCount: n % 3, sound,
    };
    n++;
    payloads.push({ input, out: buildPushPayload({ ...input, idToHandle: new Map(Object.entries(HANDLES)) }) });
  }

const collapse = KINDS.flatMap((kind) => [
  { kind, threadKey: ROOT, messageId: MSG, out: pushCollapseId(kind, ROOT, MSG) },
]);
const threadKeys = [
  { channelId: CH, channelName: null, threadRootId: ROOT, messageId: MSG },
  { channelId: CH, channelName: 'general', threadRootId: ROOT, messageId: MSG },
  { channelId: CH, channelName: 'general', threadRootId: null, messageId: MSG },
  { channelId: CH, channelName: '', threadRootId: null, messageId: MSG },
].map((i) => ({ ...i, out: pushThreadKey(i) }));

it('Rust 푸시 페이로드 골든이 TS 결과와 같다', () => {
  const golden = JSON.stringify({ handles: HANDLES, classify, payloads, collapse, threadKeys }, null, 1) + '\n';
  if (process.env.UPDATE_RUST_PUSH_GOLDEN === '1') writeFileSync(GOLDEN, golden);
  expect(readFileSync(GOLDEN, 'utf8')).toBe(golden);
});
