// 인박스 줄이 **무슨 말인가**(#488 C2).
//
// 문서의 진단: *"네 줄이 글자 하나까지 똑같다 — `스레드 답글 #general` 넷."*
// 원인은 `reason` 의 값이 셋뿐이라는 것이다. 그 셋은 **어떻게 나에게 왔는가**를 말하지
// **무슨 말인가**를 말하지 않는다.
//
// 이 파일이 지키는 것은 **줄이 갈리는 것**과 **막는 순 정렬**이다.
import { describe, it, expect } from 'vitest';
import type { AskMeta, FailureMeta, InboxEntry, ReportMeta } from '@murmur/shared';
import { inboxRow, matchesFilter } from '../src/lib/inboxRow';

const ME = 'u-me';
const OTHER = 'u-other';

const entry = (over: Partial<InboxEntry> = {}): InboxEntry => ({
  id: 1, messageId: 'm1', reason: 'thread_reply', readAt: null, channelId: 'c1',
  authorId: 'a-alpha', body: '본문', meta: {}, createdAt: '2024-01-01T00:00:00.000Z',
  threadRootId: null, ...over,
});

const ask = (to: AskMeta['ask']['to'], opts = 2, answered = false): Record<string, unknown> => ({
  kind: 'ask',
  ask: {
    options: Array.from({ length: opts }, (_, i) => ({ id: `o${i}`, label: `선택 ${i}` })),
    to, ...(answered ? { answeredWith: 'o0' } : {}),
  },
} as unknown as Record<string, unknown>);

const failure: Record<string, unknown> =
  ({ kind: 'failure', failure: { retryable: true } } as FailureMeta) as unknown as Record<string, unknown>;
// `checks` 는 **문자열 배열**이다(`readReportMeta` 가 그렇게 검사한다) — 객체 배열로
// 두면 조용히 `null` 이 되어 이 줄이 '답글'로 떨어진다. 실제로 그렇게 틀렸다.
const report: Record<string, unknown> =
  ({ kind: 'report', report: { checks: ['테스트가 통과했다'] } } as ReportMeta) as unknown as Record<string, unknown>;

describe('줄이 갈린다 — reason 만으로는 못 하던 것', () => {
  it('나에게 온 선택은 "골라 줘"이고 나를 막는다', () => {
    const r = inboxRow(entry({ meta: ask({ kind: 'account', accountId: ME }) }), ME);
    expect(r.kind).toBe('ask');
    expect(r.label).toBe('골라 줘');
    expect(r.rank).toBe(0);
  });

  /** **규칙 04.** 남에게 간 물음은 읽을 것이다 — 강조가 여러 줄에 뿌려지면 신호가 죽는다. */
  it('남에게 간 선택은 나를 막지 않는다', () => {
    const r = inboxRow(entry({ meta: ask({ kind: 'account', accountId: OTHER }) }), ME);
    expect(r.label).toBe('고르는 중');
    expect(r.rank).toBe(1);
  });

  it("'사람 아무나'에게 온 것은 나를 막는다 — 내가 사람이면 내 차례일 수 있다", () => {
    expect(inboxRow(entry({ meta: ask({ kind: 'human' }) }), ME).rank).toBe(0);
  });

  it('이미 답한 물음은 아무도 막지 않는다', () => {
    const r = inboxRow(entry({ meta: ask({ kind: 'account', accountId: ME }, 2, true) }), ME);
    expect(r.kind).not.toBe('ask');
  });

  /** 실패는 **항상 사람에게 온다**(`FailureMeta` 에 `to` 가 없는 이유). */
  it('실패는 나를 막는다', () => {
    const r = inboxRow(entry({ meta: failure }), ME);
    expect(r.label).toBe('막혔다');
    expect(r.rank).toBe(0);
  });

  it('보고는 읽을 것이다 — 끝난 일은 나를 막지 않는다', () => {
    const r = inboxRow(entry({ meta: report }), ME);
    expect(r.label).toBe('끝냈다');
    expect(r.rank).toBe(1);
  });

  /**
   * **모르는 `meta` 는 평문으로 흐른다** — 이 저장소의 불변 규약이다. 새 어휘가 생겨도
   * 인박스가 터지지 않고 `reason` 이 정한 기본값으로 떨어진다.
   */
  it('모르는 meta 는 reason 이 정한 자리로 떨어진다', () => {
    const r = inboxRow(entry({ meta: { kind: 'not-yet-known' }, reason: 'mention' }), ME);
    expect(r.kind).toBe('mention');
    expect(r.label).toBe('불렀다');
  });

  it('네 종류가 서로 다른 글자를 받는다 — 이것이 이 작업의 전부다', () => {
    const labels = [
      inboxRow(entry({ meta: ask({ kind: 'account', accountId: ME }) }), ME).label,
      inboxRow(entry({ meta: failure }), ME).label,
      inboxRow(entry({ meta: report }), ME).label,
      inboxRow(entry({ reason: 'dm' }), ME).label,
    ];
    expect(new Set(labels).size).toBe(4);
  });
});

describe('선택은 줄에서 끝난다', () => {
  /**
   * 문서: *"선택지가 둘뿐이면 인박스에서 바로 누른다. 스레드를 열어야만 답할 수 있으면
   * 인박스는 알림 목록일 뿐이고, 컨셉이 말한 '막는 말을 푸는 자리'가 되지 못한다."*
   */
  it('둘이면 줄에서 고를 수 있다', () => {
    const r = inboxRow(entry({ meta: ask({ kind: 'account', accountId: ME }, 2) }), ME);
    expect(r.options).toHaveLength(2);
  });

  /** 셋 이상은 줄이 버튼 밭이 된다 — 그때는 스레드에서 고른다. */
  it('셋 이상이면 줄에서 고르지 않는다', () => {
    const r = inboxRow(entry({ meta: ask({ kind: 'account', accountId: ME }, 3) }), ME);
    expect(r.options).toBeNull();
  });

  it('남에게 간 물음은 내가 줄에서 고를 수 없다', () => {
    const r = inboxRow(entry({ meta: ask({ kind: 'account', accountId: OTHER }, 2) }), ME);
    expect(r.options).toBeNull();
  });
});

describe('필터 칩이 정렬과 같은 축을 쓴다', () => {
  const blocking = inboxRow(entry({ meta: failure }), ME);
  const reading = inboxRow(entry({ meta: report }), ME);
  const background = inboxRow(entry({ reason: 'thread_reply' }), ME);

  it('막는 것 · 읽을 것 · 배경이 서로 다른 rank 를 받는다', () => {
    expect([blocking.rank, reading.rank, background.rank]).toEqual([0, 1, 2]);
  });

  it("'나를 막는 것' 칩은 막는 줄만 남긴다", () => {
    expect(matchesFilter(blocking, 'blocking')).toBe(true);
    expect(matchesFilter(reading, 'blocking')).toBe(false);
    expect(matchesFilter(background, 'blocking')).toBe(false);
  });

  it("'전부' 는 배경까지 남긴다", () => {
    expect([blocking, reading, background].every((r) => matchesFilter(r, 'all'))).toBe(true);
  });

  // 'unread' 만 rank 가 아니라 **호출부가 넘긴 읽음 상태**를 본다. 안 넘기면 아무것도
  // 맞지 않는다 — 잊은 자리에서 조용히 전부 통과하면 "안 읽은 것"이 전부가 된다.
  it('안 읽음 칩은 읽음 상태로 가른다', () => {
    expect(matchesFilter(blocking, 'unread', true)).toBe(true);
    expect(matchesFilter(blocking, 'unread', false)).toBe(false);
    expect(matchesFilter(background, 'unread', true)).toBe(true);
    expect(matchesFilter(blocking, 'unread')).toBe(false);
  });
});
