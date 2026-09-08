import type { AccountView } from '@murmur/shared';

/**
 * **이 사람이 이 에이전트의 설정을 볼 수 있는가.**
 *
 * ## 왜 `lib/` 로 나왔나
 *
 * 같은 판정이 **세 자리**에 각각 적혀 있었다 — 프로필의 `canSeeConfig`, 계정을 눌렀을 때
 * 갈 곳을 정하는 `accountOpen`(멘션 칩·이름줄·아바타가 그것을 쓴다), 그리고 이제 레일의
 * 에이전트 격자. 세 자리가 같은 문(설정 › 에이전트 · `targetId`)을 여는데 판정이 세 벌이면,
 * 한쪽만 고치는 순간 같은 사람이 멘션으로는 설정에 가고 격자로는 못 간다.
 * `relaunchGate`·`faceState` 가 나온 것과 같은 규율이다: **순수 함수는 컴포넌트 밖에 둔다.**
 *
 * `accountOpen` 과 나뉘어 있는 이유: 그쪽은 **어디로 가는가**(동작 + 접근 가능한 이름)이고
 * 이쪽은 **볼 수 있는가**다. 프로필처럼 갈 곳이 아니라 버튼을 그릴지만 묻는 자리가 있으므로
 * 술어가 따로 필요하고, `accountOpen` 은 그 술어를 **불러서 쓴다**(두 벌이 아니다).
 *
 * ## 이 판정이 `canRelaunchAgent` 와 값이 같은데도 따로 있는 이유
 *
 * 지금은 둘 다 "관리자이거나 소유자"다. 그래도 한 함수로 합치지 않는다 — 답하는 물음이
 * 다르다: 저쪽은 *"러너를 띄울 수 있는가"*, 이쪽은 *"설정 화면을 열 수 있는가"* 이고,
 * 각자 서버의 다른 라우트(`POST /accounts/agents/:id/runner-pat` ·
 * `GET /accounts/agents`)와 짝이 맞아야 한다. 한쪽 라우트의 권한이 바뀌는 날
 * 합쳐 둔 술어는 **아무 표시 없이** 다른 화면의 문까지 함께 여닫는다.
 *
 * ## `ownerAccountId === null` 이 '내 것'이 아니다
 *
 * `#181` 이 정한 것을 그대로 따른다(`AccountView.ownerAccountId` 주석):
 * *"추측 소유자는 소유자가 아니다."* backfill 없이 컬럼이 추가돼 **null 이 정상**이므로,
 * null 을 '주인 없음 = 아무나'로 읽으면 워크스페이스의 모든 에이전트가 모든 사람의 것이 된다.
 *
 * 서버가 최종 판정자라는 것은 그대로다 — 이 술어가 정하는 것은 **화면에 문을 그릴지**다.
 */
export function canSeeAgentConfig(
  account: Pick<AccountView, 'kind' | 'ownerAccountId'> | null | undefined,
  /**
   * 보고 있는 사람. `id: null` 을 받는 이유는 `accountOpen.Viewer` 가 그 모양이기 때문이다
   * (부트스트랩 전에는 내가 누구인지 모른다) — **모르는 것은 허용으로 읽지 않는다.**
   */
  me: { id: string | null; isAdmin: boolean } | null | undefined,
): boolean {
  if (!account || account.kind !== 'agent') return false;
  if (!me) return false;
  if (me.isAdmin) return true;
  return account.ownerAccountId !== null && account.ownerAccountId === me.id;
}
