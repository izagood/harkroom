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
// **애드온 버전은 xterm 과 짝이다 — `@xterm/xterm` 은 `6.0.x`, `@xterm/addon-webgl` 은 `0.19.x`
// 로 함께 묶어 둔다.** 이 애드온은 xterm 의 **private 내부**(`_core._renderService`·
// `_core._createRenderer`·`_core._store`)에 손을 넣는다. 0.19.0 의 정리 훅은 xterm **6 계열**
// lifecycle 의 `_core._store._isDisposed` 를 읽는데, 5.5.0 에는 그 `_store` 가 없어 애드온
// dispose 가 `undefined._isDisposed` 로 던졌다. 실측 사고: 터미널 패널의 [Close] 를 누르면
// 그 예외가 React effect cleanup 밖으로 나가 **앱 화면 전체가 꺼졌다**(웹뷰 크래시가 아니다 —
// 크래시 리포트가 없었다). 그래서 5.5 시절엔 0.18 에 묶었고, xterm 을 6.0 으로 올리면서 짝을
// 0.19 로 옮겼다. 0.19 는 peerDependencies 를 선언하지 않아 짝이 깨져도 설치가 조용하다 —
// 둘 중 하나만 올리지 말고, `^` 로 마이너를 열지 마라.

import { createEchoLatencyTracker, type EchoLatencyStats } from './terminalLatency';
import { getExternalOpener } from './openExternal';

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
  /**
   * **남이 정한 PTY 크기로 그린다**(2026-10-12, 터미널 T2). 폭을 못 정하는 창이 자기 패널로
   * 접으면 PTY(폭의 주인 폭)와 줄 폭이 달라 줄이 꺾이고 상태 줄이 섞인다. `null` 이면 지금처럼
   * 자기 패널로 맞춘다(폭의 주인이 됐거나 서버가 크기를 안 알려 줬다).
   *
   * 패널이 좁으면 글자를 정수 px 로 줄이고(하한 `FOLLOW_MIN_FONT_SIZE`), 그래도 넘치면 가로 스크롤이다.
   * 줄 수가 패널보다 많으면 아래(상태 줄·입력 상자 자리)에 붙인다. 옵셔널: 가짜 sink 는 안 해도 된다.
   */
  follow?(size: { cols: number; rows: number } | null): void;
  dispose(): void;
}

/** `follow` 중의 화면 사실 — 배지가 읽는다. */
export interface TerminalFollowView {
  cols: number;
  rows: number;
  /** 지금 그리는 글자 크기(px). 줄였으면 `FONT_SIZE` 보다 작다. */
  fontSize: number;
  /** 하한까지 줄여도 넘쳐 가로 스크롤이 생겼는가. */
  scroll: boolean;
  /** 받은 크기가 이 패널의 자기 크기와 다른가 — 같으면 배지가 덧붙일 말이 없다. */
  differs: boolean;
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
  /** `follow` 로 그리는 모양이 바뀌었다(`null` = 자기 크기로 돌아왔다). */
  onFollow?: (view: TerminalFollowView | null) => void;
  /**
   * **지금 화면에서 무엇이 실제로 벌어지는지**를 밖으로 알린다(2026-09-12).
   *
   * 두 사실이 지금까지 아무 데도 안 보였다: ① WebGL 렌더러가 정말 켜졌는지(못 켜면
   * 조용히 DOM 으로 남는다 — 그게 "빨라진 것 같지 않다"의 후보다) ② IME 조합 이벤트가
   * 오기는 하는지(안 오면 한글은 무엇을 고쳐도 안 된다). 실패를 삼키는 설계라 사람이
   * 느낌으로만 말할 수밖에 없었다 — 그 느낌을 사실로 바꾸는 통로다.
   */
  onDiagnostics?: (d: TerminalDiagnostics) => void;
}

export interface TerminalDiagnostics {
  /** 실제로 그리고 있는 것. `dom` 이면 WebGL 을 못 켰다는 뜻이다(원인은 삼켜졌다). */
  renderer: 'webgl' | 'dom' | 'pending';
  /** 붙은 뒤 관찰한 조합 시작 횟수. 한글을 쳤는데 0 이면 웹뷰가 조합을 아예 안 쏜다. */
  compositions: number;
  /**
   * 조합 신호를 달고 온 키(`keyCode 229` 또는 `isComposing`). 조합 이벤트는 0 인데 이 값이
   * 오르면, 웹뷰가 **조합을 시작하지 않은 채 IME 키만** 흘려보낸다는 뜻이다.
   */
  imeKeys: number;
  /**
   * `key` 자체가 **한글 자모/음절**인 키. 이 값이 오르면 웹뷰가 조합 없이 **자모를 그대로**
   * 키로 준다는 사실이고, "한글을 쳤는데 ㅎㄱ 만 들어간다"가 정확히 그 모양이다.
   */
  hangulKeys: number;
  /**
   * 입력 → 첫 출력 지연(ms)의 최근 통계(2026-10-10). 표본이 없으면 `null`.
   * 경로를 바꾼(서버 경유 → 로컬 직결) 전후를 **실물 앱에서** 비교하는 계기다 — `terminalLatency.ts`.
   */
  echo: EchoLatencyStats | null;
}

/**
 * xterm 에 넘기는 폰트. 셀 크기를 재는 쪽과 **같은 값**이어야 계산이 맞는다.
 *
 * 앱의 척도가 한 단 올라간 판에서 12 로 두면(2026-09-10) 앱은 커지고 **터미널 글자만**
 * 작게 남는다. 정수로 올리는 이유: 글리프가 device px 격자에 맞아야 흐리지 않다.
 */
const FONT_SIZE = 13;
/**
 * 남의 크기로 그릴 때(`follow`) 줄여도 되는 하한(designer, 2026-10-12). 이보다 작으면 못 읽으므로
 * 여기서 멈추고 나머지는 가로 스크롤로 넘긴다. CSS transform 으로 줄이지 않는 이유: webgl 그림이 흐려진다.
 */
export const FOLLOW_MIN_FONT_SIZE = 10;

/** 받은 열 수를 이 폭에 넣으려면 몇 px 글자여야 하나 — 정수, `[하한, FONT_SIZE]`. 셀 폭은 글자 크기에 비례한다. */
export function followFontSize(cols: number, panelWidth: number, cellWidthAtBase: number): number {
  if (!(cellWidthAtBase > 0) || !(panelWidth > 0)) return FONT_SIZE;
  const fit = Math.floor((FONT_SIZE * panelWidth) / (cols * cellWidthAtBase));
  return Math.max(FOLLOW_MIN_FONT_SIZE, Math.min(FONT_SIZE, fit));
}

/**
 * 한글이 든 고정폭 글꼴을 **맨 앞에** 둔다(2026-10-12). courier 류에는 한글이 없어 브라우저가
 * 대신 고른 글꼴의 한글이 2칸보다 좁았고, 글자 사이가 떠 보였다(`머 지 했 다`).
 * Nanum Gothic Coding 은 영문 0.5em·한글 1em 이라 한글 한 자가 정확히 두 칸이다 — 영문을
 * 다른 글꼴로 두고 한글만 이것으로 떨어뜨리면 그 비율이 깨지므로 영문까지 이 글꼴로 그린다.
 * 앱에 번들한다(`@fontsource/nanum-gothic-coding`, SIL OFL 1.1) — 사람 맥에 깔려 있기를 바라지 않는다.
 */
const TERMINAL_FONT = 'Nanum Gothic Coding';
/**
 * 줄 높이 배율(designer s1, 2026-10-12 캡처). 나눔고딕코딩 한글은 글자 높이가 칸 높이(배율 1)를 넘어 굵은 한글의
 * 아래가 다음 줄에 닿고 회색 배경 밖으로 삐져나왔다. xterm 의 `lineHeight` 와 `measureCell` 이 **같은 값**을
 * 써야 fit 의 줄 수가 맞는다.
 */
const LINE_HEIGHT = 1.15;
const FONT_FAMILY = `"${TERMINAL_FONT}", courier-new, courier, monospace`;

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
function measureCell(el: HTMLElement): { width: number; height: number } | null {
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${FONT_SIZE}px ${FONT_FAMILY}`;
  // 한 글자만 재면 반올림 오차가 폭 전체에 곱해진다 — 100 글자를 재서 나눈다.
  probe.textContent = 'W'.repeat(100);
  el.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  el.removeChild(probe);
  const width = rect.width / 100;
  // xterm 은 칸 높이를 `글자 높이 × lineHeight` 로 잡는다 — 같은 비율로 잰다(아니면 fit 이 줄을 더 센다).
  // xterm 처럼 기기 px 로 내린다(`floor(글자 높이 × dpr × lineHeight) / dpr`).
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const height = Math.floor(rect.height * dpr * LINE_HEIGHT) / dpr;
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

function fitDimensions(el: HTMLElement): { cols: number; rows: number } | null {
  const cell = measureCell(el);
  if (!cell) return null;
  if (!(el.clientWidth > 0) || !(el.clientHeight > 0)) return null;
  return {
    cols: Math.max(1, Math.floor(el.clientWidth / cell.width)),
    rows: Math.max(1, Math.floor(el.clientHeight / cell.height)),
  };
}

/**
 * **조합용 숨은 입력칸을 화면 안으로 끌어온다** — 한글 입력의 뿌리로 의심되는 자리다.
 *
 * xterm 은 IME 용 textarea 를 `xterm.css` 에서 이렇게 둔다:
 * `position:absolute; opacity:0; left:-9999em; top:0; width:0; height:0`.
 * 즉 **화면 밖에 0×0** 이다. Chromium 은 그래도 조합을 시작하지만, **WebKit(=WKWebView,
 * 우리 앱)은 화면 밖 0크기 입력칸에서 IME 를 걸지 않는다** — 그러면 `compositionstart`
 * 자체가 오지 않고, 그 뒤의 어떤 처리(우리 브리지 포함)도 돌 기회가 없다.
 *
 * 웃기는 것은 xterm 도 이 사실을 안다는 점이다 — `CompositionHelper` 에 *"Ensure the text
 * area is at least 1x1, otherwise certain IMEs may break"* 라고 적고 크기를 키운다. 다만 그
 * 코드는 **조합이 시작된 뒤에만** 돈다(닭과 달걀).
 *
 * 그래서 시작 전부터 **커서 자리에 1×1 투명**으로 세워 둔다. 이것은 웹 에디터들이 쓰는
 * 표준 수법이고(캐럿 자리의 투명 입력칸), 보이지 않으므로 화면은 그대로다.
 */
function trackHelperTextarea(el: HTMLElement, term: {
  buffer: { active: { cursorX: number; cursorY: number } };
  onCursorMove(handler: () => void): { dispose(): void };
}): () => void {
  const textarea = el.querySelector<HTMLTextAreaElement>('textarea.xterm-helper-textarea');
  if (!textarea) return () => { /* 붙일 곳이 없다 — xterm 이 아직 안 그렸거나 가짜다 */ };
  // 크기는 한 번만 정한다. **0×0 이 아니어야 한다**(위 주석).
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  // **화면 안으로 옮긴 것만으로는 부족했다**(2026-09-14 실측: 조합 이벤트 여전히 0).
  // 남아 있던 두 가지를 마저 벗긴다:
  //  - `z-index: -5` — xterm.css 의 값이다. WebGL 캔버스가 이 입력칸을 **덮고** 있었다.
  //    WebKit 이 IME 를 걸 자리를 hit-test 로 고른다면 덮인 입력칸은 후보가 아니다.
  //    `.xterm-helpers` 가 쓰는 5 로 올린다(그 CSS 주석도 *"IME 가 캔버스 위에 오도록"* 이다).
  //  - `opacity: 0` — 완전 투명한 요소를 "보이지 않는다"고 보는 구현이 있다. 0.01 이면
  //    사람 눈에는 없는 것과 같고(1×1 이다) 합성에는 존재한다. 커서는 따로 감춘다.
  textarea.style.zIndex = '5';
  textarea.style.opacity = '0.01';
  textarea.style.caretColor = 'transparent';
  const place = (): void => {
    const cell = measureCell(el);
    // 못 재는 세상(레이아웃 전·jsdom)에서도 **화면 밖으로는 두지 않는다** — 좌상단이면
    // 조합은 시작된다. 위치가 커서와 어긋나면 후보창이 엉뚱한 데 뜨는 것뿐이다.
    const left = cell ? Math.round(term.buffer.active.cursorX * cell.width) : 0;
    const top = cell ? Math.round(term.buffer.active.cursorY * cell.height) : 0;
    textarea.style.left = `${left}px`;
    textarea.style.top = `${top}px`;
  };
  place();
  const sub = term.onCursorMove(place);
  // **xterm 이 포커스·커서마다 이 입력칸의 inline 스타일을 다시 쓴다**(`_syncTextArea` — 5.5·6.0 둘 다, 탐침 확인).
  // 크기·위치는 xterm 것도 커서 자리 셀이라 괜찮지만, `z-index:-5` 로 되돌리면 다시 WebGL 캔버스 밑에 깔린다.
  // 그래서 그 두 값만 지킨다. 같은 값이면 쓰지 않아 관찰이 되먹임하지 않는다.
  const keep = (): void => {
    if (textarea.style.zIndex !== '5') textarea.style.zIndex = '5';
    if (textarea.style.opacity !== '0.01') textarea.style.opacity = '0.01';
  };
  const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(keep) : null;
  observer?.observe(textarea, { attributes: true, attributeFilter: ['style'] });
  return () => { sub.dispose(); observer?.disconnect(); };
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

/** 열어도 되는 링크인가 — http·https 만. 파싱이 안 되면 아니다. */
export function isWebUrl(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 이 키가 **한글 자모·음절**인가. 조합 없이 자모가 키로 오는 세상을 진단에서 세기 위한 것이다.
 * 범위는 한글 자모(U+1100–11FF) · 호환 자모(U+3130–318F) · 음절(U+AC00–D7A3).
 */
function isHangul(key: string): boolean {
  if (key.length !== 1) return false;
  const c = key.codePointAt(0) ?? 0;
  return (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f) || (c >= 0xac00 && c <= 0xd7a3);
}

/**
 * 조합이 끝난 뒤 229 로 온 **확정 키**(H-B). WebKit 은 조합을 끝내는 키를 `compositionend` **뒤에** `keyCode 229` 로
 * 줄 수 있다 — 그 키가 xterm 에 닿으면 xterm 은 IME 키로 읽고 입력칸 차이를 보내 버린다(아래 주석). 그래서 우리가
 * 막고, 터미널이 받을 바이트를 직접 보낸다. 화살표처럼 모드(application cursor)에 따라 바이트가 갈리는 키는 넣지
 * 않는다 — 틀린 바이트를 보내느니 삼킨다(실기 확인 항목).
 */
/**
 * 같은 키를 `ev.code` 로도 알아본다(security #1339 n3). WebKit 은 확정 키를 `key: 'Process'` 로 줄 수 있다 — 그때
 * `key` 만 보면 Enter 가 「IME 가 넣을 글자」로 읽혀 삼켜진다. 물리 키 자리(`code`)는 IME 가 바꾸지 않는다.
 */
const COMMIT_CODES: Readonly<Record<string, string>> = {
  Enter: '\r',
  NumpadEnter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
};

const COMMIT_KEYS: Readonly<Record<string, string>> = {
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
};

/**
 * **조합(IME) 입력을 우리가 끝까지 받는다**(H-B, 스레드 8d233406) — xterm 의 IME 경로를 타지 않는다.
 *
 * ## 무엇이 깨졌었나 (10-08 조사, 코드 확정)
 * 첫 판(#771)은 `compositionstart/end` 만 가로챘다. 그러면 xterm `CompositionHelper._isComposing` 이 **늘 false** 다.
 * 그런데 WebKit 은 조합 주변 keydown 에 `keyCode 229` 를 싣고, 그 키가 xterm 에 닿으면 xterm 은
 * `_handleAnyTextareaChanges()` 로 setTimeout 뒤 **숨은 입력칸의 차이를 그대로 PTY 에 보낸다** — 조합 중 자모가 따로
 * 들어가고(ㅎ한), 짧아졌으면 DEL 을 보내 확정 글자를 지우고, 같은 길이면 입력칸 **전체 값**을 보낸다. 그것을 막는
 * 가드가 바로 우리가 꺼 버린 `_isComposing` 이었다. 업스트림도 같은 갈래가 열려 있다(xterm.js #5704·#6140·#6089·#6090·#6065).
 *
 * ## 그래서
 * - **229 키·조합 중 키는 하나도 xterm 에 보내지 않는다.** 대신 그 키가 만든 글자는 입력칸의 `input` 이벤트에서
 *   우리가 받는다(`insertText`) — 조합 없이 IME 가 바로 넣는 기호·숫자도 이 길로 온다(#5887 의 글자 유실).
 * - 조합 이벤트와 조합용 `input`(`insertCompositionText`·`insertFromComposition`·`deleteCompositionText`)도 막고,
 *   확정 문자열(`compositionend.data`)만 정확히 한 번 보낸다.
 * - 확정 뒤 **입력칸을 비운다** — 비우지 않으면 값이 쌓이고, 무엇이든 그 값을 다시 읽는 순간 옛 글자가 되살아난다.
 * - 조합이 끝난 뒤 229 로 온 확정 키(Enter 등)는 `COMMIT_KEYS` 로 직접 보낸다.
 * - 조합 밖의 보통 키(영문·화살표·Ctrl-C, 229 가 아닌 것)는 **건드리지 않는다** — xterm 이 지금처럼 처리한다.
 * - 못 치는 창(읽기 전용·관찰 전용)이면 이 경로로 들어온 것도 버린다 — `disableStdin` 은 xterm 의 문이고, 이 경로는
 *   그 문을 지나지 않는다.
 *
 * 조합 중 밑줄 글자 표시는 아직 없다(PR-6~7 입력줄·오버레이 몫).
 */
function attachCompositionBridge(el: HTMLElement, io: {
  /** 확정된 문자열을 PTY 로 보낸다(xterm 의 `onData` 와 같은 자리로 들어간다). */
  send: (text: string) => void;
  /** 지금 이 창이 못 치는 상태인가(읽기 전용·관찰 전용). 조합 결과도 같은 게이트를 탄다. */
  blocked: () => boolean;
  /** 조합이 **시작됐다**. 진단 줄이 이것을 센다 — 0 이면 웹뷰가 조합을 안 쏜다는 사실이다. */
  onCompositionStart?: () => void;
  /** 조합 신호를 단 키(`229`·`isComposing`)와 한글 자모 키를 각각 센다(진단). */
  onKeyObserved?: (kind: 'ime' | 'hangul') => void;
}): () => void {
  let composing = false;
  /** 지금 처리 중인 키가 IME 의 것(229)이었는가 — 그 키가 만든 `insertText` 는 우리가 보낸다. */
  let imeKeyPending = false;
  const swallow = (ev: Event): void => { ev.stopImmediatePropagation(); };
  const send = (text: string): void => { if (text && !io.blocked()) io.send(text); };
  /** 입력칸을 비운다. 브라우저가 이벤트를 다 끝낸 뒤에 — 이벤트 도중 값을 바꾸면 WebKit 이 조합을 되살린다. */
  const clearSoon = (target: EventTarget | null): void => {
    if (!(target instanceof HTMLTextAreaElement)) return;
    setTimeout(() => { if (!composing) target.value = ''; }, 0);
  };
  const onStart = (ev: Event): void => { composing = true; io.onCompositionStart?.(); swallow(ev); };
  const onEnd = (ev: Event): void => {
    composing = false;
    swallow(ev);
    // `data` 가 비면 조합을 **취소**한 것이다(Esc·지우기) — 보낼 것이 없다.
    send((ev as CompositionEvent).data);
    clearSoon(ev.target);
  };
  const onInput = (ev: Event): void => {
    const ie = ev as InputEvent;
    const type = ie.inputType ?? '';
    if (composing || type.includes('Composition')) { swallow(ev); return; }
    // IME 키(229)가 조합 없이 바로 넣은 글자 — xterm 은 그 키를 못 봤으므로(우리가 막았다) 우리가 보낸다.
    if (imeKeyPending && type === 'insertText') {
      swallow(ev);
      send(ie.data ?? '');
      clearSoon(ev.target);
    }
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    // **여기서 세는 것은 막는 것과 무관하다** — 무엇이 들어오는지 알기 위한 관측이다.
    if (ev.keyCode === 229 || ev.isComposing) io.onKeyObserved?.('ime');
    if (isHangul(ev.key)) io.onKeyObserved?.('hangul');
    imeKeyPending = false;
    if (composing || ev.isComposing) { swallow(ev); return; }
    if (ev.keyCode !== 229) return;
    // 조합 밖의 229 — xterm 에 닿으면 입력칸 차이를 보낸다(위). 막고, 확정 키면 바이트를 직접 보낸다.
    swallow(ev);
    const commit = COMMIT_KEYS[ev.key] ?? COMMIT_CODES[ev.code];
    if (commit !== undefined) { ev.preventDefault(); send(commit); return; }
    imeKeyPending = true;
  };
  el.addEventListener('compositionstart', onStart, true);
  el.addEventListener('compositionupdate', swallow, true);
  el.addEventListener('compositionend', onEnd, true);
  el.addEventListener('input', onInput, true);
  el.addEventListener('keydown', onKeyDown, true);
  return () => {
    el.removeEventListener('compositionstart', onStart, true);
    el.removeEventListener('compositionupdate', swallow, true);
    el.removeEventListener('compositionend', onEnd, true);
    el.removeEventListener('input', onInput, true);
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
    options: { disableStdin?: boolean; fontSize?: number };
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
  /** 숨은 입력칸 추적 해제(`trackHelperTextarea`). */
  let detachHelper: (() => void) | null = null;
  /** 밖으로 알리는 사실(위 `onDiagnostics`). 바뀔 때마다 통째로 보낸다 — 값이 둘뿐이다. */
  const diagnostics: TerminalDiagnostics = {
    renderer: 'pending', compositions: 0, imeKeys: 0, hangulKeys: 0, echo: null,
  };
  /**
   * 입력 → 첫 출력 지연(`TerminalDiagnostics.echo`). **못 치는 창의 키는 세지 않는다** — 그 키는
   * 어디에도 안 닿으므로 다음 출력은 그 키의 반응이 아니다.
   */
  const echo = createEchoLatencyTracker();
  const sendInput = (data: string): void => {
    if (!readOnly) echo.noteInput(performance.now());
    opts?.onInput?.(data);
  };
  const reportDiagnostics = (): void => { opts?.onDiagnostics?.({ ...diagnostics }); };
  /** 마지막으로 보낸 크기. 같은 값을 다시 보내지 않는다 — 드래그 한 번이 수십 프레임이다. */
  let sent: { cols: number; rows: number } | null = null;

  /**
   * 지금 컨테이너에 맞는 크기로 터미널을 맞추고, 바뀌었으면 알린다(#335).
   *
   * xterm 을 먼저 맞추고 그다음에 알리는 순서다: PTY 가 새 폭으로 그린 바이트가 도착할
   * 때 화면이 아직 옛 폭이면 그 프레임 하나가 접혀 보인다.
   */
  /** 남이 정한 크기(`follow`). 있으면 자기 패널로 맞추지 않는다. */
  let followSize: { cols: number; rows: number } | null = null;
  let fontSize = FONT_SIZE;
  /** 가로로 이어지는 쪽 끝을 흐리게 — 옆에 내용이 더 있다는 표시(designer). */
  const updateEdges = (): void => {
    const left = el.scrollLeft > 0;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    const mask = !left && !right ? ''
      : `linear-gradient(to right, ${left ? 'transparent, #000 24px' : '#000'}, ${right ? '#000 calc(100% - 24px), transparent' : '#000'})`;
    el.style.maskImage = mask;
    el.style.setProperty('-webkit-mask-image', mask);
  };
  const clearFollowStyles = (): void => {
    el.style.overflowX = '';
    el.style.overflowY = '';
    el.style.maskImage = '';
    el.style.removeProperty('-webkit-mask-image');
    el.removeEventListener('scroll', updateEdges);
  };
  const applyFollow = (): void => {
    if (!term || !followSize) return;
    const cell = measureCell(el);
    if (!cell || !(el.clientWidth > 0)) return;
    const own = fitDimensions(el);
    const next = followFontSize(followSize.cols, el.clientWidth, cell.width);
    if (next !== fontSize) { fontSize = next; term.options.fontSize = next; }
    term.resize(followSize.cols, followSize.rows);
    // 넘침은 **그려진 화면 폭**으로 정한다(designer n1). xterm 은 칸을 기기 픽셀로 반올림하므로 10~12px 에서는
    // `열 × 셀폭 × 비율` 추정이 칸당 몇 분의 1 px 씩 어긋나고, 200열이면 수십 px 가 된다. 화면 요소를 못 찾으면
    // (가짜 xterm) 추정으로 둔다.
    const screen = el.querySelector<HTMLElement>('.xterm-screen');
    const drawnWidth = screen && screen.offsetWidth > 0
      ? screen.offsetWidth
      : followSize.cols * cell.width * (next / FONT_SIZE);
    const scroll = drawnWidth > el.clientWidth + 0.5;
    el.style.overflowX = scroll ? 'auto' : 'hidden';
    // 줄이 넘치면 아래에 붙인다 — 상태 줄·입력 상자가 맨 아래다. 바깥 스크롤은 막고(스크롤백은 xterm 몫)
    // 위치만 바닥으로 옮긴다.
    el.style.overflowY = 'hidden';
    el.scrollTop = el.scrollHeight;
    el.removeEventListener('scroll', updateEdges);
    if (scroll) el.addEventListener('scroll', updateEdges, { passive: true });
    updateEdges();
    opts?.onFollow?.({
      cols: followSize.cols, rows: followSize.rows, fontSize: next, scroll,
      differs: !own || own.cols !== followSize.cols || own.rows !== followSize.rows,
    });
  };

  const applyFit = (): void => {
    if (!term) return;
    // 남의 크기로 그리는 중이면 패널이 바뀌어도 크기는 그대로 — 글자 크기·스크롤만 다시 정한다.
    if (followSize) { applyFollow(); return; }
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
    // 두 스타일시트를 함께 받는다(한 번 기다린다).
    const fontCss = Promise.all([
      import('@fontsource/nanum-gothic-coding/korean-400.css'),
      // 굵은 글씨도 받는다 — 없으면 브라우저가 400 을 흉내 내 굵게 그리는데 webgl 에서는 굵기가 안 보였다(캡처).
      import('@fontsource/nanum-gothic-coding/korean-700.css'),
    ]);
    await import('@xterm/xterm/css/xterm.css');
    // 한글 칸 폭을 맞추는 글꼴(위 `FONT_FAMILY`). `korean-400.css` 는 unicode-range 가 없는 **통짜 한 파일**
    // (woff2 ~520KB, 영문 포함)이다 — `400.css` 의 조각(93개)을 쓰면 처음 보는 음절의 조각이 늦게 오고,
    // 그 사이 webgl 아틀라스가 대신 쓴 글꼴의 글리프를 캐시해 버린다.
    await fontCss;
    const { Terminal } = await import('@xterm/xterm');
    // **글꼴이 실제로 올라온 뒤에** 연다 — xterm 과 `measureCell` 은 연 순간의 글꼴로 셀을 잰다.
    // 늦게 오면 대신 쓴 글꼴 폭으로 칸이 정해져 줄 폭이 어긋난다. 못 받으면(오프라인 웹뷰 등) 그냥 연다.
    // `document.fonts` 가 없는 곳(jsdom)에서는 기다리지 않는다.
    if (document.fonts) {
      try {
        await Promise.all([
          document.fonts.load(`${FONT_SIZE}px "${TERMINAL_FONT}"`, '가A'),
          document.fonts.load(`bold ${FONT_SIZE}px "${TERMINAL_FONT}"`, '가A'),
        ]);
      } catch { /* 대신 쓴 글꼴로 연다 */ }
    }
    if (disposed) return;
    const t = new Terminal({
      // 스크롤백은 러너의 ring buffer(256KB)가 재생하는 만큼이면 충분하다 — 여기서 더
      // 크게 잡아도 그 이상은 애초에 오지 않는다.
      scrollback: 5_000,
      convertEol: false,
      fontSize: FONT_SIZE,
      fontFamily: FONT_FAMILY,
      lineHeight: LINE_HEIGHT,
      // 한글 글꼴은 KS X 1001 기호(`— … · →` 등)를 전각으로 그리는데 xterm 은 1칸으로 잡는다 — 다음 칸을
      // 덮지 않게 칸 안으로 줄인다(designer, 캡처에서 `—PR`·`…→` 겹침 확인).
      rescaleOverlappingGlyphs: true,
      // **터미널 출력의 링크(OSC 8)는 http·https 만 연다**(security #1294 n1). xterm 기본 경로는 scheme 을 거르지 않고
      // confirm 뒤 `window.open` 한다 — 에이전트 출력이 `file:`·앱 스킴 링크를 심을 수 있다. 여는 것은 앱의 외부 열기
      // 하나로 모은다(메시지 본문 링크와 같은 문).
      linkHandler: {
        activate: (_ev, uri) => { if (isWebUrl(uri)) void getExternalOpener().open(uri).catch(() => { /* 못 열면 그만 */ }); },
        allowNonHttpProtocols: false,
      },
      // 쓸 수 없는 사람에게는 xterm 의 stdin 을 아예 끈다(#315) — 커서도 깜빡이지 않고
      // 키를 눌러도 아무것도 그려지지 않으므로, 화면이 "여기는 읽기 전용이다"를 스스로
      // 말한다. 이유는 패널이 글로 따로 적는다(TerminalPanel.tsx).
      disableStdin: !opts?.onInput,
    });
    t.open(el);
    if (opts?.onInput) t.onData(sendInput);
    // 조합이 **시작될 수 있게** 숨은 입력칸을 화면 안으로 끌어온다(위 주석).
    detachHelper = trackHelperTextarea(el, t);
    // 조합은 xterm 에 맡기지 않는다(위 `attachCompositionBridge` 주석).
    detachComposition = attachCompositionBridge(el, {
      send: sendInput,
      blocked: () => readOnly || !opts?.onInput,
      onCompositionStart: () => { diagnostics.compositions += 1; reportDiagnostics(); },
      onKeyObserved: (kind) => {
        if (kind === 'ime') diagnostics.imeKeys += 1;
        else diagnostics.hangulKeys += 1;
        reportDiagnostics();
      },
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
    diagnostics.renderer = webgl ? 'webgl' : 'dom';
    reportDiagnostics();
    // 애드온을 받는 동안 닫혔을 수도 있다 — 그때는 여기서 바로 버린다. `dispose` 는 이미
    // 지나갔으므로 이 자리가 마지막 기회다.
    if (disposed) {
      try { webgl?.dispose(); } catch { /* dispose 규율과 같다 */ }
      webgl = null;
    }
  })().catch(() => { /* 터미널을 못 띄운 것으로 패널을 죽이지 않는다 */ });

  return {
    write(bytes) {
      if (echo.noteOutput(performance.now())) {
        diagnostics.echo = echo.stats();
        reportDiagnostics();
      }
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
    follow(size) {
      const same = size && followSize && size.cols === followSize.cols && size.rows === followSize.rows;
      if (same) return;
      followSize = size ? { cols: size.cols, rows: size.rows } : null;
      if (followSize) { applyFollow(); return; }
      // 자기 크기로 돌아온다 — 글자·스타일을 되돌리고, 중복 억제를 비워 지금 패널 크기를 다시 잰다.
      clearFollowStyles();
      if (term && fontSize !== FONT_SIZE) term.options.fontSize = FONT_SIZE;
      fontSize = FONT_SIZE;
      opts?.onFollow?.(null);
      sent = null;
      applyFit();
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
      el.removeEventListener('scroll', updateEdges);
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
      detachHelper?.();
      detachHelper = null;
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
