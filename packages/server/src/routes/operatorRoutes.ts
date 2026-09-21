// 오퍼레이터 신원 — 스펙 2026-09-20-operator-and-permissions §3.
//
// 오퍼레이터는 사람의 기기다. 등록 흐름: 사람이 [기기 등록] → 서버가 일회용 등록 코드(5분)
// → 그 머신의 오퍼레이터가 코드를 장기 토큰으로 교환 → OS 키체인. 코드는 URL 로 오가지
// 않고 사람이 옮긴다(데스크탑이 있으면 앱이 unix 소켓으로 대신 넘긴다).
//
// **"소유자 또는 operator.manage"** 는 `requireCap('operator.manage', { kind: 'operator' })`
// 하나로 표현된다 — `can()` 의 소유 분기가 소유자를 통과시키고, grant·역할 분기가 관리자를
// 통과시킨다. 라우트가 두 판정을 따로 쓰면 그것이 곧 판정 복제다(#253).
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { OperatorView } from '@harkroom/shared';
import { newToken } from '../auth/tokens.js';
import { mintPat } from '../services/pats.js';
import { can } from '../auth/permissions.js';
import { actorOf, recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { createHeartbeat } from '../ws/heartbeat.js';
import type { OperatorHub } from '../ws/operatorHub.js';

const REGISTER_CODE_TTL_MS = 5 * 60_000;
const claimBody = z.object({ code: z.string().startsWith('hkreg_'), name: z.string().min(1).max(64) });
const idParam = z.object({ id: z.string().uuid() });

const OP_COLS = `id, owner_account_id as "ownerAccountId", name, created_at as "createdAt",
  last_seen_at as "lastSeenAt", revoked_at as "revokedAt"`;

/** 허브가 아는 **지금의 사실** — 연결돼 있는가, 무엇을 돌릴 수 있다고 했는가. */
export type OperatorPresence = Pick<OperatorHub, 'isOnline' | 'capabilities'>;

/**
 * 등록 코드 저장소. `ws/tickets.ts` 의 코어는 export 돼 있지 않고 접두를 정할 수 없다 —
 * 열다섯 줄을 여기 두는 편이 그 파일의 경계를 흔드는 것보다 낫다. 1회용·TTL 은 같다.
 */
function createRegisterCodes(ttlMs: number) {
  const live = new Map<string, { ownerAccountId: string; expiresAt: number }>();
  return {
    issue(claim: { ownerAccountId: string }): string {
      const code = `hkreg_${randomBytes(16).toString('base64url')}`;
      live.set(code, { ...claim, expiresAt: Date.now() + ttlMs });
      return code;
    },
    consume(code: string): { ownerAccountId: string } | null {
      const entry = live.get(code);
      live.delete(code); // 있든 없든 지운다 — 두 번째 시도는 언제나 실패다
      if (!entry || entry.expiresAt < Date.now()) return null;
      return { ownerAccountId: entry.ownerAccountId };
    },
  };
}

export interface OperatorRoutesDeps {
  hub: OperatorHub;
  /** 소켓 ping 주기(ms). `/ws`·릴레이와 **같은 값**을 받는다(`wsHeartbeatMs`) — 갈라지면 수명이 갈린다. */
  heartbeatMs?: number;
}

export async function registerOperatorRoutes(app: FastifyInstance, pool: Pool, deps: OperatorRoutesDeps): Promise<void> {
  const codes = createRegisterCodes(REGISTER_CODE_TTL_MS);
  const presence: OperatorPresence = deps.hub;
  const view = (row: Omit<OperatorView, 'online'>): OperatorView => ({ ...row, online: presence.isOnline(row.id) });

  /**
   * 하트비트. 옛 `/agent-relay` 에 넣었던 것과 같은 배선(b485b9d8; 그 소켓은 단계 3 에서 이 채널로
   * 합쳐졌다) — 프록시가 조용히 걷어간 소켓은
   * close 를 주지 않으므로 pong 부재가 유일한 신호다. 끊으면 close 핸들러가 돌아 허브에서 빠진다.
   */
  const heartbeat = createHeartbeat();
  const beat = setInterval(() => heartbeat.tick(), deps.heartbeatMs ?? 30_000);
  beat.unref?.();
  app.addHook('onClose', async () => { clearInterval(beat); });

  app.get('/operator', { websocket: true, preHandler: app.requireOperator }, (socket, req) => {
    const operatorId = req.operator!.id;
    const detach = deps.hub.addOperator(operatorId, socket);
    heartbeat.track(socket);
    socket.on('pong', () => heartbeat.pong(socket));
    socket.on('message', (raw) => {
      // 프레임 도착 = 생존. last_seen_at 은 "마지막으로 말한 때"이고 실패해도 흐름을 막지 않는다.
      void pool.query(`update operator set last_seen_at = now() where id = $1`, [operatorId]).catch(() => {});
      deps.hub.onOperatorMessage(operatorId, String(raw));
    });
    socket.on('close', () => {
      heartbeat.untrack(socket);
      detach();
      emitEvent({ type: 'operator.changed', operatorId, audience: 'all' });
    });
    emitEvent({ type: 'operator.changed', operatorId, audience: 'all' });
  });

  app.post('/operators/register-codes', { preHandler: app.requireCap('operator.register') }, async (req) => ({
    code: codes.issue({ ownerAccountId: req.account!.id }),
    expiresAt: new Date(Date.now() + REGISTER_CODE_TTL_MS).toISOString(),
  }));

  // 인증 없음 — 코드가 인증이다. 1회용·5분이라 URL 노출보다 짧게 산다.
  app.post('/operators/claim', async (req, reply) => {
    const parsed = claimBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const claim = codes.consume(parsed.data.code);
    if (!claim) return reply.code(401).send({ error: { code: 'invalid_code', message: '등록 코드가 없거나 만료됐다' } });
    const { token, hash } = newToken('hkop');
    const res = await pool.query(
      `insert into operator (owner_account_id, name, token_hash) values ($1, $2, $3) returning ${OP_COLS}`,
      [claim.ownerAccountId, parsed.data.name, hash]);
    const operator = view(res.rows[0]);
    await recordAudit(pool, {
      action: 'operator.registered', actorId: claim.ownerAccountId, actorHandle: null,
      target: operator.id, detail: { name: operator.name },
    }, req);
    emitEvent({ type: 'operator.changed', operatorId: operator.id, audience: [claim.ownerAccountId] });
    return { operator, token };
  });

  app.get('/operators', { preHandler: app.requireAccount }, async (req) => {
    const all = await can(pool, req.account!, 'operator.manage');
    const res = await pool.query(
      `select ${OP_COLS} from operator where revoked_at is null and ($1::bool or owner_account_id = $2) order by created_at`,
      [all, req.account!.id]);
    return { operators: res.rows.map(view) };
  });

  app.get('/operators/self', { preHandler: app.requireOperator }, async (req) => view(req.operator!));

  /**
   * **단계 2~3 한정.** 러너가 아직 PAT 로 서버에 직접 붙는 동안, 그 PAT 을 데스크탑 키체인
   * 대신 오퍼레이터가 받아 간다 — 배정된 에이전트 것만. 단계 4(배정이 곧 인가)에서 이 라우트를
   * 지운다: 그때부터 러너는 PAT 을 갖지 않는다.
   */
  app.post<{ Params: { agentId: string } }>('/operator/agents/:agentId/pat', { preHandler: app.requireOperator }, async (req, reply) => {
    const { agentId } = z.object({ agentId: z.string().uuid() }).parse(req.params);
    const assigned = await pool.query(
      `select 1 from agent_assignment where agent_id = $1 and operator_id = $2`, [agentId, req.operator!.id]);
    if (!assigned.rowCount) {
      return reply.code(403).send({ error: { code: 'not_assigned', message: '이 오퍼레이터에 배정된 에이전트가 아니다' } });
    }
    // 라벨에 오퍼레이터 id 를 박는다 — 같은 오퍼레이터가 다시 받으면 앞 것을 폐기하고 새로 낸다.
    const label = `operator:${req.operator!.id}`;
    await pool.query(`update pat set revoked_at = now() where account_id = $1 and label = $2 and revoked_at is null`, [agentId, label]);
    const minted = await mintPat(pool, agentId, label, { actorId: null, actorHandle: `operator:${req.operator!.name}` }, req);
    if (!minted.ok) return reply.code(409).send({ error: { code: 'label_in_use', message: '발급 경합' } });
    return { token: minted.token };
  });

  app.get<{ Params: { id: string } }>(
    '/operators/:id/capabilities',
    { preHandler: app.requireCap('operator.manage', { kind: 'operator', param: 'id' }) },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const caps = presence.capabilities(id);
      // 오프라인이면 능력도 없다 — 저장하지 않으므로 "모른다"가 정확한 답이다.
      return caps ?? reply.code(404).send({ error: { code: 'offline', message: '오퍼레이터가 붙어 있지 않다' } });
    });

  app.delete<{ Params: { id: string } }>(
    '/operators/:id',
    { preHandler: app.requireCap('operator.manage', { kind: 'operator', param: 'id' }) },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const res = await pool.query(
        `update operator set revoked_at = now() where id = $1 and revoked_at is null returning id`, [id]);
      if (!res.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: '그런 오퍼레이터가 없다' } });
      await recordAudit(pool, { action: 'operator.revoked', ...actorOf(req), target: id, detail: {} }, req);
      emitEvent({ type: 'operator.changed', operatorId: id, audience: 'all' });
      return reply.code(204).send();
    });
}
