/**
 * 이 기기 오퍼레이터의 id(지금 커뮤니티) — MCP 상태를 「배정된 오퍼레이터」 기준으로 그릴 때의 근거다(MCP 설정 시안 v2 §7).
 *
 * `AgentsSettings` 의 `localOperator` 와 같은 원본(`listLocalAgents`)을 읽는다. 이름이 아니라 **오퍼레이터가 적어 둔
 * id** 로만 「이 맥」을 가린다 — 같은 이름의 기기가 둘일 수 있다.
 *
 * 돌려주는 값: id · `null`(이 빌드에 오퍼레이터 표면이 없거나 이 커뮤니티에 등록된 적 없음) · `'unknown'`(읽는 중·못 읽음).
 */
import { useEffect, useState } from 'react';
import { getController } from '../state/controller';
import { hasOperatorLocalSurface, listLocalAgents, onLocalAgentsChanged } from './operatorLocal';

export function useLocalOperatorId(): string | null | 'unknown' {
  const [id, setId] = useState<string | null | 'unknown'>('unknown');
  useEffect(() => {
    let live = true;
    const load = () => {
      if (!hasOperatorLocalSurface()) { setId(null); return; }
      const baseUrl = getController().api?.baseUrl ?? null;
      if (!baseUrl) { setId(null); return; }
      void listLocalAgents().then((r) => {
        if (!live) return;
        const c = r.communities.find((x) => x.baseUrl === baseUrl);
        setId(c?.registered && c.operatorId ? c.operatorId : null);
      }).catch(() => { if (live) setId('unknown'); });
    };
    load();
    const off = onLocalAgentsChanged(load);
    return () => { live = false; off(); };
  }, []);
  return id;
}
