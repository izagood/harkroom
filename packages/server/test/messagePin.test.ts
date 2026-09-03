import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

// 메시지 고정(#218). 지키는 것은 넷이다: 목록에 나오는가, 지워진 메시지가 자동으로 빠지는가,
// 해제 권한이 고정한 사람과 admin 으로 좁혀지는가, 채널의 가시성·보관 규칙을 그대로 따르는가.

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let aPat: string;
let bPat: string;
let bId: string;
let cPat: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** 채널 하나와 그 안의 메시지 하나. 테스트마다 새로 만들어 서로 간섭하지 않게 한다. */
async function makeChannelWithMessage(name: string, body = 'pin me'): Promise<{ channelId: string; messageId: string }> {
  const created = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name, topic: '' },
  });
  const channelId = created.json().id as string;
  const posted = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(aPat), payload: { body },
  });
  return { channelId, messageId: posted.json().id as string };
}

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  const a = await createAgent(app, adminToken, 'pin-a');
  const b = await createAgent(app, adminToken, 'pin-b');
  const c = await createAgent(app, adminToken, 'pin-c');
  aPat = a.pat;
  bPat = b.pat;
  bId = b.accountId;
  cPat = c.pat;
});
afterAll(async () => { await app.close(); await stop(); });

describe('message pin', () => {
  it('a pinned message shows up in the channel pin list', async () => {
    const { channelId, messageId } = await makeChannelWithMessage('pin-list', 'the decision');

    const pinned = await app.inject({
      method: 'POST', url: `/channels/${channelId}/pins`, headers: auth(aPat), payload: { messageId },
    });
    expect(pinned.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: `/channels/${channelId}/pins`, headers: auth(bPat) });
    expect(list.statusCode).toBe(200);
    const pins = list.json().pins as { messageId: string; channelId: string; message: { body: string } }[];
    expect(pins.map((p) => p.messageId)).toEqual([messageId]);
    // 복제해 둔 channel_id 는 메시지 행에서 읽어 넣은 값이어야 한다.
    expect(pins[0]?.channelId).toBe(channelId);
    expect(pins[0]?.message.body).toBe('the decision');
  });

  // 지워진 메시지의 핀은 정리 작업 없이 목록에서 사라져야 한다. **본문도 새면 안 된다** —
  // 그것이 새면 삭제가 삭제가 아니다.
  it('a deleted message drops out of the pin list, body and all', async () => {
    const { channelId, messageId } = await makeChannelWithMessage('pin-deleted', 'leaky secret 9f3a');
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/pins`, headers: auth(aPat), payload: { messageId },
    });

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${messageId}`, headers: auth(aPat),
    });
    expect(deleted.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: `/channels/${channelId}/pins`, headers: auth(aPat) });
    expect(list.json().pins).toEqual([]);
    expect(list.body).not.toContain('leaky secret 9f3a');
  });

  it('the person who pinned it can unpin it', async () => {
    const { channelId, messageId } = await makeChannelWithMessage('pin-unpin');
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/pins`, headers: auth(aPat), payload: { messageId },
    });

    const unpinned = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/pins/${messageId}`, headers: auth(aPat),
    });
    expect(unpinned.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: `/channels/${channelId}/pins`, headers: auth(aPat) });
    expect(list.json().pins).toEqual([]);
  });

  // 남이 올린 핀을 아무나 내리면 핀이 신호가 되지 못한다. admin 은 조정 수단으로 열어 둔다.
  it("a regular member cannot unpin someone else's pin, but an admin can", async () => {
    const { channelId, messageId } = await makeChannelWithMessage('pin-others');
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/pins`, headers: auth(aPat), payload: { messageId },
    });

    const byOther = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/pins/${messageId}`, headers: auth(bPat),
    });
    expect(byOther.statusCode).toBe(403);
    expect(byOther.json().error.code).toBe('forbidden');

    // 거절이 실제로 아무것도 지우지 않았는지 확인한다 — 403 만 보고 통과하면 지우고 나서
    // 403 을 주는 구현도 초록이 된다.
    const stillThere = await app.inject({ method: 'GET', url: `/channels/${channelId}/pins`, headers: auth(aPat) });
    expect((stillThere.json().pins as { messageId: string }[]).map((p) => p.messageId)).toEqual([messageId]);

    const byAdmin = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/pins/${messageId}`, headers: auth(adminToken),
    });
    expect(byAdmin.statusCode).toBe(204);
    const list = await app.inject({ method: 'GET', url: `/channels/${channelId}/pins`, headers: auth(aPat) });
    expect(list.json().pins).toEqual([]);
  });

  // 보관된 채널은 읽기 전용이다 — 고정도 그 규칙을 따른다(같은 `channelPostGate` 판정이다).
  it('pinning in an archived channel is refused', async () => {
    const { channelId, messageId } = await makeChannelWithMessage('pin-archived');
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: auth(adminToken), payload: { archived: true },
    });

    const pinned = await app.inject({
      method: 'POST', url: `/channels/${channelId}/pins`, headers: auth(aPat), payload: { messageId },
    });
    expect(pinned.statusCode).toBe(403);
    expect(pinned.json().error.code).toBe('channel_archived');

    const list = await app.inject({ method: 'GET', url: `/channels/${channelId}/pins`, headers: auth(aPat) });
    expect(list.json().pins).toEqual([]);
  });

  // 핀 목록도 채널의 가시성 규칙을 그대로 따른다. 403 이면서 **본문이 응답에 실리지 않아야** 한다.
  it('someone who cannot see the channel cannot see its pins either', async () => {
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: auth(aPat), payload: { accountIds: [bId] },
    });
    const dmId = dm.json().id as string;
    const posted = await app.inject({
      method: 'POST', url: `/channels/${dmId}/messages`, headers: auth(aPat), payload: { body: 'dm secret 7c1b' },
    });
    const pinned = await app.inject({
      method: 'POST', url: `/channels/${dmId}/pins`, headers: auth(aPat), payload: { messageId: posted.json().id },
    });
    expect(pinned.statusCode).toBe(201);

    const outsider = await app.inject({ method: 'GET', url: `/channels/${dmId}/pins`, headers: auth(cPat) });
    expect(outsider.statusCode).toBe(403);
    expect(outsider.body).not.toContain('dm secret 7c1b');

    // 비멤버는 고정도 못 한다 — 읽기만 막고 쓰기를 열어 두면 남의 DM 에 핀이 생긴다.
    const outsiderPin = await app.inject({
      method: 'POST', url: `/channels/${dmId}/pins`, headers: auth(cPat), payload: { messageId: posted.json().id },
    });
    expect(outsiderPin.statusCode).toBe(403);
  });

  // 감사에는 messageId 만 남는다 — 본문을 복사하면 그 메시지를 지워도 감사에 본문이 남는다.
  it('the audit trail records the pin without copying the body', async () => {
    const { channelId, messageId } = await makeChannelWithMessage('pin-audit', 'audit body 4d2e');
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/pins`, headers: auth(aPat), payload: { messageId },
    });
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/pins/${messageId}`, headers: auth(aPat),
    });

    const audit = await app.inject({ method: 'GET', url: '/audit', headers: auth(adminToken) });
    const entries = audit.json().entries as { action: string; detail: Record<string, unknown> }[];
    const pinEntry = entries.find((e) => e.action === 'message.pinned');
    const unpinEntry = entries.find((e) => e.action === 'message.unpinned');
    expect(pinEntry?.detail.messageId).toBe(messageId);
    expect(unpinEntry?.detail.messageId).toBe(messageId);
    expect(JSON.stringify(pinEntry)).not.toContain('audit body 4d2e');
    expect(JSON.stringify(unpinEntry)).not.toContain('audit body 4d2e');
  });
});
