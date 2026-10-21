import { describe, expect, it } from 'vitest';
import { COMPOSER_MAX_H, fitComposerHeight } from '../src/lib/composerGrow';

/**
 * 입력창 자동 높이(2026-10-21). jsdom 은 배치를 안 하므로 textarea 의 치수를 손으로 세운다 —
 * 글 높이(`scrollHeight`)·테두리(`offsetHeight - clientHeight`)를 주고 적힌 키를 본다.
 */
function box(opts: { content: number; value?: string; caret?: number; scrollTop?: number }): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.value = opts.value ?? 'a';
  const caret = opts.caret ?? el.value.length;
  el.setSelectionRange(caret, caret);
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => opts.content });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 100 });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => 102 });
  let top = opts.scrollTop ?? 0;
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  return el;
}

describe('fitComposerHeight', () => {
  it('글 높이 + 테두리로 키를 적는다 — 줄면 다시 줄어든다', () => {
    const el = box({ content: 300 });
    fitComposerHeight(el);
    expect(el.style.height).toBe('302px');
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 60 });
    fitComposerHeight(el);
    expect(el.style.height).toBe('62px');
  });

  it('커서가 글 끝이면 끝까지 내린다 — 새 줄이 칸 아래로 숨지 않게', () => {
    const el = box({ content: 900, scrollTop: 10 });
    fitComposerHeight(el);
    expect(el.scrollTop).toBe(900);
  });

  it('커서가 글 중간이면 굴린 자리를 그대로 둔다 — 한 글자마다 맨 위로 튀지 않게', () => {
    const el = box({ content: 900, value: 'abc\ndef', caret: 2, scrollTop: 240 });
    fitComposerHeight(el);
    expect(el.scrollTop).toBe(240);
  });

  it('배치 전(키 0)이면 키를 적지 않는다 — 0px 로 굳지 않게', () => {
    const el = box({ content: 0 });
    fitComposerHeight(el);
    expect(el.style.height).toBe('');
  });

  it('상한은 창 높이의 40% 와 30rem 중 작은 쪽', () => {
    expect(COMPOSER_MAX_H).toBe('max-h-[min(40vh,30rem)]');
  });
});
