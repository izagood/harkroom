import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { StorageBackend } from '../storage/local.js';
import { z } from 'zod';
import {
  addChannelMember, assertChannelVisible, audienceFor, channelListAudience, channelListLostAudience,
  channelMembershipGate, channelPostGate, createChannel, deleteChannel,
  getChannelDoc, getChannelRow, getOrCreateDm, listChannelMembers, listChannels, removeChannelMember,
  updateChannel, updateChannelDoc, updateChannelPref, listChannelPrefs, renameSection,
} from '../services/channels.js';
import { listPins, pinMessage, unpinMessage } from '../services/pins.js';
import {
  listChannelAutoMentions, setChannelAutoMention, unsetChannelAutoMention,
} from '../services/channelAutoMentions.js';
import { allReadStates, markChannelRead, markChannelUnread, readState } from '../services/readPositions.js';
import {
  cancelScheduledMessage, listScheduledMessages, scheduleMessage,
  SCHEDULE_MAX_DAYS,
} from '../services/scheduledMessages.js';
// 이름 규칙은 데스크탑의 채널 생성 입력(Sidebar.tsx)과 **같은 것**이어야 한다 — 그래서
// 정규식을 여기 리터럴로 두지 않고 shared 의 상수를 쓴다.
import { CHANNEL_NAME_PATTERN, NOTIFY_LEVELS } from '@murmur/shared';
import { recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { postMessage } from '../services/messages.js';

/**
 * 섹션 이름의 길이 규칙(#157) — 만드는 경로(`PATCH /channels/:id/pref`)와 이름을 바꾸는
 * 경로(`PATCH /channels/sections/:name`, #323)가 **이 스키마 하나**를 쓴다. 복제하면
 * 한쪽만 늘어나 "만들 수는 있는데 이름을 바꿀 수 없는" 섹션이 생긴다.
 *
 * 값 가공(앞뒤 공백 제거, 빈 값은 null)은 서비스의 `normalizeSectionName` 이 한다 —
 * 여기서는 길이만 본다.
 */
const sectionName = z.string().max(40).nullable();

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
    // 삽입이 커밋된 뒤에 발행한다(#284) — 커밋 전에 보내면 수신자가 없는 채널을 조회한다.
    emitEvent({ type: 'channel.created', channel, audience: await channelListAudience(pool, channel.id) });
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

    // 비공개화 전환을 판정하려면 바꾸기 **전** 의 visibility 를 읽어야 한다 — 갱신 뒤에는
    // 'private' 만 남아 "원래도 private 이었나"를 구분할 수 없다.
    const oldChannel = patch.visibility !== undefined
      ? await pool.query(`select visibility from channel where id = $1`, [id])
      : null;
    const wasPublic = oldChannel?.rows[0]?.visibility === 'public';

    const channel = await updateChannel(pool, id, req.account!.id, patch);
    if (!channel) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }

    // 발행은 갱신이 커밋된 **뒤** 다(#284). 커밋 전에 보내면 수신자가 이벤트를 받고
    // 곧바로 조회했을 때 아직 옛 값을 읽는다.
    //
    // 비공개화 전환: public→private 이면 목록에서 채널을 잃은 계정에게 `channel.deleted`
    // 를 보낸다 — 그 사람에게 이 채널은 사라진 것이고, 그것을 표현하는 이벤트가 삭제다.
    // 수신자를 `audience: 'all'` 로 두면 **멤버도** 받아서 보고 있던 채널이 비워지고
    // "삭제됐다" 안내가 뜬다. 그래서 두 수신자를 목록 술어 하나와 그 부정으로 계산한다.
    if (wasPublic && patch.visibility === 'private') {
      emitEvent({ type: 'channel.deleted', channelId: id, audience: await channelListLostAudience(pool, id) });
    }
    emitEvent({ type: 'channel.updated', channel, audience: await channelListAudience(pool, id) });

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
    // 보관·DM 게이트(#328). **가시성 뒤, 삽입 앞**이다. 가시성보다 앞에 두면 볼 수 없는
    // 채널에 대한 응답이 보관 여부·kind 로 갈려 그 채널의 상태를 알려 준다. 삽입보다
    // 앞이어야 하는 이유는 아래 시스템 메시지(#322)다 — 거절된 요청이 읽기 전용이어야 할
    // 채널에 새 메시지를 남기면 안 된다.
    const gate = await channelMembershipGate(pool, id);
    if (gate === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    if (gate === 'archived') {
      return reply.code(400).send({ error: { code: 'channel_archived', message: 'archived channels are read-only' } });
    }
    if (gate === 'dm') {
      return reply.code(400).send({ error: { code: 'channel_is_dm', message: 'a dm has no membership to edit' } });
    }
    // 존재하지 않는 계정은 FK 위반으로 500 이 된다 — 잘못된 입력을 서버 오류로 답하면
    // 호출부가 재시도할 대상인지 아닌지 구분하지 못한다.
    // handle 까지 여기서 읽는다 — 아래 시스템 메시지(#322)가 쓸 값이고, 존재 확인과 같은
    // 질문이다. 뒤에서 다시 조회하면 그 사이에 지워진 계정에 대해 "없다"를 두 번 다르게
    // 판정하는 자리가 생기고, 없을 때 조용히 메시지를 건너뛰는 분기가 필요해진다.
    const account = await pool.query<{ handle: string }>(
      `select handle from account where id = $1`, [accountId],
    );
    if (!account.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such account' } });
    }
    const targetHandle = account.rows[0]!.handle;
    await addChannelMember(pool, id, accountId);
    await recordAudit(pool, {
      action: 'channel.member.added', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { accountId },
    }, req);
    // 삽입이 커밋된 뒤에 발행한다(#284) — 커밋 전에 보내면 수신자가 없는 채널을 조회한다.
    // channel.member_added: 수신자는 그 채널을 목록에서 볼 수 있는 사람(#284 의 channelListAudience 재사용).
    emitEvent({
      type: 'channel.member_added',
      channelId: id,
      accountId,
      audience: await channelListAudience(pool, id),
    });
    // 추가된 사람에게는 channel.created 를 보낸다 — 그 사람에게 목록에 새로 나타난 것이다.
    // 행은 `getChannelRow` 로 읽는다: 컬럼 목록을 여기 베껴 쓰면 `createdAt` 같은 필드가 빠진
    // `ChannelRow` 가 실려 나가고, 받는 화면의 "생성순" 정렬이 조용히 깨진다.
    const channel = await getChannelRow(pool, id);
    if (channel) emitEvent({ type: 'channel.created', channel, audience: [accountId] });
/**
       * 시스템 메시지(#322). **삽입이 커밋된 뒤**다 — 위 이벤트들과 같은 자리에 두는 이유가
       * 그것이다. 앞으로 옮기면 `audienceFor` 가 아직 멤버가 아닌 사람을 빼고 계산해,
       * 초대된 본인이 자기 초대를 알리는 메시지를 실시간으로 받지 못한다.
       *
       * 본문에 `@` 를 붙이지 않는다: `postMessage` 는 kind 와 무관하게 본문의 멘션을
       * 판정하므로, `@handle` 로 적으면 그 사람의 inbox 에mention 행이 생긴다.
       * 시스템 메시지는 사실을 남기는 것이지 부르는 것이 아니다.
       *
       * #329: 본문에 이름을 박지 않는다 — 표시 시점에 meta.accountId 로 현재 handle 를
       * 찾아 그린다. 이렇게 하면 handle 변경 시 과거 메시지도 새 이름으로 갱신된다.
       */
      const added = await postMessage(pool, {
        channelId: id,
        authorId: req.account!.id,
        body: '계정이 채널에 추가되었습니다.',
        kind: 'system',
        meta: { accountId },
      });
    // 메시지 이벤트의 수신자는 메시지 층의 `audienceFor` 다 — 위 목록 이벤트의
    // `channelListAudience` 를 여기 쓰면 private 채널의 본문이 비멤버 admin 에게 흘러간다.
    if (added.message) {
      emitEvent({ type: 'message.created', message: added.message, audience: await audienceFor(pool, id) });
    }
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
    // 초대와 **같은 게이트**(#328). 제거도 막는다: 보관은 읽기 전용이고 멤버십 변경은
    // 쓰기다. 삭제 앞에 두는 이유도 초대와 같다 — 거절된 요청이 퇴장 시스템 메시지를
    // 남기면 읽기 전용 채널에 새 메시지가 생긴다.
    const gate = await channelMembershipGate(pool, id);
    if (gate === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    if (gate === 'archived') {
      return reply.code(400).send({ error: { code: 'channel_archived', message: 'archived channels are read-only' } });
    }
    if (gate === 'dm') {
      return reply.code(400).send({ error: { code: 'channel_is_dm', message: 'a dm has no membership to edit' } });
    }
    const removed = await removeChannelMember(pool, id, accountId);
    if (removed) {
      await recordAudit(pool, {
        action: 'channel.member.removed', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: id, detail: { accountId },
      }, req);
      // 삭제 후 커밋에 이벤트 발행(#284).
      // channel.member_removed: 수신자는 여전히 볼 수 있는 사람(channelListAudience 재사용).
      emitEvent({
        type: 'channel.member_removed',
        channelId: id,
        accountId,
        audience: await channelListAudience(pool, id),
      });
      // channel.deleted: #284 의 public→private 전환과 같은 논리. 목록에서 사라진 사람에게.
      // 제거된 사람이 채널을 더 이상 목록에서 볼 수 없으면 channel.deleted 를 보낸다.
      const lostAudience = await channelListLostAudience(pool, id);
      if (lostAudience.includes(accountId)) {
        emitEvent({
          type: 'channel.deleted',
          channelId: id,
          audience: [accountId],
        });
      }
/**
        * 시스템 메시지(#322). 삭제가 커밋된 뒤다 — 초대 쪽과 같은 이유.
        *
        * **문구를 둘로 둔다.** 이 라우트는 위에서 이미 `isSelf` 로 두 경우를 갈라
        * 권한을 다르게 판정한다 — 나간 것과 내보낸 것은 여기서 실재하는 구분이므로
        * 화면이 그대로 말해도 거짓 신호가 아니다(구분이 없었다면 문구도 하나여야 했다).
        *
        * 계정 행은 방금 지운 `channel_member` 의 FK 가 보장한다 — 없으면 그것은 결함이지
        * "메시지를 남기지 않을 사유"가 아니므로 조용히 건너뛰지 않는다.
        * 본문에 `@` 를 붙이지 않는 이유는 초대 쪽과 같다.
        *
        * #329: 본문에 이름을 박지 않는다 — 표시 시점에 meta.accountId 로 현재 handle 를
        * 찾아 그린다. 이렇게 하면 handle 변경 시 과거 메시지도 새 이름으로 갱신된다.
        */
      const posted = await postMessage(pool, {
        channelId: id,
        authorId: req.account!.id,
        body: isSelf
          ? '계정이 채널에서 나갔습니다.'
          : '계정이 채널에서 제거되었습니다.',
        kind: 'system',
        meta: { accountId },
      });
      // 초대 쪽과 같이 메시지 층의 `audienceFor` 를 쓴다.
      if (posted.message) {
        emitEvent({ type: 'message.created', message: posted.message, audience: await audienceFor(pool, id) });
      }
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
    // 섹션: DM 에는 사용할 수 없다(#157). 길이 1~40, 앞뒤 공백 제거, 빈 문자열은 null.
    // null 은 "섹션에서 빼기"고, 빈 문자열도 null 로 변환된다.
    // .min(1) 이 아니라 .max(40) 만 — 빈 문자열은 라우트에서 거르고 service 에서 null 로 변환.
    section: sectionName.optional(),
    // 섹션 안에서의 수동 순서(#157). null 이면 이름순 뒤에 붙는다.
    // `nullable` 인 이유: "지우기"는 명시적 null 이다 — 이것이 없으면 한 번 매긴 순서를
    // 되돌릴 방법이 없다(`undefined` 는 JSON 에서 키 자체가 사라져 "안 보냈다"가 된다).
    sortOrder: z.number().int().optional().nullable(),
  }).strict();

  app.patch('/channels/:id/pref', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = prefParam.parse(req.params);
    const patch = prefBody.parse(req.body);

    // 가시성 검사가 **먼저**다. 아래 DM 검사를 앞에 두면 남의 DM 에 섹션을 붙여 보는 것만으로
    // 400(`cannot_section_dm`)과 403 이 갈려 그 채널이 DM 이라는 사실이 새 나간다 — 볼 수 없는
    // 채널에 대한 응답은 종류도 존재도 말하지 않아야 한다.
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }

    // DM 은 섹션을 가질 수 없다(#157). null 은 "섹션에서 빼기"이므로 허용한다 —
    // 이미 붙은 섹션을 뗄 길이 없으면 잘못 들어간 DM 이 영영 그 자리에 남는다.
    if (patch.section !== undefined && patch.section !== null) {
      const channel = await pool.query(`select kind from channel where id = $1`, [id]);
      if (!channel.rowCount) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
      }
      if (channel.rows[0]!.kind === 'dm') {
        return reply.code(400).send({ error: { code: 'cannot_section_dm', message: 'DMs cannot have a section' } });
      }
    }
    // 값 가공(앞뒤 공백 제거, 빈 문자열은 null)은 `updateChannelPref` 한 곳에서 한다 —
    // 여기서 한 번 더 다듬으면 같은 뜻이 두 곳에 살고, 한쪽만 고치는 사고가 난다.
    const pref = await updateChannelPref(pool, req.account!.id, id, patch);
    if (!pref) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    return pref;
  });

  /**
   * 섹션 이름 바꾸기(#323). 요청자의 `channel_pref` 중 `section = 옛이름` 인 행을 전부
   * 새 이름으로 한 트랜잭션에서 갱신한다. 새 이름이 이미 있으면 합친다.
   *
   * 길이 규칙은 `/channels/:id/pref` 의 `section` 과 **같은 스키마**(`sectionName`)를 쓰고,
   * 값 가공(공백 제거, 빈 값은 null)은 서비스의 `normalizeSectionName` 하나가 한다 —
   * 만드는 경로와 갈라지면 "만들 때는 되는데 이름을 바꾸면 안 되는" 이름이 생긴다.
   *
   * `name` 은 **필수**다. 안 보낸 요청(`undefined`)은 400 이고, 명시적 `null`(또는 빈 값)만
   * "섹션에서 빼기"다 — 옵셔널로 두면 빈 본문이 조용히 섹션을 지운다.
   */
  app.patch('/channels/sections/:name', { preHandler: app.requireAccount }, async (req, reply) => {
    const { name: oldName } = z.object({ name: sectionName }).parse(req.params);
    const { name: newName } = z.object({ name: sectionName.optional() }).parse(req.body);

    if (newName === undefined) {
      return reply.code(400).send({ error: { code: 'invalid_body', message: 'name is required' } });
    }

    const prefs = await renameSection(pool, req.account!.id, oldName, newName);
    return { prefs };
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
   * 자동 멘션 에이전트 목록(#173). **채널을 볼 수 있는 사람 누구나** — 작성창이 칩을 그려야
   * 한다. 가시성 판정은 핀과 같이 `assertChannelVisible` 하나를 쓴다.
   *
   * 이 라우트들은 행만 다룬다. 접두는 데스크탑 작성창이 전송 직전에 본문에 넣고, 서버의
   * 알림 판정은 그 본문을 평범한 멘션으로 읽는다 — 서버가 본문을 고치는 경로는 없다
   * (`services/channelAutoMentions.ts` 머리 주석).
   */
  app.get('/channels/:id/auto-mentions', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = channelParam.parse(req.params);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    return { autoMentions: await listChannelAutoMentions(pool, id) };
  });

  const autoMentionParam = z.object({ id: z.string().uuid(), agentId: z.string().uuid() });

  /**
   * 건다. **admin 전용** — 에이전트를 어디에 자동 투입할지는 `#253` 이 admin 에 남긴
   * `mentionPermission` 과 같은 종류의 관리 행위다. 멱등이다: 이미 걸려 있으면 200 으로
   * 같은 행을 돌려준다.
   *
   * 대상이 에이전트가 아니면 400 `not_an_agent` — 사람을 자동 멘션에 걸면 그 사람은 채널의
   * 모든 글에 불린다. 비활성 에이전트는 400 `agent_disabled` — 깨어나지 못하는 상대를 매
   * 메시지에 붙이면 본문마다 죽은 handle 이 남는다.
   */
  app.put('/channels/:id/auto-mentions/:agentId', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id, agentId } = autoMentionParam.parse(req.params);
    // 존재하지 않는 채널은 FK 위반으로 500 이 된다 — 잘못된 입력을 서버 오류로 답하면
    // 호출부가 재시도할 대상인지 구분하지 못한다(멤버 초대와 같은 이유).
    const exists = await pool.query(`select 1 from channel where id = $1`, [id]);
    if (!exists.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    const result = await setChannelAutoMention(pool, { channelId: id, agentAccountId: agentId, createdBy: req.account!.id });
    if (!result.ok) {
      if (result.reason === 'not_found') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'no such account' } });
      }
      if (result.reason === 'not_an_agent') {
        return reply.code(400).send({ error: { code: 'not_an_agent', message: 'only agents can be auto-mentioned' } });
      }
      return reply.code(400).send({ error: { code: 'agent_disabled', message: 'a disabled agent cannot be auto-mentioned' } });
    }
    // 본문은 남기지 않는다 — handle 만. 이 채널에서 오간 글은 감사가 붙잡을 자리가 아니다.
    await recordAudit(pool, {
      action: 'channel.auto_mention.set', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { handle: result.row.handle },
    }, req);
    return result.row;
  });

  /** 푼다. admin 전용. 없던 것을 풀면 404 — 조용히 204 를 주면 호출부는 있었다고 믿는다. */
  app.delete('/channels/:id/auto-mentions/:agentId', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id, agentId } = autoMentionParam.parse(req.params);
    // handle 은 지우기 **전에** 읽는다 — 지운 뒤에는 조인할 행이 없다.
    const before = await pool.query<{ handle: string }>(
      `select a.handle from channel_auto_mention m join account a on a.id = m.agent_account_id
        where m.channel_id = $1 and m.agent_account_id = $2`,
      [id, agentId],
    );
    const removed = await unsetChannelAutoMention(pool, id, agentId);
    if (!removed) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'that agent is not auto-mentioned here' } });
    }
    await recordAudit(pool, {
      action: 'channel.auto_mention.unset', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { handle: before.rows[0]?.handle ?? null },
    }, req);
    return reply.code(204).send();
  });

  /**
   * 채널 문서 조회(#188). 가시성은 `assertChannelVisible` 로 검사한다 — 채널을 볼 수 없으면
   * 문서도 못 본다. `#156` 이 만든 그 술어를 그대로 쓰므로 public 채널은 볼 수 있는 사람
   * 전부, private 은 멤버다. 가시성 술어를 여기서 다시 쓰면 한쪽만 고치는 사고가 난다.
   *
   * 순서가 이렇다: **가시성 먼저, 존재 확인 나중.** `assertChannelVisible` 은 없는 채널에
   * `true` 를 주도록 만들어져 있고(그 자리 주석이 이유를 적는다) 그 다음 단계가 404 로
   * 답한다 — 이 저장소의 다른 라우트와 같은 모양이다.
   *
   * 저장된 것이 없으면 404 가 아니라 본문 `''` 인 문서다. "없다"와 "비어 있다"는 사람에게
   * 같은 화면이고, 그래야 클라이언트가 읽기와 첫 쓰기를 같은 표면으로 처리한다.
   */
  app.get('/channels/:id/doc', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = channelParam.parse(req.params);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    const channel = await pool.query(`select 1 from channel where id = $1`, [id]);
    if (!channel.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    return getChannelDoc(pool, id);
  });

  /**
   * 채널 문서 저장(#188). 편집 권한은 **그 채널을 볼 수 있는 사람**이다 — `#156` 이 멤버십을
   * 세운 뒤로 이슈가 걱정했던 전제("멤버십이 표준 채널에 없다")가 사라졌다. public 채널은
   * 볼 수 있는 사람 전부, private 은 멤버다. admin 전용으로 두면 대부분의 채널에서 아무도
   * 고치지 못한다.
   *
   * `channelPostGate` 를 쓰는 이유: 가시성과 보관 여부를 한 질의로 함께 본다. 보관된 채널은
   * 읽기 전용이라는 약속이 메시지에만 적용되고 문서에는 안 적용되면, 보관이 "더 이상 바뀌지
   * 않는다"는 뜻이 아니게 된다.
   *
   * 존재 확인을 따로 하는 이유: `channelPostGate` 는 **없는 채널에 `'ok'`** 를 준다
   * (메시지 경로에서는 이어지는 단계가 404 로 답한다). 그것을 그대로 통과시키면 insert 가
   * 외래키에서 터져 500 이 되므로 여기서 404 로 답한다.
   *
   * 낙관적 동시성: `expectedUpdatedAt` 이 서버의 것과 다르면 **409 `doc_stale` 과 현재
   * 본문**을 함께 준다. 클라이언트는 그것을 사람에게 보이고 다시 편집하게 한다 — 조용히
   * 덮어쓰지도, 조용히 버리지도 않는다.
   *
   * 감사 detail 에 **본문을 넣지 않는다.** 문서는 덮어쓰기라 매 저장이 전문을 복사하면
   * 감사 로그가 문서 이력 테이블이 된다 — 우리가 만들지 않기로 한 그것이고, 그러면서도
   * 되돌리기는 못 하는 최악의 모양이다. 길이만 남긴다.
   */
  app.put('/channels/:id/doc', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = channelParam.parse(req.params);
    const body = z.object({
      body: z.string().max(64 * 1024),
      /**
       * 내가 읽은 판의 시각(epoch ms). **부재·null 은 "아직 문서가 없다고 믿는다"**다 —
       * "검사하지 마라"가 아니다. 옵셔널을 검사 생략으로 읽으면 이 필드를 빼기만 해도
       * 조용한 덮어쓰기가 되살아난다.
       */
      expectedUpdatedAt: z.number().int().min(0).nullable().optional(),
    }).parse(req.body);

    const gate = await channelPostGate(pool, id, req.account!.id);
    if (gate === 'forbidden') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    if (gate === 'archived') {
      return reply.code(403).send({ error: { code: 'channel_archived', message: 'archived channels are read-only' } });
    }
    const channel = await pool.query(`select 1 from channel where id = $1`, [id]);
    if (!channel.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }

    const result = await updateChannelDoc(
      pool, id, req.account!.id, body.body,
      body.expectedUpdatedAt != null ? new Date(body.expectedUpdatedAt) : null,
    );
    if ('stale' in result) {
      return reply.code(409).send({
        error: { code: 'doc_stale', message: 'the document changed since you read it' },
        doc: result.stale,
      });
    }
    await recordAudit(pool, {
      action: 'channel.doc.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { bodyLength: body.body.length },
    }, req);
    return result.ok;
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
    // 삭제 전 수신자를 미리 구한다 — 삭제 후에는 채널 행이 없어 수신자 계산이 'all' 로
    // 넓어진다(존재하지 않는 채널의 규약). 발행은 아래 삭제가 커밋된 뒤다.
    const audience = await channelListAudience(pool, id);
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

  const scheduledChannelParam = z.object({ id: z.string().uuid() });

  /**
   * 예약 메시지 목록(#222). 작성자만 볼 수 있다 — 다른 사람에게는 존재 자체가
   * 보이지 않는다(그렇지 않으면 초안과 다를 게 없다).
   */
  app.get('/channels/:id/scheduled', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = scheduledChannelParam.parse(req.params);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    return { scheduled: await listScheduledMessages(pool, id, req.account!.id) };
  });

  /**
   * 예약 메시지 생성(#222).
   *
   * 에이전트가 예약할 수 없는 이유: 에이전트가 "지금은 조용히, 나중에 터뜨린다"를 스스로
   * 고르는 신뢰 문제가 있다. 에이전트가 스스로 스케줄을 짜면 사람이 언제 그 발화가
   * 날지 예측할 수 없고, 그것이 에이전트 작동 방식의 전제(사람이 발화를 검토한다)와
   * 맞지 않는다.
   */
  app.post('/channels/:id/scheduled', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = scheduledChannelParam.parse(req.params);
    const { body, sendAt, threadRootId } = z.object({
      // 8000 은 즉시 발송(`messageRoutes.ts`·`mcpPlugin.ts`)과 **같은 상한**이다. 여기만
      // 넉넉하게 두면 예약을 거쳐 8000자를 넘는 메시지를 넣을 수 있는 우회로가 된다.
      body: z.string().min(1).max(8000),
      sendAt: z.string().datetime(),
      threadRootId: z.string().uuid().optional(),
    }).parse(req.body);

    if (req.account!.kind === 'agent') {
      return reply.code(403).send({ error: { code: 'agents_cannot_schedule', message: 'agents cannot schedule messages' } });
    }

    const gate = await channelPostGate(pool, id, req.account!.id);
    if (gate === 'forbidden') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    if (gate === 'archived') {
      return reply.code(403).send({ error: { code: 'channel_archived', message: 'archived channels are read-only' } });
    }

    const sendTime = new Date(sendAt);
    const now = new Date();

    if (sendTime <= now) {
      return reply.code(400).send({ error: { code: 'send_at_in_past', message: 'send_at must be in the future' } });
    }

    const maxDate = new Date(now.getTime() + SCHEDULE_MAX_DAYS * 24 * 60 * 60 * 1000);
    if (sendTime > maxDate) {
      return reply.code(400).send({ error: { code: 'send_at_too_far', message: `send_at cannot be more than ${SCHEDULE_MAX_DAYS} days in the future` } });
    }

    const scheduled = await scheduleMessage(pool, {
      channelId: id,
      authorId: req.account!.id,
      body,
      sendAt: sendTime,
      threadRootId: threadRootId ?? null,
    });
    // 목록(`GET`)과 **같은 봉투**로 답한다 — 한쪽만 벗겨져 있으면 클라이언트가 두 모양을
    // 다 알아야 한다.
    return reply.code(201).send({ scheduled });
  });

  /**
   * 예약 메시지 취소(#222). 작성자만 가능하고, 행을 지우지 않고 canceled_at 을 찍는다 —
   * 무엇을 취소했는지 남는다.
   */
  app.delete('/scheduled/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const canceled = await cancelScheduledMessage(pool, id, req.account!.id);
    if (!canceled) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'scheduled message not found or already sent/canceled' } });
    }
    return reply.code(204).send();
  });
}
