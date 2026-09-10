import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
// 입력창에서 만든 것이 **보낸 뒤 실제로 눌리는 링크**인지 대조하려면 본문도 렌더해야
// 한다(`composerCode.test.tsx` 가 코드에서 쓰는 방식과 같다).
import { MessageBody } from '../src/components/MessageBody';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';
import { linkMarks, toggleLink } from '../src/lib/linkMarks';

/*
  텍스트에 하이퍼링크 넣기(사용자 요청, 2026-09-10).

  그리는 쪽은 #216 부터 있었다 — 이 파일이 지키는 것은 **쓰는 쪽**이고 축은 넷이다.

  1. **만든 것이 실제로 링크가 된다** — ⌘K 가 넣은 글을 그대로 보내면 `MessageBody` 가
     누를 수 있는 링크로 그린다. 이 대조가 없으면 컴포저는 링크가 아닌 문법을 만들어도
     초록이다.
  2. **커서는 빈 자리로 간다** — 고른 것이 이름이면 주소 자리, 주소면 이름 자리.
     그러지 않으면 감싼 다음에 사람이 커서를 옮겨야 하고, 그건 손으로 치는 것과 같다.
  3. **되돌릴 수 있다** — 감싼 것을 다시 누르면 이름만 남는다.
  4. **규칙이 한 벌이다** — 코드 안의 링크 문법은 링크가 아니고(보낸 뒤에도 아니다),
     열 수 없는 스킴은 주소가 아니라 이름이다.
*/

/** 입력칸에 글과 선택을 앉히고 ⌘K 를 누른다. jsdom 은 선택을 직접 넣어야 한다. */
const pressLink = (value: string, start: number, end: number) => {
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value, selectionStart: end } });
  box.setSelectionRange(start, end);
  fireEvent.keyDown(box, { key: 'k', metaKey: true });
  return box;
};

/**
 * 고른 글 **위에** 붙여넣는다. jsdom 은 paste 의 기본 동작(글자 삽입)을 하지 않으므로
 * 선택을 갈아 끼우는 것까지 흉내낸다 — 실제 브라우저가 하는 일이고, 이 기능은 그
 * 갈아 끼움이 이름을 지운다는 사실 위에 서 있다.
 */
const pasteOver = (box: HTMLTextAreaElement, text: string): void => {
  const { value, selectionStart: from, selectionEnd: to } = box;
  const notPrevented = fireEvent.paste(box, { clipboardData: { getData: () => text } });
  if (!notPrevented) return;
  const next = value.slice(0, from) + text + value.slice(to);
  fireEvent.change(box, { target: { value: next, selectionStart: from + text.length } });
};

const draft = (): string => useAppStore.getState().drafts[''] ?? '';

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') } });
  setController(new Controller(fakeApi()));
});
afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
  setController(null as unknown as Controller);
});

describe('⌘K — 고른 글을 링크로 감싼다', () => {
  it('고른 이름을 감싸고 커서를 주소 자리에 둔다', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = pressLink('설계 문서 를 봐', 0, 5);

    expect(box.value).toBe('[설계 문서]() 를 봐');
    // 커서는 **소괄호 안**이다 — 여기서 주소를 붙여넣으면 링크가 완성된다. 컴포저의 커서
    // 복원은 렌더 뒤(`requestAnimationFrame`)라 자리는 판정 함수에서 잰다.
    const out = toggleLink('설계 문서 를 봐', 0, 5)!;
    expect(out.text.slice(0, out.start)).toBe('[설계 문서](');
    expect(out.text.slice(out.start)).toBe(') 를 봐');
  });

  it('만든 것을 보내면 누를 수 있는 링크로 그려진다', () => {
    // 축 1. 컴포저가 만든 문법과 렌더러가 읽는 문법이 같은지 — 두 화면을 실제로 붙여 본다.
    const wrapped = toggleLink('설계 문서', 0, 5);
    const filled = `${wrapped!.text.slice(0, wrapped!.start)}https://example.com/design${wrapped!.text.slice(wrapped!.start)}`;
    expect(filled).toBe('[설계 문서](https://example.com/design)');

    render(<MessageBody body={filled} messageId="m1" />);
    const link = screen.getByTestId('body-link');
    expect(link.textContent).toBe('설계 문서');
    expect(link.getAttribute('href')).toBe('https://example.com/design');
  });

  it('고른 것이 주소면 이름 자리를 비우고 커서를 거기 둔다', () => {
    const out = toggleLink('https://example.com', 0, 19);
    expect(out!.text).toBe('[](https://example.com)');
    expect(out!.start).toBe(1);
    expect(out!.end).toBe(1);
  });

  it('열 수 없는 스킴은 주소가 아니라 이름으로 본다', () => {
    // `classifyLink` 가 열지 않는 것을 주소 자리에 넣으면, 사람은 누를 수 있는 링크를
    // 만들었다고 믿는다. 그래서 이름으로 간다 — 판정은 그리는 쪽과 같은 함수다.
    const out = toggleLink('javascript:alert(1)', 0, 19);
    expect(out!.text).toBe('[javascript:alert(1)]()');
  });

  it('감싼 뒤 다시 누르면 이름만 남는다', () => {
    const back = toggleLink('[설계 문서](https://example.com/design)', 2, 4);
    expect(back!.text).toBe('설계 문서');
    // 주소를 남기지 않는다 — 남기면 맨 URL 이 그대로 또 링크가 되어(#214) 아무것도
    // 벗겨지지 않은 것처럼 보인다.
    expect(back!.text).not.toContain('example.com');
  });

  it('고른 것이 없으면 빈 링크를 열고 커서를 주소 자리에 둔다', () => {
    const out = toggleLink('앞', 1, 1);
    expect(out!.text).toBe('앞[]()');
    expect(out!.start).toBe(4);
    expect(out!.end).toBe(4);
  });

  it('닫는 괄호 바로 뒤에서 누르면 벗기지 않고 새로 연다', () => {
    // 방금 쓴 링크를 벗기려는 것이 아니라 이어서 새 링크를 여는 자리다(⌘E 와 같은 경계).
    const text = '[a](https://x.com)';
    const out = toggleLink(text, text.length, text.length);
    expect(out!.text).toBe('[a](https://x.com)[]()');
  });

  it('여러 줄을 고르면 초안을 손대지 않고 사유를 말한다', () => {
    // 링크 이름은 개행을 넘지 못한다. 조용히 넘기면 사람은 열쇠가 없는 줄로 안다.
    render(<Composer onSend={vi.fn()} />);
    const box = pressLink('첫 줄\n둘째 줄', 0, 8);

    expect(box.value).toBe('첫 줄\n둘째 줄');
    expect(toggleLink('첫 줄\n둘째 줄', 0, 8)).toBeNull();
    expect(useAppStore.getState().notice).toContain('한 줄');
  });
});

describe('링크 문법이 어디인가 — 규칙은 한 벌이다', () => {
  it('코드 안의 링크 문법은 링크가 아니다', () => {
    const body = '`[a](https://x.com)` 는 문법이다';
    expect(linkMarks(body)).toEqual([]);

    // 보낸 뒤에도 링크가 아니다. 두 화면이 같은 판정을 쓴다는 뜻이다.
    render(<MessageBody body={body} messageId="m1" />);
    expect(screen.queryByTestId('body-link')).toBeNull();
  });

  it('구간은 대괄호부터 닫는 괄호까지다', () => {
    const body = '앞 [이름](https://x.com) 뒤';
    const [mark] = linkMarks(body);
    expect(body.slice(mark!.start, mark!.end)).toBe('[이름](https://x.com)');
    expect(mark!.label).toBe('이름');
    expect(mark!.href).toBe('https://x.com');
  });

  it('주소가 아직 없는 것은 링크 문법이 아니다 — 그려지지도 않는다', () => {
    // 만드는 중의 초안이다. 열 수 없는 것을 링크처럼 보여 주지 않는 것이 규칙이다.
    expect(linkMarks('[이름]()')).toEqual([]);
    render(<MessageBody body="[이름]()" messageId="m1" />);
    expect(screen.queryByTestId('body-link')).toBeNull();
  });
});

describe('고른 글 위에 주소를 붙여넣으면 링크로 만들 것을 제안한다', () => {
  const offerRow = () => screen.queryByTestId('pasted-href');
  /** 제안 줄의 **만들기** 버튼. 글자가 아니라 자리로 집는다(사전이 두 언어다). */
  const makeButton = () =>
    screen.getByTestId('pasted-href').querySelectorAll('button')[0] as HTMLElement;

  const pasteOverSelection = (value: string, start: number, end: number, url: string) => {
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value, selectionStart: end } });
    box.setSelectionRange(start, end);
    pasteOver(box, url);
    return box;
  };

  it('제안을 누르면 덮어쓴 글이 링크의 이름이 된다', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = pasteOverSelection('설계 문서 를 봐', 0, 5, 'https://example.com/design');

    // 붙여넣기 자체는 붙여넣기로 끝난다 — 초안은 주소로 갈아 끼워졌을 뿐이다.
    expect(box.value).toBe('https://example.com/design 를 봐');
    expect(offerRow()).toBeTruthy();

    fireEvent.click(makeButton());
    expect(draft()).toBe('[설계 문서](https://example.com/design) 를 봐');
  });

  it('고른 것이 없으면 제안하지 않는다 — 평범한 붙여넣기다', () => {
    render(<Composer onSend={vi.fn()} />);
    pasteOverSelection('앞', 1, 1, 'https://example.com/x');
    expect(offerRow()).toBeNull();
  });

  it('붙여넣은 것이 주소가 아니면 제안하지 않는다', () => {
    render(<Composer onSend={vi.fn()} />);
    pasteOverSelection('설계 문서 를 봐', 0, 5, '그냥 글자');
    expect(offerRow()).toBeNull();
  });

  it('주소를 지우면 제안이 사라진다 — 없는 글을 가리키는 버튼을 남기지 않는다', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = pasteOverSelection('설계 문서', 0, 5, 'https://example.com/design');
    expect(offerRow()).toBeTruthy();

    fireEvent.change(box, { target: { value: '다시 쓴다', selectionStart: 5 } });
    expect(offerRow()).toBeNull();
  });

  it('제안을 닫으면 초안은 그대로 남는다', () => {
    render(<Composer onSend={vi.fn()} />);
    pasteOverSelection('설계 문서', 0, 5, 'https://example.com/design');
    const dismiss = screen.getByTestId('pasted-href-dismiss');

    fireEvent.click(dismiss);
    expect(offerRow()).toBeNull();
    expect(draft()).toBe('https://example.com/design');
  });
});
