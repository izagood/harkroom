// 한글(IME 조합) 입력의 회귀선. **이 앱에서 한글 입력은 처음부터 안 됐다**(2026-09-11 사람
// 확인) — xterm 의 IME 경로가 macOS/WKWebView 에서 깨져 있기 때문이다(xtermjs/xterm.js#1939
// "IME composition broken on OSX" · #124 "조합 대신 영문 자모가 들어간다" · #5887·#5894).
// 그래서 `terminalSink` 가 조합을 **xterm 에 닿기 전에** 가로채 확정 문자열만 보낸다.
//
// 왜 테스트가 가능한가: IME 자체는 헤드리스로 못 띄우지만, 조합은 **DOM 이벤트**
// (`compositionstart/update/end` + 조합 중 `keydown`)로 표현된다. 그 이벤트를 손으로 쏘면
// "확정 문자열이 정확히 한 번 간다"·"조합 중 키는 xterm 에 닿지 않는다"가 그대로 잡힌다.
// IME 없이 지킬 수 있는 성질이 여기까지이고, 실제 조합 동작은 사람이 앱에서 본다.
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** xterm 이 **본** 것. 조합 중 키가 여기 닿으면 그것이 곧 "영문 자모가 들어가는" 결함이다. */
const xtermSaw: string[] = [];
/** 가짜 xterm 의 helper textarea — 진짜처럼 호스트 **안쪽**에 있고, 이벤트의 과녁이다. */
let helperTextarea: HTMLTextAreaElement | null = null;
let focused = 0;

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    activate(): void {}
    onContextLoss(): void {}
    dispose(): void {}
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: '' }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: { disableStdin?: boolean };
    constructor(opts: { disableStdin?: boolean }) { this.options = { ...opts }; }
    open(el: HTMLElement): void {
      // 진짜 xterm 처럼 호스트 안에 textarea 를 만들고, 그것에 리스너를 건다.
      const ta = document.createElement('textarea');
      ta.addEventListener('keydown', (e) => { xtermSaw.push(`keydown:${(e as KeyboardEvent).key}`); });
      ta.addEventListener('compositionstart', () => { xtermSaw.push('compositionstart'); });
      ta.addEventListener('compositionend', () => { xtermSaw.push('compositionend'); });
      el.appendChild(ta);
      helperTextarea = ta;
    }
    focus(): void { focused += 1; }
    write(): void {}
    onData(): void { /* 이 파일은 xterm 의 onData 를 쓰지 않는다 — 조합은 그 앞에서 갈린다 */ }
    resize(): void {}
    loadAddon(): void {}
    dispose(): void {}
  },
}));

import { getTerminalSinkFactory } from '../src/lib/terminalSink';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** 호스트. jsdom 은 레이아웃이 없어 크기를 직접 심는다(없으면 fit 이 아무것도 안 한다). */
function host(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 640, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 480, configurable: true });
  document.body.appendChild(el);
  return el;
}

/** 사람이 `한글` 을 치고 확정하는 흐름. 과녁은 xterm 의 textarea 다. */
function compose(target: EventTarget, text: string, opts: { cancel?: boolean } = {}): void {
  target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  // 조합 중에는 macOS IME 가 모든 키에 keyCode 229 를 실어 보낸다.
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, keyCode: 229, key: 'Process' } as KeyboardEventInit));
  target.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: text[0] }));
  target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: opts.cancel ? '' : text }));
}

beforeEach(() => {
  xtermSaw.length = 0;
  helperTextarea = null;
  focused = 0;
  document.body.innerHTML = '';
});

describe('한글 입력 — 조합은 xterm 이 아니라 sink 가 받는다', () => {
  it('확정된 문자열을 **정확히 한 번** 보낸다', async () => {
    const sent: string[] = [];
    const sink = getTerminalSinkFactory()(host(), { onInput: (d) => sent.push(d) });
    await settle();
    sink.setReadOnly!(false);

    compose(helperTextarea!, '한글');
    expect(sent).toEqual(['한글']);
    sink.dispose();
  });

  it('조합 중의 키는 xterm 에 닿지 않는다 — 그것이 "영문 자모가 들어가는" 결함이다', async () => {
    const sink = getTerminalSinkFactory()(host(), { onInput: () => {} });
    await settle();
    sink.setReadOnly!(false);

    compose(helperTextarea!, '한');
    expect(xtermSaw).toEqual([]);
    sink.dispose();
  });

  /**
   * **가드가 너무 넓었던 자리**(2026-09-12 수정). 처음엔 `keyCode === 229` 하나만으로도
   * 키를 막았는데, 그러면 *조합이 시작조차 안 한* 경우까지 삼킨다: 웹뷰가
   * `compositionstart` 를 안 쏘면서 키에 229 만 실어 보내면 **아무것도 안 들어간다**.
   * 엉뚱한 글자가 들어가던 것보다 나쁘다 — 조용해서 원인을 못 짚는다.
   */
  it('조합이 시작되지 않았으면 keyCode 229 만으로는 막지 않는다', async () => {
    const sink = getTerminalSinkFactory()(host(), { onInput: () => {} });
    await settle();

    helperTextarea!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, keyCode: 229, key: 'Process' } as KeyboardEventInit));
    expect(xtermSaw).toEqual(['keydown:Process']);
    sink.dispose();
  });

  it('조합 밖의 평범한 키는 그대로 xterm 이 받는다 — 영문·화살표·Ctrl-C 를 막으면 안 된다', async () => {
    const sink = getTerminalSinkFactory()(host(), { onInput: () => {} });
    await settle();

    helperTextarea!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    helperTextarea!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }));
    expect(xtermSaw).toEqual(['keydown:a', 'keydown:ArrowUp']);
    sink.dispose();
  });

  it('조합을 취소하면(data 가 빈 문자열) 아무것도 보내지 않는다', async () => {
    const sent: string[] = [];
    const sink = getTerminalSinkFactory()(host(), { onInput: (d) => sent.push(d) });
    await settle();
    sink.setReadOnly!(false);

    compose(helperTextarea!, '한', { cancel: true });
    expect(sent).toEqual([]);
    sink.dispose();
  });

  it('읽기 전용 창에서는 조합 결과도 보내지 않는다 — `disableStdin` 은 이 경로를 막지 못한다', async () => {
    const sent: string[] = [];
    const sink = getTerminalSinkFactory()(host(), { onInput: (d) => sent.push(d) });
    await settle();
    // 서버가 "다른 창이 writer 다"라고 알려 온 상태(#346·#369).
    sink.setReadOnly!(true);

    compose(helperTextarea!, '한글');
    expect(sent).toEqual([]);
    sink.dispose();
  });

  it('dispose 하면 리스너가 떨어진다 — 죽은 호스트가 글자를 보내지 않는다', async () => {
    const sent: string[] = [];
    const el = host();
    const sink = getTerminalSinkFactory()(el, { onInput: (d) => sent.push(d) });
    await settle();
    sink.setReadOnly!(false);
    const target = helperTextarea!;

    sink.dispose();
    compose(target, '한글');
    expect(sent).toEqual([]);
  });

  it('패널을 열면 터미널에 포커스를 준다 — 한 번 클릭해야 키가 가던 것을 없앤다', async () => {
    const sink = getTerminalSinkFactory()(host(), { onInput: () => {} });
    await settle();
    expect(focused).toBe(1);
    sink.dispose();
  });

  it('다른 입력칸에서 쓰는 중이면 포커스를 빼앗지 않는다 — 치던 문장이 터미널로 들어가면 안 된다', async () => {
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();

    const sink = getTerminalSinkFactory()(host(), { onInput: () => {} });
    await settle();
    expect(focused).toBe(0);
    sink.dispose();
  });
});

/**
 * 진단 줄이 **사실을 밖으로 내보내는지**. 이 둘은 실패를 삼키는 자리라 화면에 안 나오면
 * 사람은 "빠른 것 같지 않다"·"한글이 안 된다"를 느낌으로만 말할 수밖에 없다.
 */
describe('진단 — 렌더러와 조합 이벤트를 밖으로 알린다', () => {
  it('렌더러가 실제로 무엇인지 알린다', async () => {
    const seen: string[] = [];
    const sink = getTerminalSinkFactory()(host(), {
      onInput: () => {},
      onDiagnostics: (d) => seen.push(d.renderer),
    });
    await vi.waitFor(() => expect(seen).toContain('webgl'));
    sink.dispose();
  });

  it('조합이 시작될 때마다 센다 — 한글을 쳤는데 0 이면 웹뷰가 조합을 안 쏜다는 사실이다', async () => {
    let last = 0;
    const sink = getTerminalSinkFactory()(host(), {
      onInput: () => {},
      onDiagnostics: (d) => { last = d.compositions; },
    });
    await settle();
    sink.setReadOnly!(false);

    compose(helperTextarea!, '한');
    compose(helperTextarea!, '글');
    expect(last).toBe(2);
    sink.dispose();
  });
});
