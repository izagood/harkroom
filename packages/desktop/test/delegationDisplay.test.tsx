import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { InboxDelegationSummary, InboxEntry } from '@harkroom/shared';
import { chipRow, threadDelegations, MAX_VISIBLE_CHIPS, MAX_VISIBLE_CHIPS_NARROW } from '../src/lib/delegationDisplay';
import { DelegationChips } from '../src/components/DelegationChips';
import { usePrefsStore } from '../src/state/prefsStore';

/**
 * 위임 표시(위임 재설계 v1 P6) — 스레드 머리 아래 「맡긴 일」 칩 줄.
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
});
