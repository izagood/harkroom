// #271 회귀선 (데스크탑) — 저장된 `<@id>` 를 **현재** handle 로 그린다.
//
// 요구 8 이 이 파일의 전부다: handle 을 바꾸면 **본문 행을 건드리지 않고** 옛 메시지가
// 새 이름으로 보여야 한다. 그래서 여기서는 `message.body` 를 한 글자도 바꾸지 않고
// 디렉터리(스토어의 `accounts`)만 갈아 끼운 뒤, 화면이 무엇을 그리는지 본다.
//
// **컴포넌트를 실제로 렌더한다.** `renderMentions` 만 단언하면 `MessageBody` 가 그 함수를
// 부르지 않아도 초록이다 — 그러면 정본은 바뀌었는데 화면에는 `<@0f3c…>` 가 뜬다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { MessageItem } from '../src/components/MessageItem';
import { bodyAsHandles } from '../src/lib/mention';
import { acc, msg } from './helpers/fakeApi';

const FIZZ = '11111111-1111-4111-8111-111111111111';
const GHOST = '22222222-2222-4222-8222-222222222222';

/** 저장된 정본. 이 문자열은 이 파일 어디서도 바뀌지 않는다 — 그것이 요점이다. */
const STORED = `<@${FIZZ}> 이거 봐줘`;

const show = (body: string) => render(<MessageItem message={msg('m1', 'c1', 1, body, 'u2')} />);

/** 화면이 멘션으로 칠한 handle 들. */
function highlighted(): string[] {
  const body = screen.getByTestId('message-body');
  return [...body.querySelectorAll('[data-testid^="mention-"]')]
    .map((el) => el.getAttribute('data-testid')!.slice('mention-'.length));
}

function seed(fizzHandle: string): void {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: {
      u1: acc('u1', 'me'),
      u2: acc('u2', 'someone'),
      [FIZZ]: acc(FIZZ, fizzHandle, 'agent'),
    },
  });
}

beforeEach(() => seed('fizz'));
afterEach(() => cleanup());

describe('#271-8 저장된 <@id> 는 현재 handle 로 그려진다', () => {
  it('토큰이 아니라 이름이 보인다', () => {
    show(STORED);
    expect(screen.getByTestId('message-body').textContent).toBe('@fizz 이거 봐줘');
    // 그리고 그것이 **멘션으로** 칠해진다 — 평문으로 그려지면 이름은 맞아도 클릭·강조가 없다.
    expect(highlighted()).toEqual(['fizz']);
    // 토큰이 화면에 새지 않는다.
    expect(screen.getByTestId('message-body').textContent).not.toContain('<@');
  });

  it('handle 을 바꾸면 **같은 본문**이 새 이름으로 그려진다', () => {
    show(STORED);
    expect(screen.getByTestId('message-body').textContent).toBe('@fizz 이거 봐줘');
    cleanup();

    // 디렉터리만 바뀐다. `STORED` 는 그대로다 — 서버도 본문을 다시 쓰지 않는다.
    seed('fizzy');
    show(STORED);
    expect(screen.getByTestId('message-body').textContent).toBe('@fizzy 이거 봐줘');
    expect(highlighted()).toEqual(['fizzy']);
  });

  it('WS 로 handle 변경이 오면 그것만으로 옛 메시지가 새 이름이 된다', () => {
    // `applyHandle` 은 디렉터리 한 줄만 고친다. 본문을 다시 받아 오지 않고도 화면이
    // 바뀌는 것이 2부 설계의 값이다 — 안 그러면 이름 변경마다 전수 갱신이 필요하다.
    const { rerender } = show(STORED);
    expect(screen.getByTestId('message-body').textContent).toBe('@fizz 이거 봐줘');

    useAppStore.getState().applyHandle(FIZZ, 'renamed');
    rerender(<MessageItem message={msg('m1', 'c1', 1, STORED, 'u2')} />);

    expect(screen.getByTestId('message-body').textContent).toBe('@renamed 이거 봐줘');
  });

  it('모르는 id 는 @알 수 없음 으로 그린다 — 토큰을 사람에게 보이지 않는다', () => {
    show(`<@${GHOST}> 누구지`);
    expect(screen.getByTestId('message-body').textContent).toBe('@알 수 없음 누구지');
  });

  it('코드 구간의 토큰은 코드로 남는다', () => {
    // 화면의 코드 판정(#298)은 정본 형식과 무관하게 그대로여야 한다.
    show(`\`<@${FIZZ}>\` 는 코드다`);
    const text = screen.getByTestId('message-body').textContent!;
    expect(text).toContain(`<@${FIZZ}>`);
    expect(highlighted()).toEqual([]);
  });
});

describe('#271 수정·복사는 다시 입력할 수 있는 형태로 되돌린다', () => {
  it('아는 id 는 @handle 로, 모르는 id 는 토큰 그대로다', () => {
    const accounts = useAppStore.getState().accounts;
    expect(bodyAsHandles(STORED, accounts)).toBe('@fizz 이거 봐줘');
    // 모르는 id 를 `@알 수 없음` 으로 바꾸면 저장할 때 그 문구가 본문에 박히고,
    // 원래 가리키던 계정을 되찾을 길이 사라진다.
    expect(bodyAsHandles(`<@${GHOST}> 누구지`, accounts)).toBe(`<@${GHOST}> 누구지`);
  });
});
