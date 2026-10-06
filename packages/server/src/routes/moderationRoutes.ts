import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { assertChannelVisible } from '../services/channels.js';
import { getMessageById } from '../services/messages.js';

/**
 * 신고와 차단(사용자 생성 콘텐츠 관리, 109).
 *
 * **신고** — 볼 수 있는 메시지만 신고한다(안 보이는 것은 404/403 — 신고 라우트가 존재 확인 통로가 되지
 * 않게). 같은 사람이 같은 메시지를 다시 신고하면 처음 것을 그대로 돌려준다. 관리자가 큐를 읽고
 * 처리를 적는다. 글을 지우는 것은 기존 `DELETE /channels/:id/messages/:messageId` 가 한다 — 지우기 경로를
 * 둘로 만들면 이벤트·스레드 머리 정리가 한쪽에서 빠진다. 여기서는 "지웠다(removed)/그대로 둔다(dismissed)"를
 * 기록만 한다.
 *
 * **차단** — 사람이 자기 목록을 고친다. 효과는 서버 두 곳에서 난다: 차단한 사람에게 상대의 글이 부름(inbox·
 * 푸시)을 만들지 않는다(`insertInbox`), 둘 사이에 새 DM 을 열 수 없다(`POST /dms`). 화면에서 글을 숨기는 것은
 * 앱이 이 목록으로 한다. 상대에게는 알리지 않는다.
 */
export async function registerModerationRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const idParam = z.object({ id: z.string().uuid() });

  app.post('/messages/:id/report', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({
      reason: z.enum(['spam', 'abuse', 'inappropriate', 'other']),
      note: z.string().trim().max(1000).optional(),
    }).parse(req.body);
    const me = req.account!;
    if (me.kind !== 'human') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only people can report messages' } });
    }
    const message = await getMessageById(pool, id);
    if (!message) return reply.code(404).send({ error: { code: 'not_found', message: 'no such message' } });
    if (!(await assertChannelVisible(pool, message.channelId, me.id))) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such message' } });
    }
    if (message.authorId === me.id) {
      return reply.code(400).send({ error: { code: 'own_message', message: 'you cannot report your own message' } });
    }
    const res = await pool.query(
      `insert into message_report (message_id, reporter_id, reason, note) values ($1, $2, $3, $4)
       on conflict (message_id, reporter_id) do nothing
       returning id, created_at as "createdAt"`,
      [id, me.id, body.reason, body.note || null]);
    if (!res.rowCount) {
      const existing = await pool.query(
        `select id, created_at as "createdAt" from message_report where message_id = $1 and reporter_id = $2`, [id, me.id]);
      return reply.code(200).send({ report: existing.rows[0], duplicate: true });
    }
    await recordAudit(pool, {
      action: 'message.reported', actorId: me.id, actorHandle: me.handle, target: id, detail: { reason: body.reason },
    }, req);
    return reply.code(201).send({ report: res.rows[0], duplicate: false });
  });

  /** 관리자 큐. 기본은 처리 안 한 것, 오래된 순. 신고 대상 글의 본문을 함께 준다(관리자는 판단하려고 봐야 한다). */
  app.get('/admin/reports', { preHandler: app.requireAdmin }, async (req) => {
    const q = z.object({ status: z.enum(['open', 'resolved', 'all']).default('open') }).parse(req.query);
    const where = q.status === 'open' ? 'where r.resolved_at is null'
      : q.status === 'resolved' ? 'where r.resolved_at is not null' : '';
    const res = await pool.query(
      `select r.id, r.reason, r.note, r.created_at as "createdAt",
              r.resolved_at as "resolvedAt", r.resolved_by as "resolvedBy", r.resolution,
              r.reporter_id as "reporterId",
              m.id as "messageId", m.channel_id as "channelId", m.thread_root_id as "threadRootId",
              m.author_id as "authorId", case when m.deleted_at is null then m.body end as body,
              m.deleted_at is not null as "messageDeleted"
         from message_report r join message m on m.id = r.message_id
         ${where}
        order by r.created_at asc
        limit 200`);
    return { reports: res.rows };
  });

  app.post('/admin/reports/:id/resolve', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ resolution: z.enum(['dismissed', 'removed']) }).parse(req.body);
    const res = await pool.query(
      `update message_report set resolved_at = now(), resolved_by = $2, resolution = $3
        where id = $1 and resolved_at is null returning message_id as "messageId"`,
      [id, req.account!.id, body.resolution]);
    if (!res.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such open report' } });
    }
    await recordAudit(pool, {
      action: 'message.report.resolved', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { resolution: body.resolution, messageId: res.rows[0].messageId },
    }, req);
    return reply.code(204).send();
  });

  app.get('/accounts/me/blocks', { preHandler: app.requireAccount }, async (req) => {
    const res = await pool.query(
      `select b.blocked_id as "accountId", b.created_at as "createdAt"
         from account_block b where b.blocker_id = $1 order by b.created_at desc`, [req.account!.id]);
    return { blocks: res.rows };
  });

  app.put('/accounts/me/blocks/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const me = req.account!;
    if (me.kind !== 'human') return reply.code(403).send({ error: { code: 'forbidden', message: 'only people can block' } });
    if (id === me.id) return reply.code(400).send({ error: { code: 'self_block', message: 'you cannot block yourself' } });
    const target = await pool.query(`select 1 from account where id = $1`, [id]);
    if (!target.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: 'no such account' } });
    await pool.query(
      `insert into account_block (blocker_id, blocked_id) values ($1, $2) on conflict do nothing`, [me.id, id]);
    return reply.code(204).send();
  });

  app.delete('/accounts/me/blocks/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await pool.query(`delete from account_block where blocker_id = $1 and blocked_id = $2`, [req.account!.id, id]);
    return reply.code(204).send();
  });
}

/** 둘 사이에 어느 쪽이든 차단이 있나 — 새 DM 을 열 때 본다. */
export async function anyBlockBetween(pool: Pool, me: string, others: readonly string[]): Promise<boolean> {
  if (!others.length) return false;
  const res = await pool.query(
    `select 1 from account_block
      where (blocker_id = $1 and blocked_id = any($2::uuid[]))
         or (blocked_id = $1 and blocker_id = any($2::uuid[]))
      limit 1`, [me, others]);
  return Boolean(res.rowCount);
}
