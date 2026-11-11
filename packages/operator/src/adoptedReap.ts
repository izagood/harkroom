// 배정에 없는 채택 러너 회수(s21c-2c-1b-2, security c2b-3 ①b).
//
// 기동 때 장부에서 채택한 러너는 「그 에이전트가 지금도 이 오퍼레이터에 배정돼 있는가」를 모른 채 산다 — 꺼진 사이
// 배정이 다른 기기로 갔거나 풀렸으면 아무도 그 러너를 내리지 않는다. 서버는 hello 뒤 재전송 묶음 끝에
// `assign.synced{agentIds}` 를 보내고(`assignmentRoutes.ts`), 여기서 그것을 **「남길 것」으로만** 쓴다:
//   1. 회수 대상은 **채택한** 러너뿐이다. 내가 띄운 러너는 배정 해제(`unassign`)의 길로만 내린다.
//   2. 이 오퍼레이터가 맡은 커뮤니티가 **전부** 붙어서 이번 연결의 synced 를 받은 뒤에만 회수한다. 하나라도
//      옛 서버(표지를 안 보냄)·못 붙음·아직 못 받음이면 아무것도 하지 않는다 — 실패하면 안 죽이는 쪽.
//   3. 받음 표지는 연결마다 지운다(`community.ts` onOpen) — 지난 연결의 목록으로 회수하지 않는다.
//   4. 목록은 남길 것의 합집합이다. 서버가 엉뚱한 id 를 실어도 생길 수 있는 일은 「안 죽임」뿐이다.
//   5. 신호 직전에 커널 시작 시각을 `ps` 로 다시 읽어 장부 값과 같을 때만 SIGTERM — 채택 러너는 내 자식이 아니라
//      pid 재사용 틈이 있다. 다르거나 못 읽으면 보내지 않는다(죽었으면 `pollAdopted` 가 표에서 뺀다).
import type { ProcessIdentityProbe } from './adopt.js';

export interface AdoptedRunnerRow {
  agentId: string;
  incarnationId: string;
  pid: number;
  bootTimeSec: number | null;
}

export interface ReapDeps {
  /** 이 오퍼레이터가 맡은 커뮤니티가 전부 떠 있는가(토큰 없음·실패로 안 뜬 것이 있으면 false). */
  allStarted(): boolean;
  /** 떠 있는 커뮤니티마다 이번 연결에서 받은 「남길 것」. 아직 못 받았으면 null. */
  keeps(): readonly (ReadonlySet<string> | null)[];
  adopted(): AdoptedRunnerRow[];
  currentIncarnation(agentId: string): string | null;
  probe: Pick<ProcessIdentityProbe, 'bootTimeSec'>;
  /** 그 세대에 SIGTERM. 표에 그 세대가 없으면 false. */
  kill(agentId: string, incarnationId: string): boolean;
  log(line: string): void;
}

/** 전부 받았으면 남길 것의 합집합, 아니면 null(= 회수하지 않는다). */
export function keepUnion(deps: Pick<ReapDeps, 'allStarted' | 'keeps'>): Set<string> | null {
  if (!deps.allStarted()) return null;
  const keeps = deps.keeps();
  if (keeps.length === 0) return null;
  const union = new Set<string>();
  for (const k of keeps) {
    if (k === null) return null;
    for (const id of k) union.add(id);
  }
  return union;
}

/** 회수한 에이전트 id 를 돌려준다. */
export async function reapUnassignedAdopted(deps: ReapDeps): Promise<string[]> {
  const first = keepUnion(deps);
  if (first === null) return [];
  const reaped: string[] = [];
  for (const row of deps.adopted()) {
    if (first.has(row.agentId)) continue;
    if (row.bootTimeSec === null) {
      deps.log(`채택 러너 회수 안 함: agent=${row.agentId} — 장부에 시작 시각이 없다`);
      continue;
    }
    const now = await deps.probe.bootTimeSec(row.pid);
    if (now === null || now !== row.bootTimeSec) {
      deps.log(`채택 러너 회수 안 함: agent=${row.agentId} pid=${row.pid} — 시작 시각이 장부와 다르거나 못 읽었다`);
      continue;
    }
    // ps 를 기다리는 사이 다시 붙었거나(표지 지워짐) 배정이 왔을 수 있다 — 다시 본다.
    const again = keepUnion(deps);
    if (again === null || again.has(row.agentId)) continue;
    if (deps.currentIncarnation(row.agentId) !== row.incarnationId) continue;
    if (deps.kill(row.agentId, row.incarnationId)) {
      deps.log(`채택 러너 회수: agent=${row.agentId} pid=${row.pid} — 이 오퍼레이터의 배정에 없다(SIGTERM)`);
      reaped.push(row.agentId);
    }
  }
  return reaped;
}
