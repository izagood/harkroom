/**
 * 독(Dock)·작업 표시줄 배지의 단일 표면.
 *
 * `notify.ts` 와 같은 모양이다: 실제 호출을 인터페이스 뒤에 두고, 표면이 없는 환경
 * (브라우저 dev·테스트)에서는 조용히 아무것도 하지 않는다. **무엇을 셀지는 여기서 정하지
 * 않는다** — 그 판단은 `useDockBadge` 와 `state/unread.ts` 에 있고 테스트된다.
 */

/**
 * 독에 그릴 것. 두 신호를 그대로 옮긴다(`state/unread.ts` 주석) —
 * 숫자는 "나를 불렀다", 점은 "새 대화가 있다".
 */
export interface Badge {
  /** 안 읽은 멘션·DM 개수. 0 이면 숫자를 그리지 않는다. */
  count: number;
  /** 숫자는 없지만 안 읽은 대화가 있는가. */
  dot: boolean;
}

export interface Badger {
  set(badge: Badge): Promise<void>;
}

/**
 * 배지를 세우는 Tauri 코어 커맨드. **창이 아니라 앱 전체**에 붙는다(Tauri 문서:
 * *"It is app wide and not specific to this window"*) — 그래서 창 목록을 돌지 않고
 * 현재 창 하나로 부른다.
 *
 * 권한은 `src-tauri/capabilities/default.json` 의 `core:window:allow-set-badge-count` ·
 * `core:window:allow-set-badge-label` 이다. `core:default` 에는 들어 있지 않아서 명시로
 * 열어야 한다 — 빠지면 호출이 권한 오류로 거절되고, 아래 `catch` 가 그것을 삼켜 배지가
 * 조용히 사라진다.
 */
export const BADGE_COUNT_COMMAND = 'plugin:window|set_badge_count';
/** macOS 전용 커맨드. 숫자 없이 점만 찍는 유일한 경로다 — 다른 OS 에서는 그냥 실패한다. */
export const BADGE_LABEL_COMMAND = 'plugin:window|set_badge_label';

/**
 * 점으로 쓰는 글자. macOS 의 배지는 라벨(문자열)이므로 점도 글자로 그린다.
 * 사이드바의 회색 점과 같은 뜻이고, 크기·색은 OS 가 정한다(빨간 알약 안의 흰 점).
 */
export const BADGE_DOT_LABEL = '●';

/** 아무것도 하지 않는 배지기. 브라우저 dev 모드와 테스트 기본값. */
export const silentBadger: Badger = {
  async set() { /* 이 환경에는 독 배지 표면이 없다 */ },
};

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface Internals {
  invoke?: Invoke;
  metadata?: { currentWindow?: { label?: string } };
}

function internals(): Internals | undefined {
  return (globalThis as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__;
}

/**
 * `@tauri-apps/api` 를 의존으로 들이지 않고 `__TAURI_INTERNALS__` 를 직접 쓴다 —
 * `lib/notify.ts` · `lib/runnerLauncher.ts` 가 이미 이 규칙이고, 배지 하나 때문에
 * 깨면 Tauri 를 만지는 표면이 둘로 갈린다.
 */
function tauriInvoke(): Invoke | null {
  const invoke = internals()?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

/**
 * 커맨드가 요구하는 창 라벨. `@tauri-apps/api` 의 `getCurrentWindow()` 가 읽는 자리와
 * 같은 곳을 읽는다. 없으면 `main` 으로 떨어진다 — `tauri.conf.json` 의 창이 그것이고,
 * 권한(capabilities)도 그 라벨에만 열려 있다.
 */
function windowLabel(): string {
  return internals()?.metadata?.currentWindow?.label ?? 'main';
}

/**
 * Tauri 가 있으면 배지를 세우고, 없으면 조용히 넘긴다.
 *
 * **같은 값을 두 번 쓰지 않는다.** 이 함수를 부르는 쪽은 스토어 구독이라 미읽음과 무관한
 * 변화(타이핑·프레즌스)에도 깨어난다 — 그때마다 IPC 를 두 번 왕복하면 채팅 한 번에 수십
 * 번이 된다. 마지막으로 실제로 적용한 값을 기억해 달라진 때만 부른다.
 */
export function createBadger(): Badger {
  let applied: Badge | null = null;

  return {
    async set(badge) {
      if (applied && applied.count === badge.count && applied.dot === badge.dot) return;
      const invoke = tauriInvoke();
      if (!invoke) return;
      const label = windowLabel();
      applied = { ...badge };
      try {
        // 순서가 있다: 숫자를 먼저 정리하고 점을 얹는다. 둘은 macOS 에서 **같은 자리**를
        // 쓰므로(dock tile 의 badgeLabel), 지우는 쪽을 나중에 부르면 방금 세운 것을
        // 자기가 지운다.
        await invoke(BADGE_COUNT_COMMAND, { label, value: badge.count > 0 ? badge.count : null });
        if (badge.count === 0) {
          await invoke(BADGE_LABEL_COMMAND, { label, value: badge.dot ? BADGE_DOT_LABEL : null });
        }
      } catch {
        // 커맨드 부재(구버전 번들)·권한 거부·macOS 아닌 OS 의 라벨 커맨드 —
        // 배지는 부가 표시라 앱을 막지 않는다. 다음 변화에서 다시 시도된다.
        applied = null;
      }
    },
  };
}
