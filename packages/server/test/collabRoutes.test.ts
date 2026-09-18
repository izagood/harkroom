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
  dataDir = await mkdtemp(join(tmpdir(), 'harkroom-collab-'));
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
  // avcs 의 actor 키가 harkroom 계정으로 되짚어지는 자리(줄이 말하는 넷 중 "누가").
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

describe('GET /collab/proposals — 저장소마다 다른 서버(051)', () => {
  it('저장소가 자기 주소를 들면 전역 대신 그것으로 읽는다', async () => {
    // 두 번째 avcs 서버. 전역(hub)에는 없는 제안을 여기에만 넣는다 — 화면에 그것이 서면
    // 주소가 저장소별로 갈렸다는 뜻이다.
    const other = await startAvcsServer({ dataDir: await mkdtemp(join(tmpdir(), 'murmur-collab2-')), host: '127.0.0.1' });
    try {
      const slug = 'acme/other';
      const put2 = async (obj: Record<string, unknown>): Promise<string> => {
        const res = await fetch(`${other.url}/${slug}/objects`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj),
        });
        const body = (await res.json()) as { oid?: string };
        if (!res.ok || !body.oid) throw new Error(`put failed: ${res.status}`);
        return body.oid;
      };
      await put2({
        type: 'intent', title: '다른 서버의 제안', owner: 'human:jaebin', kind: 'feature',
        priority: 'normal', constraints: [], successCriteria: ['x'],
        allowedScopes: ['file:packages/'], createdAt: new Date().toISOString(),
      });

      await pool.query(
        `insert into channel (name, topic, kind, repo, visibility) values ('other', '', 'standard', $1, 'public')`,
        [slug],
      );
      await pool.query(`insert into repo (slug, base_url) values ($1, $2)`, [slug, other.url]);

      const res = await app.inject({ method: 'GET', url: '/collab/proposals', headers: auth(adminToken) });
      const body = res.json();

      const mine = body.repos.find((r: { repo: string }) => r.repo === slug);
      expect(mine.baseUrl).toBe(other.url);
      expect(mine.mode).toBe('linked');
      expect(mine.proposals[0].title).toBe('다른 서버의 제안');

      // 전역을 쓰는 저장소는 그대로다 — 하나가 갈렸다고 나머지가 따라가지 않는다.
      const global = body.repos.find((r: { repo: string }) => r.repo === REPO);
      expect(global.baseUrl).toBe(hub.url);
      expect(body.baseUrl).toBe(hub.url);
    } finally {
      await pool.query(`delete from channel where repo = 'acme/other'`);
      await pool.query(`delete from repo where slug = 'acme/other'`);
      await other.close();
    }
  });

  it('바인딩만 걸어도 저장소 행이 생긴다 — 설정 화면을 거치게 하지 않는다', async () => {
    await pool.query(`delete from repo where slug = $1`, [REPO]);

    await app.inject({ method: 'GET', url: '/collab/proposals', headers: auth(adminToken) });

    const rows = await pool.query(`select mode, base_url from repo where slug = $1`, [REPO]);
    expect(rows.rows[0]).toEqual({ mode: 'linked', base_url: null });
  });
});

describe('GET /collab/proposals — hosted 저장소', () => {
  it('murmur 가 띄운 서버에서 읽는다 — 전역이 있어도 그쪽을 보지 않는다', async () => {
    const { AvcsHost } = await import('../src/avcs/host.js');
    const dir = await mkdtemp(join(tmpdir(), 'murmur-hostmode-'));
    const host = new AvcsHost({ dataDir: dir });
    const slug = 'acme/hosted';
    const hosted = await buildServer({
      pool,
      projection: { envBaseUrl: null, reconfigure: async () => {}, currentUrl: () => hub.url },
      avcsHost: host,
    });
    try {
      // 호스트를 먼저 띄워 주소를 안 뒤, **그 서버에만** 제안을 넣는다. 화면에 그것이 서면
      // hosted 저장소가 전역이 아니라 murmur 자신을 읽었다는 뜻이다.
      const url = await host.ensure();
      expect(url).not.toBeNull();
      const res = await fetch(`${url}/${slug}/objects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'intent', title: 'murmur 안에서 올린 제안', owner: 'human:jaebin', kind: 'feature',
          priority: 'normal', constraints: [], successCriteria: ['x'],
          allowedScopes: ['file:packages/'], createdAt: new Date().toISOString(),
        }),
      });
      expect(res.ok).toBe(true);

      await pool.query(
        `insert into channel (name, topic, kind, repo, visibility) values ('hosted', '', 'standard', $1, 'public')`,
        [slug],
      );
      await pool.query(`insert into repo (slug, mode) values ($1, 'hosted')`, [slug]);

      const out = await hosted.inject({ method: 'GET', url: '/collab/proposals', headers: auth(adminToken) });
      const mine = out.json().repos.find((r: { repo: string }) => r.repo === slug);

      expect(mine.mode).toBe('hosted');
      expect(mine.baseUrl).toBe(url);
      expect(mine.proposals[0].title).toBe('murmur 안에서 올린 제안');
    } finally {
      await hosted.close();
      await host.stop();
      await pool.query(`delete from channel where repo = $1`, [slug]);
      await pool.query(`delete from repo where slug = $1`, [slug]);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('호스트가 없으면 그 저장소만 no-server 다 — 나머지는 그대로 선다', async () => {
    const slug = 'acme/nohost';
    await pool.query(
      `insert into channel (name, topic, kind, repo, visibility) values ('nohost', '', 'standard', $1, 'public')`,
      [slug],
    );
    await pool.query(`insert into repo (slug, mode) values ($1, 'hosted')`, [slug]);
    try {
      // 이 앱에는 `avcsHost` 를 주지 않았다(기본 인스턴스). hosted 저장소는 읽을 곳이 없다.
      const out = await app.inject({ method: 'GET', url: '/collab/proposals', headers: auth(adminToken) });
      const body = out.json();

      expect(body.repos.find((r: { repo: string }) => r.repo === slug).error).toBe('no-server');
      // 전역을 쓰는 저장소는 멀쩡하다.
      expect(body.repos.find((r: { repo: string }) => r.repo === REPO).error).toBeNull();
    } finally {
      await pool.query(`delete from channel where repo = $1`, [slug]);
      await pool.query(`delete from repo where slug = $1`, [slug]);
    }
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
