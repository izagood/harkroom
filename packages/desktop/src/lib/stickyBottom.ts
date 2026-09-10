/**
 * "새 메시지가 오면 맨 아래로 따라 내려간다"를 **조건부로** 만드는 판정.
 *
 * 이 판정이 왜 필요한가(2026-09-09, jaebin 보고): 채널 화면은 `roots.length` 가 바뀔 때마다
 * 무조건 바닥 표식으로 스크롤했다. 그러면 위쪽 대화를 읽는 중에 **채널에 메시지 한 줄이
 * 생기기만 해도** 화면이 바닥으로 끌려간다. 새 발화만이 아니다 — "Remove from channel"
 * 처럼 시스템 메시지를 낳는 조작도 목록을 한 줄 늘리므로 같은 점프를 일으킨다. 사람은
 * 읽던 자리를 잃고 다시 스크롤해 올라와야 했다.
 *
 * 그래서 규칙을 "**바닥에 붙어 있을 때만** 따라 내려간다"로 좁힌다. 바닥에서 떨어져 있으면
 * 화면을 건드리지 않고, 대신 "아래로 내려가기" 버튼을 세워 **사람이 원할 때** 내려가게 한다.
 *
 * 판정을 순수 함수로 떼어 둔 이유: 스크롤 수치를 다루는 계산은 부호 하나로 뒤집히는데,
 * 컴포넌트 안에 두면 jsdom 이 레이아웃을 재지 않아 회귀선을 걸 자리가 없다.
 */

/**
 * 바닥으로 치는 여유(px). 0 이면 안 된다 — 브라우저의 `scrollTop` 은 소수이고 확대 배율·
 * 서브픽셀 때문에 바닥에 닿아도 1~2px 이 남는다. 그러면 "따라 내려가기"가 조용히 꺼진다.
 * 한 줄 높이(약 20px)보다 넉넉히 크게 잡아, 마지막 줄이 반쯤 걸친 상태도 "보고 있다"로 친다.
 */
export const NEAR_BOTTOM_PX = 64;

/** 스크롤 상자에서 이 판정이 쓰는 값만 뽑은 모양. `HTMLElement` 가 그대로 들어맞는다. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 바닥까지 남은 거리(px). 음수는 고무줄 스크롤(overscroll)이므로 0 으로 접는다. */
export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

/**
 * 지금 바닥을 보고 있는가.
 *
 * 스크롤이 아예 없는 상자(내용이 짧아 `scrollHeight === clientHeight`)도 참이다 — 거기서는
 * 바닥이 곧 화면이고, 거짓으로 치면 대화가 몇 줄뿐인 채널에서 버튼이 늘 서 있게 된다.
 * jsdom 은 세 값이 모두 0 이라 역시 참이 되는데, 그것이 옳다: 레이아웃 없는 환경의 기본은
 * 이 기능이 생기기 전과 같은 "따라 내려간다" 여야 한다.
 */
export function isNearBottom(m: ScrollMetrics, threshold: number = NEAR_BOTTOM_PX): boolean {
  return distanceFromBottom(m) <= threshold;
}

/**
 * 위쪽 끝에 닿을 만큼 올라왔는가 — **과거를 스스로 받아 올 신호**다(2026-09-10).
 *
 * 판정이 이 파일에 있는 이유는 거울상이라서다: 쓰는 값(`ScrollMetrics`)이 같고, 부호 하나로
 * 뒤집히는 계산이며, 컴포넌트 안에 두면 jsdom 이 레이아웃을 재지 않아 회귀선을 걸 자리가
 * 없다 — `isNearBottom` 이 여기 있는 이유 그대로다.
 *
 * 여유를 두는 이유: 맨 위(`scrollTop === 0`)에 정확히 닿기를 기다리면, 관성 스크롤이 0 을
 * 스치지 않고 멈춘 사람은 아무 일도 일어나지 않는 화면을 보게 된다. 한 화면의 몇 분의 일쯤
 * 남았을 때 미리 받아 오는 것이 "위로 올리면 계속 이어진다"는 감각을 만든다.
 *
 * jsdom(전부 0)은 참이다 — 그래야 회귀선이 "맨 위에 있다"를 기본값으로 쓸 수 있다.
 */
export const NEAR_TOP_PX = 240;

export function isNearTop(m: ScrollMetrics, threshold: number = NEAR_TOP_PX): boolean {
  return m.scrollTop <= threshold;
}
