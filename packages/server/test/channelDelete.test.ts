import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: import('pg').Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let nonAdminToken: string;
let userToken: string;
let userId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  const { pat, accountId } = await createAgent(app, adminToken, 'nonadmin');
  nonAdminToken = pat;
  const userResult = await createAgent(app, adminToken, 'user');
  userToken = userResult.pat;
  userId = userResult.accountId;
});
afterAll(async () => { await app.close(); await stop(); });

describe('channel delete (#155)', () => {
  it(' archived empty channel is deleted', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-empty-archived', topic: 'test' },
    });
    const id = created.json().id as string;

    await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(deleted.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    const ch = list.json().channels.find((c: { id: string }) => c.id === id);
    expect(ch).toBeFalsy();
  });

  it('archived channel with messages is deleted without FK violation', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-with-messages', topic: 'test' },
    });
    const channelId = created.json().id as string;

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'message 1' },
    });
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'message 2' },
    });

    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(deleted.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    const ch = list.json().channels.find((c: { id: string }) => c.id === channelId);
    expect(ch).toBeFalsy();
  });

  it('non-archived channel deletion returns 409 and channel remains', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-not-archived', topic: 'test' },
    });
    const id = created.json().id as string;

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error.code).toBe('not_archived');

    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    const ch = list.json().channels.find((c: { id: string }) => c.id === id);
    expect(ch).toBeTruthy();
  });

  it('DM cannot be deleted', async () => {
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountIds: [userId] },
    });
    const dmId = dm.json().id as string;

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${dmId}`, headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error.code).toBe('cannot_delete_dm');
  });

  it('non-admin returns 403 and channel remains', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-nonadmin', topic: 'test' },
    });
    const id = created.json().id as string;

    await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${id}`, headers: { authorization: `Bearer ${nonAdminToken}` },
    });

    expect(deleted.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    const ch = list.json().channels.find((c: { id: string }) => c.id === id);
    expect(ch).toBeTruthy();
  });

  it('after deletion, no messages, reactions, attachments, read positions, members, or pins remain', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-cleanup-test', topic: 'test' },
    });
    const channelId = created.json().id as string;

    const msg1 = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'message 1' },
    });
    const messageId = msg1.json().id as string;

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${userToken}` },
      payload: { body: 'message 2' },
    });

    await app.inject({
      method: 'PUT', url: `/channels/${channelId}/messages/${messageId}/reactions/%F0%9F%91%8D`,
      headers: { authorization: `Bearer ${userToken}` },
    });

    await app.inject({
      method: 'PUT', url: `/channels/${channelId}/read`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { seq: 10 },
    });

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/pins`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { messageId },
    });

    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
    });

    const messages = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(messages.json().messages.length).toBe(0);

    const reads = await app.inject({
      method: 'GET', url: '/reads', headers: { authorization: `Bearer ${adminToken}` },
    });
    const channelRead = reads.json().reads.find((r: { channelId: string }) => r.channelId === channelId);
    expect(channelRead).toBeFalsy();

    const members = await app.inject({
      method: 'GET', url: `/channels/${channelId}/members`, headers: { authorization: `Bearer ${adminToken}` },
    });
    // 채널이 삭제되었으므로 404가 반환된다
    expect(members.statusCode).toBe(404);

    const pins = await app.inject({
      method: 'GET', url: `/channels/${channelId}/pins`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(pins.json().pins.length).toBe(0);
  });

  it('audit log contains channel name and counts without body', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-audit-test', topic: 'test topic' },
    });
    const channelId = created.json().id as string;

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'secret message' },
    });

    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
    });

    const audit = await app.inject({
      method: 'GET', url: '/audit?action=channel.deleted&limit=5', headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(audit.statusCode).toBe(200);
    const entries = audit.json().entries as Array<{ action: string; detail: Record<string, unknown> }>;
    const entry = entries.find((e) => e.detail.name === 'delete-audit-test');
    expect(entry).toBeTruthy();
    expect(entry!.detail.messageCount).toBe(1);
    expect(entry!.detail.attachmentCount).toBe(0);
    expect(entry!.detail.topic).toBeUndefined();
    expect(entry!.detail.body).toBeUndefined();
  });

  it('delete-info returns 409 for non-archived channel', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-info-test', topic: 'test' },
    });
    const id = created.json().id as string;

    const info = await app.inject({
      method: 'GET', url: `/channels/${id}/delete-info`, headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(info.statusCode).toBe(409);
    expect(info.json().error.code).toBe('not_archived');
  });

  it('delete-info returns 409 for DM', async () => {
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountIds: [userId] },
    });
    const dmId = dm.json().id as string;

    const info = await app.inject({
      method: 'GET', url: `/channels/${dmId}/delete-info`, headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(info.statusCode).toBe(409);
    expect(info.json().error.code).toBe('cannot_delete_dm');
  });
});
/**
 * #155 참조 목록의 완결성.
 *
 * 위 describe 의 6번 회귀선은 **API 로 볼 수 있는 것만** 확인해서, `channel_id`·`message_id`
 * 를 참조하는 테이블 중 읽는 표면이 없는 것들을 통째로 놓친다.
 *
 * 실제 참조를 센 방법: 마이그레이션 전체에서 `references channel(id)` 와
 * `references message(id)` 를 찾았다. 그 목록은 열이다 — channel_member,
 * message(channel_id·thread_root_id),
 * inbox(message_id), idempotency_key(message_id·channel_id), channel_read,
 * message_reaction, attachment, channel_pref, message_pin.
 *
 * 이 중 `inbox`·`idempotency_key` 는 cascade 도 없고 서비스 함수도 지우지
 * 않아서, 멘션이 하나라도 있거나 재시도 키가 하나라도 붙은 채널은 삭제가 FK 위반으로
 * 터졌다. 6번이 초록이었던 이유는 fixture 가 그 셋을 만들지 않았기 때문이다.
 */
describe('channel delete — 참조 테이블 전부 (#155)', () => {
  it('멘션(inbox)과 재시도 키(idempotency_key)가 있어도 지워진다', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-inbox-refs', topic: 'test' },
    });
    const channelId = created.json().id as string;

    // 멘션은 inbox 행을 만든다(services/messages.ts::insertInbox). `user` 는 beforeAll 이
    // 만든 계정이라 handle 이 실제로 존재하고, 그래서 inbox 에 들어간다.
    const mention = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: '@user 이것 좀 봐라' },
    });
    expect(mention.statusCode).toBe(201);
    // fixture 가 실제로 inbox 행을 만들었음을 먼저 확인한다 — 안 만들면 이 테스트가
    // 아무것도 지키지 않는 채 초록이 된다(위 6번이 그랬다). POST 응답은 메시지만 주므로
    // 표를 직접 센다.
    const inboxBefore = await pool.query(
      `select count(*)::int as cnt from inbox i
       join message m on m.id = i.message_id where m.channel_id = $1`, [channelId]);
    expect(inboxBefore.rows[0].cnt).toBe(1);

    const keyed = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': 'delete-refs-key-1' },
      payload: { body: '재시도 키가 붙은 메시지' },
    });
    expect(keyed.statusCode).toBe(201);
    const keysBefore = await pool.query(
      `select count(*)::int as cnt from idempotency_key where channel_id = $1`, [channelId]);
    expect(keysBefore.rows[0].cnt).toBe(1);

    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleted.statusCode).toBe(204);

    // 그리고 그 행들이 남아 있지 않다. 삭제가 성공했다는 것만으로는 부족하다.
    const inbox = await pool.query(
      `select count(*)::int as cnt from inbox i
       join message m on m.id = i.message_id where m.channel_id = $1`, [channelId]);
    expect(inbox.rows[0].cnt).toBe(0);
    const keys = await pool.query(
      `select count(*)::int as cnt from idempotency_key where channel_id = $1`, [channelId]);
    expect(keys.rows[0].cnt).toBe(0);
  });

  it('첨부가 있어도 지워지고 첨부 행이 남지 않는다', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'delete-attachment-refs', topic: 'test' },
    });
    const channelId = created.json().id as string;

    const boundary = '----murmurdelete';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\n` +
        'Content-Type: text/plain\r\n\r\n',
      ),
      Buffer.from('첨부 내용'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await app.inject({
      method: 'POST', url: '/uploads',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(uploaded.statusCode).toBe(201);
    const attachmentId = uploaded.json().id as string;

    const posted = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: '첨부와 함께', attachmentIds: [attachmentId] },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json().attachments).toHaveLength(1);

    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { archived: true },
    });

    const deleted = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}`, headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleted.statusCode).toBe(204);

    const rows = await pool.query(
      `select count(*)::int as cnt from attachment where id = $1`, [attachmentId]);
    expect(rows.rows[0].cnt).toBe(0);

    // 감사에 첨부 개수가 남는다 — 삭제 뒤에는 무엇이 사라졌는지 물을 곳이 없다.
    const audit = await app.inject({
      method: 'GET', url: '/audit?action=channel.deleted&limit=50',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const entries = audit.json().entries as Array<{ detail: Record<string, unknown> }>;
    const entry = entries.find((e) => e.detail.name === 'delete-attachment-refs');
    expect(entry!.detail.attachmentCount).toBe(1);
  });

  /*
   * `avcs 작업 스레드(work_thread)가 걸린 채널도 지워진다` 를 걷어냈다.
   *
   * 그 테스트는 `work_thread.thread_root_message_id` 라는 FK 가 있는데 `deleteChannel` 이
   * 그것을 몰라서 삭제가 FK 위반으로 터지는 것을 막았다. 040 이 테이블째 지웠으므로 FK 도
   * 없고, 지킬 것도 없다 — 이제 그 행을 심을 수조차 없다.
   *
   * 이 성질을 대신 지키는 자리는 아래 스키마 대조 테스트다. 그것은 목록을 손으로 적지 않고
   * `information_schema` 로 실제 FK 를 다시 세므로, 어떤 이유로든 `work_thread` 가
   * 되살아나면 처리 목록에 없다고 빨개진다. 즉 삭제 목록의 회귀선은 약해지지 않았다.
   */

  /**
   * 스키마에 새 참조가 생겼는데 서비스 함수가 그것을 모르면, 그 테이블에 행이 있는 채널만
   * 삭제가 조용히 터진다 — 그때는 이미 운영 중이다. 그래서 **스키마에게 직접 묻는다**:
   * channel 이나 message 를 참조하는 테이블 전부가 (a) cascade 이거나
   * (b) deleteChannel 이 명시적으로 지우는 목록에 있어야 한다.
   *
   * `information_schema` 로 세는 이유는 목록을 손으로 적으면 다음 마이그레이션에서
   * 어긋나기 때문이다. 새 참조를 더하는 사람은 이 테스트가 알려 준다.
   */
  it('channel·message 를 참조하는 테이블이 전부 처리 목록에 있다', async () => {
    const refs = await pool.query<{ table_name: string; delete_rule: string }>(
      `select distinct tc.table_name, rc.delete_rule
         from information_schema.table_constraints tc
         join information_schema.referential_constraints rc
           on rc.constraint_name = tc.constraint_name
          and rc.constraint_schema = tc.constraint_schema
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = tc.constraint_name
          and ccu.constraint_schema = tc.constraint_schema
        where tc.constraint_type = 'FOREIGN KEY'
          and ccu.table_name in ('channel', 'message')
          and tc.table_schema = 'public'`,
    );

    // deleteChannel 이 명시적으로 지우는 테이블. 여기와 services/channels.ts 의 delete 문이
    // 같아야 한다 — 달라지면 아래 단언이 알려 준다.
    const explicit = new Set([
      'message_pin', 'channel_read', 'channel_member', 'channel_pref',
      // #188: 채널 문서. 이 테스트가 실제로 그 누락을 잡았다 — 문서 테이블이 생겼는데
      // deleteChannel 이 그것을 몰라, 문서가 있는 채널의 삭제가 FK 위반으로 터졌다.
      'channel_doc',
      // #222: 예약 메시지. channel 과 message 를 모두 참조한다 — 예약이 하나라도 걸린
      // 채널은 이것이 없으면 삭제가 FK 위반으로 터진다.
      'scheduled_message',
      // 마이그레이션 040: 깨움. channel 과 message 를 모두 참조한다 — 예약 발송과 같은
      // 처지이고, 같은 이유로 message 보다 먼저 지워야 한다.
      'agent_wake',
      'inbox', 'idempotency_key', 'saved_message', 'message', 'channel',
    ]);

    /**
     * **`SET NULL` 도 안전하다**(마이그레이션 050 이 이 판정을 넓혔다).
     *
     * 이 시험이 막는 것은 *"삭제가 FK 위반으로 터지는 것"* 이고, `SET NULL` 은 원리적으로
     * 그것을 일으키지 않는다 — 참조하던 열이 null 이 될 뿐이다. 050 의
     * `team_delegation_item.closed_by_message_id` 가 그 갈래다(어느 발화가 이 의무를
     * 닫았는지를 가리키는데, 그 메시지가 지워져도 의무 자체는 남아야 한다).
     *
     * 그 행이 남지 않는지는 **부모의 cascade** 가 답한다: `team_delegation` 이 channel 에
     * cascade 로 매달려 있고 `team_delegation_item` 은 그 위임에 cascade 로 매달려 있다.
     * 즉 채널을 지우면 둘 다 함께 사라지므로 고아가 생기지 않는다.
     */
    const unhandled = refs.rows
      .filter((r) => r.delete_rule !== 'CASCADE' && r.delete_rule !== 'SET NULL'
        && !explicit.has(r.table_name))
      .map((r) => r.table_name);

    expect(unhandled).toEqual([]);
    // 세어 본 것이 실제로 있었음을 확인한다 — 조회가 0행이면 위 단언은 아무것도 지키지 않는다.
    expect(refs.rowCount).toBeGreaterThan(5);
  });
});
