// OS 알림의 단일 표면. 무엇을·언제 알릴지 판단하는 로직은 Controller 에 있고 테스트된다.
// 여기는 그 판단을 OS 로 내보내고, 사용자가 그 알림을 누른 것을 되받는 자리다.

/**
 * 알림이 가리키는 곳(#542). 눌렀을 때 갈 곳을 알림 자신이 들고 있어야 한다 —
 * 제목의 `#general` 은 사람에게 읽히는 문자열이고, 거기서 채널을 되짚는 것은 같은 이름의
 * 채널이 커뮤니티마다 있는 순간 틀린다.
 *
 * `messageId` 하나로 채널·스레드·강조가 다 따라온다(`controller.openMessage`).
 * `communityId` 가 그 위에 따로 필요한 이유: 알림은 **보고 있지 않은 커뮤니티**에서도
 * 오고, 메시지 id 만으로는 어느 서버에 물어볼지 정할 수 없다.
 *
 * 이 id 는 `state/communities` 의 지역 id(`community-N`)다 — 서버는 모르고 재기동하면
 * 바뀐다. 알림 클릭은 알림을 띄운 **그 프로세스**로 돌아오므로 그것으로 충분하다.
 */
export interface NotificationTarget { communityId: string; messageId: string }

export interface Notification { title: string; body: string; target?: NotificationTarget }

export interface Notifier {
  notify(n: Notification): Promise<void>;
}

/**
 * 알림을 내보내는 Rust 커맨드(`src-tauri/src/notification.rs`).
 *
 * **`tauri-plugin-notification` 의 JS `sendNotification` 을 쓰지 않는다.** 그 플러그인의
 * 데스크탑 구현(`desktop.rs`)은 `title/body/icon/sound` 만 `notify_rust` 로 넘기고
 * `extra`·`actionTypeId` 를 버린다. 그리고 JS `onAction()` 이 듣는 `actionPerformed` 를
 * 발신하는 코드는 `mobile.rs` 에만 있다 — macOS 에서는 리스너를 붙여도 영원히 울리지 않는다.
 * 목적지를 실어 보내고 클릭을 되받으려면 발신 자체를 우리 커맨드로 가져와야 했다.
 */
export const NOTIFY_COMMAND = 'notification_send';

/** 사용자가 알림을 눌렀을 때 Rust 가 쏘는 이벤트. 커맨드와 한 쌍이다. */
export const NOTIFICATION_OPEN_EVENT = 'notification://open';

/** 아무것도 하지 않는 알림기. 브라우저 dev 모드와 테스트 기본값. */
export const silentNotifier: Notifier = {
  async notify() { /* 이 환경에는 OS 알림 표면이 없다 */ },
};

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * `@tauri-apps/api` 를 의존으로 들이지 않고 `__TAURI_INTERNALS__` 를 직접 쓴다 —
 * `lib/runnerLauncher.ts` 가 키체인·프로세스·이벤트 표면에 이미 이 규칙을 두고 있고,
 * 알림 하나 때문에 그것을 깨면 Tauri 를 만지는 표면이 둘로 갈린다.
 */
function tauriInvoke(): Invoke | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function' ? internals.invoke : null;
}

/** Tauri 가 있으면 커맨드로 보내고, 없으면 조용히 넘긴다. */
export function createNotifier(): Notifier {
  return {
    async notify(n) {
      const invoke = tauriInvoke();
      if (!invoke) return;
      try {
        // 목적지가 없는 알림도 성립한다. 자리를 **비우지 않고** 명시적 `null` 로 넘긴다 —
        // 옵셔널로 흘리면 Rust 쪽 서명이 "없음" 과 "안 보냄" 을 구분할 수 없다.
        await invoke(NOTIFY_COMMAND, { title: n.title, body: n.body, target: n.target ?? null });
      } catch {
        // 커맨드 부재(구버전 번들)나 OS 거부 — 알림은 부가 기능이라 앱을 막지 않는다.
      }
    },
  };
}

/** 목적지 모양인지 확인한다. Rust 에서 온 payload 를 그대로 믿지 않는다. */
function asTarget(value: unknown): NotificationTarget | null {
  const t = value as Partial<NotificationTarget> | null | undefined;
  return t && typeof t.communityId === 'string' && typeof t.messageId === 'string'
    ? { communityId: t.communityId, messageId: t.messageId }
    : null;
}

/**
 * 알림 클릭을 듣는다. 떼어내는 함수를 돌려준다.
 *
 * 표면이 없으면 **던진다** — 조용히 안 듣는 상태로 두면 "알림을 눌렀는데 아무 일도 안 난다"
 * 는 지금 고치는 그 증상이 그대로 되돌아오고, 그때는 이유가 어디에도 남지 않는다.
 * (`listenRunnerExit` 이 같은 이유로 같은 선택을 한다.)
 */
export async function listenNotificationOpen(
  handler: (target: NotificationTarget) => void,
): Promise<() => Promise<void>> {
  const invoke = tauriInvoke();
  const internals = (globalThis as {
    __TAURI_INTERNALS__?: { transformCallback?: (cb: (payload: unknown) => void) => number };
  }).__TAURI_INTERNALS__;
  if (!invoke || typeof internals?.transformCallback !== 'function') {
    throw new Error('이 환경에는 Tauri 이벤트 표면이 없다 — 알림 클릭을 들을 수 없다');
  }
  const handlerId = internals.transformCallback((payload) => {
    const target = asTarget((payload as { payload?: unknown } | null)?.payload);
    if (target) handler(target);
  });
  const eventId = await invoke('plugin:event|listen', {
    event: NOTIFICATION_OPEN_EVENT,
    target: { kind: 'Any' },
    handler: handlerId,
  });
  return async () => {
    await invoke('plugin:event|unlisten', { event: NOTIFICATION_OPEN_EVENT, eventId });
  };
}
