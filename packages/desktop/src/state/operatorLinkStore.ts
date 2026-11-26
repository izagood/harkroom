/**
 * 이 맥 오퍼레이터 ↔ 서버 링크 경고(안 A)를 **화면 여러 곳이 같이 읽는** 자리. 판정은 `AttentionStack` 의
 * `useOperatorLinkWatch` 한 곳에서만 돈다. 격자 칩·사이드바 줄은 여기서 단계와 「이 맥의 에이전트」만 읽는다.
 * 칩을 누르면 `focusSeq` 가 올라가고 카드가 접혀 있었으면 다시 펴서 초점을 받는다.
 */
import { create } from 'zustand';
import type { LinkPhase } from '../lib/operatorLink';

export const useOperatorLinkStore = create<{
  phase: LinkPhase;
  /** 지금 커뮤니티에서 이 맥 오퍼레이터가 맡은 에이전트 id. */
  localAgentIds: readonly string[];
  focusSeq: number;
}>(() => ({ phase: 'ok', localAgentIds: [], focusSeq: 0 }));

/** 그 에이전트에 붙일 링크 단계 — 이 맥 것이 아니면 'ok'(다른 기기 에이전트 칩을 섞지 않는다). */
export function linkPhaseFor(state: { phase: LinkPhase; localAgentIds: readonly string[] }, agentId: string | null | undefined): LinkPhase {
  if (!agentId || state.phase === 'ok') return 'ok';
  return state.localAgentIds.includes(agentId) ? state.phase : 'ok';
}

/** 빨간 칩 → 카드로. */
export function focusOperatorLinkCard(): void {
  useOperatorLinkStore.setState((s) => ({ focusSeq: s.focusSeq + 1 }));
}
