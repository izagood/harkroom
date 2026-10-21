/**
 * 입력창 Enter 기록(진단, 2026-10-21 「글 끝에서 Enter 를 두 번 쳐야 보내진다」).
 *
 * 설치본에서만 나고 탐침(같은 2벌식·같은 Composer)에서는 재현되지 않았다. 그래서 다음에 증상이
 * 나면 **한 번에 원인이 잡히도록** Enter 가 지나간 길을 남긴다:
 *
 * - `raw`   — 편집기 글 칸에 Enter keydown 이 **도착했다**(캡처 단계, CodeMirror 보다 먼저).
 * - `key`   — `Composer` 의 열쇠 처리기가 그 Enter 를 **받았고** 어디로 보냈는지(`route`).
 * - `send`  — `send()` 가 보냈는지, 안 보냈으면 왜인지(`outcome`).
 *
 * `raw` 는 있는데 `key` 가 없으면 CodeMirror 가 삼킨 것이고, `key` 가 send 로 갔는데 `outcome` 이
 * `empty` 면 편집기 글과 React 의 초안이 어긋난 것이다 — 그 둘을 가르려고 글자 수를 둘 다 적는다.
 *
 * ## 남기지 않는 것
 * **글자는 한 자도 남기지 않는다.** 길이(숫자)와 판정만 남긴다 — 이 기록은 사람이 복사해 채팅에
 * 붙이는 것이라 쓰던 글이 새면 안 된다. 경로·계정·채널 id 도 없다.
 *
 * 메모리에만 있고(새로 고치면 사라진다) 200개를 넘으면 오래된 것부터 버린다.
 */

export const ENTER_TRACE_MAX = 200;

/** 열쇠 처리기가 Enter 를 보낸 곳. */
export type EnterRoute =
  | 'list'        // 멘션 후보 목록이 열려 있어 후보를 골랐다
  | 'composing'   // 조합 중이라 넘겼다
  | 'meta-send'   // ⌘/Ctrl+Enter
  | 'shift'       // Shift+Enter(줄바꿈·목록 잇기)
  | 'fence'       // 코드 블록 안이라 줄바꿈
  | 'send';       // 보내기로 갔다

/** `send()` 의 결과. 보내지 않은 갈래는 각각 이름이 있다. */
export type SendOutcome =
  | 'sent'
  | 'empty'          // 초안(React 의 `draft`)이 비었다
  | 'offline'
  | 'failedUpload'
  | 'tooLong'
  | 'manyCalls';     // 셋 이상을 불러 한 번 묻는다

export interface EnterTraceEntry {
  /** `performance.now()` 반올림(ms) — 같은 키의 raw·key·send 를 잇는다. */
  t: number;
  kind: 'raw' | 'key' | 'send';
  key?: string;
  code?: string;
  keyCode?: number;
  shift?: boolean;
  meta?: boolean;
  isComposing?: boolean;
  /** CodeMirror 가 조합 중이라고 보는가(`view.composing`). */
  editorComposing?: boolean;
  /** 편집기 글 길이(글자 수만). */
  docLen?: number;
  /** React 초안 길이(글자 수만). `docLen` 과 다르면 어긋난 것이다. */
  draftLen?: number;
  listOpen?: boolean;
  offline?: boolean;
  route?: EnterRoute;
  outcome?: SendOutcome;
  /** 포커스가 있던 요소의 종류(태그·글 칸 여부). 글자·id 는 없다. */
  focus?: string;
}

const ring: EnterTraceEntry[] = [];

export function recordEnter(entry: Omit<EnterTraceEntry, 't'>): void {
  ring.push({ t: Math.round(performance.now()), ...entry });
  if (ring.length > ENTER_TRACE_MAX) ring.splice(0, ring.length - ENTER_TRACE_MAX);
}

/** 포커스 요소를 종류로만 적는다 — `cm-content`(편집기 글 칸) · 태그 이름 · 없음. */
export function focusKind(doc: Document = document): string {
  const el = doc.activeElement;
  if (!el) return 'none';
  if (el instanceof HTMLElement && el.classList.contains('cm-content')) return 'cm-content';
  return el.tagName.toLowerCase();
}

export function enterTraceSnapshot(): EnterTraceEntry[] {
  return ring.map((e) => ({ ...e }));
}

/** 붙여 넣을 글. 한 줄에 한 기록(JSON). */
export function dumpEnterTrace(): string {
  return ['harkroom enter-trace v1', ...ring.map((e) => JSON.stringify(e))].join('\n');
}

export function clearEnterTrace(): void {
  ring.length = 0;
}

/** 꺼내는 열쇠: ⌘⌥⇧E(맥) / Ctrl+Alt+Shift+E. 글자 대신 자리(`code`)로 본다 — 한글 입력 상태에서도 된다. */
export function isEnterTraceDumpShortcut(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'code'>): boolean {
  return (e.metaKey || e.ctrlKey) && e.altKey && e.shiftKey && e.code === 'KeyE';
}
