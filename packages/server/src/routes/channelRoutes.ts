import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { assertChannelVisible, createChannel, getOrCreateDm, listChannels, updateChannel, updateChannelPref, listChannelPrefs } from '../services/channels.js';
import { allReadStates, markChannelRead, markChannelUnread, readState } from '../services/readPositions.js';
// 이름 규칙은 데스크탑의 채널 생성 입력(Sidebar.tsx)과 **같은 것**이어야 한다 — 그래서
// 정규식을 여기 리터럴로 두지 않고 shared 의 상수를 쓴다.
import { CHANNEL_NAME_PATTERN } from '@murmur/shared';
import { recordAudit } from '../audit.js';

export async function registerChannelRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post('/channels', { preHandler: app.requireAdmin }, async (req, reply) => {
    const body = z.object({
      name: z.string().regex(new RegExp(CHANNEL_NAME_PATTERN)),
      topic: z.string().max(256).optional(),
      repo: z.string().max(128).optional(),
    }).parse(req.body);
    const channel = await createChannel(pool, body);
    return reply.code(201).send(channel);
  });

  app.patch('/channels/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = z.object({
      topic: z.string().max(256).optional(),
      // null은 바인딩 해제, 키 부재는 그대로 두기 — zod에서도 이 둘을 구분해야 한다.
      repo: z.string().max(128).nullable().optional(),
      archived: z.boolean().optional(),
    }).parse(req.body);
    const channel = await updateChannel(pool, id, req.account!.id, patch);
    if (!channel) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    const isArchive = patch.archived === true;
    const isUnarchive = patch.archived === false;
    if (isArchive) {
      await recordAudit(pool, {
        action: 'channel.archived', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: id, detail: {},
      }, req);
    } else if (isUnarchive) {
      await recordAudit(pool, {
        action: 'channel.unarchived', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: id, detail: {},
      }, req);
    } else {
      await recordAudit(pool, {
        action: 'channel.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: id, detail: { fields: Object.keys(patch).filter((k) => k !== 'archived') },
      }, req);
    }
    return channel;
  });

  app.get('/channels', { preHandler: app.requireAccount }, async () => ({
    channels: await listChannels(pool),
  }));

  // 읽음 위치. 채널 스코프라 여기 둔다(messageRoutes 는 병렬 세션이 첨부파일로 만지는 중이다).
  const channelParam = z.object({ id: z.string().uuid() });

  app.put('/channels/:id/read', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = channelParam.parse(req.params);
    const { seq } = z.object({ seq: z.coerce.number().int().min(0) }).parse(req.body);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    await markChannelRead(pool, { accountId: req.account!.id, channelId: id, seq });
    // 읽음은 내 상태다 — 다른 참여자에게 알리지 않는다. 같은 계정의 다른 기기 동기화는
    // 후속 항목이다(이벤트 유니온은 병렬 세션과 공유하므로 필요할 때 한 번에 넣는다).
    return reply.code(204).send();
  });

  // 미읽음 표시(#154). 읽음 ack 와 **다른 라우트**인 것이 설계의 핵심이다 — 자동 전진과
  // 사람의 명시적 조작이 같은 표면으로 들어오면 서버가 둘을 구분할 수 없다.
  // 게이트는 `/read` 와 같다: 내 상태를 내가 바꾼다.
  app.put('/channels/:id/unread', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = channelParam.parse(req.params);
    // null 은 "표시 지우기"다. **키 부재로 지우기를 표현하지 않는다** — `JSON.stringify` 가
    // `undefined` 키를 버려서 조작이 조용히 무시되는 경로가 된다. 그래서 필수 + nullable 이다.
    // (`coerce` 는 `nullable` 안쪽이라 null 이 0 으로 뭉개지지 않는다.)
    const { seq } = z.object({ seq: z.coerce.number().int().min(1).nullable() }).parse(req.body);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    await markChannelUnread(pool, { accountId: req.account!.id, channelId: id, seq });
    // 읽음과 같은 이유로 다른 참여자에게 알리지 않는다 — 내 상태다.
    return reply.code(204).send();
  });

  // 일괄 조회. 사이드바가 채널마다 묻지 않도록 한 번에 준다.
  app.get('/reads', { preHandler: app.requireAccount }, async (req) => ({
    reads: await allReadStates(pool, req.account!.id),
  }));

  app.get('/channels/:id/read', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = channelParam.parse(req.params);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    return readState(pool, { accountId: req.account!.id, channelId: id });
  });

  app.post('/dms', { preHandler: app.requireAccount }, async (req, reply) => {
    const body = z.object({ accountIds: z.array(z.string().uuid()).min(1).max(16) }).parse(req.body);
    const channel = await getOrCreateDm(pool, [...body.accountIds, req.account!.id]);
    return reply.code(201).send(channel);
  });

  app.get('/channels/prefs', { preHandler: app.requireAccount }, async (req) => ({
    prefs: await listChannelPrefs(pool, req.account!.id),
  }));

  const prefParam = z.object({ id: z.string().uuid() });
  const prefBody = z.object({
    muted: z.boolean().optional(),
    starred: z.boolean().optional(),
  }).strict();

  app.patch('/channels/:id/pref', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = prefParam.parse(req.params);
    const patch = prefBody.parse(req.body);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const pref = await updateChannelPref(pool, req.account!.id, id, patch);
    if (!pref) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    return pref;
  });
}
