import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { emitEvent } from '../events.js';
import { assertChannelVisible, dmMemberIds } from '../services/channels.js';
import { deleteMessage, editMessage, hasOlderMessages, listInbox, listMessages, markInboxRead, postMessage, searchMessages } from '../services/messages.js';
import { recordAudit } from '../audit.js';
import { addReaction, isEmoji, MAX_REACTIONS_PER_ACTOR, removeReaction } from '../services/reactions.js';

export async function registerMessageRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post('/channels/:id/messages', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      // 첨부만 보내는 것은 자연스럽다 — 그때 본문은 빈 문자열이다.
      body: z.string().max(8000),
      threadRootId: z.string().uuid().optional(),
      attachmentIds: z.array(z.string().uuid()).max(10).optional(),
    }).refine((v) => v.body.trim().length > 0 || (v.attachmentIds?.length ?? 0) > 0, {
      message: 'a message needs a body or an attachment',
    }).parse(req.body);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? null;
    const posted = await postMessage(pool, {
      channelId: id, authorId: req.account!.id, body: body.body,
      threadRootId: body.threadRootId ?? null, idempotencyKey,
      attachmentIds: body.attachmentIds ?? [],
    });
    if (posted.failure) {
      // 세 사유를 400 하나로 합친다 — 어느 쪽인지 알려 주면 남의 업로드 id 의 존재 여부를
      // 확인하는 신호가 된다(not_found 와 not_yours 가 구분되면 그렇다).
      return reply.code(400).send({
        error: { code: 'bad_attachment', message: 'attachments must be your own, unused uploads' },
      });
    }
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const channel = await pool.query(`select kind from channel where id = $1`, [id]);
      const audience: 'all' | string[] =
        channel.rows[0]?.kind === 'dm' ? await dmMemberIds(pool, id) : 'all';
      emitEvent({ type: 'message.created', message, audience });
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return reply.code(replayed ? 200 : 201).send(message);
  });

  /** 채널 kind 에 따른 이벤트 수신자. DM 은 멤버에게만 간다. */
  const audienceFor = async (channelId: string): Promise<'all' | string[]> => {
    const channel = await pool.query(`select kind from channel where id = $1`, [channelId]);
    return channel.rows[0]?.kind === 'dm' ? await dmMemberIds(pool, channelId) : 'all';
  };

  app.patch('/channels/:id/messages/:messageId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, messageId } = z.object({
      id: z.string().uuid(), messageId: z.string().uuid(),
    }).parse(req.params);
    const { body } = z.object({ body: z.string().min(1).max(8000) }).parse(req.body);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }

    const result = await editMessage(pool, { channelId: id, messageId, actorId: req.account!.id, body });
    if (result === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such message' } });
    }
    if (result === 'forbidden') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only the author can edit a user message' } });
    }
    emitEvent({ type: 'message.updated', message: result, audience: await audienceFor(id) });
    return result;
  });

  app.delete('/channels/:id/messages/:messageId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, messageId } = z.object({
      id: z.string().uuid(), messageId: z.string().uuid(),
    }).parse(req.params);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }

    const result = await deleteMessage(pool, {
      channelId: id, messageId, actorId: req.account!.id, actorIsAdmin: req.account!.isAdmin,
    });
    if (result === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such message' } });
    }
    if (result === 'forbidden') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only the author or an admin can delete' } });
    }
    emitEvent({ type: 'message.deleted', channelId: id, messageId, audience: await audienceFor(id) });
    // 본문은 남기지 않는다 — 감사에 복사하면 삭제가 삭제가 아니다.
    await recordAudit(pool, {
      action: 'message.deleted', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: messageId, detail: { channelId: id },
    }, req);
    return reply.code(204).send();
  });

  app.get('/channels/:id/messages', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({
      since: z.coerce.number().int().min(0).optional(),
      before: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      thread: z.string().uuid().optional(),
    }).refine((v) => v.before === undefined || v.since === undefined, {
      // 서로 반대 방향이다. 함께 오면 어느 쪽을 의도했는지 서버가 고를 수 없다.
      message: 'before and since are opposite directions — send one',
    }).parse(req.query);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const messages = await listMessages(pool, id, {
      since: q.since, before: q.before, limit: q.limit, threadRootId: q.thread ?? null,
    });
    // 스레드 조회에는 '더 오래된 것'이라는 개념이 없다(루트 + 답글 전체가 한 묶음이다).
    const hasMore = q.thread
      ? false
      : messages.length > 0 && (await hasOlderMessages(pool, id, messages[0]!.seq));
    return { messages, hasMore };
  });

  /** 리액션 경로의 공통 검증. 이모지 판정과 채널 접근을 두 핸들러가 똑같이 해야 한다. */
  const reactionParams = z.object({
    id: z.string().uuid(), messageId: z.string().uuid(), emoji: z.string().min(1).max(32),
  });

  app.put('/channels/:id/messages/:messageId/reactions/:emoji', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, messageId, emoji } = reactionParams.parse(req.params);
    if (!isEmoji(emoji)) {
      // 임의 문자열을 받으면 리액션이 길이 제한도 검열도 없는 두 번째 본문 필드가 된다.
      return reply.code(400).send({ error: { code: 'bad_request', message: 'a reaction must be a single emoji' } });
    }
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }

    const result = await addReaction(pool, { channelId: id, messageId, accountId: req.account!.id, emoji });
    if (result === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such message in this channel' } });
    }
    if (result === 'too_many') {
      return reply.code(409).send({
        code: 'too_many_reactions',
        error: { code: 'too_many_reactions', message: `at most ${MAX_REACTIONS_PER_ACTOR} reactions per message` },
      });
    }
    emitEvent({
      type: 'reaction.added', channelId: id, messageId, emoji,
      accountId: req.account!.id, audience: await audienceFor(id),
    });
    return reply.code(200).send({ emoji });
  });

  app.delete('/channels/:id/messages/:messageId/reactions/:emoji', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, messageId, emoji } = reactionParams.parse(req.params);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }

    // 없는 것을 떼는 것도 성공이다 — 결과 상태가 같으니 재시도가 안전하다. 그래서 404 를 보지
    // 않고, 메시지 존재 확인도 하지 않는다(존재를 확인해 주면 없는 메시지 탐색 경로가 된다).
    await removeReaction(pool, { messageId, accountId: req.account!.id, emoji });
    emitEvent({
      type: 'reaction.removed', channelId: id, messageId, emoji,
      accountId: req.account!.id, audience: await audienceFor(id),
    });
    return reply.code(204).send();
  });

  app.get('/inbox', { preHandler: app.requireAccount }, async (req) => {
    const q = z.object({ unread: z.coerce.boolean().optional() }).parse(req.query);
    return { entries: await listInbox(pool, req.account!.id, { unreadOnly: q.unread ?? false }) };
  });

  app.post('/inbox/read', { preHandler: app.requireAccount }, async (req, reply) => {
    const body = z.object({ ids: z.array(z.number().int()).min(1) }).parse(req.body);
    await markInboxRead(pool, req.account!.id, body.ids);
    return reply.code(204).send();
  });

  app.get('/search', { preHandler: app.requireAccount }, async (req) => {
    const q = z.object({ q: z.string().min(1).max(256) }).parse(req.query);
    return { messages: await searchMessages(pool, req.account!.id, q.q) };
  });
}
