import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let agent1Id: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));

  const agent1 = await createAgent(app, adminToken, 'auditagent');
  agent1Id = agent1.accountId;
});

afterAll(async () => { await app.close(); await stop(); });

describe('#172 감사 로그 detail 에 handle 만 있다', () => {
  it('15. team.created 감사 detail 에 handle 만 있다', async () => {
    await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'auditteam' },
    });

    const audit = await app.inject({
      method: 'GET', url: '/audit', headers: auth(adminToken),
      payload: { limit: 10 },
    });
    expect(audit.statusCode).toBe(200);
    const entries = (audit.json() as { entries: { action: string; detail: Record<string, unknown> }[] }).entries;
    const created = entries.find((e) => e.action === 'team.created');
    expect(created).toBeDefined();
    expect(created!.detail).toEqual({ handle: 'auditteam' });
  });

  it('16. team.member.added 감사 detail 에 handle 만 있다', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'auditteam2' },
    });
    const teamId = team.json().id as string;

    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
    });

    const audit = await app.inject({
      method: 'GET', url: '/audit', headers: auth(adminToken),
      payload: { limit: 10 },
    });
    expect(audit.statusCode).toBe(200);
    const entries = (audit.json() as { entries: { action: string; detail: Record<string, unknown> }[] }).entries;
    const added = entries.find((e) => e.action === 'team.member.added');
    expect(added).toBeDefined();
    expect(added!.detail).toEqual({ handle: 'auditagent' });
  });

  it('17. channel.team.added 감사 detail 에 teamHandle 과 개수만 있다', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'auditteam3' },
    });
    const teamId = team.json().id as string;

    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
    });

    const channel = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken),
      payload: { name: 'auditch', visibility: 'private' },
    });
    const channelId = channel.json().id as string;

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/teams/${teamId}/add`, headers: auth(adminToken),
    });

    const audit = await app.inject({
      method: 'GET', url: '/audit', headers: auth(adminToken),
      payload: { limit: 10 },
    });
    expect(audit.statusCode).toBe(200);
    const entries = (audit.json() as { entries: { action: string; detail: Record<string, unknown> }[] }).entries;
    const added = entries.find((e) => e.action === 'channel.team.added');
    expect(added).toBeDefined();
    expect(added!.detail).toEqual({ teamHandle: 'auditteam3', added: 1, skipped: 0 });
  });

  /**
   * 삭제도 이름을 남긴다. 초판은 `detail: {}` 이었다 — 지운 뒤에는 팀 이름을 물어볼
   * 곳이 없으므로, 그 기록에는 "어떤 팀이 사라졌는가"가 영영 없다. 감사가 답해야 하는
   * 질문이 바로 그것이다.
   */
  it('17b. team.deleted 감사 detail 에 지운 팀의 handle 이 있다', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'auditgone' },
    });
    const teamId = team.json().id as string;
    const del = await app.inject({
      method: 'DELETE', url: `/teams/${teamId}`, headers: auth(adminToken),
    });
    expect(del.statusCode).toBe(204);

    const audit = await app.inject({ method: 'GET', url: '/audit', headers: auth(adminToken) });
    const entries = (audit.json() as { entries: { action: string; detail: Record<string, unknown> }[] }).entries;
    const deleted = entries.find((e) => e.action === 'team.deleted');
    expect(deleted).toBeDefined();
    expect(deleted!.detail).toEqual({ handle: 'auditgone' });
  });

  it('17c. team.member.removed 감사 detail 에 handle 만 있다', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'auditteam4' },
    });
    const teamId = team.json().id as string;
    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
    });
    await app.inject({
      method: 'DELETE', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
    });

    const audit = await app.inject({ method: 'GET', url: '/audit', headers: auth(adminToken) });
    const entries = (audit.json() as { entries: { action: string; detail: Record<string, unknown> }[] }).entries;
    const removed = entries.find((e) => e.action === 'team.member.removed');
    expect(removed).toBeDefined();
    expect(removed!.detail).toEqual({ handle: 'auditagent' });
  });
});