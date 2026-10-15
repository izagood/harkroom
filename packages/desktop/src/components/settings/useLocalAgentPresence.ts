/**
 * 이 맥 오퍼레이터 설정에서 **이 에이전트가 있는가**(풀 ↔ 이 맥 배정, `lib/poolGate.ts`).
 *
 * `LocalOperatorRow`(「이 머신」 체크)와 같은 원본(`listLocalAgents`)을 읽고, 한쪽에서 바꾸면
 * `onLocalAgentsChanged` 로 다시 읽는다 — 체크를 켜면 풀 칸의 잠금이 새로고침 없이 풀린다.
 *
 * 돌려주는 값: 읽은 사실, 못 읽었으면(또는 읽는 중) `'unknown'`. **읽는 중도 모름이다** — 그동안 잠그면
 * 화면이 열릴 때마다 잠깐 잠겼다 풀린다.
 */
import { useCallback, useEffect, useState } from 'react';

import { getController } from '../../state/controller';
import { hasOperatorLocalSurface, listLocalAgents, onLocalAgentsChanged } from '../../lib/operatorLocal';
import type { LocalOperatorFacts } from '../../lib/poolGate';

export function useLocalAgentPresence(agentId: string | null): LocalOperatorFacts | 'unknown' {
  const [facts, setFacts] = useState<LocalOperatorFacts | 'unknown'>('unknown');
  const available = hasOperatorLocalSurface();
  const load = useCallback(() => {
    const baseUrl = getController().api?.baseUrl ?? null;
    if (!available || !baseUrl || !agentId) { setFacts('unknown'); return; }
    let live = true;
    void listLocalAgents().then((r) => {
      if (!live) return;
      const c = r.communities.find((x) => x.baseUrl === baseUrl);
      setFacts({
        operatorId: c?.registered && c.operatorId ? c.operatorId : null,
        present: c?.agents[agentId] !== undefined,
      });
    }).catch(() => { if (live) setFacts('unknown'); });
    return () => { live = false; };
  }, [available, agentId]);
  useEffect(() => {
    setFacts('unknown');
    const stop = load();
    const off = onLocalAgentsChanged(() => { load(); });
    return () => { stop?.(); off(); };
  }, [load]);
  return facts;
}
