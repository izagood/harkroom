/**
 * 로그인 끊김 경고(`lib/authWarnings.ts`)를 **화면 여러 곳이 같이 읽는** 자리(2026-10-15, ③-3).
 *
 * 판정은 `AttentionStack` 의 `useAuthWarnings` 한 곳에서만 돈다(계정 목록 조회·러너 종료 구독이 둘이 되지 않게).
 * 사이드바는 여기서 S2(멈춘 에이전트)만 읽어 「멈춤 · Claude 로그인 풀림」 줄과 ⚠ 버튼을 그린다.
 * 커뮤니티로 거르는 일은 읽는 쪽이 한다 — 사이드바는 지금 커뮤니티의 DM 줄에만 그리므로 섞이지 않는다.
 */
import { create } from 'zustand';
import type { AuthWarning } from '../lib/authWarnings';

export const useAuthWarningsStore = create<{ warnings: AuthWarning[] }>(() => ({ warnings: [] }));

/** 그 에이전트를 멈춘 S2 경고(다시 로그인으로 열 풀·계정이 거기 있다). 없으면 `undefined`. */
export function stoppedWarningFor(warnings: readonly AuthWarning[], agentId: string): AuthWarning | undefined {
  return warnings.find((w) => w.kind === 's2' && w.agentIds.includes(agentId));
}
