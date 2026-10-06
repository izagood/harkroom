// 스레드 상태 리액션 — 화면 쪽. 판정은 서버(shared/threadStatus.ts)가 하고 **진짜 리액션으로 단다**(server 108,
// 2026-10-06). 여기서는 ① 서버가 단 리액션을 상태 칩으로 알아본다(보통 칩 모양·숫자) ② 남의 상태 칩은 눌러도
// 안 달린다 ③ 🙋·🚨 만 색 테두리 ④ hover 이유 ⑤ 옛 서버면 상태에서 칩을 붙인다 ⑥ 끝남 ✅ 는 그리지 않는다
// ⑦ thread.status 반영 ⑧ 실시간 행이 배지 재료를 null 로 덮지 않음(0.3.107 배지 누락) 을 본다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { MessageRow, ThreadStatusReaction } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { keepThreadFacts } from '../src/state/appStore';
import { Reactions, statusSentence, withStatusReaction } from '../src/components/Reactions';
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
afterEach(() => { cleanup(); vi.useRealTimers(); setController(null); });

describe('상태 리액션 칩', () => {
  it('서버가 단 리액션을 상태 칩으로 그린다 — 보통 칩 모양, 숫자도 있다', () => {
    seed({ statusReaction: st('running', '💬'), reactions: [{ emoji: '👍', accountIds: ['u1'] }, { emoji: '💬', accountIds: ['bot'] }] });
    render(<Reactions message={root()} />);
    const chip = screen.getByTestId('reaction-💬');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.dataset.status).toBe('running');
    expect(chip.textContent).toBe('💬1');
    expect(screen.getByTestId('reaction-👍').dataset.status).toBeUndefined();
    // 칩은 하나뿐이다 — 따로 그리던 상태 칩은 없다.
    expect(screen.queryByTestId('status-reaction')).toBeNull();
    expect(screen.getAllByTestId(/^reaction-💬$/)).toHaveLength(1);
  });

  it('남의 상태 칩은 눌러도 안 달린다 — 내가 같이 단 것은 뗄 수 있다', () => {
    const toggle = vi.fn(async () => {});
    const c = new Controller(fakeApi());
    (c as unknown as { toggleReaction: typeof toggle }).toggleReaction = toggle;
    setController(c);
    seed({ statusReaction: st('received', '👀'), reactions: [{ emoji: '👀', accountIds: ['bot'] }] });
    const { rerender } = render(<Reactions message={root()} />);
    fireEvent.click(screen.getByTestId('reaction-👀'));
    expect(toggle).not.toHaveBeenCalled();
    rerender(<Reactions message={{ ...root(), reactions: [{ emoji: '👀', accountIds: ['bot', 'u1'] }] }} />);
    fireEvent.click(screen.getByTestId('reaction-👀'));
    expect(toggle).toHaveBeenCalledWith('c1', 'r1', '👀', false);
  });

  it('🙋·🚨 만 색 테두리를 받는다', () => {
    seed({ statusReaction: st('my-turn', '🙋', '어느 쪽?'), reactions: [{ emoji: '🙋', accountIds: ['bot'] }] });
    const { rerender } = render(<Reactions message={root()} />);
    expect(screen.getByTestId('reaction-🙋').className).toContain('border-state-turn');
    rerender(<Reactions message={{ ...root(), statusReaction: st('stuck', '🚨', 'MCP auth'), reactions: [{ emoji: '🚨', accountIds: ['bot'] }] }} />);
    expect(screen.getByTestId('reaction-🚨').className).toContain('border-state-stuck');
    rerender(<Reactions message={{ ...root(), statusReaction: st('waiting', '⏳', 'u2'), reactions: [{ emoji: '⏳', accountIds: ['bot'] }] }} />);
    expect(screen.getByTestId('reaction-⏳').className).toContain('border-border');
  });

  it('마우스를 올리면 이유가 뜬다', () => {
    vi.useFakeTimers();
    seed({ statusReaction: st('my-turn', '🙋', '수정안 둘 중 어느 것?'), reactions: [{ emoji: '🙋', accountIds: ['bot'] }] });
    render(<Reactions message={root()} />);
    fireEvent.mouseEnter(screen.getByTestId('reaction-🙋'));
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByTestId('reaction-tooltip').textContent).toContain('Your turn · harkbot asks · 수정안 둘 중 어느 것?');
  });

  it('리액션이 아직 없으면(옛 서버·이벤트 찰나) 상태에서 칩을 붙인다, 끝남 ✅ 는 붙이지 않는다', () => {
    expect(withStatusReaction([], st('running', '💬'))).toEqual([{ emoji: '💬', accountIds: ['bot'] }]);
    expect(withStatusReaction([{ emoji: '💬', accountIds: ['u2'] }], st('running', '💬')))
      .toEqual([{ emoji: '💬', accountIds: ['bot', 'u2'] }]);
    const already = [{ emoji: '💬', accountIds: ['bot'] }];
    expect(withStatusReaction(already, st('running', '💬'))).toBe(already);
    expect(withStatusReaction([], st('done', '✅'))).toEqual([]);
  });

  it('끝난 스레드는 사람 ✅ 만 — 상태 칩이 아니다', () => {
    seed({ statusReaction: st('done', '✅'), reactions: [{ emoji: '✅', accountIds: ['u2'] }] });
    render(<Reactions message={root()} />);
    expect(screen.getByTestId('reaction-✅').dataset.status).toBeUndefined();
    expect(screen.getByTestId('reaction-✅').textContent).toBe('✅1');
  });

  it('답글 행에는 상태를 붙이지 않는다', () => {
    render(<Reactions message={{ ...root(), threadRootId: 'x', statusReaction: st('running', '💬') }} />);
    expect(screen.queryByTestId('reaction-💬')).toBeNull();
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
