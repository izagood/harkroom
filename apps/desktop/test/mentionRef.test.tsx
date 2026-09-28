/**
 * **지칭한 이름은 부른 이름처럼 그리지 않는다**(2026-09-09).
 *
 * 서버는 에이전트가 본문 한가운데서 동료를 가리킨 것을 부름으로 치지 않는다
 * (`shared/splitMentionCalls`) — 알림도 턴도 없다. 그런데 화면이 그 이름을 부른 이름과
 * **똑같은 옅은 배경 칩**으로 그리면, 읽는 사람은 그 동료가 불려 왔다고 읽는다. 없는 것을
 * 있다고 표시하지 않는다(design.md §4).
 *
 * 판정은 여기서 하지 않는다. 서버가 `meta.mentionRefs` 로 적어 준 것을 그대로 읽는다 —
 * `mentionChainCapped` 와 같은 규율이고, 본문 글자로 다시 가르면 서버가 실제로 부른 곳과
 * 화면이 부른 것처럼 그리는 곳이 갈라진다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

/** a1(fizz) 이 쓴 한 줄. `refs` 는 서버가 "부르지 않았다"고 적어 준 계정 id 들이다. */
const show = (body: string, refs?: string[]) =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, 'a1', refs ? { meta: { mentionRefs: refs } } : {})} />);

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: {
      u1: acc('u1', 'me'),
      a1: acc('a1', 'fizz', 'agent'),
      a2: acc('a2', 'buzz', 'agent'),
    },
  });
});
afterEach(() => cleanup());

describe('지칭한 멘션', () => {
  it('부른 이름에는 배경이 서고 `data-call` 이 참이다 — 바뀌지 않는 쪽', () => {
    show('@buzz 이어서 해 줘');
    const mention = screen.getByTestId('mention-buzz');
    expect(mention.dataset.call).toBe('true');
    expect(mention.className).toMatch(/bg-surface-sunken/);
  });

  it('지칭한 이름에는 배경이 없고 `data-call` 이 거짓이다', () => {
    show('구현은 @buzz 것이다', ['a2']);
    const mention = screen.getByTestId('mention-buzz');
    expect(mention.dataset.call).toBe('false');
    expect(mention.className).not.toMatch(/bg-/);
    // 이름인 것은 여전히 보인다 — 사라지게 하는 것이 아니라 부르지 않았음을 말하는 것이다.
    expect(mention.textContent).toBe('@buzz');
  });

  it('나를 지칭했을 뿐이면 주의색을 쓰지 않는다 — 내 차례가 아니다', () => {
    useAppStore.getState().set({ me: acc('a2', 'buzz', 'agent') });
    show('구현은 @buzz 것이다', ['a2']);
    const mention = screen.getByTestId('mention-buzz');
    expect(mention.dataset.self).toBe('false');
    expect(mention.className).not.toMatch(/warning/);
  });

  it('나를 부른 것은 그대로 주의색이다 — 지칭 판정이 여기까지 새면 안 된다', () => {
    useAppStore.getState().set({ me: acc('a2', 'buzz', 'agent') });
    show('@buzz 이어서 해 줘');
    const mention = screen.getByTestId('mention-buzz');
    expect(mention.dataset.self).toBe('true');
    expect(mention.className).toMatch(/warning/);
  });

  it('`meta.mentionRefs` 가 없는 옛 메시지는 지금까지와 똑같이 그린다', () => {
    show('구현은 @buzz 것이다');
    expect(screen.getByTestId('mention-buzz').dataset.call).toBe('true');
  });
});
