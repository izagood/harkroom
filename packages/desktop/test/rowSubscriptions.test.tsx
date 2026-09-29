import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { selectAccountNames } from '../src/lib/accountNames';
import { acc, msg } from './helpers/fakeApi';

/**
 * 행은 **자기와 관계된 것에만** 다시 그려진다(대화 불러오기 성능, 2026-09-29 재측정).
 *
 * 전에는 행마다 `s.accounts` 와 `s.savedIds` 를 통째로 구독해서, 누구 하나의 상태·아바타가
 * 바뀌거나 메시지 하나를 담을 때마다 채널의 행 전부가 다시 그려졌다(WebKit 합성 500행에서
 * 이벤트 하나에 55~75ms). 여기서는 본문(`MessageBody`) 렌더 수를 행의 렌더 수로 읽는다 —
 * 행이 다시 그려지면 본문도 다시 그려진다(본문은 `memo` 가 아니다).
 */
const renders: Record<string, number> = {};
vi.mock('../src/components/MessageBody', async (orig) => {
  const m = await orig<typeof import('../src/components/MessageBody')>();
  const Counted = (p: Parameters<typeof m.MessageBody>[0]) => {
    renders[p.body] = (renders[p.body] ?? 0) + 1;
    return m.MessageBody(p);
  };
  return { ...m, MessageBody: Counted };
});
const { MessageItem } = await import('../src/components/MessageItem');

const U3 = '0f3c1a2b-0000-4000-8000-000000000003';
const rows = [
  msg('m1', 'c1', 1, 'first from u1', 'u1'),
  msg('m2', 'c1', 2, 'second from u2', 'u2'),
  msg('m3', 'c1', 3, `third calls <@${U3}>`, 'u2'),
];
const zero = () => { for (const k of Object.keys(renders)) delete renders[k]; };
const S = () => useAppStore.getState();

beforeEach(() => {
  setController({ openThread: vi.fn(), fetchAvatar: vi.fn(async () => null) } as unknown as Controller);
  S().reset();
  S().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bob'), [U3]: acc(U3, 'bot', 'agent') },
  });
  render(<>{rows.map((m) => <MessageItem key={m.id} message={m} />)}</>);
  zero();
});
afterEach(() => cleanup());

describe('row-scoped subscriptions', () => {
  it('a status change redraws only the status mark, not the rows', () => {
    act(() => { S().applyStatus('u2', 'away', 'lunch'); });
    expect(renders).toEqual({});
    // 그래도 화면은 바뀌어야 한다 — 구독을 좁히다 상태 표시까지 굳히면 안 된다.
    for (const el of screen.getAllByTestId('status-u2')) expect(el.dataset.status).toBe('away');
  });

  it('an avatar change does not redraw the rows', () => {
    act(() => { S().applyAvatar('u2', 'att-1'); });
    expect(renders).toEqual({});
  });

  it('saving one message redraws only that row', () => {
    act(() => { S().set({ savedIds: ['m2'] }); });
    expect(renders).toEqual({ 'second from u2': 1 });
  });

  it('a handle change still reaches the mention chip', () => {
    // 이름이 바뀌면 이름 지도가 새 참조가 되고 행이 다시 그려진다 — 그것이 맞다(`selectAccountNames` 주석).
    act(() => { S().applyHandle(U3, 'robot'); });
    expect(screen.getByText('@robot')).toBeTruthy();
  });
});

describe('selectAccountNames', () => {
  it('keeps the same reference across status and avatar events', () => {
    const before = selectAccountNames(S());
    act(() => { S().applyStatus(U3, 'away', null); S().applyAvatar('u1', 'att-2'); });
    expect(selectAccountNames(S())).toBe(before);
  });

  it('changes reference when a handle or kind changes', () => {
    const before = selectAccountNames(S());
    act(() => { S().applyHandle('u2', 'robert'); });
    const after = selectAccountNames(S());
    expect(after).not.toBe(before);
    expect(after.u2?.handle).toBe('robert');
  });
});
