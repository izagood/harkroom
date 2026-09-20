// `/auth/me` 가 **전역** capability 목록을 준다 — 화면 게이트의 근거(스펙 2026-09-20 §6).
// 대상 한정 grant(scope ≠ '')는 여기 없다: 목록으로 펼치면 "어느 채널의"가 사라진다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { CAPABILITIES } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let memberToken: string; let memberId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: memberToken, accountId: memberId } = await createMember(app, adminToken, 'gated'));
});
afterAll(async () => { await app.close(); await stop(); });

describe('/auth/me 의 capabilities', () => {
  it('member 는 기본 capability 만 갖는다', async () => {
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(memberToken) });
    expect(me.json().role).toBe('member');
    expect(me.json().capabilities).toEqual(['operator.register']);
  });
  it('전역 grant 를 받으면 목록에 더해진다', async () => {
    await app.inject({ method: 'PUT', url: `/accounts/${memberId}/grants`, headers: auth(adminToken), payload: { capability: 'channel.create' } });
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(memberToken) });
    expect(me.json().capabilities).toEqual(expect.arrayContaining(['operator.register', 'channel.create']));
    expect(me.json().capabilities).toHaveLength(2);
  });
  it('대상 한정 grant 는 목록에 안 실린다', async () => {
    await app.inject({ method: 'PUT', url: `/accounts/${memberId}/grants`, headers: auth(adminToken), payload: { capability: 'team.manage', scope: `team:${memberId}` } });
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(memberToken) });
    expect(me.json().capabilities).not.toContain('team.manage');
  });
  it('owner 는 전부 갖는다', async () => {
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(adminToken) });
    expect(me.json().role).toBe('owner');
    expect([...me.json().capabilities].sort()).toEqual([...CAPABILITIES].sort());
  });
});
