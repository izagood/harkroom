import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi, msg } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';
import { sentHistory, stepHistory } from '../src/lib/inputHistory';

/*
  입력창 ↑·↓ 입력 기록(셸 history).

  지키는 축:
  1. ↑ 는 이 채널의 **내 글**을 최근 것부터, ↓ 는 되돌아오고 끝에서 쓰던 초안을 되살린다.
  2. 조합 중(한글 입력)의 ↑ 는 입력기의 것이다 — 가로채지 않는다.
  3. 여러 줄 글은 첫 줄(↑)·마지막 줄(↓)에서만 넘긴다. 멘션 목록이 열려 있으면 목록이 먼저다.
*/

const CH = 'c1';
// 본문의 멘션 정본은 `<@uuid>` 다 — 고르는 글은 사람이 친 꼴(`@handle`)로 돌아와야 한다.
const BOT = '00000000-0000-4000-8000-0000000000a1';
const draft = () => useAppStore.getState().drafts[CH] ?? '';
const place = (value: string, caret = value.length) => {
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value, selectionStart: caret } });
  box.setSelectionRange(caret, caret);
  return box;
};
const up = (box: HTMLElement, extra: Record<string, unknown> = {}) => fireEvent.keyDown(box, { key: 'ArrowUp', ...extra });
const down = (box: HTMLElement) => fireEvent.keyDown(box, { key: 'ArrowDown' });
const renderComposer = () => render(<Composer onSend={vi.fn()} scopeKey={CH} channelId={CH} autoMentionChannelId={CH} />);

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'other'), [BOT]: acc(BOT, 'bot', 'agent') },
    messages: {
      [CH]: [
        msg('m1', CH, 1, '첫 글'),
        msg('m2', CH, 2, '남의 글', 'u2'),
        msg('m3', CH, 3, `<@${BOT}> 둘째 글`),
        msg('m4', CH, 4, '여러 줄\n둘째 줄'),
      ],
      // 다른 채널의 내 글은 이 입력창의 기록이 아니다.
      c2: [msg('m5', 'c2', 5, '다른 채널 글')],
    },
  });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0; });
  setController(new Controller(fakeApi()));
});
afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
  vi.restoreAllMocks();
  setController(null as unknown as Controller);
});

describe('sentHistory — 이 채널의 내 글, 최근 것부터', () => {
  it('남의 글·시스템 글·지운 글·빈 글은 빼고, 잇단 같은 글은 한 번만, 멘션은 @handle 로', () => {
    const rows = [
      msg('a', CH, 1, '하나'),
      msg('b', CH, 2, '하나'),
      msg('c', CH, 3, '남', 'u2'),
      msg('d', CH, 4, '시스템', 'u1', { kind: 'system' }),
      msg('e', CH, 5, '지움', 'u1', { deletedAt: new Date().toISOString() }),
      msg('f', CH, 6, '  '),
      msg('g', CH, 7, '<@a1> 부름'),
    ];
    expect(sentHistory(rows, 'u1', (b) => b.replace('<@a1>', '@bot'))).toEqual(['@bot 부름', '하나']);
    expect(sentHistory(rows, undefined, (b) => b)).toEqual([]);
  });

  it('stepHistory — 끝에서 ↑ 는 머물고, 걷지 않을 때의 ↓ 는 평소 열쇠다', () => {
    expect(stepHistory(null, 'newer', CH, '', ['a'])).toEqual({ kind: 'pass' });
    expect(stepHistory(null, 'older', CH, '', [])).toEqual({ kind: 'pass' });
    const s1 = stepHistory(null, 'older', CH, '초안', ['a']);
    expect(s1).toMatchObject({ kind: 'show', text: 'a' });
    const walk = s1.kind === 'show' ? s1.walk : null;
    expect(stepHistory(walk, 'older', CH, 'a', ['a'])).toEqual({ kind: 'stay' });
    // 사람이 고쳤으면 걷기는 끝났다 — 고친 글이 새 초안이다.
    expect(stepHistory(walk, 'newer', CH, 'a!', ['a'])).toEqual({ kind: 'pass' });
    // 다른 자리면 새로 시작한다.
    expect(stepHistory(walk, 'older', 'c2', 'a', ['x'])).toMatchObject({ kind: 'show', text: 'x', walk: { saved: 'a' } });
  });
});

describe('입력창 ↑·↓', () => {
  it('빈 입력창에서 ↑ 를 거듭 누르면 내 글을 최근 것부터 채우고, 가장 오래된 글에서 멈춘다', () => {
    renderComposer();
    const box = place('');
    up(box);
    expect(draft()).toBe('여러 줄\n둘째 줄');
    // 커서는 글 끝(마지막 줄)이다 — 여러 줄 글의 둘째 줄에서 ↑ 는 넘기지 않고 편집기의 줄 이동에 맡긴다.
    up(box);
    expect(draft()).toBe('여러 줄\n둘째 줄');
    box.setSelectionRange(0, 0);
    up(box);
    expect(draft()).toBe('@bot 둘째 글');
    up(box);
    expect(draft()).toBe('첫 글');
    up(box);
    expect(draft()).toBe('첫 글');
  });

  it('↓ 는 더 최근 글로 돌아오고, 맨 끝에서 쓰던 초안을 되살린다', () => {
    renderComposer();
    const box = place('쓰던 초안');
    up(box);
    expect(draft()).toBe('여러 줄\n둘째 줄');
    box.setSelectionRange(0, 0);
    up(box);
    expect(draft()).toBe('@bot 둘째 글');
    down(box);
    expect(draft()).toBe('여러 줄\n둘째 줄');
    down(box);
    expect(draft()).toBe('쓰던 초안');
    // 걷기가 끝났으면 ↓ 는 평소의 커서 이동이다 — 초안을 건드리지 않는다.
    down(box);
    expect(draft()).toBe('쓰던 초안');
  });

  it('IME 조합 중의 ↑ 는 가로채지 않는다(isComposing·Process·방금 끝난 조합)', () => {
    renderComposer();
    const box = place('안녕');
    up(box, { isComposing: true });
    expect(draft()).toBe('안녕');
    up(box, { key: 'Process' });
    expect(draft()).toBe('안녕');
    fireEvent.compositionEnd(box);
    up(box);
    expect(draft()).toBe('안녕');
  });

  it('여러 줄 초안의 둘째 줄에서는 ↑ 를 넘기지 않는다', () => {
    renderComposer();
    const box = place('한 줄\n두 줄');
    up(box);
    expect(draft()).toBe('한 줄\n두 줄');
    box.setSelectionRange(1, 1);
    up(box);
    expect(draft()).toBe('여러 줄\n둘째 줄');
  });

  it('꾸밈 열쇠와 함께인 ↑ 는 넘기지 않는다', () => {
    renderComposer();
    const box = place('');
    up(box, { shiftKey: true });
    up(box, { metaKey: true });
    expect(draft()).toBe('');
  });

  it('멘션 목록이 열려 있으면 ↑ 는 목록이 먼저 쓴다', () => {
    renderComposer();
    const box = place('@b');
    expect(screen.getByRole('listbox')).toBeTruthy();
    up(box);
    expect(draft()).toBe('@b');
  });

  it('사람이 고친 뒤의 ↓ 는 걷기를 이어 가지 않는다', () => {
    renderComposer();
    const box = place('초안');
    up(box);
    place('여러 줄\n둘째 줄 고침');
    down(box);
    expect(draft()).toBe('여러 줄\n둘째 줄 고침');
  });
});
