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
 * harkroom 에이전트를 다른 기기에서 띄우면 그 기기에는 그 풀이 없다. 배정을 서버에 두면 그
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
 * `agentId === null` 이면 고른 목록만 기억하고(`chosen`) 데몬에 쓰지 않는다. 실제로 적는
 * 것은 `controller.createAgent` 이며, **러너가 뜨기 전에** 적는다 — 러너는 자기 풀을
 * 시작할 때 한 번만 읽으므로 그 뒤에 적으면 방금 만든 에이전트의 첫 러너는 기본 풀로
 * 돈다. 근거 전문은 그 메서드 안에 있다.
 *
 * ## 풀 n개(2026-10-15)
 *
 * 배정은 풀 하나가 아니라 **풀 순서 목록**이다(jaebin D1~D5 전부 A). 화면이 말하는 "지금 어느 풀을
 * 왜 쓰나"는 러너와 **같은 식**(`@harkroom/shared/claudePoolChain` 의 `poolChainState`)으로 잰다 —
 * 두 곳이 다른 식을 쓰면 화면은 1번을 쓴다는데 러너는 2번으로 보내는 날이 온다.
 * 러너는 5초마다 pools.json 을 다시 읽으므로(`createLiveAccountLane`) 바꾼 순서는 **다음 새
 * 스레드부터** 적용된다 — 러너를 다시 시작할 필요가 없다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { poolChainState, type PoolChainState } from '@harkroom/shared/claudePoolChain';
import type { ClaudeUsageEntry } from '@harkroom/shared/claudeUsage';

import {
  agentPoolsOf,
  assignAgentPools,
  hasClaudeAccountsSurface,
  listClaudeAccounts,
  type ClaudeAccountsSnapshot,
} from '../../lib/claudeAccounts';
import { errorTextNow } from '../../lib/errorText';
import { useProviderUsage, type ProviderUsageSnapshot } from '../../lib/providerUsage';

export interface AgentPoolState {
  /**
   * 이 빌드에 Tauri 표면이 있는가. 거짓이면 화면이 선택을 **그리지 않는다.**
   *
   * **볼 에이전트가 정해졌는지는 여기 섞지 않는다** — 만들기 화면에서도 고를 수 있어야 한다.
   * **스냅샷을 아직 못 읽은 것도 섞지 않는다** — 섞으면 조회 실패가 "이 앱엔 그런 기능이 없다"로
   * 읽힌다. 못 읽은 것은 `ready` 가 말한다.
   */
  available: boolean;
  /** 스냅샷을 읽었는가. 거짓이면 화면은 목록을 **그리되 잠근다**(고를 것이 아직 없다). */
  ready: boolean;
  /** 이 기기에 있는 풀 이름. **스냅샷에서 온다** — 지어내지 않는다. */
  pools: string[];
  /**
   * 지금 풀 순서. 빈 목록은 배정 없음(기본 풀 사용, D5)이다. 사람이 방금 고친 목록이 있으면 그
   * 목록이고, 없으면 스냅샷의 배정이다(만들기 화면에는 스냅샷 쪽 값이 없다).
   */
  chain: string[];
  /** 기본 풀 이름. 목록이 비었을 때 무엇을 쓰는지 말할 때 쓴다. */
  defaultPool: string | null;
  /**
   * 러너와 같은 식으로 잰 판정. 목록이 비었으면 기본 풀 하나를 잰다(D5). 스냅샷을 못 읽었거나
   * 잴 풀이 없으면 `null`. 사용량을 못 읽은 계정은 "모름"이지 소진이 아니다.
   */
  state: PoolChainState | null;
  /**
   * 풀 순서를 통째로 바꾼다. 빈 목록이면 배정을 **지운다**(키 삭제 — 데몬은 빈 목록을 거절한다).
   * 에이전트 id 가 없으면(만들기 화면) 데몬에 쓰지 않고 기억만 한다 — 적는 것은 `createAgent` 다.
   */
  setChain(pools: readonly string[]): Promise<void>;
  error: string | null;
}

/**
 * 사용량 스냅샷을 판정 식의 입력으로 옮긴다. **못 읽은 것은 모르는 것이다** — 오류 꼬리표가 붙었거나
 * 주간 창이 없으면 `readAtMs: null` 로 넘겨, 판정 식이 그 계정을 소진으로 세지 않게 한다.
 * 신선도(10분)는 판정 식이 `fetchedAtMs` 로 잰다.
 */
export function usageEntriesOf(snap: ProviderUsageSnapshot | null): ClaudeUsageEntry[] {
  if (!Array.isArray(snap?.accounts)) return [];
  return snap.accounts.map((a) => ({
    pool: a.pool ?? '',
    account: a.account,
    signIn: null,
    session: a.session,
    weekly: a.weekly,
    modelWeekly: [],
    readAtMs: !a.error && a.weekly && a.fetchedAtMs > 0 ? a.fetchedAtMs : null,
    ...(a.error ? { error: a.error } : {}),
  }));
}

/** 스냅샷 + 사용량 → 판정. 화면 시험이 훅 없이 같은 값을 만들 수 있게 따로 둔다. */
export function agentPoolChainState(
  snap: ClaudeAccountsSnapshot, chain: readonly string[], usage: ProviderUsageSnapshot | null, now: number,
): PoolChainState | null {
  const measured = chain.length ? chain : snap.defaultPool ? [snap.defaultPool] : [];
  if (!measured.length) return null;
  const accountsByPool = new Map(snap.pools.filter((p) => p.name).map((p) => [p.name, p.accounts.map((a) => a.name)] as const));
  const attention = new Set(snap.pools.flatMap((p) => p.accounts.filter((a) => a.attention).map((a) => `${p.name}/${a.name}`)));
  return poolChainState({
    chain: measured,
    accountsByPool,
    usage: usageEntriesOf(usage),
    cfg: { defaultPool: snap.defaultPool, order: {}, agents: {}, ...(snap.assign ? { assign: snap.assign } : {}) },
    now,
    blocked: (pool, account) => attention.has(`${pool}/${account}`),
  });
}

export function useAgentPool(agentId: string | null): AgentPoolState {
  const available = hasClaudeAccountsSurface();
  const [snap, setSnap] = useState<ClaudeAccountsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 사람이 **방금 고친** 목록. `null` 은 "고친 적 없다"이고 `[]` 은 "기본 풀 사용으로 비웠다"다 —
   * 그 둘을 뭉개면 만들기 화면에서 목록을 비우는 조작이 표현되지 않는다.
   */
  const [chosen, setChosen] = useState<string[] | null>(null);
  const prevAgentId = useRef(agentId);
  const { snap: usage } = useProviderUsage('claude', available);

  useEffect(() => {
    if (!available) return;
    let dead = false;
    void listClaudeAccounts().then(
      (s) => { if (!dead) setSnap(s); },
      // **조회 실패를 빈 목록으로 그리지 않는다** — 그러면 사용자는 풀이 없는 줄 안다.
      (err) => { if (!dead) setError(errorTextNow(err)); },
    );
    return () => { dead = true; };
  }, [available]);

  /**
   * 보던 대상이 **다른 에이전트로** 바뀌면 고친 목록을 버린다. `null → id`(만들기 → 방금 만든
   * 에이전트)는 지나간다 — 그 목록은 이미 데몬에 쓰였다(`controller.createAgent`).
   */
  useEffect(() => {
    const prev = prevAgentId.current;
    prevAgentId.current = agentId;
    if (prev === null || prev === agentId) return;
    setChosen(null);
  }, [agentId]);

  /**
   * 마지막으로 보낸 쓰기의 번호(풀 n개 후속 f4). ↑↓ 를 빠르게 누르면 쓰기 여럿이 줄을 서고
   * (`assignAgentPools` 가 차례로 돌린다) 그 응답도 차례로 온다 — **마지막 쓰기의 응답만** 화면에
   * 반영한다. 앞 쓰기의 성공이 뒤 쓰기의 실패 표시를 지우거나, 낡은 순서를 스냅샷에 되돌려 놓지 않게.
   * 화면이 그리는 순서는 그동안 `chosen`(방금 고친 목록)이 쥐고 있다.
   */
  const writeSeq = useRef(0);

  const setChain = useCallback(async (pools: readonly string[]): Promise<void> => {
    if (!snap) return;
    const next = [...pools];
    setChosen(next);
    if (!agentId) return;
    const seq = ++writeSeq.current;
    try {
      await assignAgentPools(agentId, next);
      if (seq !== writeSeq.current) return;
      // 함수형으로 고친다 — 이 콜백이 쥔 `snap` 은 그 사이 다시 읽혔을 수 있다.
      setSnap((cur) => {
        if (!cur) return cur;
        const agents = { ...cur.agents };
        if (!next.length) delete agents[agentId];
        else agents[agentId] = next;
        return { ...cur, agents };
      });
      setError(null);
    } catch (err) {
      if (seq !== writeSeq.current) return;
      setError(errorTextNow(err));
    }
  }, [snap, agentId]);

  const chain = chosen ?? (agentId && snap ? agentPoolsOf(snap, agentId) : []);
  const chainKey = chain.join('\n');
  const state = useMemo(
    () => (snap ? agentPoolChainState(snap, chain, usage, Date.now()) : null),
    [snap, chainKey, usage],
  );

  return {
    available,
    ready: snap !== null,
    pools: (snap?.pools ?? []).map((p) => p.name).filter((n) => n !== ''),
    chain,
    defaultPool: snap?.defaultPool ?? null,
    state,
    setChain,
    error,
  };
}

/**
 * 에이전트 id → 풀 순서(이 기기). 턴 줄의 「↓ 2번 풀」 칩이 쓴다 — 표면이 없거나 못 읽었으면 빈 맵이고,
 * 그때 칩은 서지 않는다(확인하지 않은 것을 단언하지 않는다).
 */
export function useAgentPoolChains(): ReadonlyMap<string, string[]> {
  const available = hasClaudeAccountsSurface();
  const [snap, setSnap] = useState<ClaudeAccountsSnapshot | null>(null);
  useEffect(() => {
    if (!available) return;
    let dead = false;
    void listClaudeAccounts().then((s) => { if (!dead) setSnap(s); }, () => {});
    return () => { dead = true; };
  }, [available]);
  return useMemo(
    () => new Map(snap ? Object.keys(snap.agents).map((id) => [id, agentPoolsOf(snap, id)] as const) : []),
    [snap],
  );
}
