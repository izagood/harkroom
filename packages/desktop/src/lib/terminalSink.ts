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
//
// **렌더러는 WebGL 로 올린다.** xterm 의 기본값은 DOM 렌더러이고, 그것이 xterm 이 가진 셋
// (DOM·canvas·WebGL) 중 가장 느리다. 이 패널이 그리는 것은 코딩 에이전트 TUI — 한 턴에
// 화면 전체를 수십 번 다시 그리는 쪽이라, 셀을 DOM 노드로 만드는 렌더러가 그대로 체감된다.
// `@xterm/addon-webgl` 은 셀을 GPU 텍스처 아틀라스로 그린다.
//
// 애드온을 **못 켜도 터미널은 뜬다**(WebGL2 가 없는 환경·컨텍스트 상실). 그때는 xterm 이
// 기본 DOM 렌더러로 그대로 그리므로, 실패는 삼키고 화면은 살린다 — `enableWebglRenderer`.
//
// **애드온 버전은 xterm 과 짝이다 — `@xterm/addon-webgl` 은 `0.18.x` 로 묶어 둔다.**
// 이 애드온은 xterm 의 **private 내부**(`_core._renderService`·`_core._createRenderer`)에
// 손을 넣는다. 0.19.0 은 그 위에 `_core._store._isDisposed` 가드를 더 넣었는데, 그 `_store` 는
// xterm **6 계열**의 lifecycle 이고 우리가 쓰는 5.5.0 에는 없다(`common/Lifecycle.ts` 는
// `_disposables`·`_isDisposed` 뿐이다) → 애드온 dispose 가 `undefined._isDisposed` 로 던진다.
// 실측 사고: 터미널 패널의 [Close] 를 누르면 그 예외가 React effect cleanup 밖으로 나가
// **앱 화면 전체가 꺼졌다**(웹뷰 크래시가 아니다 — 크래시 리포트가 없었다). `^0.19` 처럼
// 마이너를 열어 두면 이 짝이 조용히 깨진다.

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
  /**
   * 이 터미널을 **읽기 전용으로 접거나 푼다**(#369). xterm 의 stdin 을 끄면 커서가 깜빡이지
   * 않고 키를 눌러도 아무것도 그려지지 않는다 — 화면이 "여기는 못 친다"를 스스로 말한다.
   *
   * 생성 시점의 `disableStdin` 만으로는 부족하다: 쓰기 차례는 attach **뒤에** 오가고
   * (#346 승격·강등, #369 관찰 전용 판정), sink 를 그때마다 다시 만들면 화면이 통째로
   * 리셋된다. 옵셔널: 가짜 sink(테스트)는 구현하지 않아도 된다.
   */
  setReadOnly?(readOnly: boolean): void;
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

/**
 * xterm 에 넘기는 폰트. 셀 크기를 재는 쪽과 **같은 값**이어야 계산이 맞는다.
 *
 * 앱의 척도가 한 단 올라간 판에서 12 로 두면(2026-09-10) 앱은 커지고 **터미널 글자만**
 * 작게 남는다. 정수로 올리는 이유: 글리프가 device px 격자에 맞아야 흐리지 않다.
 */
const FONT_SIZE = 13;
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
 * `enableWebglRenderer` 가 터미널에게 요구하는 것 전부.
 *
 * 애드온 인자에 `activate` 까지 적어 두는 이유: 그것이 xterm 이 애드온에게 요구하는 표면
 * (`ITerminalAddon`)이고, 빼면 진짜 `Terminal` 이 이 타입에 안 맞는다(메서드 인자는
 * 양방향으로 비교되므로 한쪽이 다른 쪽의 부분집합이어야 한다).
 */
interface WebglTarget {
  loadAddon(addon: {
    activate(terminal: never): void;
    onContextLoss(handler: () => void): unknown;
    dispose(): void;
  }): void;
}

/**
 * 렌더러를 GPU 로 올린다(모듈 머리 주석). **실패를 삼킨다** — 못 켜면 xterm 이 기본 DOM
 * 렌더러로 그대로 그리고, 사람은 느린 화면을 볼 뿐 아무것도 잃지 않는다. 여기서 던지면
 * 그 반대가 된다: 렌더러 하나 때문에 터미널이 아예 안 뜬다.
 *
 * **컨텍스트 상실 때 애드온을 버리는 것이 이 함수의 절반이다.** GPU 리셋·드라이버 사정으로
 * WebGL 컨텍스트가 날아가는 일은 실제로 일어나고, 그때 애드온을 붙잡고 있으면 화면이 그
 * 자리에서 얼어 버린다. 버리면 xterm 이 DOM 렌더러로 되돌아가 계속 그린다.
 */
type LoadedAddon = { dispose(): void };

async function enableWebglRenderer(t: WebglTarget): Promise<LoadedAddon | null> {
  try {
    const { WebglAddon } = await import('@xterm/addon-webgl');
    const addon = new WebglAddon();
    // 컨텍스트 상실 때의 정리도 던질 수 있다 — 이 콜백은 xterm 의 이벤트 루프 안에서 불리므로
    // 여기서 새는 예외는 우리가 손댈 수 없는 자리에서 터진다.
    addon.onContextLoss(() => { try { addon.dispose(); } catch { /* 아래 dispose 규율과 같다 */ } });
    t.loadAddon(addon);
    return addon;
  } catch {
    /* WebGL2 가 없거나 애드온을 못 받았다 — DOM 렌더러로 그대로 둔다 */
    return null;
  }
}

/**
 * **조합(IME) 입력을 우리가 받는다** — 한글·일본어·중국어 입력이 xterm 을 통과하지 못한다.
 *
 * xterm 의 IME 지원은 macOS/WKWebView 에서 **알려진 채로 깨져 있다**: 조합 이벤트를
 * 자기 `CompositionHelper` 로 처리하는데, 그 경로가 첫 글자만 받거나(xtermjs/xterm.js#1939)
 * 조합 대신 **영문 자모를 그대로 보내거나**(#124) IME 가 `keyCode 229` 를 모든 키에 실어
 * 보내면 글자를 흘린다(#5887, #5894 는 WKWebView 전용). 실측으로도 이 앱에서 한글 입력이
 * 처음부터 안 됐다(2026-09-11, 사람 확인) — 우리가 만든 회귀가 아니라 그 위에 얹혀 있던
 * 결함이다.
 *
 * 그래서 **xterm 에 닿기 전에** 가로챈다(캡처 단계):
 * - `compositionstart/update/end` 를 멈춰 세워 xterm 의 깨진 경로를 아예 타지 않게 한다.
 * - **조합 중의 `keydown` 도 멈춘다.** 이것이 "한글을 쳤는데 영문 자모가 들어가는" 증상을
 *   막는 자리다 — 그 키는 IME 의 것이고 터미널의 것이 아니다.
 * - 확정된 문자열(`compositionend.data`)만 **정확히 한 번** 보낸다. xterm 은 조합을 못 봤
 *   으므로 중복 전송이 원천적으로 없다.
 *
 * 조합 중 화면 표시(밑줄 글자)는 **아직 그리지 않는다.** xterm 의 `.composition-view` 는
 * 위 경로와 함께 죽었고, 대신 우리가 그리려면 셀 좌표를 우리 손으로 계산해야 한다 —
 * 하네스(claude TUI)는 확정 텍스트만 받으면 되므로 그 표시는 다음 판으로 남긴다.
 */
function attachCompositionBridge(el: HTMLElement, io: {
  /** 확정된 문자열을 PTY 로 보낸다(xterm 의 `onData` 와 같은 자리로 들어간다). */
  send: (text: string) => void;
  /** 지금 이 창이 못 치는 상태인가(읽기 전용·관찰 전용). 조합 결과도 같은 게이트를 탄다. */
  blocked: () => boolean;
}): () => void {
  let composing = false;
  const swallow = (ev: Event): void => { ev.stopImmediatePropagation(); };
  const onStart = (ev: Event): void => { composing = true; swallow(ev); };
  const onEnd = (ev: Event): void => {
    composing = false;
    swallow(ev);
    // `data` 가 비면 조합을 **취소**한 것이다(Esc·지우기) — 보낼 것이 없다.
    const text = (ev as CompositionEvent).data;
    if (!text) return;
    // 읽기 전용 창에서 친 것은 여기서 버린다. `disableStdin` 은 xterm 의 문이고, 이 경로는
    // 그 문을 지나지 않으므로 **같은 판정을 여기서 한 번 더** 해야 한다.
    if (io.blocked()) return;
    io.send(text);
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    // 조합 중의 키는 IME 의 것이다. `isComposing` 은 표준 신호이고, `keyCode === 229` 는
    // macOS IME 가 조합 중 모든 키에 실어 보내는 "조합 문자" 코드다. **조합 밖의 키는
    // 건드리지 않는다** — 영문·화살표·Ctrl-C 는 그대로 xterm 이 처리해야 한다.
    if (composing || ev.isComposing || ev.keyCode === 229) ev.stopImmediatePropagation();
  };
  el.addEventListener('compositionstart', onStart, true);
  el.addEventListener('compositionupdate', swallow, true);
  el.addEventListener('compositionend', onEnd, true);
  el.addEventListener('keydown', onKeyDown, true);
  return () => {
    el.removeEventListener('compositionstart', onStart, true);
    el.removeEventListener('compositionupdate', swallow, true);
    el.removeEventListener('compositionend', onEnd, true);
    el.removeEventListener('keydown', onKeyDown, true);
  };
}

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
  // `options` 까지 드러내는 이유: 쓰기 차례가 attach 뒤에 오가므로(#346, #369) stdin 을
  // 뜬 뒤에도 켜고 끌 수 있어야 한다(`setReadOnly`).
  let term: {
    write(data: Uint8Array): void;
    resize(cols: number, rows: number): void;
    options: { disableStdin?: boolean };
    dispose(): void;
  } | null = null;
  /**
   * 얹힌 WebGL 애드온. **dispose 순서 때문에** 들고 있는다(아래 `dispose` 주석).
   */
  let webgl: LoadedAddon | null = null;
  let disposed = false;
  let observer: ResizeObserver | null = null;
  /**
   * 지금 이 창이 못 치는 상태인가. xterm 쪽 문은 `options.disableStdin` 이지만, 조합 경로는
   * 그 문을 지나지 않으므로(`attachCompositionBridge`) **같은 사실을 여기서도 들고 있어야**
   * 한다. 초기값은 생성자와 같은 규칙이다: `onInput` 이 없으면 처음부터 못 친다.
   */
  let readOnly = !opts?.onInput;
  /** 조합 브리지 해제. `dispose` 가 이것을 부른다 — 안 부르면 죽은 호스트에 리스너가 남는다. */
  let detachComposition: (() => void) | null = null;
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
    // 조합은 xterm 에 맡기지 않는다(위 `attachCompositionBridge` 주석).
    detachComposition = attachCompositionBridge(el, {
      send: (text) => opts?.onInput?.(text),
      blocked: () => readOnly || !opts?.onInput,
    });
    // 패널을 열었으면 **바로 칠 수 있어야 한다** — 지금까지는 한 번 클릭해야 키가 갔다.
    // 단 사람이 다른 입력칸에서 쓰고 있으면 **빼앗지 않는다**: 컴포저에 글을 쓰는 중에
    // 패널이 뜨는 경우가 있고, 그때 포커스를 가져가면 치던 문장이 터미널로 들어간다.
    const active = document.activeElement as HTMLElement | null;
    const typingElsewhere = !!active
      && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    if (opts?.onInput && !typingElsewhere) t.focus?.();
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
    // **바이트를 먼저 흘리고 그다음에 렌더러를 올린다.** 어느 렌더러가 그리는지는 화면의
    // 속도이고, 큐에 쌓인 ring 재생은 화면의 내용이다 — 내용을 렌더러 로딩 뒤로 미루면
    // 붙는 순간이 그만큼 늦어진다. 애드온은 뜬 뒤에 얹어도 xterm 이 다시 그린다.
    // 로딩 중에 패널이 닫혔으면 렌더러를 올리지 않는다 — 이미 버린 터미널에 애드온을
    // 얹으면 아무도 그것을 버리지 않는다(그리고 얹는 것 자체가 해체된 내부를 만진다).
    if (disposed) return;
    webgl = await enableWebglRenderer(t);
    // 애드온을 받는 동안 닫혔을 수도 있다 — 그때는 여기서 바로 버린다. `dispose` 는 이미
    // 지나갔으므로 이 자리가 마지막 기회다.
    if (disposed) {
      try { webgl?.dispose(); } catch { /* dispose 규율과 같다 */ }
      webgl = null;
    }
  })().catch(() => { /* 터미널을 못 띄운 것으로 패널을 죽이지 않는다 */ });

  return {
    write(bytes) {
      if (term) term.write(bytes);
      else pending.push(bytes);
    },
    setReadOnly(next) {
      // 조합 경로의 게이트(위 `readOnly`)를 먼저 맞춘다 — xterm 이 아직 안 떴어도
      // 이 사실은 유효하다.
      readOnly = next;
      // 아직 xterm 이 안 떴으면 생성자의 `disableStdin` 이 이미 옳은 값을 잡고 있다
      // (`onInput` 이 없으면 처음부터 꺼진다) — 뜬 뒤의 차례 변동만 여기서 반영한다.
      if (term) term.options.disableStdin = next;
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
      // **애드온을 터미널보다 먼저 버린다.** 애드온의 정리 훅은 xterm 의 private 내부를
      // 만져 렌더러를 DOM 으로 되돌리는데(그것이 컨텍스트 상실 때의 정상 경로다), 터미널이
      // 먼저 죽은 뒤에 그 훅이 돌면 이미 해체된 것 위에서 돈다.
      //
      // **그리고 어느 쪽 예외도 밖으로 내보내지 않는다.** 이 `dispose` 는 패널의 effect
      // cleanup 에서 불린다 — 여기서 새는 예외는 React 가 트리를 걷어내는 것으로 갚아지고,
      // 사람에게는 **앱 화면 전체가 꺼진 것**으로 보인다(실측 사고, 모듈 머리 주석). 터미널
      // 하나를 못 닫은 것이 앱을 닫는 일이 되어서는 안 된다.
      // 조합 리스너를 먼저 뗀다 — 남겨 두면 죽은 호스트에서 조합이 끝날 때 이미 닫힌
      // 소켓으로 글자를 보낸다.
      detachComposition?.();
      detachComposition = null;
      try { webgl?.dispose(); } catch { /* 렌더러 해체 실패가 화면을 끄지 않는다 */ }
      webgl = null;
      try { term?.dispose(); } catch { /* 같은 규율 — 여기서 새면 패널이 아니라 앱이 죽는다 */ }
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
