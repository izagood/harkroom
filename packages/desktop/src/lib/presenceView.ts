/**
 * 사람 옆의 점이 **무엇을 말하는가**(`#443`).
 *
 * ## 무엇이 문제였나 — 끊겼는데 초록이었다 (실측 2026-09-06, 릴리즈 `.app`)
 *
 * 서버가 죽은 그 순간 화면은 이랬다:
 *
 * ```
 * 타이틀 옆 점       🔴 빨강        ← 맞음
 * 에이전트 6개       전부 초록      ← 거짓. 실제로는 알 수 없음
 * 좌하단             "대화 가능"    ← 거짓
 * ```
 *
 * **`connected` 는 false 인데 `online` 배열이 그대로 남아 있었다.** 그 배열은 소켓이 마지막
 * 으로 살아 있을 때 서버가 준 값이고, 끊긴 뒤로는 **아무도 갱신하지 않는다** —
 * `controller.ts::handleDown` 은 `connected` 만 내리고 `online` 은 손대지 않는다.
 * 그것이 옳다(비우면 "전원 오프라인"이라는 또 다른 거짓말이 된다). 문제는 **화면이 그
 * 낡은 배열을 지금 사실처럼 그렸다**는 것이다.
 *
 * ## 왜 회색(오프라인)으로도 두지 않는가
 *
 * 끊긴 동안 러너들은 대개 멀쩡히 돌고 있다. 40개를 전부 회색으로 가라앉히면 사람은
 * 죽지 않은 것을 죽었다고 읽고 되살리려 한다 — **초록의 정반대 방향으로 같은 거짓말**이다.
 *
 * 그래서 값이 셋이다. **`unknown` 이 이 이슈가 만든 것이다.**
 *
 * ## 왜 `connected` 하나로 갈리는가 — 서버만이 presence 를 안다
 *
 * presence 는 **서버가 주는 것**이다(`presence.snapshot`·`presence.changed`). 서버와의
 * 소켓이 끊기면 그 값은 즉시 낡은 것이 되고, 얼마나 낡았는지조차 앱은 모른다.
 * `connected` 가 그 유일한 문지기다.
 *
 * 이 규약은 이미 저장소 안에 있었다 — `threadState.ts::Liveness`, `controller.ts::
 * startRunners` 의 `liveAccountIds`, `MessageItem`·`ThreadPanel`·`Profile`·
 * `SidebarWaitChain` 이 전부 `connected ? new Set(online) : null` 로 쓴다.
 * **점을 그리는 자리들만 그 규약 밖에 있었다.** 이 모듈은 새 규칙을 만드는 것이 아니라
 * 이미 있던 규칙을 점에까지 이어 붙인다.
 */

/**
 * 점 하나가 말할 수 있는 것.
 *
 * - `online`   서버가 지금 붙어 있다고 했다
 * - `offline`  서버가 지금 안 붙어 있다고 했다
 * - `unknown`  **서버와 끊겨 물어볼 수 없다** — 마지막으로 들은 값은 낡았다
 */
export type PresenceView = 'online' | 'offline' | 'unknown';

/** 화면에 쓰는 이름. 세 자리(사이드바·디렉터리·에이전트 격자)가 같은 말을 쓴다. */
export const PRESENCE_LABEL: Record<PresenceView, string> = {
  online: '온라인',
  offline: '오프라인',
  // **"오프라인"이라고 쓰지 않는다.** 그것은 아는 척이다 — 사람이 할 일은
  // 러너를 되살리는 것이 아니라 연결이 돌아오기를 기다리는 것이다.
  unknown: '연결 끊김 — 알 수 없음',
};

/**
 * 점 색. `unknown` 은 **초록도 회색도 아니다.**
 *
 * `bg-fg-subtle`(오프라인)과 갈라 두는 이유: 두 값이 같은 색이면 타입만 셋이고 화면은
 * 여전히 둘이다 — 사람 눈에는 이 이슈가 안 고쳐진 것이다. 그래서 테두리만 있는 빈 점으로
 * 그린다(색이 아니라 **모양**이 다르다: 채워지지 않은 것은 "값이 없다"로 읽힌다).
 *
 * **강조(`accent`)를 쓰지 않는다**(`#443` 코멘트, `#445` 의 유일성). 연결이 끊긴 것은
 * 타이틀 옆 빨간 점이 이미 불러 세우고 있고, 이 점들은 그 사실의 파생이다.
 * 같은 사실로 화면을 두 번 붙잡을 이유가 없다.
 */
export const PRESENCE_DOT_CLASS: Record<PresenceView, string> = {
  online: 'bg-success',
  offline: 'bg-fg-subtle',
  unknown: 'border border-fg-subtle bg-transparent',
};

/**
 * 이 계정의 점이 무엇을 말해야 하는가.
 *
 * **순수 함수다** — 판정이 컴포넌트 안에 흩어지면 한 자리만 고치는 사고가 나고,
 * 그 사고가 정확히 이 이슈다(다른 다섯 자리는 `connected` 를 이미 보고 있었는데
 * 점을 그리는 세 자리만 안 봤다).
 */
export function presenceView(
  accountId: string,
  online: readonly string[],
  connected: boolean,
): PresenceView {
  // **끊겼으면 `online` 을 읽지도 않는다.** 읽는 순간 낡은 값에 판정이 걸린다.
  if (!connected) return 'unknown';
  return online.includes(accountId) ? 'online' : 'offline';
}

/**
 * 여러 계정 중 **하나라도** 붙어 있는가(DM 상대가 여럿인 그룹 DM).
 *
 * `some` 을 그대로 쓰지 않는 이유: 끊긴 상태에서 `some` 은 낡은 배열 위에서 돌고
 * 그 결과가 `true` 면 초록이 된다 — 이 이슈의 그 자리다.
 */
export function anyPresenceView(
  accountIds: readonly string[],
  online: readonly string[],
  connected: boolean,
): PresenceView {
  if (!connected) return 'unknown';
  return accountIds.some((id) => online.includes(id)) ? 'online' : 'offline';
}
