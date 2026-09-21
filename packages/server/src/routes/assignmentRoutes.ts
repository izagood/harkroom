// 배정 — 스펙 2026-09-20-operator-and-permissions §3. "이 에이전트는 어느 오퍼레이터가 도는가"는
// 사람의 결정이라 서버가 기록한다. 능력(무엇을 돌릴 수 있나)은 오퍼레이터가 살아 있을 때의
// 사실이라 허브가 든다. **배정은 양쪽의 동의다**: 서버 쪽에서 고르고(소유자/관리자) ∧
// 오퍼레이터 쪽이 그 에이전트를 능력으로 등록했어야 한다. 한쪽만으로는 성립하지 않는다.
//
// 재배정은 이전 오퍼레이터에 unassign{drain:true} → 새 오퍼레이터에 assign 순서다. 두
// 오퍼레이터가 같은 에이전트를 동시에 돌리는 순간을 만들지 않는다(design.md §1 — 러너가
// 둘이면 멘션을 나눠 집어 간다).
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { actorOf, recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { assignmentOf, definitionFor } from '../services/agents.js';
import type { OperatorHub } from '../ws/operatorHub.js';

const body = z.object({ operatorId: z.string().uuid() });
const idParam = z.object({ id: z.string().uuid() });

export async function registerAssignmentRoutes(app: FastifyInstance, pool: Pool, hub: OperatorHub): Promise<void> {
  /**
   * 오퍼레이터가 붙을 때 그 오퍼레이터의 배정 전부를 다시 민다. 서버는 끊기면 잊고
   * 오퍼레이터는 재접속마다 처음부터다 — 이 재전송이 없으면 서버가 재시작한 뒤 아무도
   * 러너를 띄우지 않는다. hello 는 파싱된 프레임으로 오므로 능력도 이미 허브에 있다.
   */
  hub.onFrame((operatorId, frame) => {
    if (frame.type !== 'hello') return;
    void (async () => {
      const rows = await pool.query<{ agent_id: string }>(
        `select agent_id from agent_assignment where operator_id = $1`, [operatorId]);
      for (const r of rows.rows) {
        const definition = await definitionFor(pool, r.agent_id);
        if (definition) hub.send(operatorId, { type: 'assign', agentId: r.agent_id, definition });
      }
    })().catch(() => { /* 재전송 실패는 다음 hello 가 다시 한다 */ });
  });

  app.put<{ Params: { id: string } }>('/accounts/agents/:id/assignment', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id: agentId } = idParam.parse(req.params);
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const { operatorId } = parsed.data;

    const op = await pool.query<{ owner_account_id: string }>(
      `select owner_account_id from operator where id = $1 and revoked_at is null`, [operatorId]);
    if (!op.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: '그런 오퍼레이터가 없다' } });

    // 소유자는 **자기** 오퍼레이터에만 배정한다. 남의 오퍼레이터에 넣는 것은 그 사람의 머신에
    // 프로세스를 띄우는 일이라 전역 agent.manage 가 필요하다(스펙 §3 배정).
    const mine = op.rows[0]!.owner_account_id === req.account!.id;
    const allowed = mine
      ? await can(pool, req.account!, 'agent.manage', { kind: 'agent', id: agentId })
      : await can(pool, req.account!, 'agent.manage');
    if (!allowed) return reply.code(403).send({ error: { code: 'forbidden', message: '이 에이전트를 그 오퍼레이터에 배정할 권한이 없다' } });

    const caps = hub.capabilities(operatorId);
    if (!caps || !caps.agentIds.includes(agentId)) {
      return reply.code(409).send({
        error: { code: 'not_capable', message: '그 오퍼레이터가 이 에이전트를 돌릴 수 있다고 등록하지 않았다 — 오프라인이거나 로컬 설정에 없다' },
      });
    }

    const definition = await definitionFor(pool, agentId);
    if (!definition) return reply.code(404).send({ error: { code: 'not_found', message: '그런 에이전트가 없다' } });
    // 하네스 능력(스펙 §3). 오퍼레이터가 그 하네스를 **없다고 말했으면** 거절한다 — 배정해 봐야
    // 러너가 살아 있는데 답을 못 하는 조용한 실패다. 말하지 않았으면(옛 오퍼레이터, 빈 표) 모른다.
    const harness = caps.harnesses[definition.harness];
    if (harness && !harness.installed) {
      return reply.code(409).send({
        error: { code: 'harness_missing', message: `그 오퍼레이터의 머신에 ${definition.harness} 가 설치돼 있지 않다` },
      });
    }
    // 교차 불변식(스펙 §7): 개인 자격증명을 쥔 에이전트는 **소유자 자신의** 오퍼레이터에만 간다.
    // 남의 머신에 띄우면 그 사람의 토큰이 남의 프로세스 env 로 들어간다 — admin 도 예외가 아니다.
    // 오퍼레이터도 spawn 전에 같은 검사를 한다(서버만 믿지 않는다).
    if (definition.credentialScope === 'personal' && definition.ownerAccountId !== op.rows[0]!.owner_account_id) {
      return reply.code(403).send({
        error: { code: 'personal_on_foreign_operator', message: '개인 자격증명을 쥔 에이전트는 소유자 자신의 오퍼레이터에만 배정할 수 있다' },
      });
    }

    const previous = await assignmentOf(pool, agentId);
    await pool.query(
      `insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)
       on conflict (agent_id) do update set operator_id = excluded.operator_id, assigned_by = excluded.assigned_by, assigned_at = now()`,
      [agentId, operatorId, req.account!.id]);
    // 순서가 계약이다: 이전 곳이 먼저 놓고(drain), 새 곳이 잡는다.
    if (previous && previous.operatorId !== operatorId) hub.send(previous.operatorId, { type: 'unassign', agentId, drain: true });
    hub.send(operatorId, { type: 'assign', agentId, definition });

    await recordAudit(pool, {
      action: 'agent.assigned', ...actorOf(req), target: agentId,
      detail: { operatorId, previous: previous?.operatorId ?? null },
    }, req);
    emitEvent({ type: 'agent_assignment.changed', agentId, audience: 'all' });
    return assignmentOf(pool, agentId);
  });

  app.delete<{ Params: { id: string } }>(
    '/accounts/agents/:id/assignment',
    { preHandler: app.requireCap('agent.manage', { kind: 'agent', param: 'id' }) },
    async (req, reply) => {
      const { id: agentId } = idParam.parse(req.params);
      const previous = await assignmentOf(pool, agentId);
      if (!previous) return reply.code(404).send({ error: { code: 'not_found', message: '배정이 없다' } });
      await pool.query(`delete from agent_assignment where agent_id = $1`, [agentId]);
      hub.send(previous.operatorId, { type: 'unassign', agentId, drain: true });
      await recordAudit(pool, {
        action: 'agent.unassigned', ...actorOf(req), target: agentId, detail: { operatorId: previous.operatorId },
      }, req);
      emitEvent({ type: 'agent_assignment.changed', agentId, audience: 'all' });
      return reply.code(204).send();
    });
}
