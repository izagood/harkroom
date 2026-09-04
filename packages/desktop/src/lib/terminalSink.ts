// 바이트를 화면의 터미널에 그리는 것(#141). xterm.js 를 이 파일 뒤에 숨긴다.
//
// **왜 이음새를 두는가**: xterm 은 `Terminal#open` 에서 캔버스·`getComputedStyle` 을 만지고,
// jsdom 에는 그 표면이 온전하지 않다. 패널 컴포넌트가 xterm 을 직접 import 하면 패널의
// 렌더·구독 수명 테스트가 xterm 이 jsdom 에서 뜨는지에 걸리고, 그건 이 테스트가 지키려는
// 성질(패널을 닫으면 구독이 끊긴다)과 아무 관계가 없다. `state/controller.ts` 의
// `setController` 와 같은 모양의 이음새다.
//
// 기본 구현은 xterm 을 **동적으로** import 한다 — 그래서 가짜를 꽂은 테스트에서는 xterm
// 모듈이 아예 로드되지 않는다.

export interface TerminalSink {
  /** PTY raw 바이트. 디코드는 xterm 의 상태 기계가 한다. */
  write(bytes: Uint8Array): void;
  /**
   * 지금 크기를 다시 재서 **바뀌지 않았어도** `onResize` 로 알린다(#346). writer 승격
   * 직후를 위한 것이다 — 승격 전의 fit 은 패널 가드가 버렸으므로, 여기서 다시 알리지
   * 않으면 마지막으로 "보낸" 크기와 실제 크기가 같아 ResizeObserver 도 침묵하고 PTY 는
   * 이전 writer 의 크기로 남는다. 옵셔널: 가짜 sink(테스트)는 구현하지 않아도 된다.
   */
  refit?(): void;
  dispose(): void;
}

export interface TerminalSinkOptions {
  /**
   * 사람이 이 터미널에 친 것(#315). xterm 의 `onData` 가 주는 문자열 그대로다 — 화살표·
   * Ctrl-C·붙여 넣기가 전부 여기로 온다. **없으면 읽기 전용이다**: 옵션이 안 오면 xterm 의
   * stdin 자체를 끈다. "받아 놓고 아무 데도 안 보낸다"로 두면 사람은 글자가 찍히는 것을
   * 보고 쳤다고 믿지만 러너에는 아무것도 닿지 않는다 — 눌러도 아무 일이 없는 입력창이다.
   */
  onInput?: (data: string) => void;
  /**
   * 이 터미널이 지금 **몇 칸인가**(#335). 컨테이너가 바뀔 때마다 온다.
   *
   * `onInput` 과 같은 자리에 같은 모양으로 둔다 — 없으면 크기를 아무 데도 안 보낸다.
   * writer 가 아닐 때 값을 버리는 것이 화면 쪽 절반이고(TerminalPanel 의 가드),
   * 서버 쪽 절반은 허브의 writer 판정이다(#346 — 진짜 게이트는 그쪽이다).
   */
  onResize?: (cols: number, rows: number) => void;
}

/** xterm 에 넘기는 폰트. 셀 크기를 재는 쪽과 **같은 값**이어야 계산이 맞는다. */
const FONT_SIZE = 12;
const FONT_FAMILY = 'courier-new, courier, monospace';

/**
 * 이 호스트 요소에 몇 칸이 들어가는가. xterm 은 스스로 컨테이너에 맞추지 않는다 —
 * `resize` 를 부르는 쪽이 크기를 정해야 하고, 그 크기를 아는 방법은 셀 하나를 실제로
 * 재는 것뿐이다.
 *
 * `@xterm/addon-fit` 을 쓰지 않는 이유: 그 애드온이 하는 일이 이 함수이고, 의존을 하나
 * 더 늘리면 터미널 폭이라는 한 가지 사실이 두 패키지의 버전 조합에 걸린다.
 *
 * 잴 수 없으면(레이아웃 전, jsdom) `null` 이다 — 0 으로 계산해 1x1 을 보내지 않는다.
 */
function fitDimensions(el: HTMLElement): { cols: number; rows: number } | null {
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${FONT_SIZE}px ${FONT_FAMILY}`;
  // 한 글자만 재면 반올림 오차가 폭 전체에 곱해진다 — 100 글자를 재서 나눈다.
  probe.textContent = 'W'.repeat(100);
  el.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  el.removeChild(probe);
  const cellWidth = rect.width / 100;
  const cellHeight = rect.height;
  if (!(cellWidth > 0) || !(cellHeight > 0)) return null;
  if (!(el.clientWidth > 0) || !(el.clientHeight > 0)) return null;
  return {
    cols: Math.max(1, Math.floor(el.clientWidth / cellWidth)),
    rows: Math.max(1, Math.floor(el.clientHeight / cellHeight)),
  };
}

export type TerminalSinkFactory = (el: HTMLElement, opts?: TerminalSinkOptions) => TerminalSink;

/**
 * xterm 을 붙이는 실제 구현. `import()` 가 끝나기 전에 도착한 바이트는 **큐에 담고
 * 도착 순서 그대로** 쓴다.
 *
 * 버리면 안 되는 이유: attach 직후 서버가 보내는 첫 프레임이 ring buffer 재생이다 —
 * 그것을 버리면 사람이 보는 화면이 "붙은 순간부터"가 되어, 진행 중인 턴에 붙는다는
 * 이 기능의 값이 사라진다. 순서를 지키면 되는 이유: 서버가 이미 뷰어별로 재생 → 라이브
 * 순서를 보장하므로(스펙 §5), 도착 순서대로 쓰면 그 보장이 화면까지 그대로 온다.
 */
const xtermSink: TerminalSinkFactory = (el, opts) => {
  const pending: Uint8Array[] = [];
  let term: { write(data: Uint8Array): void; resize(cols: number, rows: number): void; dispose(): void } | null = null;
  let disposed = false;
  let observer: ResizeObserver | null = null;
  /** 마지막으로 보낸 크기. 같은 값을 다시 보내지 않는다 — 드래그 한 번이 수십 프레임이다. */
  let sent: { cols: number; rows: number } | null = null;

  /**
   * 지금 컨테이너에 맞는 크기로 터미널을 맞추고, 바뀌었으면 알린다(#335).
   *
   * xterm 을 먼저 맞추고 그다음에 알리는 순서다: PTY 가 새 폭으로 그린 바이트가 도착할
   * 때 화면이 아직 옛 폭이면 그 프레임 하나가 접혀 보인다.
   */
  const applyFit = (): void => {
    if (!term) return;
    const size = fitDimensions(el);
    if (!size) return;
    if (sent && sent.cols === size.cols && sent.rows === size.rows) return;
    sent = size;
    term.resize(size.cols, size.rows);
    opts?.onResize?.(size.cols, size.rows);
  };

  void (async () => {
    // 스타일시트를 함께 받는다 — 없으면 xterm 이 셀 크기를 계산하지 못해 화면이 겹친다.
    // 동적 import 안에 두는 이유는 모듈과 같다: 가짜 sink 를 쓰는 테스트가 이것을 로드하지
    // 않게 한다(jsdom 은 CSS 를 파싱하지 않지만, Vite 의 CSS 처리 경로 자체를 태우지 않는다).
    await import('@xterm/xterm/css/xterm.css');
    const { Terminal } = await import('@xterm/xterm');
    if (disposed) return;
    const t = new Terminal({
      // 스크롤백은 러너의 ring buffer(256KB)가 재생하는 만큼이면 충분하다 — 여기서 더
      // 크게 잡아도 그 이상은 애초에 오지 않는다.
      scrollback: 5_000,
      convertEol: false,
      fontSize: FONT_SIZE,
      fontFamily: FONT_FAMILY,
      // 쓸 수 없는 사람에게는 xterm 의 stdin 을 아예 끈다(#315) — 커서도 깜빡이지 않고
      // 키를 눌러도 아무것도 그려지지 않으므로, 화면이 "여기는 읽기 전용이다"를 스스로
      // 말한다. 이유는 패널이 글로 따로 적는다(TerminalPanel.tsx).
      disableStdin: !opts?.onInput,
    });
    t.open(el);
    if (opts?.onInput) t.onData(opts.onInput);
    term = t;
    for (const chunk of pending) t.write(chunk);
    pending.length = 0;
    // 붙자마자 한 번 맞춘다 — 이것이 러너의 spawn 기본값(120x40)을 소유자의 실제 폭으로
    // 덮어쓰는 자리다. 그 뒤로는 컨테이너가 바뀔 때마다 온다.
    applyFit();
    // jsdom 에는 `ResizeObserver` 가 없다. 없다고 터미널 자체를 못 띄우면 안 되므로,
    // 첫 맞춤만 하고 관찰은 건너뛴다.
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => applyFit());
      observer.observe(el);
    }
  })().catch(() => { /* 터미널을 못 띄운 것으로 패널을 죽이지 않는다 */ });

  return {
    write(bytes) {
      if (term) term.write(bytes);
      else pending.push(bytes);
    },
    refit() {
      // "마지막으로 보낸 크기"를 지워 applyFit 의 중복 억제를 한 번 우회한다 — writer
      // 승격 직후에는 크기가 안 바뀌었어도 알려야 한다(승격 전의 보고는 버려졌다, #346).
      sent = null;
      applyFit();
    },
    dispose() {
      disposed = true;
      pending.length = 0;
      // 관찰을 안 끊으면 패널을 닫은 뒤에도 리사이즈 콜백이 살아 남아, 이미 닫힌 소켓에
      // 크기를 계속 보낸다.
      observer?.disconnect();
      observer = null;
      term?.dispose();
      term = null;
    },
  };
};

let factory: TerminalSinkFactory = xtermSink;

export function setTerminalSinkFactory(next: TerminalSinkFactory): void {
  factory = next;
}

export function getTerminalSinkFactory(): TerminalSinkFactory {
  return factory;
}
