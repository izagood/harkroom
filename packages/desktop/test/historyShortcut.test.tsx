import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { Workspace } from '../src/components/Workspace';
import { historyShortcut } from '../src/lib/historyShortcut';
import { undoSendStorage } from '../src/lib/prefs';
import { acc, chan, fakeApi, msg } from './helpers/fakeApi';

/** 뒤로·앞으로 단축키 — 포커스가 작성창에 있어도 상단 바 버튼과 같은 이동이어야 한다. */
const parts = (over: Partial<KeyboardEvent>) => ({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over }) as KeyboardEvent;

describe('historyShortcut', () => {
  it('⌘·Ctrl 과 [ ] 만 받는다', () => {
    expect(historyShortcut(parts({ key: '[', metaKey: true }))).toBe('back');
    expect(historyShortcut(parts({ key: ']', ctrlKey: true }))).toBe('forward');
    expect(historyShortcut(parts({ key: '[' }))).toBeNull();
    expect(historyShortcut(parts({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }))).toBeNull();
    // AltGr 은 Ctrl+Alt 로 온다 — 글자 `[` 를 치는 손이다.
    expect(historyShortcut(parts({ key: '[', code: 'Digit8', ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('조합 중 이름으로 온 key 는 물리 키로 보고, 글자가 온 다른 배열의 그 자리는 받지 않는다', () => {
    expect(historyShortcut(parts({ key: 'Process', code: 'BracketLeft', metaKey: true }))).toBe('back');
    expect(historyShortcut(parts({ key: 'Process', code: 'BracketRight', metaKey: true }))).toBe('forward');
    expect(historyShortcut(parts({ key: 'ü', code: 'BracketLeft', metaKey: true }))).toBeNull();
  });
});

describe('Workspace 의 ⌘[·⌘]', () => {
  const mount = () => {
    const goBack = vi.fn().mockResolvedValue(false);
    const goForward = vi.fn().mockResolvedValue(false);
    setController({
      api: fakeApi(),
      openChannel: vi.fn().mockResolvedValue(undefined),
      openThread: vi.fn(), closeThread: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
      notifyTyping: vi.fn(), refreshAccounts: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(), reply: vi.fn(), loadOlder: vi.fn(),
      goBack, goForward,
    } as unknown as Controller);
    useAppStore.getState().set({
      channels: [chan('c1', 'general')],
      connected: true,
      activeChannelId: 'c1',
      messages: { c1: [msg('m1', 'c1', 1, '첫 줄', 'u1')] },
    });
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
    return { goBack, goForward, box: screen.getByPlaceholderText('Message #general') as HTMLElement & { value: string } };
  };
  const wait = (ms: number) => act(() => new Promise<void>((r) => { setTimeout(r, ms); }));
  /** 평범한 글 칸을 하나 붙인다 — 필요하면 `wrapper` 안에 넣는다. */
  const inputIn = (className = '', ariaModal = false) => {
    const wrap = document.createElement('div');
    wrap.className = className;
    if (ariaModal) wrap.setAttribute('aria-modal', 'true');
    const input = document.createElement('textarea');
    wrap.append(input);
    document.body.append(wrap);
    return { input, remove: () => wrap.remove() };
  };

  beforeEach(() => {
    localStorage.clear();
    usePrefsStore.getState().setLocale('en');
    undoSendStorage.saveWindowMs(0);
    useAppStore.getState().reset();
    useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') } });
  });
  afterEach(() => {
    cleanup();
    usePrefsStore.getState().setLocale('system');
    setController(null as unknown as Controller);
  });

  it('작성창에 포커스가 있어도 이동하고, 글은 들여쓰지 않는다', async () => {
    const { goBack, goForward, box } = mount();
    fireEvent.change(box, { target: { value: '쓰던 글', selectionStart: 4 } });

    fireEvent.keyDown(box, { key: '[', code: 'BracketLeft', metaKey: true });
    expect(goBack).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: ']', code: 'BracketRight', ctrlKey: true });
    expect(goForward).toHaveBeenCalledTimes(1);
    expect(box.value).toBe('쓰던 글');
  });

  it('평범한 입력칸에서도 이동한다', () => {
    const { goBack } = mount();
    const { input, remove } = inputIn();
    fireEvent.keyDown(input, { key: '[', metaKey: true });
    expect(goBack).toHaveBeenCalledTimes(1);
    remove();
  });

  it('터미널은 Ctrl+[ 를 ESC 로 가지므로 가로채지 않는다', () => {
    const { goBack } = mount();
    const { input, remove } = inputIn('xterm');
    expect(fireEvent.keyDown(input, { key: '[', ctrlKey: true })).toBe(true);
    expect(goBack).not.toHaveBeenCalled();
    remove();
  });

  it('겹창이 열려 있으면 이동하지 않는다', () => {
    const { goBack } = mount();
    const { input, remove } = inputIn('', true);
    fireEvent.keyDown(input, { key: '[', metaKey: true });
    fireEvent.keyDown(document.body, { key: '[', metaKey: true });
    expect(goBack).not.toHaveBeenCalled();
    remove();
  });

  it('한글 조합 중에 누르면 확정이 끝난 뒤 한 번 이동한다', async () => {
    const { goBack, box } = mount();
    fireEvent.compositionStart(box, { data: '' });
    fireEvent.keyDown(box, { key: 'Process', code: 'BracketLeft', keyCode: 229, metaKey: true, isComposing: true });
    expect(goBack).not.toHaveBeenCalled();

    fireEvent.compositionEnd(box, { data: '글' });
    await waitFor(() => expect(goBack).toHaveBeenCalledTimes(1));
    await wait(350);
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it('입력기가 compositionend 를 빠뜨려도 시한 뒤 이동한다', async () => {
    const { goForward, box } = mount();
    fireEvent.keyDown(box, { key: ']', code: 'BracketRight', keyCode: 229, metaKey: true, isComposing: true });
    await waitFor(() => expect(goForward).toHaveBeenCalledTimes(1), { timeout: 1000 });
  });
});
