import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { emitEvent } from '../events.js';
import { assertChannelVisible, audienceFor, channelPostGate } from '../services/channels.js';
import { deleteMessage, editMessage, getMessageById, hasOlderMessages, listInbox, listMessages, markInboxRead, postMessage, searchMessages } from '../services/messages.js';
import { listSavedMessages, getSavedSummary, saveMessage, unsaveMessage, updateSavedMessageState } from '../services/savedMessages.js';
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
      alsoInChannel: z.boolean().optional(),
    }).refine((v) => v.body.trim().length > 0 || (v.attachmentIds?.length ?? 0) > 0, {
      message: 'a message needs a body or an attachment',
    }).parse(req.body);
    // 가시성과 보관 여부를 한 번에 본다 — 메시지 POST 는 가장 자주 도는 경로라
    // 같은 channel 행을 두 번 읽지 않는다.
    const gate = await channelPostGate(pool, id, req.account!.id);
    if (gate === 'forbidden') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    if (gate === 'archived') {
      return reply.code(403).send({ error: { code: 'channel_archived', message: 'archived channels are read-only' } });
    }
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? null;
    const posted = await postMessage(pool, {
      channelId: id, authorId: req.account!.id, body: body.body,
      threadRootId: body.threadRootId ?? null, idempotencyKey,
      attachmentIds: body.attachmentIds ?? [], alsoInChannel: body.alsoInChannel,
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
      const audience = await audienceFor(pool, id);
      emitEvent({ type: 'message.created', message, audience });
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return reply.code(replayed ? 200 : 201).send(message);
  });

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
    emitEvent({ type: 'message.updated', message: result, audience: await audienceFor(pool, id) });
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
    emitEvent({ type: 'message.deleted', channelId: id, messageId, audience: await audienceFor(pool, id) });
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
    // 스레드 조회는 '더 오래된 것'을 페이지로 돌려주는 경로가 없다 — before 분기가 스레드를
    // 필터하지 않으므로 이 값을 true 로 올리면 클라이언트가 채널 전체를 거슬러 올라간다.
    // 그래서 limit 을 넘는 긴 스레드는 최신 limit 개까지만 보인다(그 창이 오래된 쪽이 아니라
    // 최신 쪽인 것이 이 커밋의 요지다). 스레드 역방향 페이지는 별도 과제다.
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
      accountId: req.account!.id, audience: await audienceFor(pool, id),
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
      accountId: req.account!.id, audience: await audienceFor(pool, id),
    });
    return reply.code(204).send();
  });

  /**
   * 링크가 가리키는 메시지 하나(#178). 채널 경로 아래가 아닌 이유는 링크를 받은 사람이
   * 채널을 모르기 때문이다 — 그것을 알려 주는 것이 이 라우트의 일이다.
   *
   * 순서가 규칙이다: 먼저 읽어 `channelId` 를 얻고, 그 다음에 `assertChannelVisible` 로 묻는다.
   * 남의 DM 메시지는 403 이고 본문은 응답에 실리지 않는다.
   */
  app.get('/messages/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const message = await getMessageById(pool, id);
    // 지워진 메시지도 여기서 404 다 — 서비스가 걸러 null 을 준다. 본문을 주면 삭제가 삭제가 아니다.
    if (!message) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such message' } });
    }
    if (!(await assertChannelVisible(pool, message.channelId, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    return message;
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

  /**
   * #221: `channelId` 가 오면 그 대화 안만 찾는다. 없으면 전과 똑같이 전역이다.
   *
   * 스코프를 준다고 가시성이 느슨해지지 않는다 — 볼 수 없는 채널을 스코프로 주면 403 이다.
   * 술어만으로도 본문은 새지 않지만(빈 200 이 된다) 그러면 "못 보는 채널"과 "일치가 없는
   * 채널"이 구분되지 않는다. 읽기 게이트를 다른 라우트와 **같은 함수**로 명시해 둔다.
   */
  app.get('/search', { preHandler: app.requireAccount }, async (req, reply) => {
    const q = z.object({
      q: z.string().min(1).max(256),
      channelId: z.string().uuid().optional(),
    }).parse(req.query);
    if (q.channelId && !(await assertChannelVisible(pool, q.channelId, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    return { messages: await searchMessages(pool, req.account!.id, q.q, 50, q.channelId ?? null) };
  });

  // #219: 나중에 볼 메시지. 라우트 전부가 **요청자 자신의 행만** 다룬다 — 남의 큐를 가리키는
  // 매개변수가 아예 없다(계정 id 는 토큰에서 오고 경로에는 messageId 만 있다).
  app.get('/saved', { preHandler: app.requireAccount }, async (req) => {
    const q = z.object({ state: z.enum(['open', 'done']).optional() }).parse(req.query);
    return { entries: await listSavedMessages(pool, req.account!.id, q.state ?? 'open') };
  });

  // 사이드바 배지(open 개수)와 `⋯` 메뉴 문구(담겼는가)를 한 왕복으로 받는다.
  app.get('/saved/summary', { preHandler: app.requireAccount }, async (req) => {
    return getSavedSummary(pool, req.account!.id);
  });

  app.put('/saved/:messageId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { messageId } = z.object({ messageId: z.string().uuid() }).parse(req.params);
    const result = await saveMessage(pool, { accountId: req.account!.id, messageId });
    // 없는(또는 이미 지워진) 메시지와 **볼 수 없는** 메시지를 나눠 답한다 — 후자는 403 이다(#219 결정 2).
    if (result === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'message not found' } });
    }
    if (result === 'forbidden') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    return result;
  });

  app.patch('/saved/:messageId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { messageId } = z.object({ messageId: z.string().uuid() }).parse(req.params);
    const { state } = z.object({ state: z.enum(['open', 'done']) }).parse(req.body);
    const result = await updateSavedMessageState(pool, { accountId: req.account!.id, messageId, state });
    if (result === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'saved message not found' } });
    }
    return result;
  });

  app.delete('/saved/:messageId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { messageId } = z.object({ messageId: z.string().uuid() }).parse(req.params);
    const result = await unsaveMessage(pool, { accountId: req.account!.id, messageId });
    if (result === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'saved message not found' } });
    }
    return reply.code(204).send();
  });
}
