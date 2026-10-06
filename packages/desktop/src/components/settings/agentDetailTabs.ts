/**
 * 에이전트 상세의 탭(designer 안 A2, 스레드 c4f4dab4). 덩어리 13개가 한 줄로 쌓여 화면 일곱 개를
 * 내려야 끝이 보이던 것을 다섯 탭으로 나눈다. 칸은 옮기기만 했고 동작·testid 는 그대로다.
 *
 * 순서가 곧 화면의 탭 순서다. 개요가 맨 앞인 이유: 상세를 연 사람이 먼저 묻는 것은
 * "지금 돌고 있나"이고, 되돌릴 수 없는 조작(사용 중지·삭제)은 그 탭 **맨 끝**에 둔다.
 */
export const AGENT_DETAIL_TABS = ['overview', 'profile', 'run', 'permissions', 'memory'] as const;
export type AgentDetailTab = (typeof AGENT_DETAIL_TABS)[number];

const isTab = (s: string): s is AgentDetailTab => (AGENT_DETAIL_TABS as readonly string[]).includes(s);

/**
 * 설정을 여는 `targetId` 는 `<에이전트 id>` 또는 `<에이전트 id>#<탭>` 이다 — 다른 화면이
 * "이 에이전트의 기억 탭"처럼 바로 열 수 있게 한다. 모르는 탭 이름은 버리고 개요로 연다
 * (오래된 링크가 화면을 빈 탭으로 열지 않게).
 */
export function parseAgentTarget(targetId: string): { agentId: string; tab: AgentDetailTab | null } {
  const at = targetId.indexOf('#');
  if (at < 0) return { agentId: targetId, tab: null };
  const tab = targetId.slice(at + 1);
  return { agentId: targetId.slice(0, at), tab: isTab(tab) ? tab : null };
}
