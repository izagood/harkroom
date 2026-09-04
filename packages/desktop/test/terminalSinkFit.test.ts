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
vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: '' }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    open(): void { /* jsdom 에는 캔버스가 없다 */ }
    write(): void { /* 이 파일은 바이트를 안 본다 */ }
    onData(): void { /* 같음 */ }
    resize(cols: number, rows: number): void { resizes.push([cols, rows]); }
    dispose(): void { disposed = true; }
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
