// 협업 탭이 읽는 표면. **실서버(in-process avcs-server) + 실제 DB** 를 상대로 본다 —
// 이 라우트가 하는 일의 대부분이 "두 원본을 붙이는 것" 이라, 어느 한쪽을 가짜로 두면
// 정작 붙는 자리가 검증되지 않는다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startAvcsServer } from '@izagood/avcs-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let hub: { url: string; close: () => Promise<void> };
let dataDir: string;
let adminToken: string;
let adminId: string;

const REPO = 'acme/collab';

async function put(obj: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${hub.url}/${REPO}/objects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });
  const body = (await res.json()) as { oid?: string; error?: string };
  if (!res.ok || !body.oid) throw new Error(`put failed: ${res.status} ${JSON.stringify(body)}`);
  return body.oid;
}

const ALPHA = { kind: 'ai_agent' as const, id: 'ai:alpha', model: 'opus' };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'murmur-collab-'));
  hub = await startAvcsServer({ dataDir, host: '127.0.0.1' });
  ({ pool, stop } = await startTestDb());
  app = await buildServer({
    pool,
    projection: { envBaseUrl: null, reconfigure: async () => {}, currentUrl: () => hub.url },
  });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));

  await pool.query(
    `insert into channel (name, topic, kind, repo, visibility) values ('collab', '', 'standard', $1, 'public')`,
    [REPO],
  );
  // avcs 의 actor 키가 murmur 계정으로 되짚어지는 자리(줄이 말하는 넷 중 "누가").
  await pool.query(
    `insert into account_key (key_id, account_id, public_key_pem) values ('human:jaebin', $1, 'pem')`,
    [adminId],
  );

  const intentOid = await put({
    type: 'intent',
    title: '008 마이그레이션을 되돌린다',
    owner: 'human:jaebin',
    kind: 'bugfix',
    priority: 'high',
    constraints: [],
    successCriteria: ['되돌린 뒤에도 테스트가 돈다'],
    allowedScopes: ['file:packages/server/'],
    createdAt: new Date().toISOString(),
  });
  const sessionOid = await put({
    type: 'session',
    intentOid,
    actor: ALPHA,
    baseViewOid: null,
    summary: '되돌리기 세션',
    openedEntities: ['file:packages/server/src/db/migrations/008.sql'],
    toolCalls: [],
    startedAt: new Date().toISOString(),
  });
  await put({
    type: 'operation',
    sessionOid,
    intentOid,
    actor: ALPHA,
    target: { entityKind: 'file', entityId: 'packages/server/src/db/migrations/008.sql' },
    body: { kind: 'note' },
    causalDeps: [],
    declaredPurpose: '008 을 지운다',
    effects: { changesBehavior: true, breaksPublicApi: false },
    lamport: 1,
    createdAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  await app.close();
  await stop();
  await hub.close();
  await rm(dataDir, { recursive: true, force: true });
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('GET /collab/proposals', () => {
  it('바인딩된 저장소의 제안을 트리로 주고, 어느 시점의 판정인지 함께 말한다', async () => {
    const res = await app.inject({ method: 'GET', url: '/collab/proposals', headers: auth(adminToken) });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.baseUrl).toBe(hub.url);
    expect(body.repos).toHaveLength(1);

    const repo = body.repos[0];
    expect(repo.repo).toBe(REPO);
    expect(repo.channelIds).toHaveLength(1);
    expect(repo.error).toBeNull();
    expect(repo.proposals).toHaveLength(1);

    const p = repo.proposals[0];
    expect(p.title).toBe('008 마이그레이션을 되돌린다');
    expect(p.ownerKeyId).toBe('human:jaebin');
    expect(p.ops).toHaveLength(1);
    expect(p.ops[0].purpose).toBe('008 을 지운다');
    // 줄이 말하는 넷 중 "무엇을 건드리나".
    expect(p.effects).toEqual({ changesBehavior: true, breaksPublicApi: false });
    // 환원 평면이 붙어 있으므로 "모른다" 가 아니어야 한다.
    expect(p.state).not.toBe('unknown');
    expect(repo.reducedAt.materializer).not.toBe('');
    expect(repo.reducedAt.cursor).toBeGreaterThan(0);
  });

  it('avcs 의 actor 키를 아는 만큼만 계정으로 되짚는다 — 모르는 키는 목록에 없다', async () => {
    const res = await app.inject({ method: 'GET', url: '/collab/proposals', headers: auth(adminToken) });
    const { actors } = res.json();

    expect(actors['human:jaebin']).toBe(adminId);
    // alpha 는 이 워크스페이스에 계정이 없다. 지어내지 않는다 — 그것이 "외부 작업자" 다.
    expect(actors['ai:alpha']).toBeUndefined();
  });

  it('두 번째 호출도 같은 목록을 준다 — 커서를 들고 따라잡을 뿐 다시 처음부터 세지 않는다', async () => {
    const first = await app.inject({ method: 'GET', url: '/collab/proposals', headers: auth(adminToken) });
    const second = await app.inject({ method: 'GET', url: '/collab/proposals', headers: auth(adminToken) });

    expect(second.json().repos[0].proposals).toEqual(first.json().repos[0].proposals);
    // 로그를 두 번 접었다면 op 이 두 개로 보였을 것이다.
    expect(second.json().repos[0].proposals[0].ops).toHaveLength(1);
  });

  it('로그인하지 않으면 못 읽는다', async () => {
    const res = await app.inject({ method: 'GET', url: '/collab/proposals' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /collab/proposals — 투영 URL 이 없을 때', () => {
  it('빈 목록과 baseUrl:null 을 준다 — "제안이 없다" 와 "보고 있는 서버가 없다" 는 다르다', async () => {
    const off = await buildServer({
      pool,
      projection: { envBaseUrl: null, reconfigure: async () => {}, currentUrl: () => null },
    });
    try {
      const res = await off.inject({ method: 'GET', url: '/collab/proposals', headers: auth(adminToken) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ baseUrl: null, repos: [] });
    } finally {
      await off.close();
    }
  });
});
