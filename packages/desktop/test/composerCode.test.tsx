import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
// 입력창이 칠하는 구간과 **보낸 뒤 그려지는 구간**이 같은지 대조하려면 본문도 실제로
// 렌더해야 한다(`composer.test.tsx` 가 멘션에서 쓰는 방식과 같다).
import { MessageBody } from '../src/components/MessageBody';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';
import { codeMarks, toggleCode } from '../src/lib/codeMarks';
import { COMPOSER_BOX } from '../src/components/ComposerEditor';

/*
  입력 중인 코드(사용자 요청, 2026-09-10 — "채팅창에서도 인터랙티브하게 적용되도록").

  이 파일이 지키는 축은 셋이다.
  1. **판정이 한 벌이다** — 입력창이 칠하는 구간은 `splitCode` 가 정한 그 구간이다.
     닫히지 않은 백틱은 칠하지 않는다(보낸 뒤에도 코드가 아니므로).
  2. **그림만 바뀐다** — 기호를 숨겨도 초안(보낼 글)에는 기호가 그대로 있다(입력창 개편 P1,
     CodeMirror 6 — 원문은 마크다운 그대로다).
  3. **⌘E 는 되돌릴 수 있다** — 감싼 것을 다시 누르면 원문으로 돌아온다.
*/

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  // selectionStart 는 jsdom 이 change 로 갱신하지 않는다 — 커서를 끝에 두는 것을 직접 흉내낸다.
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box as HTMLTextAreaElement;
};

/** 편집기가 코드로 칠한 글자(인라인 코드). 기호가 숨으면 백틱은 빠진다. */
const codeText = () => [...document.querySelectorAll('.cm-content .cm-md-code')].map((el) => el.textContent).join('');

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), a1: acc('a1', 'fizz', 'agent') },
  });
  setController(new Controller(fakeApi()));
});
afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
  setController(null as unknown as Controller);
});

describe('입력 중인 코드에 면이 깔린다', () => {
  it('백틱으로 감싼 것은 입력칸 안에서도 코드로 칠해진다 — 커서 밖이면 백틱은 숨는다', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = typeInto('마지막에 `🤖 Generated with Claude Code` 라는 줄이 있다');

    expect(codeText()).toBe('🤖 Generated with Claude Code');
    // 숨긴 것은 그림뿐이다 — 초안(보낼 글)에는 백틱이 그대로 있다.
    expect(box.value).toContain('`🤖 Generated with Claude Code`');
  });

  it('짝이 없는 백틱은 칠하지 않는다 — 보낸 뒤에도 코드가 아니다', () => {
    const { unmount } = render(<Composer onSend={vi.fn()} />);
    typeInto('`아직 안 닫았다');
    expect(codeText()).toBe('');
    unmount();

    // 같은 글을 메시지로 그려도 코드는 없다. 두 화면이 같은 판정을 쓴다는 뜻이다.
    render(<MessageBody body="`아직 안 닫았다" messageId="m1" />);
    expect(screen.queryByTestId('inline-code')).toBeNull();
  });

  it('펜스로 감싼 여러 줄은 블록으로 칠해진다', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('보기:\n```\nls -la\n```\n끝');

    expect(document.querySelectorAll('.cm-md-codeblock')).toHaveLength(3);
  });

  it('커서가 들어온 구간만 기호가 옅게 보인다 (결정 2)', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = typeInto('앞 **굵게** 뒤');
    // 커서가 끝(구간 밖)에 있다 — 기호는 숨는다.
    expect(screen.getByTestId('composer-editor').textContent).toBe('앞 굵게 뒤');

    box.setSelectionRange(4, 4);
    expect(screen.getByTestId('composer-editor').textContent).toBe('앞 **굵게** 뒤');
    expect([...document.querySelectorAll('.cm-md-mark')].map((el) => el.textContent)).toEqual(['**', '**']);
  });

  it('링크는 커서 밖이면 이름만 남는다 — 주소도 기호처럼 숨고, 초안에는 그대로 있다', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = typeInto('[문서](https://example.com) 끝');
    expect(screen.getByTestId('composer-editor').textContent).toBe('문서 끝');
    expect(useAppStore.getState().drafts['']).toBe('[문서](https://example.com) 끝');

    box.setSelectionRange(2, 2);
    expect(screen.getByTestId('composer-editor').textContent).toBe('[문서](https://example.com) 끝');
  });

  it('입력칸 상자 값은 한 곳(COMPOSER_BOX)에서 오고, 면은 감싸는 칸이 든다', () => {
    render(<Composer onSend={vi.fn()} />);
    const editor = screen.getByTestId('composer-editor');
    for (const cls of COMPOSER_BOX.split(' ')) expect(editor.className).toContain(cls);
    expect(editor.className).toContain('bg-transparent');
    expect(editor.parentElement!.className).toContain('bg-field');
  });

  it('코드 구간의 위치는 백틱까지 포함한다', () => {
    const draft = '앞 `x` 뒤';
    const [mark] = codeMarks(draft);
    expect(draft.slice(mark!.start, mark!.end)).toBe('`x`');
  });
});

describe('⌘E — 고른 글을 코드로 감싸고 벗긴다', () => {
  /** 입력칸에 글과 선택을 앉히고 ⌘E 를 누른다. jsdom 은 선택을 직접 넣어야 한다. */
  const pressToggle = (value: string, start: number, end: number) => {
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value, selectionStart: end } });
    box.setSelectionRange(start, end);
    fireEvent.keyDown(box, { key: 'e', metaKey: true });
    return box;
  };

  it('한 줄 선택은 백틱 하나로 감싼다', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = pressToggle('설정은 pnpm typecheck 로', 4, 18);
    expect(box.value).toBe('설정은 `pnpm typecheck` 로');
    expect(codeText()).toBe('pnpm typecheck');
  });

  it('여러 줄 선택은 펜스로 감싼다 — 인라인 코드는 개행을 넘지 못한다', () => {
    const out = toggleCode('a\nb', 0, 3);
    expect(out.text).toBe('```\na\nb\n```');
    expect(out.text.slice(out.start, out.end)).toBe('a\nb');
  });

  it('감싼 뒤 다시 누르면 원문으로 돌아온다', () => {
    const wrapped = toggleCode('설정은 pnpm 로', 4, 8);
    expect(wrapped.text).toBe('설정은 `pnpm` 로');
    const back = toggleCode(wrapped.text, wrapped.start, wrapped.end);
    expect(back.text).toBe('설정은 pnpm 로');
  });

  it('펜스도 벗긴다 — 펜스 줄 자체가 사라진다', () => {
    const out = toggleCode('```\nls\n```', 4, 6);
    expect(out.text).toBe('ls');
  });

  it('고른 것이 없으면 빈 코드를 열고 그 안에 커서를 둔다', () => {
    const out = toggleCode('앞', 1, 1);
    expect(out.text).toBe('앞``');
    expect(out.start).toBe(2);
    expect(out.end).toBe(2);
  });

  it('닫는 백틱 바로 뒤에서 누르면 벗기지 않고 새로 연다', () => {
    // 방금 쓴 코드를 벗기려는 것이 아니라 이어서 새 코드를 여는 자리다.
    const out = toggleCode('`x`', 3, 3);
    expect(out.text).toBe('`x```');
    expect(out.start).toBe(4);
  });
});
