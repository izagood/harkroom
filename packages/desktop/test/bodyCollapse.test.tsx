import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController, type Controller as ControllerType } from '../src/state/controller';
import { setExternalOpener } from '../src/lib/openExternal';
import { MessageItem } from '../src/components/MessageItem';
import { acc, chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

// #217 — 긴 메시지를 접는 자리의 회귀선.
//
// 여기서 지키는 것은 "접힌다" 가 아니라 **접혀도 아무것도 잃지 않는다** 다. 접기는 화면
// 점유를 줄이려는 것이지 내용을 줄이려는 것이 아니므로, 접힌 상태에서도 본문 전체가 DOM
// 에 도달 가능하게 남아 있어야 하고(찾기·복사·스크린리더) 펼칠 수단이 항상 함께 있어야
// 한다. 그리고 접기가 #216 의 코드 렌더링을 훼손하지 않아야 한다.
//
// **높이를 픽셀로 재지 않는다.** jsdom 에는 레이아웃 엔진이 없어 scrollHeight 는 언제나
// 0 이다 — 픽셀을 재는 테스트는 접히지 않는 구현도 통과시킨다(#187 이 그 함정을 밟았다).
// 그래서 적용된 상태(data-collapsed, aria-expanded, max-height 적용 여부)로 확인한다.

/** 짧은 메시지. 다섯 줄이면 어떤 문턱에도 닿지 않는다. */
const SHORT = 'ok\n확인했어\n세 줄\n네 줄\n다섯 줄';

/** 긴 평문. 앞뒤에 표식을 둬서 "전체가 남았는가" 를 양쪽 끝으로 확인한다. */
const LONG = ['FIRSTLINE', ...Array.from({ length: 28 }, (_, i) => `line ${i + 1}`), 'LASTLINE'].join('\n');

const show = (body: string, authorId = 'u2') =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, authorId)} />);

/**
 * 이 요소가 정말 사람과 도구에 도달 가능한가. `textContent` 만 보는 것으로는 부족하다 —
 * `display:none` 인 노드의 글자도 textContent 에는 그대로 남으므로, 접기를 display:none
 * 으로 되돌린 구현을 그대로 통과시킨다. 그래서 조상 사슬을 올라가며 숨김 수단을 직접 찾는다.
 */
function hiddenAncestor(el: HTMLElement | null): HTMLElement | null {
  for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
    if (cur.hasAttribute('hidden')) return cur;
    const style = getComputedStyle(cur);
    if (style.display === 'none' || style.visibility === 'hidden') return cur;
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

describe('긴 메시지를 접는다', () => {
  it('짧은 메시지는 접히지 않고 펼치기 수단도 없다', () => {
    show(SHORT);

    // 접을 상자 자체가 만들어지지 않는다 — 짧은 글에 "더 보기" 가 붙으면 소음이다.
    expect(screen.queryByTestId('collapsible-body')).toBeNull();
    expect(screen.queryByTestId('expand-body')).toBeNull();
    expect(screen.getByTestId('message-body').textContent).toContain('확인했어');
  });

  it('긴 메시지는 접히고 펼치기 수단이 보인다', () => {
    show(LONG);

    const wrap = screen.getByTestId('collapsible-body');
    expect(wrap.dataset.collapsed).toBe('true');
    // 자르는 수단은 max-height 다. 값이 실제로 걸려 있어야 자른 것이다.
    expect(screen.getByTestId('body-clip').style.maxHeight).toBe('320px');
    const button = screen.getByTestId('expand-body');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toBe('Show more');
  });

  it('자기가 쓴 긴 메시지도 똑같이 접힌다', () => {
    // 예외를 두면 "왜 어떤 건 접히고 어떤 건 안 접히지" 를 사람이 매번 판단해야 한다.
    show(LONG, 'u1');

    expect(screen.getByTestId('collapsible-body').dataset.collapsed).toBe('true');
    expect(screen.getByTestId('expand-body')).not.toBeNull();
  });

  it('누르면 펼쳐지고 다시 접는 수단으로 바뀐다', () => {
    show(LONG);

    fireEvent.click(screen.getByTestId('expand-body'));

    expect(screen.getByTestId('collapsible-body').dataset.collapsed).toBe('false');
    // 펼친 뒤에는 자르지 않는다 — max-height 가 남아 있으면 펼쳐도 잘린 채다.
    expect(screen.getByTestId('body-clip').style.maxHeight).toBe('');
    const button = screen.getByTestId('expand-body');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toBe('Show less');

    // 되돌아갈 길도 그 자리에 있다.
    fireEvent.click(button);
    expect(screen.getByTestId('collapsible-body').dataset.collapsed).toBe('true');
    expect(screen.getByTestId('expand-body').textContent).toBe('Show more');
  });

  it('접힌 상태에서도 본문 전체가 도달 가능하게 DOM 에 남는다', () => {
    show(LONG);

    expect(screen.getByTestId('collapsible-body').dataset.collapsed).toBe('true');
    const body = screen.getByTestId('message-body');
    // 잘린 것은 보이는 높이뿐이다 — 첫 줄도 마지막 줄도 그대로 있어야 한다.
    expect(body.textContent).toContain('FIRSTLINE');
    expect(body.textContent).toContain('LASTLINE');
    expect(body.textContent).toContain('line 28');
    // 그리고 숨겨져 있지 않아야 한다. display:none 이면 찾기·복사·스크린리더가 못 닿는다.
    expect(hiddenAncestor(body)).toBeNull();
  });

  it('코드 블록은 접힘 안에서도 코드로 그려진다', () => {
    const code = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join('\n');
    show(`설명\n\`\`\`ts\n${code}\n\`\`\`\n끝`);

    expect(screen.getByTestId('collapsible-body').dataset.collapsed).toBe('true');
    // #216 이 만든 구조가 그대로다 — 접기는 담는 상자만 바꿨다.
    const block = screen.getByTestId('code-block');
    expect(block.tagName).toBe('PRE');
    expect(block.dataset.lang).toBe('ts');
    expect(block.textContent).toContain('const v0 = 0;');
    // 마지막 줄까지 있어야 한다. 접기가 코드를 잘라내면 복사한 코드가 실행되지 않는다.
    expect(block.textContent).toContain('const v29 = 29;');
    expect(hiddenAncestor(block)).toBeNull();
  });

  it('접기 기준은 줄 수가 아니라 높이다 — 감기는 긴 줄도 접힌다', () => {
    // 다섯 줄뿐이지만 한 줄이 400자라 화면에서는 수십 줄로 감긴다. 줄 수로 재는 구현은
    // 이것을 짧은 메시지로 본다.
    show(Array.from({ length: 5 }, () => 'x'.repeat(400)).join('\n'));

    expect(screen.getByTestId('collapsible-body').dataset.collapsed).toBe('true');
    expect(screen.getByTestId('expand-body')).not.toBeNull();
  });

  it('채널을 나갔다 돌아오면 다시 접혀 있다', async () => {
    const long = msg('m1', 'c1', 1, LONG, 'u2');
    const api = fakeApi({
      channels: vi.fn(async () => [chan('c1', 'one'), chan('c2', 'two')]),
      messages: vi.fn(async () => ({ messages: [long], hasMore: false })),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    setController(c);

    render(<MessageItem message={long} />);
    fireEvent.click(screen.getByTestId('expand-body'));
    expect(screen.getByTestId('collapsible-body').dataset.collapsed).toBe('false');

    // 다른 채널로 갔다 돌아온다. 펼침은 **세션 한정 화면 상태**이므로 살아남지 않는다 —
    // 남으면 돌아온 채널이 애초에 접기가 막으려던 모습(하나가 화면을 다 먹는 것)이 된다.
    await act(async () => { await c.openChannel('c2'); });
    await act(async () => { await c.openChannel('c1'); });

    expect(useAppStore.getState().expandedMessageIds).toEqual({});
    expect(screen.getByTestId('collapsible-body').dataset.collapsed).toBe('true');
    expect(screen.getByTestId('expand-body').textContent).toBe('Show more');
  });
});
