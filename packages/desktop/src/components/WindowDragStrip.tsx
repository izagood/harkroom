import { isMacOS, MAC_TRAFFIC_LIGHT_H } from '../lib/platform';

/**
 * 창을 옮기는 손잡이만 하는 띠(#342).
 *
 * `#270` 이 macOS 에서 OS 타이틀바를 없앴다. 그런데 **창 설정은 앱 전역**이다 —
 * `titleBarStyle: "Overlay"` 는 특정 화면이 아니라 창 하나에 걸리므로 타이틀바는 모든
 * 화면에서 사라졌는데, 대체 손잡이는 `Workspace`(헤더·사이드바 브랜드 바)에만 생겼다.
 * 그래서 로그인 전(`boot`·`connect`)에는 창을 옮길 수단이 하나도 없었다.
 *
 * **화면마다 손잡이를 붙이지 않고 이 띠 하나를 공유한다.** 화면이 늘어날 때마다 붙이는 것을
 * 잊는 구조가 #342 의 원인 그 자체였다.
 *
 * 왜 배경 전체가 아니라 띠인가: 로그인 폼은 화면 정중앙이라 바깥 여백이 넓다. 그 전체를
 * 손잡이로 두면 폼 옆 아무 데나 눌러도 창이 끌려, 텍스트를 긁으려던 드래그가 창 이동이 된다.
 * OS 타이틀바가 있던 자리와 같은 위치·같은 높이로 좁힌다.
 *
 * macOS 가 아니면 **아무것도 그리지 않는다**. 다른 플랫폼은 OS 장식이 그대로 있어(#270:
 * `decorations` 를 끄지 않는다) 이 띠가 없어도 창이 끌리고, 두면 빈 줄만 하나 는다.
 */
export function WindowDragStrip() {
  if (!isMacOS()) return null;
  return (
    <div
      data-testid="window-drag-strip"
      data-tauri-drag-region
      // `shrink-0`: 아래 형제가 `h-screen`·`flex-1` 이면 이 띠가 눌려 높이 0 이 된다 —
      // 그러면 요소는 있는데 잡히지 않는, 고치기 전과 같은 상태가 된다.
      className={`shrink-0 ${MAC_TRAFFIC_LIGHT_H}`}
    />
  );
}
