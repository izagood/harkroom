import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ChannelAutoMentionRow } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { Composer } from '../src/components/Composer';
import { acc } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

/**
 * 채널이 특정 에이전트를 자동으로 멘션한다(#173) — 작성창 쪽 회귀선.
 *
 * 3. 작성창이 전송 직전 본문에 `@handle ` 을 붙인다 — onSend 로 나가는 본문(서버에 도착하는
 *    본문 그 자체)으로 확인한다.
 * 4. 본문에 이미 그 handle 이 있으면 두 번 붙이지 않는다.
 * 5. 칩 × 를 누르면 **그 메시지에는** 접두가 없고, 다음 메시지에는 다시 붙는다.
 * 그리고 칩이 고정 멘션과 구분돼 보인다('자동' 배지·title), 채널이 여럿을 부르면 전부 붙는다,
 * 비활성화된 에이전트는 붙이지 않는다.
 *
 * 서버 쪽(라우트·MCP 본문 무변경·inbox·감사)은 `packages/server/test/channelAutoMention.test.ts`.
 */
const row = (agentAccountId: string, handle: string): ChannelAutoMentionRow =>
  ({ channelId: 'c1', agentAccountId, handle, createdBy: 'ad', createdAt: new Date().toISOString() });

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};
const sendText = (value: string) => {
  const box = typeInto(value);
  fireEvent.keyDown(box, { key: 'Escape' });
  fireEvent.keyDown(box, { key: 'Enter' });
};
const autoChips = () =>
  screen.queryAllByTestId('auto-mention').map((el) => el.getAttribute('data-handle'));
const stickyChips = () =>
  screen.queryAllByTestId('sticky-mention').map((el) => el.getAttribute('data-handle'));

beforeEach(() => {
  // 보냄 취소 창은 이 파일의 관심사가 아니다(#223) — 끄고 즉시 전송 경로를 본다.
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: {
      u1: acc('u1', 'me'),
      a1: acc('a1', 'fizz', 'agent'),
      a2: acc('a2', 'honey', 'agent'),
      u2: acc('u2', 'rusalka'),
    },
    channelAutoMentions: { c1: [row('a1', 'fizz')] },
  });
});
afterEach(() => cleanup());

describe('자동 멘션 작성창 (#173)', () => {
  // 회귀 3
  it('전송 직전 본문 앞에 @handle 을 붙인다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" channelId="c1" />);

    sendText('이거 확인해 줘');

    expect(onSend).toHaveBeenCalledWith('@fizz 이거 확인해 줘', []);
  });

  it('채널이 부르지 않으면(설정 없음) 아무것도 붙이지 않는다', () => {
    useAppStore.getState().set({ channelAutoMentions: {} });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" channelId="c1" />);

    sendText('그냥 글');

    expect(onSend).toHaveBeenCalledWith('그냥 글', []);
    expect(autoChips()).toEqual([]);
  });

  // 회귀 4
  it('본문이 이미 그 handle 을 부르면 두 번 붙이지 않는다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" channelId="c1" />);

    sendText('@fizz 직접 불렀다');

    expect(onSend).toHaveBeenCalledWith('@fizz 직접 불렀다', []);
    // 직접 부른 것이 고정 칩으로 또 서지 않는다 — 자동 칩이 그 자리다.
    expect(stickyChips()).toEqual([]);
    expect(autoChips()).toEqual(['fizz']);
  });

  // 회귀 5
  it('칩 × 는 그 메시지에서만 뺀다 — 다음 메시지에는 다시 붙는다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" channelId="c1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip @fizz this time' }));
    expect(autoChips()).toEqual([]);
    sendText('이 줄은 에이전트 없이');
    expect(onSend).toHaveBeenLastCalledWith('이 줄은 에이전트 없이', []);

    // 설정은 그대로다 — 칩이 돌아오고 다음 줄에 다시 붙는다.
    expect(autoChips()).toEqual(['fizz']);
    sendText('다음 줄');
    expect(onSend).toHaveBeenLastCalledWith('@fizz 다음 줄', []);
  });

  it('칩은 고정 멘션과 구분된다 — 자동 배지와 title', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" channelId="c1" />);

    const chip = screen.getByTestId('auto-mention');
    expect(chip.getAttribute('title')).toBe('이 채널이 자동으로 멘션한다');
    expect(chip.textContent).toContain('자동');
    expect(chip.textContent).toContain('@fizz');
    // 고정 칩이 아니다 — 고정 칩의 × 는 설정을 바꾸는 뜻으로 읽힌다.
    expect(stickyChips()).toEqual([]);
  });

  it('채널이 여럿을 부르면 전부 붙고, 고정 멘션은 그 뒤에 온다', () => {
    useAppStore.getState().set({ channelAutoMentions: { c1: [row('a1', 'fizz'), row('a2', 'honey')] } });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" channelId="c1" />);

    sendText('@rusalka 같이 보자');
    sendText('다음');

    expect(stickyChips()).toEqual(['rusalka']);
    expect(onSend).toHaveBeenLastCalledWith('@fizz @honey @rusalka 다음', []);
  });

  it('설정된 뒤 비활성화된 에이전트는 붙이지 않는다', () => {
    useAppStore.getState().set({
      accounts: { ...useAppStore.getState().accounts, a1: acc('a1', 'fizz', 'agent', false, { disabled: true }) },
    });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" channelId="c1" />);

    sendText('깨어나지 못하는 상대');

    expect(autoChips()).toEqual([]);
    expect(onSend).toHaveBeenCalledWith('깨어나지 못하는 상대', []);
  });
});
