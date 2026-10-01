// 스레드 상태 리액션(D안) — 화면 쪽. 판정은 서버(shared/threadStatus.ts)가 하고, 여기서는
// ① 맨 앞에 숫자 없이 ② 누를 수 없게 ③ 🙋·🚨 만 테두리+낱말 ④ hover 이유 ⑤ thread.status 반영
// ⑥ 실시간 행이 배지 재료를 null 로 덮지 않음(0.3.107 배지 누락) ⑦ 사람 ✅ 와 분리 를 본다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { MessageRow, ThreadStatusReaction } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { keepThreadFacts } from '../src/state/appStore';
import { Reactions, statusSentence, withoutAgentStatusEchoes } from '../src/components/Reactions';
import { translator } from '../src/i18n';
import { acc, fakeApi, msg } from './helpers/fakeApi';

const st = (status: ThreadStatusReaction['status'], emoji: string, reason: string | null = null): ThreadStatusReaction =>
  ({ status, emoji, accountId: 'bot', reason, updatedAt: '2026-10-01T00:00:00.000Z' });

const seed = (extra: Partial<MessageRow> = {}) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), bot: acc('bot', 'harkbot', 'agent'), u2: acc('u2', 'someone') },
    activeChannelId: 'c1',
  });
  useAppStore.getState().upsertMessages('c1', [msg('r1', 'c1', 1, '부탁', 'u1', extra)]);
};
const root = () => useAppStore.getState().messages['c1']![0]!;
const feed = (c: Controller, e: unknown) =>
  (c as unknown as { handleEvent: (e: unknown) => void }).handleEvent(e);

beforeEach(() => seed());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('상태 리액션 칩', () => {
  it('맨 앞에, 숫자 없이, 버튼이 아니다 — 사람 칩은 그 뒤에 따로', () => {
    seed({ statusReaction: st('done', '✅'), reactions: [{ emoji: '✅', accountIds: ['u2'] }, { emoji: '👍', accountIds: ['u1'] }] });
    render(<Reactions message={root()} />);
    const row = screen.getByTestId('reactions');
    const first = row.firstElementChild as HTMLElement;
    expect(first.dataset.testid).toBe('status-reaction');
    expect(first.tagName).toBe('SPAN');
    expect(first.textContent).toBe('✅');
    // 사람이 단 ✅ 는 숫자와 함께 따로 남는다.
    expect(screen.getByTestId('reaction-✅').textContent).toBe('✅1');
  });

  it('눌러도 토글되지 않는다', () => {
    const toggle = vi.fn(async () => {});
    const c = new Controller(fakeApi());
    (c as unknown as { toggleReaction: typeof toggle }).toggleReaction = toggle;
    seed({ statusReaction: st('running', '💬') });
    render(<Reactions message={root()} />);
    fireEvent.click(screen.getByTestId('status-reaction'));
    expect(toggle).not.toHaveBeenCalled();
    expect(root().reactions).toEqual([]);
  });

  it('🙋·🚨 만 낱말을 받는다', () => {
    seed({ statusReaction: st('my-turn', '🙋', '어느 쪽?') });
    const { rerender } = render(<Reactions message={root()} />);
    expect(screen.getByTestId('status-reaction-label').textContent).toBe('Your turn');
    expect(screen.getByTestId('status-reaction').className).toContain('border-state-turn');
    rerender(<Reactions message={{ ...root(), statusReaction: st('stuck', '🚨', 'MCP auth') }} />);
    expect(screen.getByTestId('status-reaction-label').textContent).toBe('Stuck');
    expect(screen.getByTestId('status-reaction').className).toContain('border-state-stuck');
    rerender(<Reactions message={{ ...root(), statusReaction: st('waiting', '⏳', 'u2') }} />);
    expect(screen.queryByTestId('status-reaction-label')).toBeNull();
  });

  it('마우스를 올리면 이유가 뜬다', () => {
    vi.useFakeTimers();
    seed({ statusReaction: st('my-turn', '🙋', '수정안 둘 중 어느 것?') });
    render(<Reactions message={root()} />);
    fireEvent.mouseEnter(screen.getByTestId('status-reaction'));
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByTestId('reaction-tooltip').textContent).toContain('Your turn · harkbot asks · 수정안 둘 중 어느 것?');
  });

  it('상태가 있으면 에이전트만 단 👀·💬 는 숨기고, 사람이 낀 칩은 둔다', () => {
    const out = withoutAgentStatusEchoes([
      { emoji: '👀', accountIds: ['bot'] }, { emoji: '✅', accountIds: ['bot', 'u2'] }, { emoji: '🎉', accountIds: ['bot'] },
    ], useAppStore.getState().accounts as never);
    expect(out.map((r) => r.emoji)).toEqual(['✅', '🎉']);
  });

  it('답글 행에는 그리지 않는다', () => {
    render(<Reactions message={{ ...root(), threadRootId: 'x', statusReaction: st('done', '✅') }} />);
    expect(screen.queryByTestId('status-reaction')).toBeNull();
  });
});

describe('statusSentence', () => {
  const t = translator('ko');
  it('상태 낱말 · 누구 · 이유 — 기다리는 상대, 깨움 시각, 이유 없는 막힘, 80자 자르기', () => {
    const accounts = useAppStore.getState().accounts as never;
    expect(statusSentence(st('my-turn', '🙋', '어느 쪽?'), accounts, t, 'ko')).toBe('내 차례 · harkbot 가 묻는다 · 어느 쪽?');
    expect(statusSentence(st('waiting', '⏳', 'u2'), accounts, t, 'ko')).toBe('기다림 · someone 답을 기다림');
    expect(statusSentence(st('waiting', '⏳', '2026-10-01T06:30:00.000Z'), accounts, t, 'ko')).toMatch(/^기다림 · \d\d:\d\d에 다시 본다$/);
    expect(statusSentence(st('stuck', '🚨'), accounts, t, 'ko')).toBe('막힘 · harkbot 실패');
    expect(statusSentence(st('running', '💬'), accounts, t, 'ko')).toBe('작업 중 · harkbot');
    const long = 'ㄱ'.repeat(120);
    expect(statusSentence(st('stuck', '🚨', long), accounts, t, 'ko')).toBe(`막힘 · harkbot 실패 · ${'ㄱ'.repeat(80)}…`);
  });
});

describe('실시간 반영', () => {
  it('thread.status 가 루트의 상태를 갈아 끼우고 null 이면 뗀다', () => {
    const c = new Controller(fakeApi());
    feed(c, { type: 'thread.status', channelId: 'c1', rootId: 'r1', statusReaction: st('running', '💬') });
    expect(root().statusReaction?.emoji).toBe('💬');
    feed(c, { type: 'thread.status', channelId: 'c1', rootId: 'r1', statusReaction: st('my-turn', '🙋') });
    expect(root().statusReaction?.emoji).toBe('🙋');
    feed(c, { type: 'thread.status', channelId: 'c1', rootId: 'r1', statusReaction: null });
    expect(root().statusReaction).toBeNull();
  });

  it('재료가 빈 실시간 행(message.updated)이 알던 배지 재료를 지우지 않는다 — 0.3.107 배지 누락', () => {
    seed({ replyCount: 3, activityCount: 4, openAskHumanCount: 1, openAskAccountIds: [], openAskLinks: [],
      failureCount: 0, unresolvedFailureCount: 0, lastKind: 'user', lastAuthorId: 'bot', statusReaction: st('my-turn', '🙋') });
    const c = new Controller(fakeApi());
    // 서버 COLS 행: 재료는 null, statusReaction 은 실린다(키 있음).
    feed(c, { type: 'message.updated', message: msg('r1', 'c1', 1, '고친 부탁', 'u1', { editedAt: 'now', statusReaction: st('stuck', '🚨') }) });
    expect(root().body).toBe('고친 부탁');
    expect(root().openAskHumanCount).toBe(1);
    expect(root().replyCount).toBe(3);
    expect(root().lastAuthorId).toBe('bot');
    expect(root().statusReaction?.emoji).toBe('🚨');
  });

  it('옛 서버(statusReaction 키 없음)면 알던 상태를 유지한다, 답글 행은 손대지 않는다', () => {
    const prev = msg('r1', 'c1', 1, 'a', 'u1', { statusReaction: st('done', '✅') });
    const next = msg('r1', 'c1', 1, 'b', 'u1');
    expect(keepThreadFacts(prev, next).statusReaction?.emoji).toBe('✅');
    const reply = msg('x', 'c1', 2, 'r', 'u1', { threadRootId: 'r1' });
    expect(keepThreadFacts(reply, reply)).toBe(reply);
  });
});
