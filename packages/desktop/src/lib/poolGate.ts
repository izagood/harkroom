/**
 * 계정 풀이 **이 맥에서 쓰이는가**(2026-10-15, jaebin 「오퍼레이터에 배정된 것과 풀이 맞아야」, 시안 pool_gate v2).
 *
 * 풀(pools.json)은 이 기기의 파일이고, 그 파일을 읽는 것은 **이 맥 오퍼레이터가 띄운 러너**뿐이다. 오퍼레이터가
 * 러너를 띄우려면 두 절반이 다 맞아야 한다(스펙 2026-09-20 §3): 서버 배정이 이 맥 오퍼레이터를 가리키고, 이 맥
 * 오퍼레이터 설정(「이 머신」 체크)에 그 에이전트가 있다. 하나라도 어긋나면 화면에서 고친 순서는 아무 데도 쓰이지
 * 않는다 — 그래서 그때는 순서를 잠그고 이유를 보인다.
 *
 * **모르면 잠그지 않는다**(⑤). 오퍼레이터 설정을 못 읽은 것을 "이 맥에서 안 돈다"로 읽으면 데몬이 잠깐 대답을
 * 못 한 것만으로 설정이 막힌다. 순수 함수다 — 화면이 읽은 사실을 받는다.
 */
export type PoolGate =
  /** ① 이 맥에서 돈다 — 순서가 쓰인다. */
  | { kind: 'here' }
  /** ② 어디에도 배정되지 않았다. */
  | { kind: 'unassigned' }
  /** ③ 다른 오퍼레이터에 배정됐다 — 풀은 그 머신의 것이다. */
  | { kind: 'elsewhere'; operatorId: string }
  /** ④ 배정은 이 맥인데 이 맥 설정(「이 머신」)에 없다 — 오퍼레이터가 띄우지 않는다. */
  | { kind: 'half' }
  /** ⑤ 이 맥 오퍼레이터 설정을 못 읽었다 — 잠그지 않는다. */
  | { kind: 'unknown' };

export interface LocalOperatorFacts {
  /** 이 맥 오퍼레이터의 id. `null` 은 이 커뮤니티에 등록되지 않았다(이 맥에서 돌 수 없다). */
  operatorId: string | null;
  /** 이 맥 설정에 그 에이전트가 있나. */
  present: boolean;
}

export function poolGateOf(
  assignmentOperatorId: string | null,
  local: LocalOperatorFacts | 'unknown',
): PoolGate {
  if (local === 'unknown') return { kind: 'unknown' };
  if (assignmentOperatorId === null) return { kind: 'unassigned' };
  if (local.operatorId === null || assignmentOperatorId !== local.operatorId) {
    return { kind: 'elsewhere', operatorId: assignmentOperatorId };
  }
  return local.present ? { kind: 'here' } : { kind: 'half' };
}

/** 순서를 고칠 수 있나 — 이 맥에서 돌거나, 모를 때. */
export function poolGateEditable(g: PoolGate): boolean {
  return g.kind === 'here' || g.kind === 'unknown';
}
