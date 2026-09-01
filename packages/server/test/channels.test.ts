import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

describe('channels', () => {
  it('admin creates channel with repo binding; anyone lists it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'dev', topic: 'work', repo: 'main-repo' },
    });
    expect(res.statusCode).toBe(201);
    const list = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.json().channels).toEqual([
      expect.objectContaining({ name: 'dev', kind: 'standard', repo: 'main-repo' }),
    ]);
  });

  // repo 바인딩은 생성 시에만 지정할 수 있었다 — avcs 주소 규약이 바뀌자 기존 채널을 고칠
  // 경로가 없어 SQL을 직접 건드려야 했다.
  it('admin rebinds a channel repo and topic', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'rebind', topic: '옛 주제', repo: 'legacy' },
    });
    const id = created.json().id as string;

    const patched = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { topic: '새 주제', repo: 'izagood/murmur' },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ id, name: 'rebind', topic: '새 주제', repo: 'izagood/murmur' });
  });

  it('leaves untouched fields alone on a partial patch', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'partial', topic: '유지되어야 함', repo: 'keep/me' },
    });
    const id = created.json().id as string;

    const patched = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { topic: '주제만 바꾼다' },
    });

    expect(patched.json()).toMatchObject({ topic: '주제만 바꾼다', repo: 'keep/me' });
  });

  it('clears a repo binding with an explicit null', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'unbind', repo: 'drop/me' },
    });
    const id = created.json().id as string;

    const patched = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { repo: null },
    });

    expect(patched.json().repo).toBeNull();
  });

  it('refuses a channel patch from a non-admin', async () => {
    const created = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'guarded', repo: 'a/b' },
    });
    const id = created.json().id as string;
    const { pat } = await createAgent(app, adminToken, 'patchbot');

    const patched = await app.inject({
      method: 'PATCH', url: `/channels/${id}`, headers: { authorization: `Bearer ${pat}` },
      payload: { repo: 'evil/repo' },
    });

    expect(patched.statusCode).toBe(403);
  });

  it('404s a patch against an unknown channel', async () => {
    const patched = await app.inject({
      method: 'PATCH', url: '/channels/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { topic: '없는 채널' },
    });
    expect(patched.statusCode).toBe(404);
  });

  it('dm is deduplicated for the same member set', async () => {
    const { accountId: botId } = await createAgent(app, adminToken, 'dmbot');
    const mk = () => app.inject({
      method: 'POST', url: '/dms', headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountIds: [botId] },
    });
    const a = await mk();
    const b = await mk();
    expect(a.json().id).toBe(b.json().id);
    expect(a.json().kind).toBe('dm');
  });
});
