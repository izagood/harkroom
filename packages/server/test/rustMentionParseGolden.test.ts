// Rust 코어의 본문 멘션 파싱(`crates/harkroom-server/src/core/mention_parse.rs`, S5.3 C3a-3a)의 정본은 shared 의 TS 함수다.
// 이 시험이 같은 본문들을 TS 로 돌린 결과를 `golden/mention_parse.json` 으로 두고, Rust 시험이 그 파일과 한 줄씩 대조한다 —
// shared 의 규칙을 고치고 골든을 안 고치면 여기서 빨개지고, 골든을 고치면 Rust 가 따라오는지 cargo test 가 본다.
// 고칠 때: `UPDATE_RUST_MENTION_GOLDEN=1 pnpm --filter @harkroom/server exec vitest run test/rustMentionParseGolden.test.ts`.
//
// 위치(오프셋)는 넣지 않는다 — TS 는 UTF-16 칸, Rust 는 UTF-8 바이트라 숫자가 다르다. 대신 그 위치로 자른 **글자**를 넣는다.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  denormalizeMentions,
  headMentionRunEnd,
  mentionedHandles,
  mentionedIds,
  mentionedTargets,
  mentionScanText,
  normalizeMentions,
  splitCode,
  splitMentionCalls,
} from '@harkroom/shared';
import { expect, it } from 'vitest';

const GOLDEN = fileURLToPath(new URL('../../../crates/harkroom-server/golden/mention_parse.json', import.meta.url));

const FORGE = '11111111-1111-4111-8111-111111111111';
const MURMUR = '22222222-2222-4222-8222-222222222222';
const PERSON = '33333333-3333-4333-8333-333333333333';
const OPS = 'group:44444444-4444-4444-8444-444444444444';
const DEVTEAM = 'team:55555555-5555-4555-8555-555555555555';

/** handle(소문자) → 계정 id 또는 `group:`·`team:` 값. */
const ACCOUNTS: Record<string, string> = { forge: FORGE, murmur: MURMUR, alex: PERSON, ops: OPS, devteam: DEVTEAM };
const AGENTS = [FORGE, MURMUR];

/** 갈라지기 쉬운 자리를 하나씩 건드리는 본문들. 늘릴 때는 끝에 더한다. */
const BODIES: string[] = [
  '',
  'hello',
  '@forge',
  '@forge 일 좀',
  '@Forge @MURMUR 둘 다',
  '@forge\n@murmur\n본문',
  '보고: 구현은 @forge 것이고 @alex 확인',
  '@murmur 구현은 @forge 것이다',
  '@forge 다시 @forge',
  '@devteam 보고 바람',
  '보고 끝 — @devteam 참고',
  '@ops 공지',
  '중간에 @ops 공지',
  '@channel 모두',
  'me@forge.com 메일',
  'a@forge b',
  '(@forge) [@alex] "@murmur"',
  '@unknownperson 오타',
  '@f 한 글자',
  '@abcdefghijabcdefghijabcdefghijabcd 긴 이름',
  '@forge-bot_x 붙은 이름',
  '`@forge` 인라인 코드',
  '앞 `코드 @forge` 뒤 @alex',
  '``@forge`` 이중 백틱',
  '```\n@forge in fence\n```\n@alex 밖',
  '```ts\nconst a = "@forge";\n```',
  '```\n@forge 닫히지 않은 펜스',
  '```a```\n@forge',
  '  ```\n@forge\n  ``` x\n@murmur',
  '> @forge 인용\n@alex 평문',
  '> 인용 `코드` @forge\n본문',
  '   > 세 칸 인용 @forge',
  '    > 네 칸은 인용 아님 @forge',
  '> 인용\r\n@forge 다음',
  '> CRLF 인용 @forge\r\n끝',
  'https://x.com/@forge/status/1',
  '보세요 https://x.com/@forge. 그리고 @alex',
  '[@forge](https://x.io) 링크 이름표',
  'cc:@forge 평문',
  'mailto:@forge 스킴',
  'javascript:@forge',
  'http:@forge',
  'https://w.org/A_(@forge) 괄호',
  'harkroom://message/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee @forge',
  'harkroom://message/not-a-uuid@forge',
  '> 참고 https://x.com/@forge 겹침\n@murmur',
  '한국어 앞@forge 붙음',
  '이모지😀@forge 와 😀 @murmur',
  '　@forge 전각 공백 머리',
  '﻿@forge BOM 머리',
  '\u0085@forge NEL 머리',
  '@forge @murmur 줄 구분자',
  `<@${FORGE}> 이미 토큰`,
  `본문 <@${MURMUR}> 지칭 토큰`,
  `<@${DEVTEAM}> 팀 토큰 머리`,
  `끝에 <@${DEVTEAM}> 와 <@${OPS}>`,
  '@forge @devteam @ops 머리 셋 뒤 @murmur @devteam',
  '@forge,@murmur 쉼표',
  '@forge@murmur 붙여 씀',
  '\n\n  @forge 앞 빈 줄',
  'line1\n```\ncode @forge\n```\nline2 @murmur\n```\nopen only @alex',
  '`a` `b @forge` c @alex `',
  '``a` @forge 앞 이중 백틱',
  'x`a``@forge` 닫는 쪽 이중 백틱',
  'https://x.com/@forge 링크가 인용보다 앞\n> @murmur 인용\n@alex',
];

function golden(): string {
  const map = new Map(Object.entries(ACCOUNTS));
  const idToHandle = new Map(Object.entries(ACCOUNTS).map(([h, id]) => [id, h]));
  const isAgent = (id: string) => AGENTS.includes(id);
  const split = (body: string, authorIsAgent: boolean) => {
    const s = splitMentionCalls(body, { authorIsAgent, isAgent });
    return { call: s.call, ref: s.ref, targetCall: s.targetCall, targetRef: s.targetRef };
  };
  const cases = BODIES.map((body) => {
    const normalized = normalizeMentions(body, map);
    return {
      body,
      segments: splitCode(body).map((s) =>
        s.kind === 'plain'
          ? { kind: s.kind, text: s.text, lang: null, raw: body.slice(s.start, s.start + s.text.length) }
          : s.kind === 'inlineCode'
            ? { kind: s.kind, text: s.code, lang: null, raw: body.slice(s.start, s.end) }
            : { kind: s.kind, text: s.code, lang: s.lang, raw: body.slice(s.start, s.end) },
      ),
      scanText: mentionScanText(body),
      handles: mentionedHandles(body),
      ids: mentionedIds(body),
      targets: mentionedTargets(body),
      head: body.slice(0, headMentionRunEnd(body)),
      normalized,
      denormalized: denormalizeMentions(normalized, idToHandle),
      splitHuman: split(normalized, false),
      splitAgent: split(normalized, true),
    };
  });
  return `${JSON.stringify({ accounts: ACCOUNTS, agents: AGENTS, cases }, null, 2)}\n`;
}

it('Rust 코어의 멘션 파싱 골든이 TS 정본과 같다', () => {
  const text = golden();
  if (process.env.UPDATE_RUST_MENTION_GOLDEN === '1') writeFileSync(GOLDEN, text);
  expect(readFileSync(GOLDEN, 'utf8')).toBe(text);
});
