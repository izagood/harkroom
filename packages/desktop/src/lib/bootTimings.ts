/**
 * 콜드 스타트 구간 기록(0단계 계측, 2026-10-06).
 *
 * 재시작 → 첫 채널 메시지가 보이기까지를 구간별로 재려고 둔다. 각 지점은 **이 프로세스에서
 * 한 번만** 찍힌다 — 두 번째 커뮤니티의 기동이나 재접속이 같은 이름을 다시 찍으면 "첫 화면"
 * 의 숫자가 덮인다.
 *
 * 값은 두 곳에 남는다.
 * - `performance.mark('harkroom:boot:<이름>')` — 개발 빌드의 개발자 도구 Performance 탭.
 * - `localStorage['harkroom.bootTimings']` — 릴리스 번들에는 개발자 도구가 없어서, 재시작
 *   한 번 뒤 이 값을 WebKit 의 localStorage 파일에서 읽는다(읽는 법은 그 PR 본문).
 *   담는 것은 지점 이름과 밀리초뿐이다 — 채널 id·본문 같은 내용은 싣지 않는다.
 *
 * 밀리초는 `performance.now()`(웹뷰 문서가 시작한 때부터)다. 앱 프로세스 기동부터 웹뷰
 * 시작까지는 이 값에 없다.
 */

export type BootMark =
  | 'boot'
  | 'keychain:start'
  | 'keychain:done'
  | 'start:request'
  | 'start:done'
  | 'ready'
  | 'ws:open'
  | 'messages:request'
  | 'messages:response'
  | 'messages:applied'
  | 'first-message-paint';

export const BOOT_TIMINGS_KEY = 'harkroom.bootTimings';
const MARK_PREFIX = 'harkroom:boot:';

export interface BootTimings {
  /** 이 기동의 벽시계 시각(ISO). 여러 번 재시작했을 때 어느 판인지 가리는 용도다. */
  at: string;
  /** 지점 이름 → `performance.now()` 밀리초(정수). */
  marks: Partial<Record<BootMark, number>>;
}

let current: BootTimings | null = null;

function now(): number {
  try { return performance.now(); } catch { return 0; }
}

/** 지점을 찍는다. 이미 찍힌 이름은 무시한다. */
export function markBoot(name: BootMark): void {
  if (!current) current = { at: new Date().toISOString(), marks: {} };
  if (current.marks[name] !== undefined) return;
  current.marks[name] = Math.round(now());
  try { performance.mark(MARK_PREFIX + name); } catch { /* 계측이 앱을 멈추게 하지 않는다 */ }
  try { localStorage.setItem(BOOT_TIMINGS_KEY, JSON.stringify(current)); } catch { /* 저장 불가 환경 허용 */ }
}

/**
 * 첫 메시지 줄이 **그려진 뒤**를 찍는다. 렌더 커밋 직후(effect)에서 부르고, 두 프레임을
 * 넘겨 브라우저가 실제로 칠한 다음을 근사한다.
 */
export function markFirstMessagePaint(): void {
  if (current?.marks['first-message-paint'] !== undefined) return;
  const raf = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (cb: () => void) => setTimeout(cb, 0);
  raf(() => raf(() => markBoot('first-message-paint')));
}

/** 시험 이음새 — 모듈 상태를 비운다. */
export function resetBootTimingsForTest(): void {
  current = null;
}

export function readBootTimings(): BootTimings | null {
  return current;
}
