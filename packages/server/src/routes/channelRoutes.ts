import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { StorageBackend } from '../storage/local.js';
import { z } from 'zod';
import {
  addChannelMember, assertChannelVisible, audienceFor, channelPostGate, createChannel, deleteChannel, getOrCreateDm,
  listChannelMembers, listChannels, removeChannelMember, updateChannel, updateChannelPref,
  listChannelPrefs,
} from '../services/channels.js';
import { listPins, pinMessage, unpinMessage } from '../services/pins.js';
import { allReadStates, markChannelRead, markChannelUnread, readState } from '../services/readPositions.js';
// 이름 규칙은 데스크탑의 채널 생성 입력(Sidebar.tsx)과 **같은 것**이어야 한다 — 그래서
// 정규식을 여기 리터럴로 두지 않고 shared 의 상수를 쓴다.
import { CHANNEL_NAME_PATTERN, NOTIFY_LEVELS } from '@murmur/shared';
import { recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';

export async function registerChannelRoutes(app: FastifyInstance, pool: Pool, storage?: StorageBackend): Promise<void> {
  app.post('/channels', { preHandler: app.requireAdmin }, async (req, reply) => {
    const body = z.object({
      name: z.string().regex(new RegExp(CHANNEL_NAME_PATTERN)),
      topic: z.string().max(256).optional(),
      repo: z.string().max(128).optional(),
      // 키가 없으면 public 이다 — 기존 호출부(부트스트랩·데스크탑의 기존 경로)가 그대로 돈다.
      visibility: z.enum(['public', 'private']).optional(),
    }).parse(req.body);
    // private 이면 만든 사람이 첫 멤버다. 이 인자를 빠뜨리면 아무도 열 수 없는 채널이 생긴다.
    const channel = await createChannel(pool, { ...body, creatorId: req.account!.id });
    const audience = await audienceFor(pool, channel.id);
    emitEvent({ type: 'channel.created', channel, audience });
    return reply.code(201).send(channel);
  });

  app.patch('/channels/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = z.object({
      topic: z.string().max(256).optional(),
      // null은 바인딩 해제, 키 부재는 그대로 두기 — zod에서도 이 둘을 구분해야 한다.
      repo: z.string().max(128).nullable().optional(),
      archived: z.boolean().optional(),
      visibility: z.enum(['public', 'private']).optional(),
    }).parse(req.body);

    // 비공개화 전환을 처리하려면 기존 채널의.visibility 를 미리 읽어야 한다.
    const oldChannel = patch.visibility !== undefined
      ? await pool.query(`select visibility from channel where id = $1`, [id])
      : null;
    const wasPublic = oldChannel?.rows[0]?.visibility === 'public';

    const channel = await updateChannel(pool, id, req.account!.id, patch);
    if (!channel) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }

    // 비공개화 전환(#284): public→private 일 때 기존 비멤버에게 channel.deleted 를 보내고,
    // 멤버에게는 channel.updated 를 보낸다. public→private 은 그 사람에게 채널이 사라진 것이기 때문이다.
    // public 채널은 멤버가 없을 수 있으므로, 변경을 시작한 계정(actor)도 포함한다.
    if (wasPublic && patch.visibility === 'private') {
      const currentMembers = await audienceFor(pool, id);
      const isCurrentMembersAll = currentMembers === 'all';
      const membersArray = isCurrentMembersAll ? [] : currentMembers;
      // 채널을 변경한 계정도 포함 — public→private 전환 시 创建자는 명시적 멤버가 아닐 수 있다.
      const audienceSet = new Set([...membersArray, req.account!.id]);
      const audience = [...audienceSet];
      // 전원에게 channel.deleted — 비멤버는 필터에서 걸러진다.
      emitEvent({ type: 'channel.deleted', channelId: id, audience: 'all' });
      // 변경한 계정을 포함한 멤버에게 channel.updated
      emitEvent({ type: 'channel.updated', channel, audience });
    } else {
      const audience = await audienceFor(pool, id);
      emitEvent({ type: 'channel.updated', channel, audience });
    }

    // 공개 범위 전환은 별도 감사 항목이다 — 채널 하나가 통째로 열리거나 닫히는 사건이라
    // 'channel.updated' 의 필드 목록에 섞여 있으면 나중에 골라낼 수 없다. topic 과 함께
    // 온 경우에도 둘 다 남긴다(아래 else 가 나머지 필드를 계속 기록한다).
    if (patch.visibility !== undefined) {
      await recordAudit(pool, {
        action: 'channel.visibility.changed', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: id, detail: { visibility: patch.visibility },
      }, req);
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
      const fields = Object.keys(patch).filter((k) => k !== 'archived' && k !== 'visibility');
      // visibility 만 온 요청은 위에서 이미 기록했다 — 빈 필드 목록의 'channel.updated' 를
      // 덧붙이면 감사 로그에 아무것도 안 바뀐 항목이 하나 더 생긴다.
      if (fields.length) {
        await recordAudit(pool, {
          action: 'channel.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
          target: id, detail: { fields },
        }, req);
      }
    }
    return channel;
  });

  app.get('/channels', { preHandler: app.requireAccount }, async (req) => ({
    channels: await listChannels(pool, req.account!.id, req.account!.isAdmin),
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

  /**
   * 멤버 목록. private 채널에서는 **admin 도 볼 수 있다** — 목록에서 보이는 채널의
   * "누가 있나"까지는 운영에 필요하다(#182 의 절충). 메시지는 여전히 못 본다.
   */
  app.get('/channels/:id/members', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = channelParam.parse(req.params);
    const exists = await pool.query(`select 1 from channel where id = $1`, [id]);
    if (!exists.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    if (!req.account!.isAdmin && !(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    return { members: await listChannelMembers(pool, id) };
  });

  /**
   * 초대. **admin 전용이 아니다** — 그 채널의 멤버라면 누구나 부를 수 있다.
   *
   * 게이트가 `assertChannelVisible` 인 것이 핵심이다: private 채널에서는 그 술어가 곧
   * 멤버십이므로 "남의 private 채널에 사람을 밀어 넣기"가 막히고, public 채널에서는 누구나
   * 통과하므로 초대가 필요 없다는 결정이 그대로 성립한다(멤버십은 구독일 뿐이다).
   * admin 이라는 이유로 열지 않는다 — admin 도 자기가 없는 private 채널에는 못 부른다.
   */
  app.post('/channels/:id/members', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = channelParam.parse(req.params);
    const { accountId } = z.object({ accountId: z.string().uuid() }).parse(req.body);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    // 존재하지 않는 계정은 FK 위반으로 500 이 된다 — 잘못된 입력을 서버 오류로 답하면
    // 호출부가 재시도할 대상인지 아닌지 구분하지 못한다.
    const account = await pool.query(`select 1 from account where id = $1`, [accountId]);
    if (!account.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such account' } });
    }
    await addChannelMember(pool, id, accountId);
    await recordAudit(pool, {
      action: 'channel.member.added', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { accountId },
    }, req);
    return { members: await listChannelMembers(pool, id) };
  });

  /**
   * 나가기/내보내기.
   *
   * 자기 자신은 언제나 뺄 수 있다 — 나가기를 막을 이유가 없고, 막으면 private 채널이
   * 편도가 된다. 남을 빼는 것은 admin 만이다: 멤버 누구나 서로를 뺄 수 있으면
   * 초대한 사람이 초대한 사람을 지우는 경합이 생긴다.
   *
   * 마지막 멤버가 나가도 채널 행은 남는다(#155 의 캐스케이드 결정 전까지). 그 상태는
   * admin 만 목록에서 보는 채널이 되므로, 화면이 나가기 전에 그 사실을 알린다.
   */
  app.delete('/channels/:id/members/:accountId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, accountId } = z.object({
      id: z.string().uuid(), accountId: z.string().uuid(),
    }).parse(req.params);
    const isSelf = accountId === req.account!.id;
    if (!isSelf && !req.account!.isAdmin) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only admin can remove others' } });
    }
    // 자기 자신을 뺄 때도 그 채널을 볼 수 있어야 한다 — 볼 수 없는 채널에 대한 조작이
    // 성공/실패로 갈리면 그 응답 자체가 채널의 존재를 알려 준다.
    if (isSelf && !(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    const removed = await removeChannelMember(pool, id, accountId);
    if (removed) {
      await recordAudit(pool, {
        action: 'channel.member.removed', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: id, detail: { accountId },
      }, req);
    }
    return { members: await listChannelMembers(pool, id) };
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
  // `muted` 는 받지 않는다 — `notifyLevel` 이 그 자리를 대체했다(#224). 아무것도 읽지 않는
  // 스위치를 남겨 두면 "껐는데 왜 아직도 울리나"가 그대로 돌아온다(#229 가 그 모양이었다).
  const prefBody = z.object({
    // 값의 목록은 `NOTIFY_LEVELS` 하나뿐이다 — 여기에 다시 적으면 수준이 늘어날 때
    // 한쪽만 고쳐 API 가 새 값을 400 으로 막는다.
    notifyLevel: z.enum(NOTIFY_LEVELS).optional(),
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

  /**
   * 고정된 메시지들(#218). **채널 전역 상태**라 계정별 선호(`/channels/:id/pref`)가 아니라
   * 채널 자원 아래에 있다 — 보관(#153)과 같은 층이다.
   *
   * 가시성은 그 채널의 규칙을 그대로 따른다: 채널을 볼 수 없으면 핀 목록도 못 본다.
   * 여기서 판정을 다시 쓰지 않고 `assertChannelVisible` 을 부르는 이유는, 같은 계산이 두
   * 곳에 생기면 한쪽만 고쳐서 DM 본문이 핀 목록으로 새기 때문이다.
   */
  app.get('/channels/:id/pins', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = channelParam.parse(req.params);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    return { pins: await listPins(pool, id) };
  });

  /**
   * 고정한다. **그 채널에 글을 쓸 수 있는 사람 누구나** 할 수 있다 — admin 전용이 아니다.
   * 핀은 대화 행위이지 관리 행위가 아니다(보관이 admin 인 이유는 그것이 사람들이 글을 쓸 수 있는지를
   * 바꾸기 때문인데, 핀은 아무것도 막지 않는다).
   *
   * 그래서 게이트가 `channelPostGate` 다: "글을 쓸 수 있는가"가 곧 "고정할 수 있는가"이고,
   * 보관된 채널이 읽기 전용이라는 판정도 그 함수 하나에만 있어야 한다.
   */
  app.post('/channels/:id/pins', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = channelParam.parse(req.params);
    const { messageId } = z.object({ messageId: z.string().uuid() }).parse(req.body);
    const gate = await channelPostGate(pool, id, req.account!.id);
    if (gate === 'forbidden') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    if (gate === 'archived') {
      return reply.code(403).send({ error: { code: 'channel_archived', message: 'archived channels are read-only' } });
    }
    const pin = await pinMessage(pool, { channelId: id, messageId, actorId: req.account!.id });
    if (pin === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such message in this channel' } });
    }
    // 본문은 남기지 않는다 — 감사에 복사하면 그 메시지를 지워도 본문이 감사에 남는다.
    await recordAudit(pool, {
      action: 'message.pinned', actorId: req.account!.id, actorHandle: req.account!.handle,
      // target 이 채널인 이유: 핀은 채널 전역 상태이고, 어느 메시지였는지는 detail 이 말한다.
      target: id, detail: { messageId },
    }, req);
    return reply.code(201).send(pin);
  });

  /**
   * 해제한다. **고정한 사람 또는 admin 만** — 서비스가 그 판정을 한다.
   *
   * 게이트가 `channelPostGate` 가 아니라 `assertChannelVisible` 인 것이 고정과 다른 점이다.
   * 보관된 채널에서도 잘못 올라간 핀은 치울 수 있어야 한다 — `channelPostGate` 주석이 편집·
   * 삭제·리액션을 같은 이유로 제외해 뒀고, 해제는 그쪽(치우기)에 속한다.
   */
  app.delete('/channels/:id/pins/:messageId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, messageId } = z.object({
      id: z.string().uuid(), messageId: z.string().uuid(),
    }).parse(req.params);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const result = await unpinMessage(pool, {
      channelId: id, messageId, actorId: req.account!.id, actorIsAdmin: req.account!.isAdmin,
    });
    if (result === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'that message is not pinned here' } });
    }
    if (result === 'forbidden') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only the person who pinned it, or an admin, can unpin' } });
    }
    await recordAudit(pool, {
      action: 'message.unpinned', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { messageId },
    }, req);
    return reply.code(204).send();
  });

  /**
   * 채널 삭제(#155). **보관된 표준 채널만** 삭제 가능하고, **admin 만** 할 수 있다.
   *
   * DM 은 삭제할 수 없다 — kind = 'standard' 만 대상이다.
   * 보관되지 않은 채널은 409 로 거절한다 — 삭제 전에 보관이 선행 조건이다.
   *
   * 삭제 대상 테이블( channel_id 또는 message_id 로 참조하는 전부):
   *   - attachment (message_id 로 참조, cascade)
   *   - message_reaction (message_id 로 참조, cascade)
   *   - message_pin (channel_id 로 직접 참조)
   *   - channel_read (channel_id 로 직접 참조)
   *   - channel_member (channel_id 로 직접 참조)
   *   - channel_pref (channel_id 로 직접 참조)
   *   - message (channel_id 로 직접 참조)
   *   - channel (자신)
   *
   * 확인 문구에 지울 메시지 수를 보여 준다.
   */
  app.delete('/channels/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // 삭제 전 수신자를 미리 구한다 — 삭제 후에는 채널이 존재하지 않아 audienceFor 가 'all'을 반환한다.
    const audience = await audienceFor(pool, id);
    const result = await deleteChannel(pool, id, storage);
    if (result === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    if (result === 'is_dm') {
      return reply.code(409).send({ error: { code: 'cannot_delete_dm', message: 'DMs cannot be deleted' } });
    }
    if (result === 'not_archived') {
      return reply.code(409).send({ error: { code: 'not_archived', message: 'only archived channels can be deleted' } });
    }
    // 삭제 전 구한 수신자에게 channel.deleted 를 보낸다 — 트랜잭션 커밋 뒤이므로
    // 수신자가 채널을 조회해도 없는 상태다.
    emitEvent({ type: 'channel.deleted', channelId: id, audience });
    // 감사에 이름과 개수만 남기고 본문·topic 은 절대 넣지 않는다 — 지운 것이 감사에 남으면 삭제가 아니다.
    await recordAudit(pool, {
      action: 'channel.deleted', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { name: result.name, messageCount: result.messageCount, attachmentCount: result.attachmentCount },
    }, req);
    return reply.code(204).send();
  });

  /**
   * 채널 삭제 전 확인용 메시지 수 조회(#155). 보관된 표준 채널만 가능하고 admin 만 할 수 있다.
   * 이 수치는 확인 문구에 "이 채널과 메시지 N개를 영구히 지운다"로 표시된다.
   */
  app.get('/channels/:id/delete-info', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const channel = await pool.query(
      `select id, name, kind, archived_at from channel where id = $1`,
      [id],
    );
    if (!channel.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    const row = channel.rows[0] as { id: string; name: string; kind: string; archived_at: string | null };
    if (row.kind !== 'standard') {
      return reply.code(409).send({ error: { code: 'cannot_delete_dm', message: 'DMs cannot be deleted' } });
    }
    if (!row.archived_at) {
      return reply.code(409).send({ error: { code: 'not_archived', message: 'only archived channels can be deleted' } });
    }
    const messageCountResult = await pool.query(
      `select count(*)::int as cnt from message where channel_id = $1`,
      [id],
    );
    return { name: row.name ?? '', messageCount: messageCountResult.rows[0]!.cnt };
  });
}
