// Rust 코어의 정체 홉 판정(`crates/harkroom-server/src/core/chain_stall.rs`, S5.3 C1c-4b)의 정본은 shared `chainStall.ts` 다.
// 이 시험이 같은 본문들을 TS 로 돌린 결과를 `golden/chain_stall.json` 으로 두고, Rust 시험이 그 파일과 한 줄씩 대조한다.
// 고칠 때: `UPDATE_RUST_STALL_GOLDEN=1 pnpm --filter @harkroom/server exec vitest run test/rustChainStallGolden.test.ts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chainArtifacts, messageLinkIds, STALL_HOP_LIMIT, STALL_LOOKBACK, stallStep } from '@harkroom/shared';
import { expect, it } from 'vitest';

const GOLDEN = fileURLToPath(new URL('../../../crates/harkroom-server/golden/chain_stall.json', import.meta.url));

const OWN = '1e086e53-91c5-4745-99f4-446432722094';
const OTHER = 'db87a234-68fb-4a62-9c32-a7545c4c5998';

/** 갈라지기 쉬운 자리(JS `\b`·`\s`·`/i`·uuid 마디·링크 지우기)를 건드리는 본문들. 늘릴 때는 끝에 더한다. */
const BODIES: string[] = [
  '',
  '확인',
  'head 4c3e7f2a 로 #1600 올림. harkroom://message/1e086e53-91c5-4745-99f4-446432722094 https://github.com/o/r/pull/1601',
  '10:15 KST, 2026-10-27 에 1234567 건 확인',
  '이미 4c3e7f2a 봤다',
  'head 4c3e7f2a83f63b23bcde61b7e309c5aaa8ba14b4',
  '#1600 다음으로 #1601 올림',
  '턴 a57049ef-b2c8-4047-be94-648f000142a0 확인',
  `앞 글 harkroom://message/${OWN}`,
  `저쪽 harkroom://message/${OTHER}`,
  `#1700 과 harkroom://message/${OTHER}`,
  'harkroom://message/1e086e53-91c5-4745-99f4-446432722094 harkroom://message/------------------------------------',
  'HARKROOM://MESSAGE/1E086E53-91C5-4745-99F4-446432722094 대문자',
  'ABCDEF1234 대문자 sha · deadbeef 낱말 · cafe 짧음',
  'sha4c3e7f2a 붙음 · 4c3e7f2a로 붙음 · (4c3e7f2a) 괄호',
  'izagood/harkroom#2273 과 owner.x/re-po#12, (#13) [#14] ,#15',
  '#12345678 길다 · a#16 앞 낱말 · #17a 뒤 낱말 · #18_ 밑줄',
  ' #19 nbsp · ﻿#20 bom · \u0085#21 nel · 　#22 전각',
  '줄\n#23 · 탭\t#24 · 로#25',
  'https://github.com/o/r/commit/4C3E7F2A83F63B23 커밋 · https://GITHUB.com/o/r/issues/77 · https://github.com/o/r/tree/main',
  'https://github.com/o/r/pull/1601#issuecomment-1 꼬리',
  'id 1e086e53-91c5-4745-99f4-446432722094 · 마디 1e086e53-91c5',
  '0123456789abcdef0123456789abcdef0123456789 41자',
  '0123456789abcdef0123456789abcdef01234567 40자',
  'Kelvin harkroom://meſſage/1e086e53-91c5-4745-99f4-446432722094',
  'ｃａｆｅ１２３ 전각 16진',
  `harkroom://message/${OWN}harkroom://message/${OTHER}`,
  'abc1234로 한글 붙은 sha 만',
  '#26로 뒤에 한글',
  'harKroom://message/1e086e53-91c5-4745-99f4-446432722094 켈빈 K 만',
];

const STEPS = [
  { mentionDepth: 0, prevStall: 3, body: '확인', recentBodies: [] as string[] },
  { mentionDepth: 5, prevStall: 3, body: 'head abc1234 올림', recentBodies: [] },
  { mentionDepth: 5, prevStall: 3, body: '이미 봤다', recentBodies: [] },
  { mentionDepth: 2, prevStall: 1, body: '이미 4c3e7f2a 봤다', recentBodies: ['head 4c3e7f2a83f63b23bcde61b7e309c5aaa8ba14b4'] },
  { mentionDepth: 2, prevStall: 1, body: '#1600 다음으로 #1601 올림', recentBodies: ['#1600 올림'] },
  { mentionDepth: 2, prevStall: 1, body: '캡처', recentBodies: [], hasAttachment: true },
  { mentionDepth: 3, prevStall: 2, body: `앞 글 harkroom://message/${OWN}`, recentBodies: [], own: [OWN] },
  { mentionDepth: 3, prevStall: 2, body: `저쪽 harkroom://message/${OTHER}`, recentBodies: [], own: [OWN] },
  { mentionDepth: 3, prevStall: 2, body: `#1700 과 harkroom://message/${OTHER}`, recentBodies: [], own: [OWN] },
  { mentionDepth: 3, prevStall: 2, body: `저쪽 harkroom://message/${OTHER}`, recentBodies: [`전에 harkroom://message/${OTHER}`], own: [OWN] },
  { mentionDepth: 1, prevStall: 0, body: 'id 1e086e53-91c5-4745-99f4-446432722094', recentBodies: [] },
];

it('정체 홉 판정 골든이 shared 의 TS 결과와 같다', () => {
  const want = {
    hopLimit: STALL_HOP_LIMIT,
    lookback: STALL_LOOKBACK,
    artifacts: BODIES.map((body) => ({
      body,
      artifacts: [...chainArtifacts(body)].sort(),
      ownArtifacts: [...chainArtifacts(body, { ownThreadIds: new Set([OWN]) })].sort(),
      linkIds: messageLinkIds(body),
    })),
    steps: STEPS.map((s) => ({
      ...s,
      hasAttachment: s.hasAttachment ?? false,
      own: s.own ?? [],
      out: stallStep({ ...s, ownThreadIds: new Set(s.own ?? []) }),
    })),
  };
  const text = `${JSON.stringify(want, null, 2)}\n`;
  if (process.env.UPDATE_RUST_STALL_GOLDEN === '1') writeFileSync(GOLDEN, text);
  expect(readFileSync(GOLDEN, 'utf8')).toBe(text);
});
