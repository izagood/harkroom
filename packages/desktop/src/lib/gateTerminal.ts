/**
 * 계정 관문 실패 카드의 [터미널 열기]가 **어느 계정을 열지** 정한다(2026-10-02, 관문 대응 PR-4).
 *
 * ## 이름이 아니라 순번으로 찾는다 (칩 ②, 2026-11-12 · security #1039·#1047)
 * 실패 카드에는 계정·풀 **이름이 없다** — 폴더 이름이라 사람 이름일 수 있어 서버에 남기지 않는다. 카드에는 러너가
 * 센 순번(`claudePoolRank`·`claudeAccountRank`)만 있고, 이 기기의 실제 계정 목록(`listClaudeAccounts`)에서 러너와
 * **같은 규칙**(`agent/src/claudeAccounts.ts::loadClaudeLane` 의 풀 순서·`accountRanks`)으로 그 자리를 다시 찾는다.
 * 찾은 (풀, 계정) 이름 둘만 데몬에 넘기고, 경로·명령은 데몬이 조립한다(#1007 결정). 순번은 에이전트가 고른
 * 값이므로 목록 밖이면 아무것도 열지 않는다(`missing`).
 *
 * ## 열 수 없는 곳
 * 터미널은 그 에이전트를 돌리는 **오퍼레이터 기계**에서만 열 수 있다. 웹·모바일(Tauri 표면 없음)이나
 * 다른 오퍼레이터에 배정된 에이전트면 `elsewhere` — 화면은 "<오퍼레이터>에서 열기" 문구만 보인다.
 *
 * 순수 함수다 — 사실은 호출자가 모아 넘긴다(`useGateTerminalTarget`).
 */
import { orderAccounts } from '@harkroom/shared/claudePools';
import { agentPoolsOf, type ClaudeAccountsSnapshot } from './claudeAccounts';

export type GateTerminalTarget =
  /** 이 기기에서 연다 — 데몬에 넘길 이름 둘. */
  | { kind: 'open'; pool: string; account: string }
  /** 다른 기기(또는 웹·모바일)에서만 열 수 있다. 이름을 모르면 `null`. */
  | { kind: 'elsewhere'; operatorName: string | null }
  /** 이 기기의 오퍼레이터인데 그 이름의 계정이 없다(지워졌거나 이름표가 틀렸다). */
  | { kind: 'missing' }
  /** 같은 이름의 계정이 여러 풀에 있고 그 에이전트의 풀로도 못 고른다. */
  | { kind: 'ambiguous' }
  /** 아직 모른다(목록을 읽는 중). */
  | { kind: 'unknown' };

export interface GateTerminalFacts {
  /** meta 의 풀 순번(1부터). 없으면 풀 순서 밖(지정 풀·뿌리)이다. */
  poolRank?: number | undefined;
  /** meta 의 그 풀 안 계정 순번(1부터). */
  accountRank: number;
  agentId: string;
  /** 이 빌드에 로컬 표면(Tauri)이 있는가. 없으면 웹·모바일이다. */
  hasLocalSurface: boolean;
  /** 이 기기 오퍼레이터의 로컬 배정에 그 에이전트가 있는가. 모르면 `null`. */
  agentIsLocal: boolean | null;
  /** 그 에이전트가 배정된 오퍼레이터 이름(문구용). 모르면 `null`. */
  operatorName: string | null;
  /** 이 기기의 계정 목록. 아직 못 읽었으면 `null`. */
  snapshot: ClaudeAccountsSnapshot | null;
  /** 이 기기 로컬 설정이 그 에이전트에 지정한 풀(`OperatorLocalAgent.claudePool`). */
  localPool?: string | null;
}

export function resolveGateTerminalTarget(f: GateTerminalFacts): GateTerminalTarget {
  if (!f.hasLocalSurface) return { kind: 'elsewhere', operatorName: f.operatorName };
  if (f.agentIsLocal === false) return { kind: 'elsewhere', operatorName: f.operatorName };
  if (f.agentIsLocal === null || f.snapshot === null) return { kind: 'unknown' };
  const snap = f.snapshot;
  // 스냅숏의 계정은 이름순이다. 러너는 풀 안 계정을 `orderAccounts`(`pools.json` 의 order 먼저 → 나머지 이름순)로
  // 센다 — 같은 규칙으로 늘어놓아야 순번이 같은 계정을 가리킨다. order 가 없는 옛 오퍼레이터면 이름순 그대로다.
  const accountsOf = (name: string) => {
    const names = snap.pools.find((p) => p.name === name)?.accounts.map((a) => a.name);
    return names ? orderAccounts({ order: snap.order ?? {} }, name, names) : null;
  };
  // 러너와 같은 순서: 로컬 지정 풀(HARKROOM_CLAUDE_POOL) → 에이전트의 풀 순서(있는 풀만) → 기본 풀 → 평평한 뿌리.
  const chain = snap.mode === 'flat' ? []
    : f.localPool ? []
    : agentPoolsOf(snap, f.agentId).filter((p) => accountsOf(p) !== null);
  const fallbackChain = !chain.length && snap.mode !== 'flat' && !f.localPool && snap.defaultPool && accountsOf(snap.defaultPool)
    ? [snap.defaultPool] : chain;
  let pool: string | undefined;
  if (f.poolRank !== undefined) {
    pool = fallbackChain[f.poolRank - 1];
  } else if (snap.mode === 'flat') {
    pool = snap.pools[0]?.name;
  } else if (f.localPool) {
    pool = f.localPool;
  } else {
    pool = fallbackChain.find((p) => (accountsOf(p)?.length ?? 0) > 0) ?? fallbackChain[0];
  }
  if (pool === undefined) return { kind: 'missing' };
  const account = accountsOf(pool)?.[f.accountRank - 1];
  if (!account) return { kind: 'missing' };
  return { kind: 'open', pool, account };
}
