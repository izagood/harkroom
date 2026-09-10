// #335 — **재는 쪽**의 회귀선. `terminalSink.ts` 의 fit 경로가 여기 산다.
//
// 왜 별도 파일인가: `agentTerminal.test.tsx` 는 sink 를 통째로 가짜로 바꾸므로(`setTerminalSinkFactory`),
// 그 파일이 재는 것은 "패널이 sink 가 알려 온 크기를 소켓으로 보내는가"까지다. 실제로 폭을
// **재는** 코드(`fitDimensions`·`applyFit`·`ResizeObserver`)는 그 가짜 뒤에 가려 한 줄도 안
// 돈다 — 실측으로 확인했다: 그 경로를 통째로 지워도 데스크탑 1094건이 전부 초록이었다.
// 그러면 "소유자의 폭이 PTY 폭이 된다"의 출발점이 조용히 사라져도 아무도 모른다.
//
// 그래서 이 파일은 가짜 sink 를 쓰지 않고 **진짜 `xtermSink`** 를 돌린다. xterm 모듈과
// 기하(jsdom 은 레이아웃이 없어 전부 0 이다)만 흉내내고, 계산과 배선은 진짜를 쓴다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** xterm 자체는 이 파일의 관심이 아니다 — 크기를 받는 쪽으로만 세운다. */
const resizes: [number, number][] = [];
let disposed = false;
/** 마지막으로 만들어진 가짜 xterm(#369). `setReadOnly` 가 닿는 자리를 여기서 읽는다. */
let lastTerm: { options: { disableStdin?: boolean } } | null = null;
/** `loadAddon` 으로 들어온 애드온들 — WebGL 렌더러 회귀선이 이것을 읽는다. */
const loadedAddons: FakeWebglAddon[] = [];
/** WebGL2 가 없는 세상. 진짜 애드온도 그때 **생성자에서** 던진다. */
let webglUnavailable = false;
/** 무엇을 어떤 순서로 버렸는가. dispose 순서 회귀선이 이것을 읽는다. */
const disposeOrder: string[] = [];
/** 애드온 정리가 던지는 세상(0.19.0 이 xterm 5.5 에서 그랬다 — `undefined._isDisposed`). */
let addonDisposeThrows = false;
/** 터미널 정리가 던지는 세상. */
let termDisposeThrows = false;

/** 컨텍스트 상실 핸들러와 dispose 를 드러내는 가짜 애드온. */
class FakeWebglAddon {
  disposed = false;
  private handler: (() => void) | null = null;
  constructor() {
    if (webglUnavailable) throw new Error('WebGL2 를 못 얻었다');
  }
  /** xterm 이 애드온을 얹을 때 부르는 자리 — 진짜 애드온과 같은 표면으로 둔다. */
  activate(): void { /* 이 파일은 렌더링을 안 본다 */ }
  onContextLoss(handler: () => void): void { this.handler = handler; }
  dispose(): void {
    disposeOrder.push('addon');
    this.disposed = true;
    if (addonDisposeThrows) throw new TypeError("Cannot read properties of undefined (reading '_isDisposed')");
  }
  /** 테스트가 GPU 컨텍스트 상실을 흉내내는 손잡이. */
  loseContext(): void { this.handler?.(); }
}

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: FakeWebglAddon }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: '' }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    // #369: `options` 를 진짜 xterm 처럼 **생성자 인자에서 그대로 들고 있는다.** 이것이
    // 없으면 `setReadOnly` 가 건드리는 자리 자체가 이 파일에 존재하지 않아, 그 구현을
    // 통째로 지워도 초록이 된다(실측했다).
    options: { disableStdin?: boolean };
    constructor(opts: { disableStdin?: boolean }) { this.options = { ...opts }; lastTerm = this; }
    open(): void { /* jsdom 에는 캔버스가 없다 */ }
    write(): void { /* 이 파일은 바이트를 안 본다 */ }
    onData(): void { /* 같음 */ }
    resize(cols: number, rows: number): void { resizes.push([cols, rows]); }
    // 진짜 xterm 과 같은 자리 — 애드온은 `open()` 뒤에 얹힌다.
    loadAddon(addon: FakeWebglAddon): void { loadedAddons.push(addon); }
    dispose(): void {
      disposeOrder.push('term');
      disposed = true;
      if (termDisposeThrows) throw new Error('터미널 해체 실패');
    }
  },
}));

import { getTerminalSinkFactory } from '../src/lib/terminalSink';

/**
 * 셀 하나가 8x16 인 세상. `fitDimensions` 는 숨은 span 에 'W' 100 개를 넣고 재므로,
 * span 의 폭이 800 이면 셀 폭은 8 이다.
 */
const CELL_W = 8;
const CELL_H = 16;

/** 이 콜백이 곧 `ResizeObserver` — 테스트가 직접 발화해 컨테이너 변화를 흉내낸다. */
let fireResize: (() => void) | null = null;
let observing = false;

class FakeResizeObserver {
  constructor(private readonly cb: () => void) {}
  observe(): void { observing = true; fireResize = () => this.cb(); }
  disconnect(): void { observing = false; }
  unobserve(): void { /* 쓰지 않는다 */ }
}

/** 호스트 요소. jsdom 은 레이아웃이 없어 `clientWidth` 가 늘 0 이므로 직접 심는다. */
function host(width: number, height: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

function setHostSize(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
}

/** import() 두 번이 풀릴 때까지 기다린다 — 첫 fit 은 그 뒤에 일어난다. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

let rectSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  resizes.length = 0;
  disposed = false;
  loadedAddons.length = 0;
  webglUnavailable = false;
  disposeOrder.length = 0;
  addonDisposeThrows = false;
  termDisposeThrows = false;
  lastTerm = null;
  fireResize = null;
  observing = false;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  // 숨은 span 이 실제로 그려진 것처럼 기하를 준다. 다른 요소는 0 그대로 둔다 —
  // 이 파일이 재는 것은 span 하나의 폭에서 셀 크기를 얻는 그 계산이다.
  rectSpy = vi.spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLSpanElement) {
      const chars = this.textContent?.length ?? 0;
      return { width: CELL_W * chars, height: CELL_H } as DOMRect;
    });
});

afterEach(() => {
  rectSpy?.mockRestore();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('#335 sink 는 컨테이너를 실제로 재서 그 크기를 알린다', () => {
  it('붙자마자 한 번 잰다 — 이것이 러너의 spawn 기본값(120x40)을 소유자의 실제 폭으로 덮어쓰는 자리다', async () => {
    const el = host(640, 480);
    const reported: [number, number][] = [];
    const sink = getTerminalSinkFactory()(el, { onResize: (c, r) => reported.push([c, r]) });
    await settle();

    // 640/8 = 80 칸, 480/16 = 30 줄.
    expect(reported).toEqual([[80, 30]]);
    // **xterm 을 먼저 맞추고 그다음에 알린다**(terminalSink.ts::applyFit 주석) — 화면이
    // 옛 폭인 채로 새 폭의 바이트를 받으면 그 프레임 하나가 접혀 보인다.
    expect(resizes).toEqual([[80, 30]]);
    sink.dispose();
  });

  it('컨테이너가 바뀌면 새 크기를 알리고, 같은 크기로는 다시 안 알린다', async () => {
    const el = host(640, 480);
    const reported: [number, number][] = [];
    const sink = getTerminalSinkFactory()(el, { onResize: (c, r) => reported.push([c, r]) });
    await settle();
    expect(observing).toBe(true);

    // 드래그 한 번은 프레임 수십 개다 — 같은 크기가 반복되는 동안은 아무것도 안 나가야
    // 한다. 안 막으면 창을 한 번 끄는 것이 소켓에 수십 프레임이 된다.
    fireResize!();
    fireResize!();
    expect(reported).toEqual([[80, 30]]);

    setHostSize(el, 800, 480);
    fireResize!();
    expect(reported).toEqual([[80, 30], [100, 30]]);
    sink.dispose();
  });

  it('dispose 하면 관찰이 끊긴다 — 닫힌 패널이 이미 닫힌 소켓에 크기를 보내지 않는다', async () => {
    const el = host(640, 480);
    const reported: [number, number][] = [];
    const sink = getTerminalSinkFactory()(el, { onResize: (c, r) => reported.push([c, r]) });
    await settle();

    sink.dispose();
    expect(observing).toBe(false);
    expect(disposed).toBe(true);
    // 관찰을 안 끊었으면 여기서 한 건 더 나간다.
    setHostSize(el, 800, 480);
    fireResize!();
    expect(reported).toEqual([[80, 30]]);
  });

  it('아직 잴 수 없으면 아무것도 안 알린다 — 0 으로 계산한 1x1 을 PTY 에 보내지 않는다', async () => {
    // 레이아웃 전(또는 패널이 접힌 상태)이다. 여기서 크기를 보내면 러너의 PTY 가 1칸이
    // 되고, 하네스는 그 폭으로 화면을 다시 그린다.
    const el = host(0, 0);
    const reported: [number, number][] = [];
    const sink = getTerminalSinkFactory()(el, { onResize: (c, r) => reported.push([c, r]) });
    await settle();

    expect(reported).toEqual([]);
    expect(resizes).toEqual([]);

    // 나중에 레이아웃이 잡히면 그때 알린다 — 못 잰 것이 영영 못 재는 것은 아니다.
    setHostSize(el, 640, 480);
    fireResize!();
    expect(reported).toEqual([[80, 30]]);
    sink.dispose();
  });

  it('admin 처럼 onResize 를 안 넘기면 크기를 아무 데도 안 보낸다 — xterm 만 맞춘다', async () => {
    const el = host(640, 480);
    // 읽기 전용 패널이 넘기는 것과 같은 모양이다(TerminalPanel.tsx: writable 이 아니면
    // 옵션 자체를 안 넘긴다). 자기 화면은 맞되, 남의 PTY 는 안 건드린다.
    const sink = getTerminalSinkFactory()(el, undefined);
    await settle();

    expect(resizes).toEqual([[80, 30]]);
    sink.dispose();
  });
});

/**
 * #369 — **진짜 `xtermSink` 의** 읽기 전용 토글. 위 파일 머리 주석과 같은 이유로 여기 산다:
 * `agentTerminal.test.tsx` 의 가짜 sink 는 `setReadOnly` 가 **불렸는지**까지만 재고, 그 호출이
 * xterm 에 실제로 닿는지는 한 줄도 안 돈다 — 그 구현을 통째로 지워도 데스크탑 전 건이 초록이었다.
 *
 * 이 토글이 이 결함 수정의 사람 쪽 절반이다: 서버가 바이트를 버리는 것만으로는 커서가 계속
 * 깜빡여 화면이 여전히 "칠 수 있다"고 말한다.
 */
describe('#369 sink 는 뜬 뒤에도 stdin 을 껐다 켤 수 있다', () => {
  it('setReadOnly 가 xterm 의 disableStdin 을 실제로 바꾼다 — 차례는 attach 뒤에 오간다', async () => {
    const el = host(640, 480);
    // 칠 수 있는 창으로 띄운다(onInput 이 있으면 생성자에서 stdin 이 켜진다).
    const sink = getTerminalSinkFactory()(el, { onInput: () => {} });
    await settle();
    expect(lastTerm!.options.disableStdin).toBe(false);

    // 서버가 관찰 전용이라고 알려 왔다(#369) — 또는 다른 창에 차례를 뺏겼다(#346).
    sink.setReadOnly!(true);
    expect(lastTerm!.options.disableStdin).toBe(true);

    // 되돌아오는 방향도 같은 자리를 탄다 — 한쪽만 되면 승격된 창이 영영 못 친다.
    sink.setReadOnly!(false);
    expect(lastTerm!.options.disableStdin).toBe(false);
    sink.dispose();
  });

  it('xterm 이 아직 안 떴으면 아무 일도 안 일어난다 — 그때는 생성자의 disableStdin 이 맞는 값이다', () => {
    const el = host(640, 480);
    // `await settle()` 을 하지 않는다 — 동적 import 가 아직 안 풀린 시점이 이 케이스다.
    const sink = getTerminalSinkFactory()(el, { onInput: () => {} });
    expect(() => sink.setReadOnly!(true)).not.toThrow();
    sink.dispose();
  });
});

/**
 * 렌더러 회귀선. xterm 의 기본값은 **DOM 렌더러**이고 그것이 셋 중 가장 느리다 —
 * 애드온을 얹는 한 줄이 조용히 사라지면 화면은 여전히 뜨므로 아무도 모른다.
 *
 * 그리고 실패 쪽이 더 중요하다: 이 애드온은 WebGL2 가 없으면 **생성자에서 던진다.**
 * 그 예외가 밖으로 나가면 렌더러 하나 때문에 터미널이 아예 안 뜬다.
 */
describe('sink 는 렌더러를 WebGL 로 올린다', () => {
  it('애드온을 얹는다 — 기본 DOM 렌더러로 두지 않는다', async () => {
    const el = host(640, 480);
    const sink = getTerminalSinkFactory()(el, {});
    await vi.waitFor(() => expect(loadedAddons).toHaveLength(1));
    sink.dispose();
  });

  it('컨텍스트를 잃으면 애드온을 버린다 — 그러면 xterm 이 DOM 으로 되돌아가 계속 그린다', async () => {
    const el = host(640, 480);
    const sink = getTerminalSinkFactory()(el, {});
    await vi.waitFor(() => expect(loadedAddons).toHaveLength(1));

    const addon = loadedAddons[0]!;
    expect(addon.disposed).toBe(false);
    // GPU 리셋·드라이버 사정으로 컨텍스트가 날아갔다. 붙잡고 있으면 화면이 그 자리에서 언다.
    addon.loseContext();
    expect(addon.disposed).toBe(true);
    sink.dispose();
  });

  it('WebGL2 가 없어도 터미널은 그대로 산다 — 렌더러는 화면의 속도지 내용이 아니다', async () => {
    webglUnavailable = true;
    const el = host(640, 480);
    const reported: [number, number][] = [];
    const sink = getTerminalSinkFactory()(el, { onResize: (c, r) => reported.push([c, r]) });
    await settle();

    // 애드온은 못 얹혔지만 배선(fit → PTY 폭 통지)은 살아 있다.
    expect(loadedAddons).toHaveLength(0);
    expect(reported).toEqual([[80, 30]]);
    expect(resizes).toEqual([[80, 30]]);
    sink.dispose();
  });
});

/**
 * 패널 [Close] 가 **앱 화면 전체를 끄던** 사고의 회귀선(2026-09-10).
 *
 * 원인은 두 겹이었다. (1) `@xterm/addon-webgl` 0.19.0 의 정리 훅이 xterm 6 계열의
 * `_core._store` 를 읽는데 우리가 쓰는 5.5.0 에는 그 필드가 없어 `undefined._isDisposed` 로
 * 던졌다(버전 핀으로 고쳤다). (2) 그 예외가 `sink.dispose()` → 패널의 effect cleanup 을
 * 타고 나가 React 가 트리 전체를 걷어냈다.
 *
 * (1)은 의존을 갈면 또 올 수 있다. (2)는 다시는 오지 않아야 한다 — **터미널 하나를 못 닫은
 * 것이 앱을 닫는 일이 되어서는 안 된다.** 그래서 순서와 삼킴을 여기서 고정한다.
 */
describe('dispose 는 애드온을 먼저 버리고, 어떤 예외도 밖으로 내보내지 않는다', () => {
  it('애드온을 터미널보다 먼저 버린다 — 훅이 이미 해체된 것 위에서 돌지 않게', async () => {
    const el = host(640, 480);
    const sink = getTerminalSinkFactory()(el, {});
    await vi.waitFor(() => expect(loadedAddons).toHaveLength(1));

    sink.dispose();
    expect(disposeOrder).toEqual(['addon', 'term']);
  });

  it('애드온 정리가 던져도 삼키고, 터미널은 그대로 버린다 — 그 예외가 앱을 껐다', async () => {
    const el = host(640, 480);
    const sink = getTerminalSinkFactory()(el, {});
    await vi.waitFor(() => expect(loadedAddons).toHaveLength(1));
    addonDisposeThrows = true;

    expect(() => sink.dispose()).not.toThrow();
    // 애드온 때문에 터미널 해체를 건너뛰면 죽은 화면이 살아 남는다.
    expect(disposeOrder).toEqual(['addon', 'term']);
    expect(disposed).toBe(true);
  });

  it('터미널 정리가 던져도 삼킨다 — 같은 규율의 나머지 절반', async () => {
    const el = host(640, 480);
    const sink = getTerminalSinkFactory()(el, {});
    await vi.waitFor(() => expect(loadedAddons).toHaveLength(1));
    termDisposeThrows = true;

    expect(() => sink.dispose()).not.toThrow();
    expect(disposeOrder).toEqual(['addon', 'term']);
  });

  it('컨텍스트 상실 콜백이 던져도 새지 않는다 — xterm 의 이벤트 루프 안에서 불린다', async () => {
    const el = host(640, 480);
    const sink = getTerminalSinkFactory()(el, {});
    await vi.waitFor(() => expect(loadedAddons).toHaveLength(1));
    addonDisposeThrows = true;

    expect(() => loadedAddons[0]!.loseContext()).not.toThrow();
    sink.dispose();
  });
});

/**
 * 애드온을 **받는 동안 패널이 닫히는** 경로. `dispose` 는 이미 지나갔으므로 그 뒤에 얹히면
 * 아무도 그것을 버리지 않는다 — 죽은 터미널에 붙은 렌더러가 남는다.
 */
describe('로딩 중에 닫히면 렌더러를 남기지 않는다', () => {
  it('dispose 가 먼저 지나가면 애드온은 얹히지 않거나 곧바로 버려진다', async () => {
    const el = host(640, 480);
    const sink = getTerminalSinkFactory()(el, {});
    // `await` 을 하지 않는다 — 동적 import 가 아직 안 풀린 시점에 닫는다.
    sink.dispose();
    await settle();
    await vi.waitFor(() => {
      // 얹히지 않았거나(0개), 얹혔더라도 버려져 있어야 한다.
      expect(loadedAddons.every((a) => a.disposed)).toBe(true);
    });
  });
});
