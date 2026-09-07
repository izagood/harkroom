import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller as ControllerType } from '../src/state/controller';
import { setExternalOpener } from '../src/lib/openExternal';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

// #539 — 본문은 길이와 무관하게 **전부 보인다**. 이 파일이 잡는 회귀는 접힘의 부활이다.
//
// #217 이 320px 로 자르고 "Show more" 를 달았고, 그 파일(bodyCollapse.test.tsx)이 이 자리에
// 있었다. 실사용에서 접힘이 줄여 준 것은 스크롤이지 읽어야 할 양이 아니었다 — 어차피 다
// 읽으므로 메시지마다 "누르고 다시 읽기 시작" 한 단계가 늘 뿐이었다. 그래서 회귀선의 방향을
// 뒤집는다: 이제 확인하는 것은 "접힌다" 가 아니라 **자르는 수단이 아예 생기지 않는다** 다.
//
// 높이를 픽셀로 재지 않는다. jsdom 에는 레이아웃 엔진이 없어 scrollHeight 는 언제나 0 이고,
// 픽셀을 재는 단언은 접는 구현도 통과시킨다(#187 이 그 함정을 밟았다). 대신 **자르는 수단이
// DOM 에 걸려 있는가**(max-height · overflow 클래스 · 펼치기 버튼)를 직접 본다.

/** 짧은 메시지. 어떤 문턱에도 닿지 않는다. */
const SHORT = 'ok\n확인했어\n세 줄';

/** 옛 문턱(480px 추정)을 한참 넘는 평문. 앞뒤 표식으로 "전체가 남았는가" 를 양끝에서 본다. */
const LONG = ['FIRSTLINE', ...Array.from({ length: 60 }, (_, i) => `line ${i + 1}`), 'LASTLINE'].join('\n');

const show = (body: string, authorId = 'u2') =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, authorId)} />);

/**
 * 조상 사슬 어딘가에서 이 요소가 잘리고 있는가.
 *
 * 인라인 `max-height` 만 보지 않는다 — 같은 자르기를 Tailwind 클래스(`max-h-*` +
 * `overflow-hidden`)로 되살리면 인라인 스타일은 비어 있고, jsdom 은 클래스에 붙은 CSS 를
 * 계산해 주지 않으므로 `getComputedStyle` 로도 잡히지 않는다. 그래서 클래스 이름 자체도 본다.
 */
function clippedAncestor(el: HTMLElement | null): HTMLElement | null {
  for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
    if (cur.style.maxHeight) return cur;
    if (getComputedStyle(cur).maxHeight && getComputedStyle(cur).maxHeight !== 'none') return cur;
    if (/(^|\s)(max-h-|line-clamp-)/.test(cur.className)) return cur;
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

describe('본문은 길이와 무관하게 전부 보인다', () => {
  it('짧은 메시지는 그대로 보이고 아무 상자도 덧대지 않는다', () => {
    show(SHORT);

    expect(screen.getByTestId('message-body').textContent).toContain('확인했어');
    expect(screen.queryByTestId('collapsible-body')).toBeNull();
    expect(screen.queryByTestId('expand-body')).toBeNull();
  });

  it('아주 긴 메시지도 잘리지 않고 펼치기 버튼이 없다', () => {
    show(LONG);

    // 누를 것이 없다. 버튼이 다시 생기면 그게 곧 클릭 한 단계의 부활이다.
    expect(screen.queryByTestId('expand-body')).toBeNull();
    expect(screen.queryByTestId('collapsible-body')).toBeNull();
    expect(screen.queryByTestId('body-clip')).toBeNull();

    const body = screen.getByTestId('message-body');
    expect(body.textContent).toContain('FIRSTLINE');
    expect(body.textContent).toContain('line 60');
    expect(body.textContent).toContain('LASTLINE');
    // 그리고 어디서도 잘려 있지 않다 — 버튼만 떼고 자르기를 남기면 본문이 사라진다.
    expect(clippedAncestor(body)).toBeNull();
  });

  it('자기가 쓴 긴 메시지도 똑같이 전부 보인다', () => {
    show(LONG, 'u1');

    expect(screen.queryByTestId('expand-body')).toBeNull();
    expect(clippedAncestor(screen.getByTestId('message-body'))).toBeNull();
  });

  it('줄 수가 적어도 길게 감기는 본문을 자르지 않는다', () => {
    // 다섯 줄뿐이지만 한 줄이 400자다. 옛 구현은 이것을 높이로 재서 접었다.
    show(Array.from({ length: 5 }, () => 'x'.repeat(400)).join('\n'));

    expect(screen.queryByTestId('expand-body')).toBeNull();
    expect(clippedAncestor(screen.getByTestId('message-body'))).toBeNull();
  });

  it('긴 코드 블록도 마지막 줄까지 그대로 그려진다', () => {
    const code = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join('\n');
    show(`설명\n\`\`\`ts\n${code}\n\`\`\`\n끝`);

    const block = screen.getByTestId('code-block');
    expect(block.tagName).toBe('PRE');
    expect(block.dataset.lang).toBe('ts');
    // 잘린 코드를 복사해 가면 실행되지 않는다. 첫 줄과 끝 줄이 모두 있어야 한다(#216).
    expect(block.textContent).toContain('const v0 = 0;');
    expect(block.textContent).toContain('const v39 = 39;');
    expect(screen.queryByTestId('expand-body')).toBeNull();
    expect(clippedAncestor(block)).toBeNull();
  });
});
