// 도는 턴을 멈춘 **뒤의 정리** 한 벌(2026-10-29, 턴 중단).
//
// 멈추는 문은 둘이다 — 사람이 화면에서 누르는 `POST /agent-sessions/:id/cancel` 과 일을 넘긴 에이전트가
// 부르는 MCP `turn.cancel`. 신호 자체는 둘 다 허브(`RelayHub.cancelSession`)가 보내고, 그 뒤에 닫을 것 —
// 위임 의무와 그 스레드의 예약 — 은 여기 하나로 모은다. 문마다 정리를 따로 쓰면 한쪽만 고친 날 다른
// 문으로 멈춘 일이 기한·예약으로 되살아난다(위임 의무가 그렇게 10분 뒤 되살아났던 것이 051 이다).
import type { Pool } from 'pg';
import type { AgentSessionView, WakeReportTo } from '@harkroom/shared';
import { announceReportWakes, cancelWakesForTurn } from './agentWakes.js';
import { cancelDelegationsFor } from './delegations.js';
import { emitEvent } from '../events.js';

export interface SettledCancel {
  /** 의무를 닫으며 깨운 팀장들(`cancelDelegationsFor` 의 반환). */
  woke: string[];
  /** 접은 예약 수. */
  wakesCanceled: number;
}

/**
 * 멈춘 턴의 위임 의무와 그 에이전트·그 스레드의 예약을 **한 커밋으로** 닫는다. 이벤트는 커밋 뒤에 친다 —
 * 러너는 `inbox.updated` 를 보고 곧바로 폴하므로, 앞에서 치면 아직 안 보이는 inbox 를 읽고 빈손으로 돌아간다.
 *
 * **던지지 않는다.** 신호는 이미 갔고 사람이 원한 것은 그 턴이 멈추는 것이다. 못 닫았으면 기한·예약 시각이
 * 그 자리를 메운다 — 늦은 대신 틀리지 않는다(중단 라우트의 옛 주석 그대로).
 */
export async function settleCanceledTurn(
  pool: Pool,
  args: { threadRootId: string; agentAccountId: string },
): Promise<SettledCancel> {
  const out: SettledCancel = { woke: [], wakesCanceled: 0 };
  const reportTouched: WakeReportTo[] = [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    out.woke = await cancelDelegationsFor(client, {
      threadRootId: args.threadRootId, accountId: args.agentAccountId,
    });
    out.wakesCanceled = await cancelWakesForTurn(client, {
      threadRootId: args.threadRootId, accountId: args.agentAccountId, reportTouched,
    });
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.error('[cancel] 위임 의무·예약을 닫지 못했다(중단은 이미 보냈다):', err);
    return { woke: [], wakesCanceled: 0 };
  } finally {
    client.release();
  }
  for (const accountId of out.woke) emitEvent({ type: 'inbox.updated', accountId });
  if (reportTouched.length) await announceReportWakes(pool, reportTouched).catch(() => undefined);
  return out;
}

/**
 * 이 스레드에서 `leadId` 가 넘긴 **아직 열린** 의무의 팀원들. `turn.cancel` 의 인가가 이것 하나다 —
 * 일을 넘긴 쪽이 그 일을 거둘 수 있다는 것이지, 남의 턴을 멈출 권한이 아니다. 닫힌 의무(답·기한·중단)는
 * 들지 않는다: 그 팀원은 이제 다른 이유로 그 스레드에서 돌 수 있고, 그 턴은 넘긴 일의 것이 아니다.
 */
export async function openDelegatesOf(
  pool: Pool,
  args: { leadId: string; threadRootId: string },
): Promise<Set<string>> {
  const res = await pool.query<{ delegate_account_id: string }>(
    `select distinct i.delegate_account_id
       from team_delegation d
       join team_delegation_item i on i.delegation_id = d.id
      where d.lead_account_id = $1
        and d.thread_root_id = $2
        and i.outcome is null`,
    [args.leadId, args.threadRootId],
  );
  return new Set(res.rows.map((r) => r.delegate_account_id));
}

/** 허브 중 `turn.cancel` 이 쓰는 두 손잡이. MCP 가 허브 전체를 들지 않게 좁혀 넘긴다. */
export interface TurnCancelHub {
  listSessions(agentAccountIds: readonly string[] | 'all'): AgentSessionView[];
  cancelSession(sessionId: string, byHandle: string): 'ok' | 'not_found' | 'no_runner' | 'runner_outdated';
}
