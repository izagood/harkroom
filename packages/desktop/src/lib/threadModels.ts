/**
 * 스레드 × 에이전트 모델 지정(서버 079)을 화면이 읽는 순수 함수들.
 *
 * 칩이 그리는 값은 **두 축이 따로**다: 모델만 정하고 effort 는 에이전트 설정을 따를 수 있다.
 * 비어 있는 축은 칩에 적지 않는다 — `opus` 만 정했으면 `opus` 다.
 */
import type { AgentModelPick, ThreadAgentModelView } from '@harkroom/shared';

export interface ModelValue {
  model: string | null;
  effort: string | null;
}

/** 칩에 적는 값. 두 축이 다 비면 null(= `기본`). */
export function formatModelValue(v: ModelValue | null | undefined): string | null {
  if (!v) return null;
  const parts = [v.model, v.effort].filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : null;
}

/** 그 스레드에서 이 에이전트의 지정. 무효(stale)여도 돌려준다 — 칩이 취소선으로 그린다. */
export function threadRowFor(
  rows: readonly ThreadAgentModelView[] | undefined, agentId: string,
): ThreadAgentModelView | null {
  return rows?.find((r) => r.agentId === agentId) ?? null;
}

/**
 * 칩 꼬리에 적을 "정한 에이전트"(087, 결정 7). 사람이 정했거나 행이 없으면 null(꼬리는 `스레드 지정`).
 * 정한 계정을 모르면(지워졌거나 목록에 없음) 빈 문자열 — 꼬리는 `에이전트 지정` 이다. 사람 지정으로
 * 떨어뜨리지 않는다: 그러면 에이전트가 올린 값을 사람이 정한 것으로 읽는다.
 */
export function setByAgentHandle(
  row: Pick<ThreadAgentModelView, 'setBy' | 'setByKind'> | null | undefined,
  accounts: Readonly<Record<string, { handle: string } | undefined>>,
): string | null {
  if (!row || row.setByKind !== 'agent') return null;
  return (row.setBy && accounts[row.setBy]?.handle) || '';
}

/**
 * 작성창 칩으로 고른 값을 보낼 모양으로. 두 축이 다 빈 것은 뺀다 — 그것은 "지정 없음" 이고,
 * 서버에 실으면 그 스레드의 지정을 **푼다**. 작성창 칩의 `기본` 은 "손대지 않음" 이지 "풀기" 가
 * 아니다(풀기는 스레드 칩의 [기본으로 되돌리기] 다).
 */
export function picksToSend(picks: Readonly<Record<string, ModelValue>>): AgentModelPick[] {
  return Object.entries(picks)
    .filter(([, v]) => v.model !== null || v.effort !== null)
    .map(([agentId, v]) => ({ agentId, model: v.model, effort: v.effort }));
}

/** ⌘⇧M 인가. 대문자 `M` 으로 오는 키보드와 `KeyM` 코드 둘 다 받는다 — ⌘M(최소화)은 아니다. */
export function isModelShortcut(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key' | 'code'>): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm');
}
