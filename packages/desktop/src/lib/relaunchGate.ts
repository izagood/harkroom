import type { AccountView } from '@harkroom/shared';

/**
 * **이 사람이 이 에이전트의 러너를 띄울 수 있는가.**
 *
 * ## 왜 `lib/` 로 나왔나 (`docs/desktop-rail.html` 3단계)
 *
 * 문서 3단계가 에이전트 칸을 얼굴 그리드로 바꾸면서 *"멈춘 것은 ▶ 로 여기서 바로 켠다"*
 * 를 요구했고, 그 순간 이 판정을 보는 화면이 **둘**이 됐다 — 설정 › 에이전트와 레일의
 * 에이전트 칸. `faceState` 가 같은 이유로 `AgentGrid` 에서 나온 그 자리다: 두 벌이 되면
 * 한쪽만 고치는 순간 같은 사람이 한 화면에서는 띄울 수 있고 다른 화면에서는 못 띄운다.
 *
 * 컴포넌트가 아니라 `lib/` 인 것은 `faceState`·`presenceView`·`threadState`·`waitChain`
 * 과 같은 규율이다 — **순수 함수는 컴포넌트 밖에 둔다.**
 *
 * ## `ownerAccountId === null` 이 '내 것'이 아닌 이유
 *
 * `#181` 이 정한 것이다(`AccountView.ownerAccountId` 주석): *"추측 소유자는 소유자가
 * 아니다."* backfill 없이 컬럼이 추가돼 **null 이 정상**이므로, null 을 '주인 없음 =
 * 아무나'로 읽으면 워크스페이스의 모든 에이전트가 모든 사람의 것이 된다. `me` 자체가
 * 없는 순간(부트스트랩 전)도 같은 판정에 든다 — 모르는 것을 허용으로 읽지 않는다.
 *
 * 서버가 최종 판정자라는 것은 그대로다. 이 술어가 정하는 것은 **화면에 문을 그릴지**이고,
 * 눌렀을 때 실제로 되는지는 서버가 답한다.
 */
export function canRelaunchAgent(
  agent: Pick<AccountView, 'ownerAccountId'>,
  me: Pick<AccountView, 'id' | 'isAdmin'> | null,
): boolean {
  if (!me) return false;
  if (me.isAdmin) return true;
  return agent.ownerAccountId !== null && agent.ownerAccountId === me.id;
}
