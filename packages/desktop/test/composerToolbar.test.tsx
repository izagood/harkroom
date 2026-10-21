import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
import { QUICK_REACTIONS } from '../src/components/Reactions';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';
import { composerToolbarStorage, undoSendStorage } from '../src/lib/prefs';

/*
  입력창 상자의 도구줄·동작줄(입력창 개편 P2, 시안 v1).

  지키는 축:
  1. **단추 = 단축키** — 도구줄 단추는 같은 글·같은 선택에서 단축키와 똑같은 결과를 낸다.
  2. **Aa 는 기억된다** — 도구줄을 접으면 다음에 열어도 접혀 있다.
  3. **☺ 는 커서 자리에 넣는다**, ⌄ 는 「나중에 보내기」를 연다.
  4. **열린 메뉴는 Escape·바깥 누르기로 닫힌다** — 메뉴를 열어도 포커스는 편집기에 남으므로
     Escape 는 편집기로 간다. 그래도 닫혀야 한다.
*/

const place = (value: string, start: number, end = start) => {
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value, selectionStart: end } });
  box.setSelectionRange(start, end);
  return box;
};
const draft = () => useAppStore.getState().drafts[''] ?? '';

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  undoSendStorage.saveWindowMs(0);
  composerToolbarStorage.save(true);
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') } });
  setController(new Controller(fakeApi()));
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0; });
});
afterEach(() => {
  vi.restoreAllMocks();
  usePrefsStore.getState().setLocale('system');
  cleanup();
  setController(null as unknown as Controller);
});

describe('도구줄 단추 = 단축키', () => {
  // ⌘E·⌘K 는 글자(key)로, 나머지는 자리(code)로 읽는다(P1) — 둘 다 싣는다.
  const cases: { kind: string; code: string; key?: string; shift?: boolean }[] = [
    { kind: 'bold', code: 'KeyB' },
    { kind: 'italic', code: 'KeyI' },
    { kind: 'strike', code: 'KeyX', shift: true },
    { kind: 'ordered', code: 'Digit7', shift: true },
    { kind: 'bullet', code: 'Digit8', shift: true },
    { kind: 'quote', code: 'Digit9', shift: true },
    { kind: 'code', code: 'KeyE', key: 'e' },
    { kind: 'link', code: 'KeyK', key: 'k' },
  ];

  for (const c of cases) {
    it(`${c.kind}: 단추와 열쇠가 같은 글·같은 선택을 남긴다`, () => {
      render(<Composer onSend={vi.fn()} />);
      const box = place('이건 중요하다', 3, 5);
      fireEvent.keyDown(box, { key: c.key ?? '', code: c.code, metaKey: true, shiftKey: !!c.shift });
      const byKey = { text: draft(), sel: [box.selectionStart, box.selectionEnd] };
      expect(byKey.text).not.toBe('이건 중요하다');

      place('이건 중요하다', 3, 5);
      fireEvent.click(screen.getByTestId(`fmt-${c.kind}`));
      expect(draft()).toBe(byKey.text);
      expect([box.selectionStart, box.selectionEnd]).toEqual(byKey.sel);
    });
  }

  it('코드 블록 단추는 고른 줄을 펜스로 감싼다', () => {
    render(<Composer onSend={vi.fn()} />);
    place('ls -la', 0, 6);
    fireEvent.click(screen.getByTestId('fmt-codeBlock'));
    expect(draft()).toMatch(/^```\nls -la\n```/);
  });

  it('⌘⌥C 는 코드 블록 단추와 같은 글을 남긴다(시안 키보드 표)', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = place('ls -la', 0, 6);
    fireEvent.keyDown(box, { key: 'ç', code: 'KeyC', metaKey: true, altKey: true });
    expect(draft()).toMatch(/^```\nls -la\n```/);
  });
});

describe('Aa — 도구줄 접기', () => {
  it('접으면 도구줄이 사라지고, 다시 그려도 접혀 있다', () => {
    const { unmount } = render(<Composer onSend={vi.fn()} />);
    expect(screen.getByTestId('composer-toolbar')).toBeTruthy();
    const toggle = screen.getByTestId('composer-toolbar-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.queryByTestId('composer-toolbar')).toBeNull();
    expect(composerToolbarStorage.load()).toBe(false);
    unmount();

    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByTestId('composer-toolbar')).toBeNull();
    expect(screen.getByTestId('composer-toolbar-toggle').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('☺ 빠른 이모지', () => {
  it('리액션과 같은 목록을 띄우고, 고른 것은 커서 자리에 들어간다', async () => {
    // 커서는 다음 그림 뒤에 놓인다 — 즉시 부르는 rAF 로는 새 값이 그려지기 전에 놓여 잘린다.
    vi.restoreAllMocks();
    render(<Composer onSend={vi.fn()} />);
    const box = place('앞뒤', 1);
    fireEvent.click(screen.getByTestId('composer-emoji'));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((b) => b.textContent)).toEqual(QUICK_REACTIONS);
    fireEvent.click(screen.getByRole('menuitem', { name: '👍' }));
    expect(draft()).toBe('앞👍뒤');
    await waitFor(() => expect(box.selectionStart).toBe(1 + '👍'.length));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('⌄ 보내기 옵션', () => {
  it('「나중에 보내기」는 본문이 비면 막히고(⌄ 가 전송과 같이 흐리다), 있으면 예약 창을 연다', () => {
    render(<Composer onSend={vi.fn()} channelId="c1" />);
    // 「전송」│⌄ 는 한 덩어리(#1431 designer 2) — 빈 입력이면 둘 다 흐리다.
    expect((screen.getByTestId('composer-send-options') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '메시지 보내기' }) as HTMLButtonElement).disabled).toBe(true);

    place('나중에 보낼 말', 8);
    fireEvent.click(screen.getByTestId('composer-send-options'));
    fireEvent.click(screen.getByRole('menuitem', { name: '나중에 보내기' }));
    expect(screen.getByLabelText('예약 시각')).toBeTruthy();
  });

  it('채널이 없는 자리(단독 컴포저)에는 ⌄ 를 그리지 않는다', () => {
    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByTestId('composer-send-options')).toBeNull();
  });

  it('한쪽 메뉴를 열면 다른 쪽은 닫힌다', () => {
    render(<Composer onSend={vi.fn()} channelId="c1" />);
    place('글', 1);
    fireEvent.click(screen.getByTestId('composer-emoji'));
    fireEvent.click(screen.getByTestId('composer-send-options'));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByTestId('composer-emoji').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('열린 메뉴 닫기', () => {
  it('포커스가 편집기에 있어도 Escape 로 닫히고, 그 Escape 는 다른 일을 하지 않는다', () => {
    render(<Composer onSend={vi.fn()} channelId="c1" />);
    const box = place('글', 1);
    fireEvent.click(screen.getByTestId('composer-emoji'));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(draft()).toBe('글');

    fireEvent.click(screen.getByTestId('composer-send-options'));
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('입력창 밖을 누르면 닫히고, 안을 누르면 남는다', () => {
    render(<Composer onSend={vi.fn()} channelId="c1" />);
    const box = place('글', 1);
    fireEvent.click(screen.getByTestId('composer-emoji'));
    fireEvent.mouseDown(box);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
