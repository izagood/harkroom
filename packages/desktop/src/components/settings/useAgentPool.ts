/**
 * 에이전트 하나의 **계정 풀 배정**을 읽고 쓴다.
 *
 * ## 왜 훅으로 뺐나
 *
 * `AgentsSettings.tsx` 는 이미 1500 줄이다. 여기 인라인으로 넣으면 그 파일이 계정 풀의
 * 스냅샷 모양·표면 부재 판정·쓰기 경로까지 알게 되고, 그 셋은 이 파일 하나가 알면 되는
 * 것들이다.
 *
 * ## 이 값은 서버로 가지 않는다
 *
 * 풀은 **이 기기에만 존재하는 자원**이다 — 계정 디렉터리와 그 안의 자격증명이고, 같은
 * murmur 에이전트를 다른 기기에서 띄우면 그 기기에는 그 풀이 없다. 배정을 서버에 두면 그
 * 순간 **없는 풀을 가리키는 설정**이 다른 기기로 전파된다.
 *
 * 저장소에 같은 판례가 있다(설정 화면): *"설정값은 기기 로컬이 의미론적으로 맞다 — '이
 * 기기에서 알림 울릴까'는 계정이 아니라 기기의 속성이고, 다기기 세션이 있는 이상 서버에
 * 두면 노트북에서 끈 게 데스크탑에서도 꺼진다."*
 *
 * 그래서 이 값은 `AgentConfig` 의 다른 필드들과 **저장 경로가 다르다.** 에이전트 저장
 * 버튼을 거치지 않고 고르는 즉시 쓴다 — 같은 버튼에 묶으면 서버 PATCH 에 이 값이 실려
 * 가거나, 반대로 저장을 눌러야 반영되는 것으로 오해된다. 화면은 그 사실을 적어야 한다.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  configureClaudeAccounts,
  hasClaudeAccountsSurface,
  listClaudeAccounts,
  type ClaudeAccountsSnapshot,
} from '../../lib/claudeAccounts';

export interface AgentPoolState {
  /**
   * 이 빌드에 Tauri 표면이 있고 볼 에이전트가 정해졌는가. 거짓이면 화면이 선택을
   * **그리지 않는다.**
   *
   * **스냅샷을 아직 못 읽은 것은 여기 섞지 않는다.** 섞으면 조회가 실패했을 때 선택이
   * 통째로 사라지고, 그러면 `error` 를 그릴 자리도 같이 없어져 사람은 "이 앱에는 그런
   * 기능이 없다"고 읽는다 — 실제로 그렇게 읽힌 적이 있다. 못 읽은 것은 `ready` 가 말한다.
   */
  available: boolean;
  /** 스냅샷을 읽었는가. 거짓이면 화면은 선택을 **그리되 잠근다**(고를 것이 아직 없다). */
  ready: boolean;
  /** 고를 수 있는 풀 이름. **스냅샷에서 온다** — 지어내지 않는다. */
  pools: string[];
  /** 지금 배정. `''` 은 배정 없음(기본 풀 사용)이다. */
  assigned: string;
  /** 기본 풀 이름. 화면이 "기본 풀 사용"이 무엇을 뜻하는지 말할 때 쓴다. */
  defaultPool: string | null;
  /** 배정을 바꾼다. `''` 이면 배정을 **지운다**. */
  assign(pool: string): Promise<void>;
  error: string | null;
}

export function useAgentPool(agentId: string | null): AgentPoolState {
  const available = hasClaudeAccountsSurface();
  const [snap, setSnap] = useState<ClaudeAccountsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!available || !agentId) return;
    let dead = false;
    void listClaudeAccounts().then(
      (s) => { if (!dead) setSnap(s); },
      // **조회 실패를 빈 목록으로 그리지 않는다** — 그러면 사용자는 풀이 없는 줄 안다.
      (err) => { if (!dead) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { dead = true; };
  }, [available, agentId]);

  const assign = useCallback(async (pool: string): Promise<void> => {
    if (!snap || !agentId) return;
    // 세 값을 **한 번에** 쓴다(부분 갱신이 아니다). 이 화면은 순서·기본 풀을 손대지 않으므로
    // 스냅샷의 값을 그대로 실어 보낸다 — 안 실으면 그 둘이 지워진다.
    const order: Record<string, string[]> = {};
    for (const p of snap.pools) if (p.name) order[p.name] = p.accounts.map((a) => a.name);
    const agents = { ...snap.agents };
    // `''` 은 "기본 풀 사용"이다. 빈 문자열을 배정으로 쓰면 이름 문법에 걸려 데몬이
    // 거절하므로, **키를 지우는** 것이 그 뜻의 유일한 표현이다.
    if (pool === '') delete agents[agentId];
    else agents[agentId] = pool;
    try {
      await configureClaudeAccounts({ defaultPool: snap.defaultPool, order, agents });
      setSnap({ ...snap, agents });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [snap, agentId]);

  return {
    available: available && agentId !== null,
    ready: snap !== null,
    pools: (snap?.pools ?? []).map((p) => p.name).filter((n) => n !== ''),
    assigned: (agentId && snap?.agents[agentId]) || '',
    defaultPool: snap?.defaultPool ?? null,
    assign,
    error,
  };
}
