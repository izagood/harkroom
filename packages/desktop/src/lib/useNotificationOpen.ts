import { useEffect, useRef } from 'react';
import { listenNotificationOpen, type NotificationTarget } from './notify';

/**
 * OS 알림 클릭을 앱 수명 전체에 걸쳐 듣는다(#542).
 *
 * **`App` 최상단에 있어야 한다.** 알림은 화면이 어느 단계(`boot`·`connect`·`ready`)에
 * 있든 도착하고, 리스너를 `ready` 안쪽에 두면 부팅 중에 누른 알림이 조용히 사라진다.
 *
 * 콜백을 ref 로 잡아 두는 이유: 의존성에 넣으면 매 렌더마다 리스너를 떼고 다시 붙이고,
 * 그 사이에 온 클릭이 사라진다. 리스너는 마운트당 하나여야 한다.
 *
 * 표면이 없는 환경(브라우저 개발·테스트)에서 `listenNotificationOpen` 은 던진다 —
 * 그것이 옳지만(조용히 안 듣는 상태를 만들지 않는다) **여기서 삼킨다.** 알림 클릭을
 * 못 듣는 것이 앱을 안 뜨게 할 이유는 아니다.
 */
export function useNotificationOpen(onOpen: (target: NotificationTarget) => void): void {
  const handler = useRef(onOpen);
  handler.current = onOpen;

  useEffect(() => {
    let off: (() => Promise<void>) | null = null;
    let cancelled = false;

    void listenNotificationOpen((target) => handler.current(target))
      .then((unlisten) => {
        // StrictMode 는 effect 를 한 번 정리한 뒤 다시 실행한다. 정리가 등록보다 먼저
        // 끝났다면 여기서 바로 떼어낸다 — 아니면 떼어낼 손이 없는 리스너가 남는다.
        if (cancelled) { void unlisten(); return; }
        off = unlisten;
      })
      .catch(() => { /* 이 환경에는 Tauri 이벤트 표면이 없다 */ });

    return () => {
      cancelled = true;
      if (off) void off();
    };
  }, []);
}
