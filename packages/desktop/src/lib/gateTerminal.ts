/**
 * 계정 관문 실패 카드의 [터미널 열기]가 **어느 계정을 열지** 정한다(2026-10-02, 관문 대응 PR-4).
 *
 * ## meta 의 계정을 그대로 믿지 않는다 (security, #1039·#1047)
 * `FailureMeta.failure.account` 는 **에이전트가 고른 값**이다. 그 이름을 그대로 데몬에 넘기지 않고, 이
 * 기기의 실제 계정 목록(`listClaudeAccounts`)에서 그 이름을 찾는다. 찾은 (풀, 계정) 이름 둘만 데몬에
 * 넘기고, 경로·명령은 데몬이 조립한다(#1007 결정).
 *
 * ## 열 수 없는 곳
 * 터미널은 그 에이전트를 돌리는 **오퍼레이터 기계**에서만 열 수 있다. 웹·모바일(Tauri 표면 없음)이나
 * 다른 오퍼레이터에 배정된 에이전트면 `elsewhere` — 화면은 "<오퍼레이터>에서 열기" 문구만 보인다.
 *
 * 순수 함수다 — 사실은 호출자가 모아 넘긴다(`useGateTerminalTarget`).
 */
import type { ClaudeAccountsSnapshot } from './claudeAccounts';

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
  /** meta 의 이름표(`계정` 또는 `풀/계정`). */
  label: string;
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

/** 이름표 문법(서버 `ACCOUNT_GATE_LABEL_PATTERN` 과 같다). 밖이면 아무것도 열지 않는다. */
const LABEL = /^(?:([a-z0-9-]{1,32})\/)?([a-z0-9-]{1,32})$/;

export function resolveGateTerminalTarget(f: GateTerminalFacts): GateTerminalTarget {
  if (!f.hasLocalSurface) return { kind: 'elsewhere', operatorName: f.operatorName };
  if (f.agentIsLocal === false) return { kind: 'elsewhere', operatorName: f.operatorName };
  if (f.agentIsLocal === null || f.snapshot === null) return { kind: 'unknown' };
  const m = LABEL.exec(f.label);
  if (!m) return { kind: 'missing' };
  const [, labelPool, name] = m as unknown as [string, string | undefined, string];
  const pools = f.snapshot.pools.filter((p) => p.accounts.some((a) => a.name === name)).map((p) => p.name);
  if (!pools.length) return { kind: 'missing' };
  // 고르는 순서: 이름표에 풀이 있으면 그 풀 → 그 에이전트의 로컬 지정 풀 → 배정 → 기본 풀 → 하나뿐이면 그것.
  const preferred = [labelPool, f.localPool, f.snapshot.agents[f.agentId], f.snapshot.defaultPool]
    .filter((p): p is string => typeof p === 'string');
  for (const p of preferred) if (pools.includes(p)) return { kind: 'open', pool: p, account: name };
  if (pools.length === 1) return { kind: 'open', pool: pools[0]!, account: name };
  return { kind: 'ambiguous' };
}
