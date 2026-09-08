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
 *
 * ## 만들기 화면은 예외다 — 쓸 대상이 아직 없다
 *
 * 배정은 **에이전트 id 로 적히는 값**이고, 만들 때는 그 id 가 아직 없다. 그래서 이 훅은
 * `agentId === null` 이면 고른 값만 기억하고(`chosen`) 데몬에 쓰지 않는다. 실제로 적는
 * 것은 `controller.createAgent` 이며, **러너가 뜨기 전에** 적는다 — 러너는 자기 풀을
 * 시작할 때 한 번만 읽으므로 그 뒤에 적으면 방금 만든 에이전트의 첫 러너는 기본 풀로
 * 돈다. 근거 전문은 그 메서드 안에 있다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  assignAgentPool,
  hasClaudeAccountsSurface,
  listClaudeAccounts,
  type ClaudeAccountsSnapshot,
} from '../../lib/claudeAccounts';

export interface AgentPoolState {
  /**
   * 이 빌드에 Tauri 표면이 있는가. 거짓이면 화면이 선택을 **그리지 않는다.**
   *
   * **볼 에이전트가 정해졌는지는 여기 섞지 않는다.** 앞 판본은 `agentId !== null` 을 함께
   * 봤고, 그래서 만들기 화면(`selected === null`)에는 풀 선택이 **아예 나타나지 않았다** —
   * 사람은 에이전트를 만든 뒤 상세로 다시 들어가야 풀을 고를 수 있었고, 그 사이 러너는
   * 이미 기본 풀로 떠 있었다. 고를 수 있는 풀 목록은 에이전트와 무관한 기기의 사실이다.
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
  /**
   * 지금 배정. `''` 은 배정 없음(기본 풀 사용)이다.
   *
   * 사람이 방금 고른 값이 있으면 **그 값**이고, 없으면 스냅샷의 배정이다. 만들기 화면에는
   * 스냅샷 쪽 값이 없으므로(에이전트 id 가 아직 없다) 고른 값만이 화면의 근거다.
   */
  assigned: string;
  /** 기본 풀 이름. 화면이 "기본 풀 사용"이 무엇을 뜻하는지 말할 때 쓴다. */
  defaultPool: string | null;
  /**
   * 배정을 바꾼다. `''` 이면 배정을 **지운다**.
   *
   * 에이전트 id 가 없으면(만들기 화면) 데몬에 쓰지 않고 고른 값만 기억한다 — 쓸 대상이
   * 아직 없다. 그 값을 실제로 적는 것은 `createAgent` 다.
   */
  assign(pool: string): Promise<void>;
  error: string | null;
}

export function useAgentPool(agentId: string | null): AgentPoolState {
  const available = hasClaudeAccountsSurface();
  const [snap, setSnap] = useState<ClaudeAccountsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 사람이 **방금 고른** 값. `null` 은 "고른 적 없다"이고 `''` 은 "기본 풀 사용을 골랐다"다 —
   * 그 둘을 한 값으로 뭉개면 만들기 화면에서 배정을 지우는 조작이 표현되지 않는다.
   *
   * 왜 스냅샷만으로는 안 되나: 만들기 화면에는 **아직 에이전트 id 가 없다.** 배정은
   * id 로 적히는 값이므로 고르는 순간에는 쓸 곳이 없고, 그동안 화면이 보여 줄 값은
   * 스냅샷이 아니라 이 상태다. 그 값을 실제로 적는 것은 `controller.createAgent` 다.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  const prevAgentId = useRef(agentId);

  useEffect(() => {
    if (!available) return;
    let dead = false;
    void listClaudeAccounts().then(
      (s) => { if (!dead) setSnap(s); },
      // **조회 실패를 빈 목록으로 그리지 않는다** — 그러면 사용자는 풀이 없는 줄 안다.
      (err) => { if (!dead) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { dead = true; };
  }, [available]);

  /**
   * 보던 대상이 **다른 에이전트로** 바뀌면 고른 값을 버린다 — 남기면 앞 에이전트의 선택이
   * 뒤 에이전트의 배정으로 보인다.
   *
   * `null → id` 전이는 **예외로 지나간다.** 그것은 만들기 화면이 방금 만든 에이전트로
   * 이어지는 전이이고, 그 값은 이미 데몬에 쓰였다(`controller.createAgent`). 여기서 지우면 화면이
   * 방금 적용한 선택을 "기본 풀 사용"으로 되돌려 그린다 — 사람은 배정이 안 됐다고 읽는다.
   */
  useEffect(() => {
    const prev = prevAgentId.current;
    prevAgentId.current = agentId;
    if (prev === null || prev === agentId) return;
    setChosen(null);
  }, [agentId]);

  const assign = useCallback(async (pool: string): Promise<void> => {
    if (!snap) return;
    setChosen(pool);
    // **만들기 화면에는 아직 쓸 곳이 없다.** id 가 없으면 고른 값만 기억하고 끝낸다 —
    // 그 값은 `createAgent` 가 러너를 띄우기 **전에** 실어 보낸다(위 머리말).
    if (!agentId) return;
    try {
      await assignAgentPool(agentId, pool);
      // 병합은 `assignAgentPool` 이 새로 읽은 스냅샷으로 한다. 여기서 캐시를 갱신하는
      // 것은 **되돌아 그리지 않기 위한 것**뿐이다(`assigned` 의 대체값).
      const agents = { ...snap.agents };
      if (pool === '') delete agents[agentId];
      else agents[agentId] = pool;
      setSnap({ ...snap, agents });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [snap, agentId]);

  return {
    available,
    ready: snap !== null,
    pools: (snap?.pools ?? []).map((p) => p.name).filter((n) => n !== ''),
    assigned: chosen ?? ((agentId && snap?.agents[agentId]) || ''),
    defaultPool: snap?.defaultPool ?? null,
    assign,
    error,
  };
}
