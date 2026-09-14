import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * 채널 이름 바꾸기의 회귀선 — `PATCH /channels/:id` 의 `name`.
 *
 * 여기서 지키는 것은 "이름이 바뀐다"가 아니라 **바뀌지 않아야 할 것이 안 바뀌는가**다.
 * `updateChannel` 은 한 UPDATE 문에서 다섯 필드를 조건부로 쓰므로, 새 필드를 더할 때
 * 파라미터 자리를 한 칸 밀면 **다른 필드가 조용히 덮인다**(topic 만 고쳤는데 이름이 null 이
 * 되는 식으로). 그래서 아래 테스트들이 "안 보낸 필드는 그대로"를 매번 함께 확인한다.
 *
 * 충돌(409)을 따로 세는 이유: `channel.name` 은 DB 유니크이고, 그 위반을 500 으로 흘리면
 * 사용자는 자기가 고칠 수 있는 실패(다른 이름을 쓰면 된다)를 서버 고장으로 본다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let nonAdminToken: string;
let nonAdminId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function makeChannel(name: string, topic = ''): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name, topic },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  const agent = await createAgent(app, adminToken, 'renamer');
  nonAdminToken = agent.pat;
  nonAdminId = agent.accountId;
});
afterAll(async () => { await app.close(); await stop(); });

describe('channel rename', () => {
  it('admin renames; the list and the response both carry the new name', async () => {
    const id = await makeChannel('rename-before', 'keep me');

    const res = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: auth(adminToken),
      payload: { name: 'rename-after' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('rename-after');
    // 이름만 보냈으므로 topic 은 그대로여야 한다 — 조건부 UPDATE 가 어긋나면 여기서 빨개진다.
    expect(res.json().topic).toBe('keep me');

    const list = await app.inject({ method: 'GET', url: '/channels', headers: auth(adminToken) });
    const ch = list.json().channels.find((c: { id: string }) => c.id === id);
    expect(ch.name).toBe('rename-after');
  });

  it('topic-only patch leaves the name alone', async () => {
    const id = await makeChannel('rename-untouched');

    const res = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: auth(adminToken),
      payload: { topic: 'new topic' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('rename-untouched');
    expect(res.json().topic).toBe('new topic');
  });

  it('a taken name returns 409 channel_name_taken and changes nothing', async () => {
    await makeChannel('rename-taken');
    const id = await makeChannel('rename-mine');

    const res = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: auth(adminToken),
      payload: { name: 'rename-taken' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('channel_name_taken');

    const list = await app.inject({ method: 'GET', url: '/channels', headers: auth(adminToken) });
    const ch = list.json().channels.find((c: { id: string }) => c.id === id);
    expect(ch.name).toBe('rename-mine');
  });

  it('renaming a channel to the name it already has succeeds', async () => {
    // 폼이 이름 칸을 늘 채워 보내는 구현으로 바뀌어도 자기 이름에 걸려 409 가 나면 안 된다.
    const id = await makeChannel('rename-same');
    const res = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: auth(adminToken),
      payload: { name: 'rename-same' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('rename-same');
  });

  it('a name that breaks the pattern is rejected before it reaches the database', async () => {
    const id = await makeChannel('rename-pattern');
    for (const bad of ['Has Upper', 'has space', 'has/slash', '', 'x'.repeat(49)]) {
      const res = await app.inject({
        method: 'PATCH', url: `/channels/${id}`, headers: auth(adminToken), payload: { name: bad },
      });
      expect(res.statusCode).toBe(400);
    }
    const list = await app.inject({ method: 'GET', url: '/channels', headers: auth(adminToken) });
    const ch = list.json().channels.find((c: { id: string }) => c.id === id);
    expect(ch.name).toBe('rename-pattern');
  });

  it('a non-admin cannot rename', async () => {
    const id = await makeChannel('rename-guarded');
    const res = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: auth(nonAdminToken),
      payload: { name: 'rename-hijacked' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a DM has no name to change — 404, not a renamed DM', async () => {
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: auth(adminToken), payload: { accountIds: [nonAdminId] },
    });
    expect(dm.statusCode).toBe(201);
    const res = await app.inject({
      method: 'PATCH', url: `/channels/${dm.json().id}`, headers: auth(adminToken),
      payload: { name: 'dm-renamed' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('the audit log keeps from/to, and a no-op rename writes nothing', async () => {
    const id = await makeChannel('rename-audited');
    await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: auth(adminToken),
      payload: { name: 'rename-audited-2' },
    });
    // 같은 이름으로 다시 저장한 것은 사건이 아니다 — 항목이 늘면 안 된다.
    await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: auth(adminToken),
      payload: { name: 'rename-audited-2' },
    });

    const audit = await app.inject({
      method: 'GET', url: '/audit?action=channel.renamed', headers: auth(adminToken),
    });
    const mine = audit.json().entries.filter((e: { target: string }) => e.target === id);
    expect(mine).toHaveLength(1);
    expect(mine[0].detail).toEqual({ from: 'rename-audited', to: 'rename-audited-2' });
  });
});
