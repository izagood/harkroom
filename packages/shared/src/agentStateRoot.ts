/**
 * 러너(에이전트) 상태·작업 폴더의 뿌리 — 격리 C P4(설계 harkroom 스레드 456a56ce · architect seq 35548).
 *
 * | 경우 | 뿌리 |
 * |---|---|
 * | 스위치 꺼짐(지금) | `~/.harkroom-agent`(그 아래 `<인스턴스>-<agentId>/` 는 `stateDir.ts` 가 정한다) |
 * | 켜짐 · 새 커뮤니티 | `<커뮤니티 뿌리>/agents` |
 * | 켜짐 · 옛 자리 커뮤니티(D5) | `~/.harkroom-agent` 그대로 — 작업 폴더를 옮기지 않는다 |
 *
 * 스위치·커뮤니티 뿌리·옛 자리 여부는 오퍼레이터를 띄우는 쪽이 env 로 주고, 러너는 오퍼레이터의 env 를 그대로 물려받는다.
 * 켜져 있는데 뿌리를 모르면 **던진다** — 기계 하나의 자리로 물러서면 커뮤니티끼리 작업 폴더가 섞인다.
 */
import { join, resolve } from 'node:path';

/** 「옛 단일 오퍼레이터 자리를 그 커뮤니티 뿌리로 쓴다」(D5). `1` 이면 작업 폴더도 옛 자리 그대로다. */
export const OPERATOR_LEGACY_ENV = 'HARKROOM_OPERATOR_LEGACY';

export function agentStateBaseDir(defaultDir: string, env: NodeJS.ProcessEnv): string {
  if (env.HARKROOM_OPERATOR_PER_COMMUNITY !== '1') return defaultDir;
  if (env[OPERATOR_LEGACY_ENV] === '1') return defaultDir;
  const root = env.HARKROOM_OPERATOR_ROOT;
  if (!root || !root.startsWith('/')) {
    throw new Error('HARKROOM_OPERATOR_PER_COMMUNITY=1 인데 HARKROOM_OPERATOR_ROOT 가 절대 경로가 아니다 — 작업 폴더 뿌리를 정할 수 없다');
  }
  return join(resolve(root), 'agents');
}
