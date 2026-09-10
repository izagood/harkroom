import type { AvcsLogEntry, AvcsReduced } from './client.js';

/**
 * 제안 트리를 조립한다 — 협업 탭이 읽는 자리(`docs/desktop-collab.html` 1단계,
 * `docs/hub-seat.md`).
 *
 * ## 왜 조립은 여기서 하고 판정은 안 하는가
 *
 * avcs 의 단위는 **`intent` 를 뿌리로 한 제안 트리**이지 평평한 이벤트 목록이 아니다.
 * 그 트리를 세우는 것은 객체들의 참조를 따라가는 일이고(operation.intentOid,
 * evidence.forOps, decision.chosenOps), 그건 순수 함수로 할 수 있다 — 그래서 여기 있다.
 *
 * **상태·충돌은 조립하지 않는다.** `statuses`·`conflicts`·`blockedReasons` 는 avcs-server 의
 * `GET /reduced` 가 준 것을 그대로 얹는다. 같은 값을 murmur 가 두 번째로 계산하면 두 구현이
 * 갈라지고, 그 순간 화면은 avcs 가 말하지 않은 판정을 말하게 된다.
 *
 * ## 왜 `null` 인 reduced 를 허용하는가
 *
 * 환원 평면은 프로토콜에서 선택이다(avcs `docs/26` §0). 미러를 상대로도 제안 목록은 떠야
 * 하고, 그때 화면이 말할 것은 "상태를 모른다"(`unknown`) 이지 "제안이 없다" 가 아니다.
 */

/** 목록이 거르고 정렬하는 축. 인박스와 같은 규칙 — **막는 것이 위로 온다.** */
export type ProposalState =
  | 'needs_decision'
  | 'check_failed'
  | 'open'
  | 'accepted'
  | 'rejected'
  | 'unknown';

/** 정렬 순서. `desktop-collab.html`: 결정 필요 → 검증 실패 → 열림 → 승인·머지·거부. */
const STATE_ORDER: Record<ProposalState, number> = {
  needs_decision: 0,
  check_failed: 1,
  open: 2,
  unknown: 3,
  accepted: 4,
  rejected: 5,
};

export interface ProposalEvidence {
  oid: string;
  /** `<kind> <result>` — 로그 엔트리가 이미 접어 둔 요약이다. */
  summary: string;
  actorKeyId: string | null;
}

export interface ProposalOp {
  oid: string;
  purpose: string;
  actorKeyId: string | null;
  /** `/reduced` 의 op 상태. 환원 평면이 없으면 `null`. */
  status: string | null;
  /** 왜 막혔는지(사람이 읽을 문장). 없으면 `null`. */
  blockedReason: string | null;
  effects?: { changesBehavior: boolean; breaksPublicApi: boolean };
  evidence: ProposalEvidence[];
}

export interface ProposalDecision {
  oid: string;
  reason: string;
  decidedByKeyId: string | null;
}

export interface Proposal {
  intentOid: string;
  /** `intent.title`. 줄이 말하는 넷 중 "무슨 제안". */
  title: string;
  /** intent 를 연 사람/에이전트의 키. 줄이 말하는 넷 중 "누가"(얼굴이 여기서 온다). */
  ownerKeyId: string | null;
  /** 이 제안에 달린 것 중 objlog 에서 **가장 늦은** 위치. "언제" 의 정렬 재료다. */
  lastLogIndex: number;
  ops: ProposalOp[];
  decisions: ProposalDecision[];
  state: ProposalState;
  /** 이 제안의 op 을 다투는 충돌들. 비어 있지 않으면 곧 `needs_decision` 이다. */
  conflicts: { id: string; key: string; reason: string }[];
  /** 줄에 그릴 파급. op 들의 선언을 OR 로 접는다 — 하나라도 깨면 그 제안이 깨는 것이다. */
  effects: { changesBehavior: boolean; breaksPublicApi: boolean } | null;
}

export interface ProposalView {
  proposals: Proposal[];
  /** 어느 시점·어느 환원기의 판정인가. 환원 평면이 없으면 `null` 이다. */
  reducedAt: { cursor: number; materializer: string; treeHash: string } | null;
}

/**
 * `intent` 를 뿌리로 op·evidence·decision 을 접는다.
 *
 * 엔트리는 `fetchSince(repo, 0)` 이 준 **로그 순서**로 들어온다고 본다. 순서를 다시 정렬하지
 * 않는 이유: `logIndex` 는 필터 전 objlog 위치라 그 자체가 시간축이고, 여기서 한 번 더 정렬하면
 * 같은 사실에 대한 두 번째 규칙이 생긴다.
 *
 * 뿌리 없는 것(자기 intent 가 이번 로그에 없는 op·evidence)은 **버린다**. 화면이 뿌리 없는
 * 가지를 그릴 자리가 없기 때문이고, 그런 엔트리는 로그를 처음부터 읽지 않았을 때만 생긴다.
 */
export function buildProposals(entries: AvcsLogEntry[], reduced: AvcsReduced | null): ProposalView {
  const byIntent = new Map<string, Proposal>();
  const opIndex = new Map<string, ProposalOp>();
  const statuses = reduced?.statuses ?? {};
  const blocked = reduced?.blockedReasons ?? {};

  const touch = (intentOid: string | null, logIndex: number): Proposal | null => {
    if (!intentOid) return null;
    const p = byIntent.get(intentOid);
    if (!p) return null;
    if (logIndex > p.lastLogIndex) p.lastLogIndex = logIndex;
    return p;
  };

  for (const e of entries) {
    switch (e.type) {
      case 'intent':
        byIntent.set(e.oid, {
          intentOid: e.oid,
          title: e.summary,
          ownerKeyId: e.actorKeyId,
          lastLogIndex: e.logIndex,
          ops: [],
          decisions: [],
          state: 'unknown',
          conflicts: [],
          effects: null,
        });
        break;
      case 'operation': {
        const p = touch(e.intentOid, e.logIndex);
        if (!p) break;
        const op: ProposalOp = {
          oid: e.oid,
          purpose: e.summary,
          actorKeyId: e.actorKeyId,
          status: statuses[e.oid] ?? null,
          blockedReason: blocked[e.oid] ?? null,
          ...(e.effects ? { effects: e.effects } : {}),
          evidence: [],
        };
        p.ops.push(op);
        opIndex.set(e.oid, op);
        break;
      }
      case 'evidence': {
        const p = touch(e.intentOid, e.logIndex);
        if (!p) break;
        // evidence 는 op 을 참조하지만 로그 엔트리는 그 참조를 intent 까지만 접어 준다
        // (client.ts 의 `referencedOp`). 그래서 어느 op 밑인지는 여기서 다시 못 고른다 —
        // 제안의 마지막 op 에 붙인다: 검증은 통상 방금 올린 op 을 향한다.
        const host = p.ops[p.ops.length - 1];
        if (host) host.evidence.push({ oid: e.oid, summary: e.summary, actorKeyId: e.actorKeyId });
        break;
      }
      case 'decision': {
        const p = touch(e.intentOid, e.logIndex);
        if (!p) break;
        p.decisions.push({ oid: e.oid, reason: e.summary, decidedByKeyId: e.actorKeyId });
        break;
      }
      default:
        break;
    }
  }

  // 충돌은 op 을 가리킨다 — 그 op 을 가진 제안으로 되짚는다. 한 충돌이 두 제안을 가로지르면
  // (다른 intent 의 op 둘이 같은 파일을 다투는, 정확히 그 흔한 경우) **양쪽에** 붙는다:
  // 한쪽에만 붙이면 다른 쪽 사람은 자기가 막혔다는 것을 모른다.
  for (const c of reduced?.conflicts ?? []) {
    const seen = new Set<Proposal>();
    for (const o of c.options ?? []) {
      const op = opIndex.get(o.opOid);
      if (!op) continue;
      for (const p of byIntent.values()) {
        if (!p.ops.includes(op) || seen.has(p)) continue;
        seen.add(p);
        p.conflicts.push({ id: c.id, key: c.key, reason: c.reason });
      }
    }
  }

  for (const p of byIntent.values()) {
    p.state = stateOf(p, reduced !== null);
    p.effects = foldEffects(p.ops);
  }

  const proposals = [...byIntent.values()].sort((a, b) => (
    STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.lastLogIndex - a.lastLogIndex
  ));

  return {
    proposals,
    reducedAt: reduced
      ? { cursor: reduced.cursor, materializer: reduced.materializer, treeHash: reduced.treeHash }
      : null,
  };
}

/**
 * 제안 하나의 상태. **막는 것이 이긴다** — 같은 제안 안에 승인된 op 과 결정을 기다리는 op 이
 * 함께 있으면 그 제안은 기다리는 것이다.
 *
 * `hasReduced` 가 거짓이면 상태를 모른다(`unknown`). op 이 있다고 `open` 이라고 말하면,
 * 환원 평면 없는 서버에서 **이미 머지된 제안까지 열린 것으로 보인다.**
 */
function stateOf(p: Proposal, hasReduced: boolean): ProposalState {
  if (!hasReduced) return 'unknown';
  if (p.conflicts.length) return 'needs_decision';
  const s = p.ops.map((o) => o.status);
  if (s.includes('needs_decision')) return 'needs_decision';
  if (s.includes('quarantined')) return 'check_failed';
  if (s.some((x) => x === 'proposed' || x === 'validating')) return 'open';
  if (!s.length) return 'open'; // op 이 아직 없는 intent — 열어만 둔 제안이다
  if (s.every((x) => x === 'accepted')) return 'accepted';
  if (s.every((x) => x === 'rejected' || x === 'superseded')) return 'rejected';
  // accepted 와 rejected 가 섞였다: 일부는 들어갔고 일부는 밀렸다. 아직 볼 것이 남았으므로
  // 끝난 것으로 접지 않는다.
  return 'open';
}

/** 하나라도 선언했으면 제안이 선언한 것이다. 아무 op 도 선언하지 않았으면 `null`(모름). */
function foldEffects(ops: ProposalOp[]): Proposal['effects'] {
  const declared = ops.map((o) => o.effects).filter((e): e is NonNullable<typeof e> => !!e);
  if (!declared.length) return null;
  return {
    changesBehavior: declared.some((e) => e.changesBehavior),
    breaksPublicApi: declared.some((e) => e.breaksPublicApi),
  };
}
