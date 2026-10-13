// Inbox 보드 판정의 **계약 표** — TS(원본)와 모바일 Dart 포팅(`apps/mobile/lib/api/inbox_board.dart`)이 같은
// 파일 `test/fixtures/inboxBoardCases.json` 을 읽는다(`apps/mobile/test/inbox_board_contract_test.dart`).
//
// 왜 표인가: 판정은 서버가 아니라 클라이언트에 있다. 모바일이 생기며 두 번째 구현이 생겼고, 둘이 갈리면 두 기기가
// 다른 「나를 기다리는 일 N」을 말한다. 표를 손으로 적지 않는다 — 손으로 적은 표는 세 번째 구현이다. 여기가
// 시나리오(입력)를 짓고 **지금 TS 구현으로** 답을 뽑는다.
//
// - 표와 구현이 다르면 여기가 빨개진다. 구현을 일부러 바꿨으면 `UPDATE_INBOX_BOARD_CASES=1 npx vitest run
//   test/inboxBoardCases.test.ts` 로 다시 뽑고, Dart 포팅도 고쳐라(그쪽 시험이 빨개진다).
// - 입력은 **서버가 보내는 그대로의 JSON 모양**이다 — Dart 는 자기 `fromJson` 으로 읽으므로 읽기도 함께 잰다.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxEntry, InboxThreadState, MessageRow } from '@harkroom/shared';
import { buildBoard, groupSimilar, mineCount, oneSentence, daysWaiting, type BoardCard } from '../src/lib/inboxBoard';
import { msg } from './helpers/fakeApi';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'inboxBoardCases.json');

const ME = 'me';
const BOT = 'bot';
const BOT2 = 'bot2';
const OTHER = 'other';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

let seq = 0;
const entry = (root: string | null, extra: Partial<InboxEntry> = {}): InboxEntry => {
  seq += 1;
  return {
    id: seq, messageId: `m${seq}`, reason: 'mention', readAt: null, channelId: 'c1', authorId: BOT,
    body: `말 ${seq}`, meta: {}, createdAt: ago(DAY / 2), threadRootId: root, ...extra,
  };
};
const head = (id: string, extra: Partial<MessageRow> = {}): MessageRow =>
  msg(id, 'c1', 1, `머리 ${id}`, OTHER, {
    createdAt: ago(DAY / 2), replyCount: 0, openAskHumanCount: 0, openAskAccountIds: [], openAskLinks: [],
    unresolvedFailureCount: 0, failureCount: 0, lastKind: 'user', lastAuthorId: OTHER, ...extra,
  });
const ask = (to: { kind: 'human' } | { kind: 'account'; accountId: string }, prompt?: string, extra: Record<string, unknown> = {}) => ({
  kind: 'ask', ask: { prompt, options: [{ id: 'a', label: '이대로' }, { id: 'b', label: '다시' }], to, ...extra },
});
const fail = (reason: string | undefined, extra: Record<string, unknown> = {}) => ({
  kind: 'failure', failure: { retryable: true, what: '하네스가 사람의 확인을 기다린다', reason, ...extra },
});
const sr = (status: NonNullable<MessageRow['statusReaction']>['status']): MessageRow['statusReaction'] =>
  ({ status, emoji: '·', accountId: BOT, reason: null, updatedAt: ago(0) });
const st = (rootId: string, state: 'done' | 'later', updatedAt = ago(0), until: string | null = null): InboxThreadState =>
  ({ rootId, state, updatedAt, until: state === 'later' ? until ?? new Date(NOW + DAY).toISOString() : null });

interface Scenario {
  name: string;
  entries: InboxEntry[];
  threads: MessageRow[] | null;
  threadStates?: InboxThreadState[];
  me?: { id: string; kind: 'human' | 'agent' } | null;
}

/** 시나리오. 갈래마다 하나 이상 — 하나가 빠지면 Dart 의 그 갈래는 아무것도 지키지 않는다. */
function scenarios(): Scenario[] {
  seq = 0;
  return [
    { name: '나를 지목한 열린 물음 = 내 차례·결정', entries: [entry('r1', { meta: ask({ kind: 'account', accountId: ME }, '어느 쪽으로 갈까?') })], threads: [head('r1', { openAskAccountIds: [ME] })] },
    { name: '남에게 간 물음은 내 차례가 아니다', entries: [entry('r1', { meta: ask({ kind: 'account', accountId: OTHER }) })], threads: [head('r1', { openAskAccountIds: [OTHER] })] },
    { name: '수신자 없는 물음은 내 스레드에서만', entries: [entry('r1', { reason: 'thread_reply', meta: ask({ kind: 'human' }) }), entry('r2', { reason: 'thread_reply', meta: ask({ kind: 'human' }) })], threads: [head('r1', { authorId: ME, openAskHumanCount: 1 }), head('r2', { openAskHumanCount: 1 })] },
    { name: '에이전트에게는 사람 앞 물음이 내 차례가 아니다', entries: [entry('r1', { meta: ask({ kind: 'human' }) })], threads: [head('r1', { authorId: ME, openAskHumanCount: 1 })], me: { id: ME, kind: 'agent' } },
    { name: '닫히거나 답한 물음은 열린 물음이 아니다', entries: [entry('r1', { meta: ask({ kind: 'account', accountId: ME }, '답했나?', { answeredWith: 'a' }) }), entry('r2', { meta: ask({ kind: 'account', accountId: ME }, '닫혔나?', { closedAt: ago(0) }) })], threads: [head('r1', { lastAuthorId: BOT }), head('r2', { lastAuthorId: BOT })] },
    { name: '선택지가 하나·여섯이거나 수신자를 못 읽으면 물음이 아니다', entries: [
      entry('r1', { meta: { kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }], to: { kind: 'account', accountId: ME } } } }),
      entry('r2', { meta: { kind: 'ask', ask: { options: [1, 2, 3, 4, 5, 6].map((i) => ({ id: `o${i}`, label: `${i}` })), to: { kind: 'account', accountId: ME } } } }),
      entry('r3', { meta: { kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to: { kind: 'robot' } } } }),
    ], threads: null },
    { name: '내 스레드의 실패 = 내 차례·막힘, 제목은 원인', entries: [entry('r1', { meta: fail('관문 화면에 섰다') })], threads: [head('r1', { authorId: ME, unresolvedFailureCount: 1 })] },
    { name: '원인이 없으면 무엇이 제목이다', entries: [entry('r1', { meta: fail(undefined) })], threads: [head('r1', { authorId: ME, unresolvedFailureCount: 1 })] },
    { name: 'retryable 이 불리언이 아니면 실패로 읽지 않는다', entries: [entry('r1', { meta: { kind: 'failure', failure: { what: '이상한 실패' } } })], threads: null },
    { name: '계정 관문 = 내 차례·막힘', entries: [entry('r1')], threads: [head('r1', { openGateAccountIds: [ME] })] },
    { name: '대기 마디가 나를 막고 있다 = 내 차례', entries: [entry('r1')], threads: [head('r1', { openAskLinks: [{ waiter: BOT, blockedBy: ME, askedAt: ago(DAY / 2) }] })] },
    { name: '내가 연 스레드가 남을 기다리면 막힘', entries: [entry('r1', { reason: 'thread_reply' })], threads: [head('r1', { authorId: ME, openAskAccountIds: [OTHER] })] },
    { name: '내가 기다리는 마디가 있으면 막힘', entries: [entry('r1')], threads: [head('r1', { openAskLinks: [{ waiter: ME, blockedBy: OTHER, askedAt: ago(DAY / 2) }] })] },
    { name: '에이전트의 답으로 끝난 것 = 끝남, 사람이 마지막이면 진행', entries: [entry('r1', { reason: 'thread_reply' }), entry('r2', { reason: 'thread_reply' })], threads: [head('r1', { authorId: ME, lastAuthorId: BOT }), head('r2', { authorId: ME, lastAuthorId: OTHER })] },
    { name: '도는 중(progress)이면 끝남이 아니다', entries: [entry('r1', { reason: 'thread_reply' })], threads: [head('r1', { authorId: ME, lastAuthorId: BOT, lastKind: 'progress' })] },
    { name: '서버 상태가 열을 정한다', entries: ['run', 'recv', 'wait', 'turn', 'mystuck', 'stuck', 'done'].map((r) => entry(r, { reason: 'thread_reply' })), threads: [
      head('run', { authorId: ME, statusReaction: sr('running') }), head('recv', { authorId: ME, statusReaction: sr('received') }),
      head('wait', { authorId: ME, statusReaction: sr('waiting') }), head('turn', { authorId: ME, statusReaction: sr('my-turn') }),
      head('mystuck', { authorId: ME, statusReaction: sr('stuck') }), head('stuck', { statusReaction: sr('stuck') }),
      head('done', { authorId: ME, lastAuthorId: ME, statusReaction: sr('done') }),
    ] },
    { name: '치움 — 내 차례도 이기고 끝남 맨 아래로', entries: [entry('r1', { meta: ask({ kind: 'account', accountId: ME }) }), entry('r2', { reason: 'thread_reply' })], threads: [head('r1', { openAskAccountIds: [ME] }), head('r2', { authorId: ME, lastAuthorId: BOT })], threadStates: [st('r1', 'done'), st('r2', 'done')] },
    { name: '치운 뒤 나에게 새 말이 오면 다시 선다', entries: [entry('r1', { createdAt: ago(DAY / 4) })], threads: [head('r1', { openAskAccountIds: [ME] })], threadStates: [st('r1', 'done', ago(DAY / 2))] },
    { name: '나중에 — 접히고, 시각이 지나면 다시 선다', entries: [entry('r1'), entry('r2')], threads: [head('r1', { openAskAccountIds: [ME] }), head('r2', { openAskAccountIds: [ME] })], threadStates: [st('r1', 'later', ago(0), new Date(NOW + DAY).toISOString()), st('r2', 'later', ago(DAY), ago(DAY / 8))] },
    { name: '7일 넘게 기다린 내 차례·막힘은 stale, 기간은 들어오게 한 말부터', entries: [
      entry('fresh', { createdAt: ago(DAY) }), entry('old', { createdAt: ago(10 * DAY) }),
      entry('reply', { createdAt: ago(10 * DAY), meta: ask({ kind: 'account', accountId: ME }, '열흘 된 물음?') }), entry('reply', { reason: 'thread_reply', createdAt: ago(DAY) }),
      entry('blk', { reason: 'thread_reply', createdAt: ago(8 * DAY) }),
    ], threads: [
      head('fresh', { openAskAccountIds: [ME] }), head('old', { openAskAccountIds: [ME] }),
      head('reply', { openAskAccountIds: [ME], lastReplyAt: ago(DAY) }),
      head('blk', { authorId: ME, openAskAccountIds: [OTHER], createdAt: ago(8 * DAY) }),
    ] },
    { name: '7일 조용한 진행은 quiet, 도는 중이면 아니다 · 7일 지난 끝남은 old', entries: [
      entry('q', { reason: 'thread_reply', createdAt: ago(9 * DAY) }), entry('qr', { reason: 'thread_reply', createdAt: ago(9 * DAY) }),
      entry('o', { reason: 'thread_reply', createdAt: ago(9 * DAY) }),
    ], threads: [
      head('q', { authorId: ME, createdAt: ago(9 * DAY) }), head('qr', { authorId: ME, createdAt: ago(9 * DAY), lastKind: 'progress' }),
      head('o', { authorId: ME, lastAuthorId: BOT, createdAt: ago(9 * DAY) }),
    ] },
    { name: '옛 서버(머리 없음) — 항목 meta 로', entries: [entry('r1', { meta: ask({ kind: 'account', accountId: ME }, '옛 서버?') }), entry(null), entry('r3', { meta: fail('옛 실패') })], threads: null },
    { name: '머리를 물었는데 안 왔으면(지워짐) 세우지 않는다', entries: [entry('gone')], threads: [] },
    { name: 'inbox 밖의 머리는 항목 없는 카드다(상태 유지)', entries: [], threads: [head('asked', { authorId: ME, body: '<@bot> 이거 해 줘', statusReaction: sr('received'), createdAt: ago(DAY / 4) }), head('kept', { authorId: ME, statusReaction: sr('running') })], threadStates: [st('kept', 'done', ago(DAY))] },
    { name: '같은 실패는 ×N — 채널·작성자·원인이 같아야, 결정 카드는 묶지 않는다', entries: [
      entry('f1', { meta: fail('관문'), createdAt: ago(60_000) }), entry('f2', { meta: fail('관문'), createdAt: ago(120_000) }), entry('f3', { meta: fail('관문'), createdAt: ago(180_000) }),
      entry('f4', { meta: fail('다른 원인') }), entry('f5', { channelId: 'c2', meta: fail('관문') }), entry('f6', { authorId: BOT2, meta: fail('관문') }),
      entry('f7', { meta: fail('관문', { code: 'gate' }) }),
      entry('q1', { meta: ask({ kind: 'account', accountId: ME }, 'q1?') }), entry('q1', { meta: fail('관문') }),
      entry('q2', { meta: ask({ kind: 'account', accountId: ME }, 'q2?') }), entry('q2', { meta: fail('관문') }),
      entry('d1', { meta: fail('관문') }), entry('d2', { meta: fail('관문') }),
    ], threads: [
      ...['f1', 'f2', 'f3', 'f4', 'f6', 'f7', 'q1', 'q2'].map((r) => head(r, { unresolvedFailureCount: 1 })),
      head('f5', { channelId: 'c2', unresolvedFailureCount: 1 }),
      head('d1', { openAskAccountIds: [ME], unresolvedFailureCount: 1 }), head('d2', { openAskAccountIds: [ME], unresolvedFailureCount: 1 }),
    ] },
    { name: '최근 것이 위 — 같은 시각이면 원래 자리 그대로', entries: [
      entry('a', { createdAt: ago(DAY) }), entry('b', { createdAt: ago(3 * DAY) }), entry('c', { createdAt: ago(DAY) }), entry('d', { createdAt: ago(2 * DAY) }),
    ], threads: ['a', 'b', 'c', 'd'].map((r) => head(r, { openAskAccountIds: [ME] })) },
    { name: '한 문장 — 표·코드·멘션·마크다운을 벗기고 물음 줄을 고른다', entries: [entry('s1', { body: '<@bot> 안녕\n| a | b |\n```\ncode?\n```\n## **굵게** 그리고 [링크](https://example.com) 를 볼까?' }), entry('s2', { body: '- `x` 와 _y_ 와 *기울임*을 했다\n\n둘째 줄' })], threads: [head('s1', { lastAuthorId: BOT, body: '' }), head('s2', { lastAuthorId: BOT })] },
    { name: '답글 수·안 읽음·작성자 없는 깨움', entries: [entry('r1', { readAt: ago(0), reason: 'thread_reply' }), entry('r2', { reason: 'wake', authorId: null })], threads: [head('r1', { authorId: ME, replyCount: 57, lastAuthorId: BOT }), head('r2', { authorId: ME, replyCount: 3 })] },
    { name: '머리만 나를 지목한 물음도 결정이다', entries: [entry('r1')], threads: [head('r1', { openAskAccountIds: [ME] })] },
    { name: '나를 모르면 내 차례가 없다', entries: [entry('r1', { meta: ask({ kind: 'account', accountId: ME }) })], threads: [head('r1', { openAskAccountIds: [ME] })], me: null },
  ];
}

const msOf = (iso: string | null): number | null => (iso == null ? null : Date.parse(iso));
const cardOut = (c: BoardCard) => ({
  rootId: c.rootId, channelId: c.channelId, column: c.column, fold: c.fold, entryIds: c.entries.map((e) => e.messageId),
  summary: c.summary, whoId: c.whoId, sinceAt: msOf(c.sinceAt), lastActivityAt: msOf(c.lastActivityAt), unread: c.unread,
  ask: c.ask, laterUntil: msOf(c.laterUntil), kind: c.kind, similarKey: c.similarKey, replyCount: c.replyCount,
});

const ONE_SENTENCE = [
  '', '그냥 한 줄', '첫 줄\n둘째 줄?', '> 인용된 물음?', '1) 번호 붙은 줄', '---\n| 표 |\n본문', '<@a><@b> 멘션 둘 뒤',
  '![그림](x.png) 과 [글](y)', 'snake_case_name 은 그대로', '_강조_ 는 벗긴다.', '**굵은** ~~취소~~ `코드`', '전각 물음표？',
  '가'.repeat(200), '```\n울타리 안?\n```\n밖', '  앞뒤 공백  ',
];

function generate() {
  return {
    note: 'packages/desktop/src/lib/inboxBoard.ts 가 원본. 손으로 고치지 말고 UPDATE_INBOX_BOARD_CASES=1 로 다시 뽑는다.',
    nowMs: NOW,
    me: { id: ME, kind: 'human' },
    agentIds: [BOT, BOT2],
    cases: scenarios().map((s) => {
      const me = s.me === undefined ? { id: ME, kind: 'human' as const } : s.me;
      const cards = buildBoard({
        entries: s.entries, threads: s.threads, threadStates: s.threadStates ?? [], me,
        isAgent: (id) => id === BOT || id === BOT2, nowMs: NOW,
      });
      return {
        name: s.name,
        input: { entries: s.entries, threads: s.threads, threadStates: s.threadStates ?? [], me },
        expected: {
          cards: cards.map(cardOut),
          groups: groupSimilar(cards).map((g) => [g.card.rootId, ...g.similar.map((c) => c.rootId)]),
          mineCount: mineCount(cards),
        },
      };
    }),
    oneSentence: ONE_SENTENCE.map((body) => ({ body, sentence: oneSentence(body) })),
    daysWaiting: [0, DAY / 2, DAY, 3 * DAY + 1, 10 * DAY].map((msAgo) => ({ sinceAt: ago(msAgo), days: daysWaiting(ago(msAgo), NOW) })),
  };
}

describe('Inbox 보드 판정 계약 (TS ↔ Dart 공용 표)', () => {
  const now = generate();
  if (process.env.UPDATE_INBOX_BOARD_CASES === '1') writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
  const saved = JSON.parse(readFileSync(FIXTURE, 'utf8')) as ReturnType<typeof generate>;

  it('표가 지금 TS 구현과 같다 — 다르면 다시 뽑고 Dart 포팅도 고쳐라', () => {
    expect(saved).toEqual(JSON.parse(JSON.stringify(now)));
  });

  it('표가 지키는 갈래가 실제로 들어 있다', () => {
    const cards = saved.cases.flatMap((c) => c.expected.cards);
    for (const col of ['mine', 'blocked', 'active', 'done']) expect(cards.some((c) => c.column === col), col).toBe(true);
    for (const fold of ['quiet', 'old', 'stale', 'cleared', 'later', null]) expect(cards.some((c) => c.fold === fold), String(fold)).toBe(true);
    for (const kind of ['decision', 'blocker', 'news']) expect(cards.some((c) => c.kind === kind), kind).toBe(true);
    expect(cards.some((c) => c.similarKey != null)).toBe(true);
    expect(cards.some((c) => c.ask != null)).toBe(true);
    expect(saved.cases.some((c) => c.expected.groups.some((g) => g.length > 2))).toBe(true);
  });
});
