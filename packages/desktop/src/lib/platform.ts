/**
 * 플랫폼 판정(#270).
 *
 * `@tauri-apps/plugin-os` 의 `platform()` 이 더 정확하지만 이 앱은 그 플러그인을 의존하지
 * 않는다 — 창 장식 여백 하나를 위해 네이티브 플러그인을 늘릴 이유가 없다. 그래서 웹뷰가 항상
 * 주는 값만 본다.
 *
 * **실패하면 false 다.** 브라우저 개발 모드(`pnpm dev` 를 크롬에서 여는 경우)나 `navigator`
 * 가 없는 테스트 환경에서 던지면 화면이 통째로 안 뜬다 — 여백 하나를 잘못 맞히는 것보다 나쁘다.
 */
export function isMacOS(): boolean {
  try {
    if (typeof navigator === 'undefined') return false;
    // `platform` 은 폐기 예정이지만 아직 모든 웹뷰가 준다. 없는 날에도 userAgent 로 답이 난다.
    const platform = navigator.platform ?? '';
    const userAgent = navigator.userAgent ?? '';
    if (/Mac|iPhone|iPad|iPod/.test(platform)) return true;
    // Windows 의 UA 에는 `Mac` 이 없지만, 일부 브라우저가 호환용으로 다른 OS 이름을 함께
    // 흘리는 경우가 있어 명시적으로 배제한다.
    return /Mac/.test(userAgent) && !/Windows/.test(userAgent);
  } catch {
    return false;
  }
}

/**
 * macOS 신호등(닫기·최소화·최대화) 3 개와 그 좌우 여백이 차지하는 폭. `titleBarStyle:
 * "Overlay"` 는 신호등을 **콘텐츠 위에** 띄우므로, 창 좌상단에 있는 바가 이만큼을 비워 두지
 * 않으면 신호등이 그 바의 내용을 덮는다.
 *
 * 전체화면에서는 신호등이 사라지지만 이 여백은 그대로 남는다 — v1 에서 받아들인다. 전체화면
 * 상태를 추적하려면 창 이벤트 구독이 필요하고, 그것은 이 작업의 범위가 아니다.
 */
export const MAC_TRAFFIC_LIGHT_PL = 'pl-[78px]';

/**
 * 신호등이 세로로 차지하는 높이(#342). 로그인 화면처럼 좌상단에 바가 없는 화면이 창 손잡이
 * 띠를 둘 때 쓴다 — OS 타이틀바가 있던 자리와 같은 높이여야 신호등이 띠 밖으로 삐져나오지
 * 않는다. `MAC_TRAFFIC_LIGHT_PL` 이 가로 여백이라면 이쪽은 세로다.
 */
export const MAC_TRAFFIC_LIGHT_H = 'h-[38px]';
