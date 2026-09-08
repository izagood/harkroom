import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller as ControllerType } from '../src/state/controller';
import { setExternalOpener } from '../src/lib/openExternal';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

// #217 을 되돌린 자리의 회귀선.
//
// 접기는 화면 점유를 줄이려고 넣었지만, 실사용에서는 거의 모든 메시지가 문턱을 넘어
// **늘** "Show more" 가 달렸다. 읽으려면 매번 눌러야 했으니 스크롤 한 번으로 끝날 일에
// 클릭이 하나 늘어난 것이고, 그래서 걷어냈다.
//
// 여기서 지키는 것은 "길어도 통째로 보인다" 다. 높이를 픽셀로 재지 않는다 — jsdom 에는
// 레이아웃 엔진이 없어 scrollHeight 가 언제나 0 이고, 픽셀을 재는 테스트는 잘라내는
// 구현도 통과시킨다(#187 이 그 함정을 밟았다). 대신 **잘라내는 수단이 DOM 에 없다**는
// 것을 본다: 접기 상자도, 펼치기 버튼도, max-height 도 없다.

/** 아주 긴 평문. 앞뒤 표식으로 양쪽 끝이 다 남았는지 확인한다. */
const LONG = ['FIRSTLINE', ...Array.from({ length: 200 }, (_, i) => `line ${i + 1}`), 'LASTLINE'].join('\n');

/** 코드 블록이 든 긴 메시지. 예전 판정은 코드 줄을 따로 셌으므로 함께 확인한다. */
const LONG_CODE = '```ts\n' + Array.from({ length: 60 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n```';

const show = (body: string, authorId = 'u2') =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, authorId)} />);

/** 조상 사슬에 높이를 자르는 스타일이 걸려 있는가. */
function clippedAncestor(el: HTMLElement | null): HTMLElement | null {
  for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
    if (cur.style.maxHeight) return cur;
  }
  return null;
}

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
  });
  setExternalOpener({ open: vi.fn(async () => undefined) });
  setController({ openMessage: vi.fn(async () => undefined) } as unknown as ControllerType);
});
afterEach(() => {
  cleanup();
  setExternalOpener(null);
  setController(null);
});

describe('긴 메시지도 접지 않는다', () => {
  it('아무리 길어도 펼치기 버튼이 생기지 않는다', () => {
    show(LONG);

    expect(screen.queryByTestId('collapsible-body')).toBeNull();
    expect(screen.queryByTestId('expand-body')).toBeNull();
    expect(screen.queryByTestId('body-clip')).toBeNull();
    // 글자로도 남지 않는다 — testid 를 바꿔 되살리는 것까지 막는다.
    expect(screen.queryByText(/show more/i)).toBeNull();
    expect(screen.queryByText(/show less/i)).toBeNull();
  });

  it('본문이 처음부터 끝까지 잘리지 않은 채로 보인다', () => {
    show(LONG);

    const bodyEl = screen.getByTestId('message-body');
    expect(bodyEl.textContent).toContain('FIRSTLINE');
    expect(bodyEl.textContent).toContain('LASTLINE');
    expect(clippedAncestor(bodyEl)).toBeNull();
  });

  it('내가 쓴 긴 메시지도 같다', () => {
    show(LONG, 'u1');

    expect(screen.queryByTestId('expand-body')).toBeNull();
    expect(screen.getByTestId('message-body').textContent).toContain('LASTLINE');
  });

  it('긴 코드 블록도 접히지 않고 코드로 남는다', () => {
    show(LONG_CODE);

    expect(screen.queryByTestId('expand-body')).toBeNull();
    expect(screen.queryByTestId('body-clip')).toBeNull();
    const bodyEl = screen.getByTestId('message-body');
    expect(bodyEl.querySelector('pre')).not.toBeNull();
    expect(bodyEl.textContent).toContain('const x59 = 59;');
  });
});
