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
import type { OperatorStatus, OperatorView } from '@harkroom/shared';
import { isMachineDigest } from '@harkroom/shared/operatorProtocol';
import { newToken } from '../auth/tokens.js';
import { can } from '../auth/permissions.js';
import { actorOf, recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { suspendSecretGrants } from '../services/secretAccess.js';
import { createHeartbeat } from '../ws/heartbeat.js';
import type { OperatorHub } from '../ws/operatorHub.js';

const REGISTER_CODE_TTL_MS = 5 * 60_000;
/**
 * `replaces` 는 다시 등록하는 머신이 들고 있던 **옛 operatorId** 다(오퍼레이터 `register` 가
 * `operator.json` 에서 읽어 싣는다). 옛 서버는 zod 가 모르는 키를 걷어 내므로 그대로 무시한다.
 */
const claimBody = z.object({
  code: z.string().startsWith('hkreg_'),
  name: z.string().min(1).max(64),
  replaces: z.string().uuid().optional(),
});
const idParam = z.object({ id: z.string().uuid() });
/**
 * 이름 바꾸기. `label` 은 앞뒤 공백을 자른 뒤 1~64자(등록 이름 상한과 같다). **비우거나 null 이면
 * 호스트명으로 되돌린다** — 화면의 「Use hostname」 과 빈 칸 저장이 같은 요청이다. 같은 이름이 있어도
 * 막지 않는다: 배정은 id 로 고르므로 겹쳐도 틀린 기계를 고르게 되지 않고, 화면이 경고만 띄운다.
 */
const renameBody = z.object({
  label: z.string().max(200).nullable().transform((v) => (v?.trim() ? v.trim() : null))
    .refine((v) => v === null || v.length <= 64, { message: 'label 은 64자까지다' }),
});

const OP_COLS = `id, owner_account_id as "ownerAccountId", name, created_at as "createdAt",
  last_seen_at as "lastSeenAt", revoked_at as "revokedAt", version, label, machine_id as "machineId"`;

/** 허브가 아는 **지금의 사실** — 연결돼 있는가, 무엇을 돌릴 수 있다고 했는가. */
export type OperatorPresence = Pick<OperatorHub, 'isOnline' | 'capabilities' | 'status'>;

/**
 * 박동 가운데 **화면이 바로 알아야 하는 것**만 뽑은 서명 — 이것이 바뀔 때만 `operator.changed` 를 낸다.
 * 박동은 30초마다 오므로 매번 내면 모든 창이 목록을 30초마다 다시 읽는다. 메모리·디스크 숫자는 화면이
 * 열려 있을 때 스스로 다시 읽는다(P7). 턴 수와 자격 증명 상태(「jira 만료 → 멈춤」, H5)는 바로 보여야 한다.
 */
export function statusSignature(status: OperatorStatus): string {
  return JSON.stringify([
    status.turns.running, status.turns.max,
    (status.credentials ?? []).map((c) => `${c.kind}:${c.name}:${c.state}`).sort(),
  ]);
}

/**
 * 등록 코드 저장소. `ws/tickets.ts` 의 코어는 export 돼 있지 않고 접두를 정할 수 없다 —
 * 열다섯 줄을 여기 두는 편이 그 파일의 경계를 흔드는 것보다 낫다. 1회용·TTL 은 같다.
 */
function createRegisterCodes(ttlMs: number) {
  const live = new Map<string, { ownerAccountId: string; codeId: string; expiresAt: number }>();
  return {
    /**
     * `codeId` 는 코드와 따로 뽑은 표다(코드에서 파생하지 않는다) — 이벤트로 퍼져도 코드를 되짚을 수 없다.
     * 화면은 이것으로 「내가 낸 코드로 붙은 operator」를 알아본다(H2).
     */
    issue(claim: { ownerAccountId: string }): { code: string; codeId: string } {
      const code = `hkreg_${randomBytes(16).toString('base64url')}`;
      const codeId = randomBytes(9).toString('base64url');
      live.set(code, { ...claim, codeId, expiresAt: Date.now() + ttlMs });
      return { code, codeId };
    },
    consume(code: string): { ownerAccountId: string; codeId: string } | null {
      const entry = live.get(code);
      live.delete(code); // 있든 없든 지운다 — 두 번째 시도는 언제나 실패다
      if (!entry || entry.expiresAt < Date.now()) return null;
      return { ownerAccountId: entry.ownerAccountId, codeId: entry.codeId };
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
  const view = (row: Omit<OperatorView, 'online'>): OperatorView =>
    ({ ...row, online: presence.isOnline(row.id), status: presence.status(row.id) });

  /**
   * 하트비트. 옛 `/agent-relay` 에 넣었던 것과 같은 배선(b485b9d8; 그 소켓은 단계 3 에서 이 채널로
   * 합쳐졌다) — 프록시가 조용히 걷어간 소켓은
   * close 를 주지 않으므로 pong 부재가 유일한 신호다. 끊으면 close 핸들러가 돌아 허브에서 빠진다.
   */
  const heartbeat = createHeartbeat();
  const beat = setInterval(() => heartbeat.tick(), deps.heartbeatMs ?? 30_000);
  beat.unref?.();
  app.addHook('onClose', async () => { clearInterval(beat); });

  /**
   * hello 의 버전을 적는다(마이그레이션 075). 화면의 러너 뒤처짐 판정 기준이 이 값이다.
   *
   * hello 에 버전이 없으면 **null 로 덮는다** — 옛 오퍼레이터로 되돌아갔는데 예전 값이 남으면
   * 그 값이 거짓 기준이 된다. 바뀌었을 때만 `operator.changed` 를 낸다: 접속 때 이미 한 번
   * 냈고(아래 소켓 배선), 재접속마다 같은 값이면 화면이 목록을 다시 읽을 까닭이 없다.
   */
  const offFrame = deps.hub.onFrame((operatorId, frame) => {
    if (frame.type !== 'hello') return;
    const version = frame.version ?? null;
    void pool.query(
      `update operator set version = $2 where id = $1 and version is distinct from $2 returning id`,
      [operatorId, version])
      .then((res) => { if (res.rowCount) emitEvent({ type: 'operator.changed', operatorId, audience: 'all' }); })
      .catch((err: unknown) => app.log.warn({ err, operatorId }, 'operator version 기록 실패'));
  });
  app.addHook('onClose', async () => { offFrame(); });

  /**
   * 박동(P2a). 숫자는 허브가 든다(`hub.status`) — 여기서는 두 가지만 한다.
   * 1. 머신 digest 를 소유자 id 와 섞어 `operator.machine_id` 에 적는다(H8). 섞기는 SQL 한 문장 안에서
   *    소유자 열로 한다 — 오퍼레이터가 소유자를 말하게 두지 않는다. 바뀌었을 때만 쓰고 알린다.
   * 2. 화면이 바로 알아야 하는 것(`statusSignature`)이 바뀌면 소유자에게 `operator.changed` 를 낸다.
   *    전원(`'all'`)이 아니다 — 남의 턴 수가 오갈 때마다 모든 창이 목록을 다시 읽을 까닭이 없다.
   */
  const lastSignature = new Map<string, string>();
  const offStatus = deps.hub.onFrame((operatorId, frame) => {
    if (frame.type !== 'status') return;
    const status = deps.hub.status(operatorId);
    const signature = status ? statusSignature(status) : null;
    const signatureChanged = signature !== null && lastSignature.get(operatorId) !== signature;
    if (signature !== null) lastSignature.set(operatorId, signature);
    const machine = isMachineDigest(frame.machine) ? frame.machine : null;
    void (async () => {
      let machineChanged = false;
      if (machine) {
        const res = await pool.query(
          `update operator set machine_id = encode(sha256(convert_to(owner_account_id::text || ':' || $2, 'UTF8')), 'hex')
            where id = $1 and machine_id is distinct from encode(sha256(convert_to(owner_account_id::text || ':' || $2, 'UTF8')), 'hex')
            returning id`,
          [operatorId, machine]);
        machineChanged = (res.rowCount ?? 0) > 0;
      }
      if (machineChanged) {
        emitEvent({ type: 'operator.changed', operatorId, audience: 'all' });
      } else if (signatureChanged) {
        const owner = await pool.query<{ owner: string }>(
          `select owner_account_id as owner from operator where id = $1 and revoked_at is null`, [operatorId]);
        if (owner.rows[0]) emitEvent({ type: 'operator.changed', operatorId, audience: [owner.rows[0].owner] });
      }
    })().catch((err: unknown) => app.log.warn({ err, operatorId }, 'operator 박동 처리 실패'));
  });
  // 끊기면 서명을 잊는다 — 다시 붙은 뒤 첫 박동은 언제나 알린다(끊긴 사이 화면은 status: null 을 봤다).
  const offStatusClose = deps.hub.onClose((operatorId) => { lastSignature.delete(operatorId); });
  app.addHook('onClose', async () => { offStatus(); offStatusClose(); });

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

  app.post('/operators/register-codes', { preHandler: app.requireCap('operator.register') }, async (req) => {
    const { code, codeId } = codes.issue({ ownerAccountId: req.account!.id });
    // `codeId` 는 새 키다 — 옛 화면은 모르는 키로 무시한다.
    return { code, codeId, expiresAt: new Date(Date.now() + REGISTER_CODE_TTL_MS).toISOString() };
  });

  // 인증 없음 — 코드가 인증이다. 1회용·5분이라 URL 노출보다 짧게 산다.
  app.post('/operators/claim', async (req, reply) => {
    const parsed = claimBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const claim = codes.consume(parsed.data.code);
    if (!claim) return reply.code(401).send({ error: { code: 'invalid_code', message: '등록 코드가 없거나 만료됐다' } });
    const { token, hash } = newToken('hkop');
    // 새 행과 옛 행 폐기·배정 이동은 한 트랜잭션이다 — 중간에 죽으면 둘 다 없던 일이 된다.
    const client = await pool.connect();
    let row: Omit<OperatorView, 'online'>;
    let replaced: { operatorId: string; movedAgentIds: string[] } | null = null;
    try {
      await client.query('begin');
      const res = await client.query(
        `insert into operator (owner_account_id, name, token_hash) values ($1, $2, $3) returning ${OP_COLS}`,
        [claim.ownerAccountId, parsed.data.name, hash]);
      row = res.rows[0];
      if (parsed.data.replaces) {
        // **코드를 발급한 사람의 것일 때만** 폐기한다. 아니면(남의 id·이미 폐기·없는 id) 조용히
        // 넘어간다 — 무엇이 걸렸는지 말하면 남의 operatorId 가 있는지 떠보는 길이 된다.
        const old = await client.query<{ label: string | null }>(
          `update operator set revoked_at = now()
            where id = $1 and owner_account_id = $2 and revoked_at is null returning label`,
          [parsed.data.replaces, claim.ownerAccountId]);
        if (old.rowCount) {
          // 사람이 붙인 이름도 새 행으로 옮긴다 — 안 옮기면 다시 등록한 순간 이름이 말없이 호스트명으로 돌아간다.
          const label = old.rows[0]!.label;
          if (label !== null) {
            await client.query(`update operator set label = $2 where id = $1`, [row.id, label]);
            row = { ...row, label };
          }
          // 배정은 새 등록으로 옮긴다. 옛 행이 이 사람의 것임을 위에서 확인했으므로 같은 소유 조건 안이다.
          const moved = await client.query<{ agent_id: string }>(
            `update agent_assignment set operator_id = $2 where operator_id = $1 returning agent_id`,
            [parsed.data.replaces, row.id]);
          const movedAgentIds = moved.rows.map((r) => r.agent_id);
          // 옛 operator 에 묶인 비밀 grant 는 세운다(M1, 배정 라우트와 같다) — 소유자가 믿은 것은
          // 그 등록이었다. 다시 주면 풀린다.
          for (const agentId of movedAgentIds) {
            await suspendSecretGrants(client, { agentId, exceptOperatorId: row.id }, 'assignment_changed');
          }
          replaced = { operatorId: parsed.data.replaces, movedAgentIds };
        }
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const operator = view(row);
    // **commit 뒤의 일은 응답을 막지 못한다**(security #1025). 옛 행은 이미 폐기됐고 배정도 옮겨졌다 —
    // 여기서 던져 500 이 나가면 새 토큰이 머신에 가지 않고, 배정은 아무도 토큰을 모르는 새 행에
    // 갇힌다(다시 등록해도 replaces 는 이미 폐기된 옛 id 라 no-op). 그래서 감사·이벤트·소켓 끊기는
    // 실패해도 로그만 남기고 토큰은 언제나 돌려준다. 로그에 토큰을 싣지 않는다.
    // 감사를 트랜잭션 안으로 넣지 않은 이유: `recordAudit` 는 실패를 삼키는데, 트랜잭션 안에서 삼킨
    // 실패는 트랜잭션을 abort 시키고 commit 이 조용히 rollback 이 된다 — 없는 행의 토큰을 주게 된다.
    // 폐기된 토큰의 소켓은 지금 끊는다(`DELETE /operators/:id` 와 같다). 아래 try 의 **앞**이다 — 이벤트
    // 하나가 던져도 끊기는 건너뛰지 않는다(disconnect 는 스스로 던지지 않는다).
    if (replaced) deps.hub.disconnect(replaced.operatorId, 4401, 'operator revoked');
    try {
      // 감사 두 건을 이벤트보다 **먼저** 쓴다 — 구독자 하나가 던져도 옛 토큰 폐기라는 보안 사건이
      // 감사에서 빠지지 않게(security #1025).
      await recordAudit(pool, {
        action: 'operator.registered', actorId: claim.ownerAccountId, actorHandle: null,
        target: operator.id, detail: { name: operator.name, ...(replaced ? { replaces: replaced.operatorId } : {}) },
      }, req);
      if (replaced) {
        await recordAudit(pool, {
          action: 'operator.revoked', actorId: claim.ownerAccountId, actorHandle: null, target: replaced.operatorId,
          detail: { replacedBy: operator.id, movedAssignments: replaced.movedAgentIds.length },
        }, req);
      }
      emitEvent({ type: 'operator.changed', operatorId: operator.id, audience: [claim.ownerAccountId], codeId: claim.codeId });
      if (replaced) {
        emitEvent({ type: 'operator.changed', operatorId: replaced.operatorId, audience: 'all' });
        for (const agentId of replaced.movedAgentIds) emitEvent({ type: 'agent_assignment.changed', agentId, audience: 'all' });
      }
    } catch (err) {
      req.log.warn({ err, operatorId: operator.id, replaces: replaced?.operatorId ?? null }, 'claim 뒤 감사·이벤트 실패 — 응답은 그대로 보낸다');
    }
    // `replaced` 는 클라이언트가 "옛 등록이 정말 폐기됐나"를 아는 유일한 길이다 — 옛 서버는 이 키를
    // 주지 않으므로 화면이 "직접 지워라"로 물러난다. 남의 id 였을 때도 null 이라 구별되지 않는다.
    return { operator, token, replaced: replaced ? { operatorId: replaced.operatorId, movedAssignments: replaced.movedAgentIds.length } : null };
  });

  app.get('/operators', { preHandler: app.requireAccount }, async (req) => {
    const all = await can(pool, req.account!, 'operator.manage');
    const res = await pool.query(
      `select ${OP_COLS} from operator where revoked_at is null and ($1::bool or owner_account_id = $2) order by created_at`,
      [all, req.account!.id]);
    return { operators: res.rows.map(view) };
  });

  app.get('/operators/self', { preHandler: app.requireOperator }, async (req) => view(req.operator!));

  app.get<{ Params: { id: string } }>(
    '/operators/:id/capabilities',
    { preHandler: app.requireCap('operator.manage', { kind: 'operator', param: 'id' }) },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const caps = presence.capabilities(id);
      // 오프라인이면 능력도 없다 — 저장하지 않으므로 "모른다"가 정확한 답이다.
      return caps ?? reply.code(404).send({ error: { code: 'offline', message: '오퍼레이터가 붙어 있지 않다' } });
    });

  /**
   * 이름 바꾸기 — 권한은 폐기와 같다(소유자 또는 `operator.manage`). 이름은 서버가 든 값이라 끊긴
   * 오퍼레이터도 바꿀 수 있다. 같은 값이면 쓰지도, 감사·이벤트를 내지도 않는다.
   */
  app.patch<{ Params: { id: string } }>(
    '/operators/:id',
    { preHandler: app.requireCap('operator.manage', { kind: 'operator', param: 'id' }) },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const parsed = renameBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
      const { label } = parsed.data;
      const res = await pool.query<Omit<OperatorView, 'online'> & { before: string | null }>(
        // 옛 값은 같은 문장에서 읽는다(잠근 뒤) — 감사의 from 과 "바뀌었나" 판정이 한 시점의 값이다.
        `with prev as (select id as prev_id, label as before from operator where id = $1 and revoked_at is null for update)
         update operator set label = $2 from prev where operator.id = prev.prev_id
         returning ${OP_COLS}, prev.before`,
        [id, label]);
      if (!res.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: '그런 오퍼레이터가 없다' } });
      const { before, ...row } = res.rows[0]!;
      if (before !== label) {
        await recordAudit(pool, { action: 'operator.renamed', ...actorOf(req), target: id, detail: { from: before, to: label } }, req);
        emitEvent({ type: 'operator.changed', operatorId: id, audience: 'all' });
      }
      return view(row);
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
      // 폐기한 토큰으로 붙어 있던 소켓을 끊는다. 인증은 붙을 때만 보므로 두면 계속 산다.
      deps.hub.disconnect(id, 4401, 'operator revoked');
      emitEvent({ type: 'operator.changed', operatorId: id, audience: 'all' });
      return reply.code(204).send();
    });
}
