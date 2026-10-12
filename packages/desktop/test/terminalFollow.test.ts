// 터미널 T2 — 폭을 못 정하는 창은 서버가 알려 준 PTY 크기로 그린다(designer 2026-10-12 안).
// 자기 패널로 접으면 줄이 꺾이고 상태 줄이 섞인다. 패널이 좁으면 정수 px 로 줄이되 10px 밑으로는
// 안 줄이고, 그래도 넘치면 가로 스크롤이다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const resizes: [number, number][] = [];
let lastTerm: { options: { fontSize?: number } } | null = null;

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate(): void {} onContextLoss(): void {} dispose(): void {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: '' }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: { fontSize?: number };
    constructor(opts: { fontSize?: number }) { this.options = { ...opts }; lastTerm = this; }
    open(): void {}
    write(): void {}
    onData(): void {}
    resize(cols: number, rows: number): void { resizes.push([cols, rows]); }
    loadAddon(): void {}
    dispose(): void {}
  },
}));

import { getTerminalSinkFactory, followFontSize, FOLLOW_MIN_FONT_SIZE, type TerminalFollowView } from '../src/lib/terminalSink';

/** 글자 13px 에서 셀 8x16 인 세상. */
const CELL_W = 8;
const CELL_H = 16;
let fireResize: (() => void) | null = null;

class FakeResizeObserver {
  constructor(private readonly cb: () => void) {}
  observe(): void { fireResize = () => this.cb(); }
  disconnect(): void {}
  unobserve(): void {}
}

function host(width: number, height: number): HTMLElement {
  const el = document.createElement('div');
  setHostSize(el, width, height);
  document.body.appendChild(el);
  return el;
}
function setHostSize(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
}
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

beforeEach(() => {
  resizes.length = 0;
  lastTerm = null;
  fireResize = null;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width: CELL_W * 100, height: CELL_H } as DOMRect);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function open(width: number, height: number) {
  const el = host(width, height);
  const reported: [number, number][] = [];
  const views: (TerminalFollowView | null)[] = [];
  const sink = getTerminalSinkFactory()(el, {
    onResize: (c, r) => reported.push([c, r]),
    onFollow: (v) => views.push(v),
  });
  await settle();
  return { el, sink, reported, views };
}

describe('followFontSize — 받은 열 수를 패널에 넣는 글자 크기', () => {
  it('다 들어가면 기본 13px, 좁으면 정수로 줄이고, 10px 밑으로는 안 줄인다', () => {
    expect(followFontSize(120, 960, CELL_W)).toBe(13);
    expect(followFontSize(120, 2000, CELL_W)).toBe(13); // 키우지 않는다
    expect(followFontSize(120, 780, CELL_W)).toBe(10); // floor(13·780/960)=10
    expect(followFontSize(120, 850, CELL_W)).toBe(11);
    expect(followFontSize(200, 400, CELL_W)).toBe(FOLLOW_MIN_FONT_SIZE);
  });
});

describe('follow — 남의 크기로 그린다', () => {
  it('받은 크기로 xterm 을 맞추고, 그 크기는 PTY 로 다시 보고하지 않는다', async () => {
    const { sink, reported, views } = await open(780, 640);
    resizes.length = 0; reported.length = 0;
    sink.follow!({ cols: 120, rows: 40 });
    expect(resizes.at(-1)).toEqual([120, 40]);
    expect(lastTerm!.options.fontSize).toBe(10);
    expect(reported).toEqual([]);
    expect(views.at(-1)).toMatchObject({ cols: 120, rows: 40, fontSize: 10, scroll: false, differs: true });
  });

  it('하한까지 줄여도 넘치면 가로 스크롤을 켠다', async () => {
    const { el, sink, views } = await open(400, 640);
    sink.follow!({ cols: 200, rows: 50 });
    expect(lastTerm!.options.fontSize).toBe(FOLLOW_MIN_FONT_SIZE);
    expect(el.style.overflowX).toBe('auto');
    expect(views.at(-1)).toMatchObject({ scroll: true });
  });

  it('넘침은 그려진 화면(.xterm-screen) 폭으로 정한다 — 추정이 맞아도 실제로 넘치면 스크롤(designer n1)', async () => {
    const { el, sink, views } = await open(780, 640);
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    Object.defineProperty(screen, 'offsetWidth', { value: 800, configurable: true }); // 반올림으로 추정(738)보다 넓다
    el.appendChild(screen);
    sink.follow!({ cols: 120, rows: 40 });
    expect(views.at(-1)).toMatchObject({ fontSize: 10, scroll: true });
    expect(el.style.overflowX).toBe('auto');
  });

  it('받은 크기가 자기 크기와 같으면 differs=false — 배지가 덧붙일 말이 없다', async () => {
    const { sink, views } = await open(960, 640); // 자기 fit = 120x40
    sink.follow!({ cols: 120, rows: 40 });
    expect(views.at(-1)).toMatchObject({ fontSize: 13, scroll: false, differs: false });
  });

  it('패널이 바뀌어도 크기는 그대로 두고 글자만 다시 정한다', async () => {
    const { el, sink, reported } = await open(960, 640);
    sink.follow!({ cols: 120, rows: 40 });
    reported.length = 0; resizes.length = 0;
    setHostSize(el, 850, 640);
    fireResize!();
    expect(resizes.every(([c, r]) => c === 120 && r === 40)).toBe(true);
    expect(lastTerm!.options.fontSize).toBe(11);
    expect(reported).toEqual([]);
  });

  it('follow(null) 이면 글자·스크롤을 되돌리고 자기 패널 크기로 다시 맞춰 보고한다', async () => {
    const { el, sink, reported, views } = await open(400, 640);
    sink.follow!({ cols: 200, rows: 50 });
    reported.length = 0;
    sink.follow!(null);
    expect(lastTerm!.options.fontSize).toBe(13);
    expect(el.style.overflowX).toBe('');
    expect(views.at(-1)).toBeNull();
    expect(reported).toEqual([[50, 40]]); // 400/8 × 640/16
  });

  it('xterm 이 뜨기 전에 받은 크기도 뜨자마자 적용한다', async () => {
    const el = host(780, 640);
    const sink = getTerminalSinkFactory()(el, {});
    sink.follow!({ cols: 120, rows: 40 });
    await settle();
    expect(resizes.at(-1)).toEqual([120, 40]);
    expect(lastTerm!.options.fontSize).toBe(10);
  });
});
