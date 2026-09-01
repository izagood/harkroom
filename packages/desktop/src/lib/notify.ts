// OS 알림의 단일 표면. Tauri v2 는 웹 Notification API 대신 플러그인을 쓰고, 브라우저 dev
// 모드에는 그 플러그인이 없다 — 그래서 실제 전송을 이 인터페이스 뒤에 두고, 쓸 수 없는 환경에서는
// 조용히 아무것도 하지 않는다. 무엇을·언제 알릴지 판단하는 로직은 Controller 에 있고 테스트된다.
export interface Notification { title: string; body: string }

export interface Notifier {
  notify(n: Notification): Promise<void>;
}

/** 아무것도 하지 않는 알림기. 브라우저 dev 모드와 테스트 기본값. */
export const silentNotifier: Notifier = {
  async notify() { /* 이 환경에는 OS 알림 표면이 없다 */ },
};

type TauriNotificationPlugin = {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<'granted' | 'denied' | 'default'>;
  sendNotification(n: Notification): void;
};

/** Tauri 플러그인이 있으면 그것으로, 없으면 조용히 넘긴다. 권한은 첫 알림 때 한 번만 묻는다. */
export function createNotifier(): Notifier {
  let plugin: TauriNotificationPlugin | null | undefined;
  let allowed: boolean | undefined;

  return {
    async notify(n) {
      try {
        plugin ??= (await import('@tauri-apps/plugin-notification')) as unknown as TauriNotificationPlugin;
        if (!plugin) return;
        allowed ??= (await plugin.isPermissionGranted()) || (await plugin.requestPermission()) === 'granted';
        if (!allowed) return;
        plugin.sendNotification(n);
      } catch {
        // 플러그인 부재(브라우저 dev)나 권한 거부 — 알림은 부가 기능이라 앱을 막지 않는다.
        plugin = null;
      }
    },
  };
}
