import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { InboxDelegationSummary, InboxEntry } from '@harkroom/shared';
import { cardDelegation, chipRow, threadDelegations, MAX_VISIBLE_CHIPS, MAX_VISIBLE_CHIPS_NARROW, STALLED_MS } from '../src/lib/delegationDisplay';
import { buildBoard } from '../src/lib/inboxBoard';
import { DelegationChips } from '../src/components/DelegationChips';
import { DelegationLabel } from '../src/components/DelegationLabel';
import { usePrefsStore } from '../src/state/prefsStore';

/**
 * 위임 표시(위임 재설계 v1 P6) — 인박스 카드 라벨 넷과 스레드 머리 아래 「맡긴 일」 칩 줄.
 * 재료는 서버가 싣는 `InboxEntry.delegations` 하나다. 요약이 없으면(스위치 꺼짐·옛 서버) 화면은 지금과 같아야 한다.
 */
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const H = 3_600_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

let seq = 0;
const entry = (extra: Partial<InboxEntry> = {}): InboxEntry => {
  seq += 1;
  return {
    id: seq, messageId: `m${seq}`, reason: 'delegation_update', readAt: null, channelId: 'c1', authorId: 'bot',
    body: `말 ${seq}`, meta: {}, createdAt: ago(H / 2), threadRootId: 'r1', ...extra,
  };
};
type Item = InboxDelegationSummary['items'][number];
const item = (handle: string, state: Item['state'], extra: Partial<Item> = {}): Item => ({
  handle, state, lastMessageId: null, lastActivityAt: ago(H / 2), ...extra,
});
const summary = (items: Item[], extra: Partial<InboxDelegationSummary> = {}): InboxDelegationSummary => ({
  id: `d${++seq}`, role: 'delegator', kind: 'delegate', delegatorHandle: 'lead', messageId: 'open-msg',
  planStepId: null, items, prWatches: [], ...extra,
});

describe('cardDelegation — 인박스 라벨 넷', () => {
  it('위임 사유도 요약도 없으면 라벨이 없다 — 지금 화면 그대로', () => {
    expect(cardDelegation([entry({ reason: 'mention' })], NOW)).toBeNull();
  });

  it('담당의 글이 오면 진행 소식, 여럿이면 그 수를 센다', () => {
    const got = cardDelegation([entry(), entry(), entry()], NOW);
    expect(got).toEqual({ label: 'update', quietHours: null, updates: 3 });
  });

  it('결과(report)가 오면 「결과가 왔다」', () => {
    const got = cardDelegation([entry({ delegations: [summary([item('a', 'reported')])] })], NOW);
    expect(got?.label).toBe('reported');
    expect(cardDelegation([entry({ reason: 'delegation_done' })], NOW)?.label).toBe('reported');
  });

  it('담당 하나라도 실패면 다른 담당의 결과보다 먼저 「막혔다」', () => {
    const got = cardDelegation([entry({ delegations: [summary([item('a', 'reported'), item('b', 'failed')])] })], NOW);
    expect(got?.label).toBe('failed');
  });

  it('결과 없는 담당이 오래 조용하면 「멈췄다 · n시간」 — 기준 아래면 아니다', () => {
    const stalled = cardDelegation([entry({ delegations: [summary([item('a', 'open', { lastActivityAt: ago(STALLED_MS + H) })])] })], NOW);
    expect(stalled).toMatchObject({ label: 'stalled', quietHours: 5 });
    const fresh = cardDelegation([entry({ delegations: [summary([item('a', 'open', { lastActivityAt: ago(STALLED_MS - H) })])] })], NOW);
    expect(fresh?.label).toBe('update');
  });

  it('담당 쪽 요약(내가 맡은 일)은 라벨을 만들지 않는다', () => {
    const got = cardDelegation([entry({ reason: 'mention', delegations: [summary([item('me', 'failed')], { role: 'delegate' })] })], NOW);
    expect(got).toBeNull();
  });

  it('실패·멈춤 카드는 보드에서 「막힘」 묶음으로 간다', () => {
    const cards = buildBoard({
      entries: [
        entry({ threadRootId: 'f', delegations: [summary([item('a', 'failed')])] }),
        entry({ threadRootId: 'u' }),
      ],
      threads: null, me: { id: 'me', kind: 'human' }, threadStates: [], isAgent: () => true, nowMs: NOW,
    });
    expect(cards.find((c) => c.rootId === 'f')?.kind).toBe('blocker');
    expect(cards.find((c) => c.rootId === 'u')?.kind).toBe('news');
    expect(cards.find((c) => c.rootId === 'u')?.delegation?.label).toBe('update');
  });
});

describe('chipRow — 칩 줄', () => {
  it('위임이 없으면 줄이 없다', () => {
    expect(chipRow(null)).toBeNull();
    expect(chipRow([])).toBeNull();
  });

  it('막힘 → 결과 옴 → 하는 중 → 닫힘 순, PR 감시는 그 위임 칩 바로 뒤', () => {
    const watch = { repo: 'o/r', number: 12, head: 'a'.repeat(40), until: 'checks' as const, byHandle: 'w' };
    const row = chipRow([
      summary([item('w', 'open')], { prWatches: [watch] }),
      summary([item('c', 'closed', { closedReason: 'idle' })]),
      summary([item('r', 'reported')]),
      summary([item('f', 'failed')]),
    ])!;
    expect(row.chips.map((c) => (c.kind === 'item' ? `${c.handle}:${c.state}` : `pr#${c.watch.number}`)))
      .toEqual(['f:failed', 'r:reported', 'w:open', 'pr#12', 'c:closed']);
  });

  it(`담당 칩이 ${MAX_VISIBLE_CHIPS}개를 넘으면 뒤(닫힌 것부터)를 접는다`, () => {
    const row = chipRow([summary([
      item('a', 'open'), item('b', 'open'), item('c', 'closed'), item('d', 'failed'), item('e', 'closed'), item('f', 'reported'),
    ])])!;
    expect(row.chips.filter((c) => c.kind === 'item')).toHaveLength(MAX_VISIBLE_CHIPS);
    expect(row.hidden.map((c) => (c.kind === 'item' ? c.handle : ''))).toEqual(['c', 'e']);
    expect(row.hiddenClosed).toBe(2);
  });

  it(`좁은 줄은 담당 칩 ${MAX_VISIBLE_CHIPS_NARROW}개만 편다 — 순서 규칙은 같다`, () => {
    const row = chipRow([summary([
      item('a', 'open'), item('b', 'open'), item('c', 'closed'), item('d', 'failed'),
    ])], MAX_VISIBLE_CHIPS_NARROW)!;
    expect(row.chips.map((c) => (c.kind === 'item' ? c.handle : ''))).toEqual(['d', 'a']);
    expect(row.hidden.map((c) => (c.kind === 'item' ? c.handle : ''))).toEqual(['b', 'c']);
    expect(row.hiddenClosed).toBe(1);
  });

  it('옛 결말(done·timeout·canceled)은 닫힘으로 읽는다', () => {
    const row = chipRow([summary([item('a', 'done'), item('b', 'timeout')])])!;
    expect(row.chips.map((c) => (c.kind === 'item' ? c.state : ''))).toEqual(['closed', 'closed']);
  });

  it('스레드의 가장 최근 요약을 고른다', () => {
    const old = summary([item('a', 'open')]);
    const fresh = summary([item('a', 'reported')]);
    const got = threadDelegations([
      entry({ createdAt: ago(2 * H), delegations: [old] }),
      entry({ createdAt: ago(H), delegations: [fresh] }),
      entry({ threadRootId: 'other', createdAt: ago(0), delegations: [summary([item('z', 'failed')])] }),
    ], 'r1');
    expect(got).toEqual([fresh]);
  });
});

describe('화면 — ko/en', () => {
  beforeEach(() => { usePrefsStore.getState().setLocale('ko'); });
  afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

  it('칩 줄: 머리·상태·단계·감시가 한국어로', () => {
    const watch = { repo: 'o/r', number: 1724, head: 'a'.repeat(40), until: 'checks' as const, byHandle: 'h' };
    const opened: string[] = [];
    render(<DelegationChips rootId="r1" onOpenMessage={(id) => opened.push(id)} summaries={[
      summary([item('harkroom', 'open')], { planStepId: 's2', prWatches: [watch] }),
      summary([item('security', 'failed')]),
      summary([item('designer', 'closed', { closedReason: 'delegator_close' })], { delegatorHandle: 'lead' }),
    ]} />);
    expect(screen.getByText('맡긴 일')).toBeTruthy();
    expect(screen.getByTestId('delegation-chip-harkroom').textContent).toContain('하는 중');
    expect(screen.getByTestId('delegation-chip-harkroom').textContent).toContain('s2 단계');
    expect(screen.getByTestId('delegation-chip-security').textContent).toContain('막힘');
    expect(screen.getByTestId('delegation-chip-designer').textContent).toContain('닫힘 · lead');
    // 조사를 붙이지 않는다 — handle 끝소리에 따라 틀리기 쉽다(designer).
    expect(screen.getByTestId('delegation-chip-designer').textContent).not.toContain('닫음');
    expect(screen.getByTestId('delegation-pr-1724').textContent).toContain('#1724 CI 감시 중');
    fireEvent.click(screen.getByTestId('delegation-chip-security'));
    expect(opened).toEqual(['open-msg']);
  });

  it('위임이 없으면 줄을 그리지 않는다', () => {
    render(<DelegationChips rootId="r1" summaries={null} onOpenMessage={() => {}} />);
    expect(screen.queryByTestId('delegation-chips')).toBeNull();
  });

  it('맡은 쪽이면 「맡은 일 · 넘긴 쪽」', () => {
    render(<DelegationChips rootId="r1" onOpenMessage={() => {}} summaries={[summary([item('me', 'open')], { role: 'delegate', delegatorHandle: 'lead' })]} />);
    expect(screen.getByText('맡은 일 · lead')).toBeTruthy();
  });

  it('넘친 칩은 「+n · 닫힘 k」로 접고 누르면 편다', () => {
    render(<DelegationChips rootId="r1" onOpenMessage={() => {}} summaries={[summary([
      item('a', 'open'), item('b', 'open'), item('c', 'closed'), item('d', 'failed'), item('e', 'closed'), item('f', 'reported'),
    ])]} />);
    const more = screen.getByTestId('delegation-chips-more');
    expect(more.textContent).toBe('+2 · 닫힘 2');
    expect(screen.queryByTestId('delegation-chip-e')).toBeNull();
    fireEvent.click(more);
    expect(screen.getByTestId('delegation-chip-e')).toBeTruthy();
  });

  it('좁은 줄 몫: 3·4번째 칩은 @sm 이상에서만 보이고 「+n」 이 폭마다 따로 선다', () => {
    render(<DelegationChips rootId="r1" onOpenMessage={() => {}} summaries={[summary([
      item('a', 'open'), item('b', 'open'), item('c', 'closed'), item('d', 'failed'),
    ])]} />);
    expect(screen.queryByTestId('delegation-chips-more')).toBeNull();
    const narrowMore = screen.getByTestId('delegation-chips-more-narrow');
    expect(narrowMore.textContent).toBe('+2 · 닫힘 1');
    expect(narrowMore.className).toContain('@sm:hidden');
    expect(screen.getByTestId('delegation-chip-b').parentElement!.className).toContain('hidden @sm:block');
    expect(screen.getByTestId('delegation-chip-a').parentElement!.className).not.toContain('hidden');
    fireEvent.click(narrowMore);
    expect(screen.getByTestId('delegation-chip-b').parentElement!.className).not.toContain('hidden');
  });

  it('라벨 넷 — ko 와 en', () => {
    const labels = [
      { label: 'update', quietHours: null, updates: 1 },
      { label: 'reported', quietHours: null, updates: 0 },
      { label: 'failed', quietHours: null, updates: 0 },
      { label: 'stalled', quietHours: 4, updates: 0 },
    ] as const;
    const { container, rerender } = render(<>{labels.map((d) => <DelegationLabel key={d.label} delegation={d} />)}</>);
    expect([...container.querySelectorAll('[data-label]')].map((e) => e.textContent))
      .toEqual(['진행 소식', '결과가 왔다', '맡긴 일이 막혔다', '멈췄다 · 4시간 조용']);
    usePrefsStore.getState().setLocale('en');
    rerender(<>{labels.map((d) => <DelegationLabel key={d.label} delegation={d} />)}</>);
    expect([...container.querySelectorAll('[data-label]')].map((e) => e.textContent))
      .toEqual(['Progress', 'Results are in', 'Handoff stuck', 'Stalled · quiet 4h']);
  });
});
