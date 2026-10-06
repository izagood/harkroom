/**
 * 그림 보기(라이트박스) 배율 셈 — designer 사양 3192efed(2026-10-02). 화면 없이 시험으로 고정한다.
 *
 * 왜: 예전 라이트박스는 그림을 `max-h-[80vh] object-contain` 한 장으로 그렸다. 세로로 긴 캡처(HTML 시안 전체)는
 * 높이 80vh 에 맞춰 줄어 폭이 수십 px 가 됐고 확대할 길이 없었다(jaebin "확대도 안되고 엄청 작게 보여").
 * 그래서 처음 배율을 **폭 맞춤**(높이는 보지 않는다)으로 두고, 단계·연속 확대를 둔다.
 */

/** ⌘+/⌘− 와 [+]/[−] 가 밟는 단계. 맞춤 값은 그 사이에 끼운다. */
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
export const ZOOM_MAX = 4;
const ZOOM_FLOOR = 0.25;

/** 처음 배율 = min(1, 본문 칸 폭 ÷ 그림 폭). 작은 그림은 키우지 않는다. 폭을 모르면 1. */
export function fitScale(viewWidth: number, imageWidth: number): number {
  if (!(viewWidth > 0) || !(imageWidth > 0)) return 1;
  return Math.min(1, viewWidth / imageWidth);
}

/** 범위: 최소 min(맞춤, 25%), 최대 400%. */
export function clampScale(scale: number, fit: number): number {
  return Math.min(ZOOM_MAX, Math.max(Math.min(fit, ZOOM_FLOOR), scale));
}

/** 단계 목록에 맞춤 값을 끼운 것(겹치면 하나). */
function stepsWith(fit: number): number[] {
  const all = [...ZOOM_STEPS, fit].map((v) => Math.round(v * 1000) / 1000);
  return [...new Set(all)].sort((a, b) => a - b).filter((v) => v >= Math.min(fit, ZOOM_FLOOR) && v <= ZOOM_MAX);
}

/** 다음 단계(+). 지금 값보다 큰 첫 단계. 이미 끝이면 그대로. */
export function stepUp(scale: number, fit: number): number {
  const s = Math.round(scale * 1000) / 1000;
  return stepsWith(fit).find((v) => v > s + 1e-6) ?? clampScale(scale, fit);
}

/** 앞 단계(−). 지금 값보다 작은 마지막 단계. */
export function stepDown(scale: number, fit: number): number {
  const s = Math.round(scale * 1000) / 1000;
  const smaller = stepsWith(fit).filter((v) => v < s - 1e-6);
  return smaller.length ? smaller[smaller.length - 1]! : clampScale(scale, fit);
}

/**
 * 배율을 바꿀 때 **한 점을 그 자리에 둔다** — 커서(핀치·클릭) 아래의 그림 점이 바꾼 뒤에도 커서 아래에 있게
 * 스크롤 위치를 다시 셈한다. `offset` 은 본문 칸 안에서의 커서 위치(px), `scroll` 은 지금 스크롤 위치.
 */
export function scrollToKeep(scroll: number, offset: number, from: number, to: number): number {
  if (!(from > 0)) return scroll;
  return Math.max(0, ((scroll + offset) / from) * to - offset);
}

/** 트랙패드 핀치(ctrl+휠)의 한 번 움직임 → 배율 곱. deltaY 가 음수면 키운다. */
export function pinchFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.01);
}

/** 화면에 보일 배율 글자. */
export function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
