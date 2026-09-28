// 소유는 grant 가 아니다(스펙 2026-09-20 §6 (3)). 내가 만든 채널은 `channel.manage` grant 없이
// 내가 관리한다 — `channel.created_by`(056)와 `can()` 의 소유 분기가 그것을 성립시킨다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let aToken: string; let aId: string; let bToken: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: aToken, accountId: aId } = await createMember(app, adminToken, 'alice'));
  ({ token: bToken } = await createMember(app, adminToken, 'bob'));
  await app.inject({ method: 'PUT', url: `/accounts/${aId}/grants`, headers: auth(adminToken), payload: { capability: 'channel.create' } });
});
afterAll(async () => { await app.close(); await stop(); });

describe('내가 만든 채널은 grant 없이 내가 관리한다', () => {
  it('생성자는 PATCH 할 수 있고 남은 못 한다', async () => {
    const created = await app.inject({ method: 'POST', url: '/channels', headers: auth(aToken), payload: { name: 'mine' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const mine = await app.inject({ method: 'PATCH', url: `/channels/${id}`, headers: auth(aToken), payload: { topic: 't' } });
    expect(mine.statusCode).toBe(200);
    const theirs = await app.inject({ method: 'PATCH', url: `/channels/${id}`, headers: auth(bToken), payload: { topic: 'u' } });
    expect(theirs.statusCode).toBe(403);
  });
  it('생성자는 자기 채널을 지울 수 있다', async () => {
    const created = await app.inject({ method: 'POST', url: '/channels', headers: auth(aToken), payload: { name: 'gone' } });
    const id = created.json().id as string;
    const del = await app.inject({ method: 'DELETE', url: `/channels/${id}`, headers: auth(aToken) });
    expect(del.statusCode).not.toBe(403);
  });
});
