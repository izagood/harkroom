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
let agent1Id: string;
let agent2Id: string;
let disabledAgentId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));

  const agent1 = await createAgent(app, adminToken, 't1agent1');
  agent1Id = agent1.accountId;

  const agent2 = await createAgent(app, adminToken, 't1agent2');
  agent2Id = agent2.accountId;

  const disabledAgent = await createAgent(app, adminToken, 't1disabled');
  disabledAgentId = disabledAgent.accountId;
  await app.inject({
    method: 'PATCH', url: `/accounts/agents/${disabledAgentId}`, headers: auth(adminToken),
    payload: { disabled: true },
  });
});

afterAll(async () => { await app.close(); await stop(); });

describe('#172 팀을 채널에 추가', () => {
  it('12. private 채널에 팀 추가 → 팀원 전원이 멤버, alreadyMember 도 있다', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'chteam1' },
    });
    const teamId = team.json().id as string;

    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
    });
    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent2Id}`, headers: auth(adminToken),
    });

    const channel = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken),
      payload: { name: 'teamch1', visibility: 'private' },
    });
    const channelId = channel.json().id as string;

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`, headers: auth(adminToken),
      payload: { accountId: agent1Id },
    });

    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/teams/${teamId}/add`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { added: string[]; skipped: string[]; alreadyMember: string[] };
    expect(body.added).toContain('t1agent2');
    expect(body.alreadyMember).toContain('t1agent1');
  });

  it('13. 비활성 팀원은 건너뛰고 skipped 에 handle 이 있다', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'chteam2' },
    });
    const teamId = team.json().id as string;

    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${disabledAgentId}`, headers: auth(adminToken),
    });

    const channel = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken),
      payload: { name: 'teamch2', visibility: 'private' },
    });
    const channelId = channel.json().id as string;

    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/teams/${teamId}/add`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { added: string[]; skipped: string[]; alreadyMember: string[] };
    expect(body.skipped).toContain('t1disabled');
    expect(body.added).toHaveLength(0);
  });

  it('14. public 채널에 팀 추가는 400 channel_is_public', async () => {
    const team = await app.inject({
      method: 'POST', url: '/teams', headers: auth(adminToken),
      payload: { name: 'chteam3' },
    });
    const teamId = team.json().id as string;

    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/members/${agent1Id}`, headers: auth(adminToken),
    });

    const channel = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken),
      payload: { name: 'teamch3', visibility: 'public' },
    });
    const channelId = channel.json().id as string;

    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/teams/${teamId}/add`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'channel_is_public' } });
  });
});