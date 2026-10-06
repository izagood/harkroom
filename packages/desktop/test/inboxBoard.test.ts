// Inbox 상태 보드의 묶기·열 판정(`lib/inboxBoard`, C안 · designer 정정 1~5).
//
// 화면을 띄우지 않는다 — 여기서 재는 것은 **어느 카드가 어느 열에 서는가**이고, 그 판정은
// 순수 함수다. 화면이 그 결과를 그리는지는 `inbox.test.tsx` 가 잰다.
import { describe, it, expect } from 'vitest';
import type { InboxEntry, InboxThreadState, MessageRow } from '@harkroom/shared';
import { buildBoard, filterBoard, oneSentence, daysWaiting, laterUntilLabel, RECENT_MS, type BoardInput } from '../src/lib/inboxBoard';
import { msg } from './helpers/fakeApi';

const ME = 'me';
const BOT = 'bot';
const OTHER = 'other';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const DAY = 86_400_000;

const entry = (id: number, extra: Partial<InboxEntry> = {}): InboxEntry => ({
  id, messageId: `m${id}`, reason: 'mention', readAt: null, channelId: 'c1', authorId: BOT,
  body: `말 ${id}`, meta: {}, createdAt: ago(DAY / 2), threadRootId: null, ...extra,
});
const head = (id: string, extra: Partial<MessageRow> = {}): MessageRow =>
  msg(id, 'c1', 1, `머리 ${id}`, OTHER, {
    createdAt: ago(DAY / 2), replyCount: 0, openAskHumanCount: 0, openAskAccountIds: [], openAskLinks: [],
    unresolvedFailureCount: 0, failureCount: 0, lastKind: 'user', lastAuthorId: OTHER, ...extra,
  });

/** 내 상태 하나. 기본은 항목들(반나절 전)보다 **뒤에** 정한 것이다. */
const st = (rootId: string, state: 'done' | 'later', updatedAt = ago(0), until: string | null = null): InboxThreadState =>
  ({ rootId, state, updatedAt, until: state === 'later' ? until ?? new Date(NOW + DAY).toISOString() : null });

const board = (entries: InboxEntry[], threads: MessageRow[] | null, over: Partial<BoardInput> = {}) => buildBoard({
  entries, threads, threadStates: [], me: { id: ME, kind: 'human' }, isAgent: (id) => id === BOT, nowMs: NOW, ...over,
});

describe('묶기 — 카드 하나 = 스레드 하나', () => {
  it('같은 스레드에서 온 줄 다섯은 카드 한 장이다', () => {
    const rows = [1, 2, 3, 4, 5].map((i) => entry(i, { threadRootId: 'r1', reason: 'thread_reply' }));
    const cards = board(rows, [head('r1', { authorId: ME })]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.rootId).toBe('r1');
    expect(cards[0]!.entries).toHaveLength(5);
  });

  it('머리를 물었는데 안 왔으면(지워짐) 카드를 세우지 않는다', () => {
    expect(board([entry(1, { threadRootId: 'gone' })], [])).toHaveLength(0);
  });
});

describe('내 차례 — 범위는 내 스레드다 (정정 1)', () => {
  it('나를 지목한 열린 물음은 어느 스레드든 내 차례다', () => {
    const cards = board([entry(1, { reason: 'thread_reply', threadRootId: 'r1' })],
      [head('r1', { openAskAccountIds: [ME] })]);
    expect(cards[0]!.column).toBe('mine');
  });

  it('수신자 없는 물음·실패는 남의 스레드면 내 차례가 아니다 — "219" 가 다시 생기지 않는다', () => {
    const cards = board(
      [entry(1, { reason: 'thread_reply', threadRootId: 'r1' }), entry(2, { reason: 'thread_reply', threadRootId: 'r2' })],
      [head('r1', { openAskHumanCount: 1 }), head('r2', { unresolvedFailureCount: 1 })],
    );
    expect(cards.map((c) => c.column)).not.toContain('mine');
  });

  it('수신자 없는 물음은 내가 연 스레드거나 나를 부른 스레드면 내 차례다', () => {
    const cards = board(
      [entry(1, { reason: 'thread_reply', threadRootId: 'r1' }), entry(2, { reason: 'mention', threadRootId: 'r2' })],
      [head('r1', { authorId: ME, openAskHumanCount: 1 }), head('r2', { unresolvedFailureCount: 1 })],
    );
    expect(cards.map((c) => c.column)).toEqual(['mine', 'mine']);
  });

  it('에이전트에게는 사람 앞 물음이 내 차례가 아니다', () => {
    const cards = board([entry(1, { threadRootId: 'r1' })], [head('r1', { authorId: ME, openAskHumanCount: 1 })],
      { me: { id: ME, kind: 'agent' } });
    expect(cards[0]!.column).not.toBe('mine');
  });

  it('오래 기다린 것이 위다 (정정 2)', () => {
    const cards = board(
      [entry(1, { threadRootId: 'new', createdAt: ago(DAY) }), entry(2, { threadRootId: 'old', createdAt: ago(3 * DAY) })],
      [head('new', { openAskAccountIds: [ME] }), head('old', { openAskAccountIds: [ME] })],
    );
    expect(cards.map((c) => c.rootId)).toEqual(['old', 'new']);
  });
});

describe('막힘 — 내가 열었거나 위임한 스레드만', () => {
  it('내가 연 스레드가 남을 기다리면 막힘이다', () => {
    const cards = board([entry(1, { threadRootId: 'r1' })],
      [head('r1', { authorId: ME, openAskAccountIds: [OTHER] })]);
    expect(cards[0]!.column).toBe('blocked');
  });

  it('내가 위임한 일이 열려 있으면 막힘이다', () => {
    const cards = board([entry(1, { threadRootId: 'r1' })],
      [head('r1', { openAskLinks: [{ waiter: ME, blockedBy: BOT, askedAt: ago(DAY) }] })]);
    expect(cards[0]!.column).toBe('blocked');
  });

  it('나와 관계없는 남의 기다림은 막힘이 아니다', () => {
    const cards = board([entry(1, { threadRootId: 'r1' })],
      [head('r1', { openAskLinks: [{ waiter: OTHER, blockedBy: BOT, askedAt: ago(DAY) }] })]);
    expect(cards[0]!.column).toBe('active');
  });
});

describe('끝남 = 결과가 나온 것, 완료 = 치움 (정정 3 · 2/2)', () => {
  it('열린 것이 없고 마지막 말이 에이전트의 답이면 끝남이다', () => {
    const cards = board([entry(1, { threadRootId: 'r1' })], [head('r1', { lastKind: 'user', lastAuthorId: BOT })]);
    expect(cards[0]!.column).toBe('done');
    expect(cards[0]!.fold).toBeNull();
  });

  it('에이전트가 도는 중이면 진행이다', () => {
    const cards = board([entry(1, { threadRootId: 'r1' })], [head('r1', { lastKind: 'progress', lastAuthorId: BOT })]);
    expect(cards[0]!.column).toBe('active');
  });

  it('사람이 마지막이면 아직 답을 기다리는 진행이다', () => {
    const cards = board([entry(1, { threadRootId: 'r1' })], [head('r1', { lastAuthorId: ME })]);
    expect(cards[0]!.column).toBe('active');
  });

  it('완료한 카드는 끝남 맨 아래 치운 것으로 접힌다', () => {
    const cards = board([entry(1, { threadRootId: 'r1' })], [head('r1', { lastAuthorId: ME })],
      { threadStates: [st('r1', 'done')] });
    expect(cards[0]!.column).toBe('done');
    expect(cards[0]!.fold).toBe('cleared');
  });

  it('머리의 ✅ 리액션은 더 이상 치움이 아니다 — 서버의 내 상태만 본다', () => {
    const cards = board([entry(1, { threadRootId: 'r1' })],
      [head('r1', { lastAuthorId: ME, reactions: [{ emoji: '✅', accountIds: [ME] }] })]);
    expect(cards[0]!.fold).toBeNull();
  });

  it('치운 뒤 다시 나에게 물음이 오면 내 차례가 이긴다', () => {
    const cards = board([entry(1, { threadRootId: 'r1' })], [head('r1', { openAskAccountIds: [ME] })],
      { threadStates: [st('r1', 'done')] });
    expect(cards[0]!.column).toBe('mine');
    expect(cards[0]!.fold).toBeNull();
  });

  it('치운 뒤 나에게 새 말이 오면 다시 선다', () => {
    const cards = board([entry(1, { threadRootId: 'r1', createdAt: ago(DAY / 4) })], [head('r1', { lastAuthorId: ME })],
      { threadStates: [st('r1', 'done', ago(DAY / 2))] });
    expect(cards[0]!.fold).toBeNull();
  });
});

describe('나중에 (2/2)', () => {
  it('미룬 내 차례는 내 차례 열 맨 아래로 접힌다 — 수에서 빠질 수 있게', () => {
    const cards = board([entry(1, { threadRootId: 'r1' })], [head('r1', { openAskAccountIds: [ME] })],
      { threadStates: [st('r1', 'later', ago(0), new Date(NOW + DAY).toISOString())] });
    expect(cards[0]!.column).toBe('mine');
    expect(cards[0]!.fold).toBe('later');
  });

  it('깨어날 시각이 지나면 다시 선다', () => {
    const cards = board([entry(1, { threadRootId: 'r1' })], [head('r1', { openAskAccountIds: [ME] })],
      { threadStates: [st('r1', 'later', ago(0), ago(1000))] });
    expect(cards[0]!.fold).toBeNull();
  });
});

describe('7일 접힘 (정정 4)', () => {
  it('7일 넘게 조용한 진행은 조용한 것으로 접힌다', () => {
    const old = ago(RECENT_MS + DAY);
    const cards = board([entry(1, { threadRootId: 'r1', createdAt: old })],
      [head('r1', { createdAt: old, lastAuthorId: ME })]);
    expect(cards[0]!.column).toBe('active');
    expect(cards[0]!.fold).toBe('quiet');
  });

  it('도는 중이면 오래돼도 펼친다', () => {
    const old = ago(RECENT_MS + DAY);
    const cards = board([entry(1, { threadRootId: 'r1', createdAt: old })],
      [head('r1', { createdAt: old, lastKind: 'progress', lastAuthorId: BOT })]);
    expect(cards[0]!.fold).toBeNull();
  });

  it('7일 넘은 끝남은 지난 것으로 접힌다 — 최근 답글이 있으면 펼친다', () => {
    const old = ago(RECENT_MS + DAY);
    const cards = board(
      [entry(1, { threadRootId: 'r1', createdAt: old }), entry(2, { threadRootId: 'r2', createdAt: old })],
      [head('r1', { createdAt: old, lastAuthorId: BOT }), head('r2', { createdAt: old, lastAuthorId: BOT, lastReplyAt: ago(DAY) })],
    );
    expect(cards.find((c) => c.rootId === 'r1')!.fold).toBe('old');
    expect(cards.find((c) => c.rootId === 'r2')!.fold).toBeNull();
  });
});

describe('옛 서버 — 머리가 없으면 항목 meta 로', () => {
  it('나에게 온 열린 물음은 내 차례, 나머지는 진행', () => {
    const askMe = { kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to: { kind: 'account', accountId: ME } } };
    const cards = board([entry(1, { meta: askMe }), entry(2)], null);
    expect(cards.find((c) => c.rootId === 'm1')!.column).toBe('mine');
    expect(cards.find((c) => c.rootId === 'm1')!.ask?.options).toHaveLength(2);
    expect(cards.find((c) => c.rootId === 'm2')!.column).toBe('active');
  });
});

describe('한 문장', () => {
  it('표·코드·멘션·마크다운을 벗기고 물음 문장을 고른다', () => {
    const body = [
      '<@2c8c1910-da9c-47bc-a483-ce41a1217d85> **경과** 보고',
      '| a | b |',
      '|---|---|',
      '```',
      'code?',
      '```',
      '배포는 [여기](https://example.com) 서 봤다.',
      '이대로 *머지*해도 될까?',
    ].join('\n');
    expect(oneSentence(body)).toBe('이대로 머지해도 될까?');
  });

  it('물음이 없으면 첫 의미 있는 줄', () => {
    expect(oneSentence('## 제목\n\n- 첫 항목')).toBe('제목');
  });

  it('카드 문장은 나에게 온 물음의 prompt 를 먼저 쓴다', () => {
    const ask = { kind: 'ask', ask: { prompt: '어느 쪽으로 갈까?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to: { kind: 'account', accountId: ME } } };
    const cards = board([entry(1, { threadRootId: 'r1', meta: ask, body: '긴 설명\n\n표' })], [head('r1', { openAskAccountIds: [ME] })]);
    expect(cards[0]!.summary).toBe('어느 쪽으로 갈까?');
  });
});

describe('N일째', () => {
  it('하루 안이면 null, 넘으면 날 수', () => {
    expect(daysWaiting(ago(DAY / 2), NOW)).toBeNull();
    expect(daysWaiting(ago(3 * DAY + 1), NOW)).toBe(3);
  });
});

describe('미룬 카드가 다시 서는 시각', () => {
  const tr = (_k: 'inbox.board.tomorrowAt', v: { time: string }) => `내일 ${v.time}`;
  /** 로컬 시계 기준의 날짜 하나 — 오늘/내일 경계가 시험 기계의 시간대에 휘둘리지 않게. */
  const local = (dayOffset: number, h: number, m = 0): Date => {
    const d = new Date(2026, 9, 2, 0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const now = local(0, 14).getTime();

  it('카드가 until 을 싣는다 — 미룬 것만', () => {
    const until = new Date(NOW + DAY).toISOString();
    const cards = board([entry(1, { threadRootId: 'r1' }), entry(2, { threadRootId: 'r2' })],
      [head('r1', { openAskAccountIds: [ME] }), head('r2', { openAskAccountIds: [ME] })],
      { threadStates: [st('r1', 'later', ago(0), until)] });
    expect(cards.find((c) => c.rootId === 'r1')!.laterUntil).toBe(until);
    expect(cards.find((c) => c.rootId === 'r2')!.laterUntil).toBeNull();
  });

  it('내일이면 "내일 …", 정각이면 분을 뺀다', () => {
    const label = laterUntilLabel(local(1, 9).toISOString(), now, 'ko', tr);
    expect(label.startsWith('내일 ')).toBe(true);
    expect(label).toContain('9');
    expect(label).not.toContain(':');
  });

  it('오늘이면 시각만, 분이 있으면 분까지', () => {
    const label = laterUntilLabel(local(0, 18, 30).toISOString(), now, 'en', tr);
    expect(label).not.toContain('내일');
    expect(label).toContain('6:30');
  });

  it('그 뒤면 날짜가 붙는다', () => {
    const label = laterUntilLabel(local(3, 9).toISOString(), now, 'ko', tr);
    expect(label).not.toContain('내일');
    // 날짜 모양(`10월 5일`·`Oct 5`)은 ICU 데이터에 따라 갈린다 — 날이 들어가는지만 잰다.
    expect(label).toMatch(/5/);
    expect(label).not.toBe(laterUntilLabel(local(0, 9).toISOString(), now, 'ko', tr));
  });
});

describe('계정 관문 — Inbox 내 차례(서버 #1039 openGateAccountIds)', () => {
  it('차례 주인이 나면 남의 스레드여도 내 차례 열이다 — 지목된 물음과 같다', () => {
    const cards = board([entry(1, { threadRootId: 'r1', reason: 'thread_reply' })],
      [head('r1', { unresolvedFailureCount: 1, failureCount: 1, openGateAccountIds: [ME] })]);
    expect(cards[0]!.column).toBe('mine');
  });
});

/** 서버 상태 리액션(088) 하나. */
const sr = (status: NonNullable<MessageRow['statusReaction']>['status']): MessageRow['statusReaction'] =>
  ({ status, emoji: '·', accountId: BOT, reason: null, updatedAt: ago(0) });

describe('「내 작업」 S2 — 열은 서버 상태가 원본이다', () => {
  it('서버 상태가 열을 정한다: 💬👀 진행 · ⏳ 기다림 · ✅ 끝', () => {
    const rows = ['run', 'recv', 'wait', 'done'].map((r, i) => entry(i + 1, { threadRootId: r, reason: 'thread_reply' }));
    const cards = board(rows, [
      head('run', { authorId: ME, statusReaction: sr('running') }),
      head('recv', { authorId: ME, statusReaction: sr('received') }),
      head('wait', { authorId: ME, statusReaction: sr('waiting') }),
      // 마지막 말이 사람이어도 서버가 ✅ 면 끝이다 — 옛 규칙("마지막이 에이전트")과 갈리던 자리.
      head('done', { authorId: ME, lastAuthorId: ME, statusReaction: sr('done') }),
    ]);
    const col = Object.fromEntries(cards.map((c) => [c.rootId, c.column]));
    expect(col).toEqual({ run: 'active', recv: 'active', wait: 'blocked', done: 'done' });
  });

  it('서버가 ⏳ 면 마지막 말이 에이전트여도 끝이 아니다', () => {
    const cards = board([entry(1, { threadRootId: 'r1', reason: 'thread_reply' })],
      [head('r1', { authorId: ME, lastAuthorId: BOT, statusReaction: sr('waiting') })]);
    expect(cards[0]!.column).toBe('blocked');
  });

  it('나를 지목한 물음은 서버 상태보다 먼저다 — 🙋 이 나에게 온 것이면 내 차례', () => {
    const cards = board([entry(1, { threadRootId: 'r1', reason: 'thread_reply' })],
      [head('r1', { openAskAccountIds: [ME], statusReaction: sr('my-turn') })]);
    expect(cards[0]!.column).toBe('mine');
  });

  it('🙋 이 남에게 간 것이면 기다림이다', () => {
    const cards = board([entry(1, { threadRootId: 'r1', reason: 'thread_reply' })],
      [head('r1', { openAskHumanCount: 1, statusReaction: sr('my-turn') })]);
    expect(cards[0]!.column).toBe('blocked');
  });

  it('🚨 은 내 스레드면 내 차례, 남의 스레드면 기다림이다', () => {
    const cards = board(
      [entry(1, { threadRootId: 'mine', reason: 'thread_reply' }), entry(2, { threadRootId: 'theirs', reason: 'thread_reply' })],
      [head('mine', { authorId: ME, statusReaction: sr('stuck') }), head('theirs', { statusReaction: sr('stuck') })],
    );
    const col = Object.fromEntries(cards.map((c) => [c.rootId, c.column]));
    expect(col).toEqual({ mine: 'mine', theirs: 'blocked' });
  });

  it('서버 상태가 없는 머리(에이전트가 낀 적 없음)는 옛 규칙 그대로다', () => {
    const cards = board([entry(1, { threadRootId: 'r1', reason: 'thread_reply' })],
      [head('r1', { authorId: ME, lastAuthorId: BOT, statusReaction: null })]);
    expect(cards[0]!.column).toBe('done');
  });
});

describe('「내 작업」 S2 — inbox 밖의 머리는 항목 없는 카드다', () => {
  it('시켜 놓고 아직 답이 없는 스레드가 카드로 선다', () => {
    const cards = board([], [head('asked', { authorId: ME, body: '<@bot> 이거 해 줘', statusReaction: sr('received'), createdAt: ago(DAY / 4) })]);
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c).toMatchObject({ rootId: 'asked', column: 'active', entries: [], unread: false, whoId: ME, ask: null });
    expect(c.summary).toBe('이거 해 줘');
    expect(c.sinceAt).toBe(ago(DAY / 4));
  });

  it('항목과 겹치는 머리는 카드 하나다', () => {
    const cards = board([entry(1, { threadRootId: 'r1', reason: 'thread_reply' })],
      [head('r1', { authorId: ME, statusReaction: sr('running') })]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.entries).toHaveLength(1);
  });

  it('항목 없는 카드의 내 상태(완료)는 풀리지 않는다 — 풀 새 부름이 없다', () => {
    const cards = board([], [head('r1', { authorId: ME, statusReaction: sr('running') })],
      { threadStates: [st('r1', 'done', ago(DAY))] });
    expect(cards[0]).toMatchObject({ column: 'done', fold: 'cleared' });
  });

  it('남이 연 스레드에서 내가 말만 얹었어도 🚨 은 기다림이다 — 나를 부르지 않았다', () => {
    const cards = board([], [head('r1', { statusReaction: sr('stuck') })]);
    expect(cards[0]!.column).toBe('blocked');
  });
});

describe('「내 작업」 W2b — 필터는 서버가 준 머리 안에서만 거른다', () => {
  const heads = [
    head('opened', { authorId: ME }),
    head('said', { participantIds: [BOT, ME] }),
    head('other', { participantIds: [BOT] }),
  ];
  const cards = board(
    [entry(1, { threadRootId: 'opened' }), entry(2, { threadRootId: 'said' }), entry(3, { threadRootId: 'other' }), entry(4, { threadRootId: 'gone' })],
    null,
  );
  const ids = (scope: Parameters<typeof filterBoard>[2]) => filterBoard(cards, heads, scope, ME).map((c) => c.rootId).sort();

  it('모든 채널은 그대로다 — 머리가 없는 카드도', () => {
    expect(ids('all')).toEqual(['gone', 'opened', 'other', 'said']);
  });
  it('내가 연 것 ⊂ 참여한 것, 머리가 없으면 어느 쪽에도 안 든다', () => {
    expect(ids('opened')).toEqual(['opened']);
    expect(ids('participated')).toEqual(['opened', 'said']);
  });
  it('나를 모르면 걸러진 범위는 비어 있다', () => {
    expect(filterBoard(cards, heads, 'opened', null)).toEqual([]);
  });
});
