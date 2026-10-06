import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { createSecretKeyring } from '../src/services/secretKeyring.js';
import { RevealLimiter, suspendSecretGrants } from '../src/services/secretAccess.js';
import { AGENT_SECRET_MAX } from '../src/services/secretCreate.js';

// 에이전트가 비밀을 만든다(102) — 서버 판정(security F1~F4, L2·L4~L6). 스레드 1a08d0cf.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
// 실제 토큰 모양의 리터럴을 저장소에 두지 않는다 — 런타임에 조립한다.
const IMPORTED = `imp_${'q'.repeat(30)}`;
const OTHERS = `mnt_${'z'.repeat(30)}`;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('에이전트가 비밀을 만든다 (102)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let agentId: string;
  let sibling: string;
  let op: { token: string; operatorId: string };
  let ch: string;
  let ch2: string;
  const ring = createSecretKeyring(new Map([['k1', randomBytes(32)]]), 'k1');
  const limiter = new RevealLimiter(1000, 60_000);

  const asAgent = (id = agentId, o = op) => ({ ...auth(o.token), 'x-harkroom-agent': id });
  const mention = async (channelId: string, authorId: string, forAgent = agentId): Promise<string> => {
    const m = await pool.query(
      `insert into message (channel_id, author_id, body, kind) values ($1, $2, 'hi', 'user') returning id`, [channelId, authorId]);
    const id = m.rows[0].id as string;
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [forAgent, id]);
    return id;
  };
  const lease = async (channelId = ch, authorId = alice.accountId, forAgent = agentId) => {
    const res = await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(forAgent), payload: { causeMessageId: await mention(channelId, authorId, forAgent) } });
    expect(res.statusCode).toBe(200);
    return res.json().lease as { id: string; token: string };
  };
  const create = (l: { id: string; token: string }, name: string, source: unknown, extra: Record<string, unknown> = {}, id = agentId) =>
    app.inject({ method: 'POST', url: '/agent/secrets', headers: asAgent(id), payload: { leaseId: l.id, token: l.token, name, source, ...extra } });
  const rotate = (l: { id: string; token: string }, name: string, source: unknown) =>
    app.inject({ method: 'POST', url: '/agent/secrets/rotate', headers: asAgent(), payload: { leaseId: l.id, token: l.token, name, source } });
  const reveal = (l: { id: string; token: string }, name: string, id = agentId) =>
    app.inject({ method: 'POST', url: '/agent/secrets/reveal', headers: asAgent(id), payload: { leaseId: l.id, token: l.token, name } });
  const giveCreate = (token: string, id = agentId) =>
    app.inject({ method: 'PUT', url: `/accounts/${id}/grants`, headers: auth(token), payload: { capability: 'secret.create', scope: '' } });
  const secretRow = async (name: string) => (await pool.query(`select * from secret where name = $1`, [name])).rows[0];

  beforeAll(async () => {
    db = await startTestDb();
    pool = db.pool;
    app = await buildServer({ pool, secretKeyring: ring, secretRevealLimiter: limiter, secretCreateLimiter: new RevealLimiter(1000, 60_000) });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    agentId = (await createAgent(app, admin.token, 'maker')).accountId;
    sibling = (await createAgent(app, admin.token, 'sibling')).accountId;
    await pool.query(`update agent_config set owner_account_id = $1 where account_id = any($2::uuid[])`, [alice.accountId, [agentId, sibling]]);
    op = await registerOperator(app, admin.token, 'mac');
    for (const a of [agentId, sibling]) {
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a, op.operatorId, admin.accountId]);
    }
    const mk = async (name: string) => (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name } })).json().id as string;
    ch = await mk('build');
    ch2 = await mk('other');
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('capability 없으면 not_granted — 주는 것은 그 에이전트의 소유자만(admin 도 아니다)', async () => {
    const res = await create(await lease(), 'early', { generate: { type: 'password' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_granted');
    expect((await giveCreate(admin.token)).statusCode).toBe(403);
    expect((await giveCreate(bob.token)).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/accounts/${agentId}/grants`, headers: auth(alice.token), payload: { capability: 'secret.create', scope: `channel:${ch}` } })).statusCode).toBe(400);
    expect((await giveCreate(alice.token)).statusCode).toBe(200);
  });

  it('F2: 소유자가 아닌 사람·에이전트가 띄운 턴은 cause_not_owner', async () => {
    const byBob = await create(await lease(ch, bob.accountId), 'by-bob', { generate: { type: 'password' } });
    expect(byBob.statusCode).toBe(403);
    expect(byBob.json().error.code).toBe('cause_not_owner');
    const byAgent = await create(await lease(ch, sibling), 'by-agent', { generate: { type: 'password' } });
    expect(byAgent.json().error.code).toBe('cause_not_owner');
    const audit = await pool.query(`select detail from audit_log where action = 'secret.create.denied' order by id desc limit 1`);
    expect(audit.rows[0].detail).toMatchObject({ code: 'cause_not_owner', causeAuthorId: sibling });
    expect(await secretRow('by-bob')).toBeUndefined();
  });

  it('generate: 값은 응답에 없고, 소유자는 사람·자동 부여는 임대 채널·오퍼레이터 한 줄·기본 만료 90일(L5)', async () => {
    const l = await lease();
    const res = await create(l, 'db-pass', { generate: { type: 'password', length: 40 } }, { description: 'staging db' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ secret: { name: 'db-pass', kind: 'text', version: 1 }, publicKey: null });
    expect(JSON.stringify(res.json())).not.toMatch(/valueBase64|value"/);
    const s = await secretRow('db-pass');
    expect(s).toMatchObject({ owner_account_id: alice.accountId, created_by_agent_id: agentId });
    const days = (new Date(s.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
    const g = await pool.query(`select * from secret_grant where secret_id = $1`, [s.id]);
    expect(g.rows).toHaveLength(1);
    expect(g.rows[0]).toMatchObject({ agent_id: agentId, channel_id: ch, operator_id: op.operatorId, granted_by: agentId });
    expect((await pool.query(`select result from secret_access_log where secret_id = $1`, [s.id])).rows).toEqual([{ result: 'created' }]);
    // 같은 턴에 바로 받을 수 있다(mount:true 는 오퍼레이터가 이 reveal 을 부른다). 다른 채널에서는 아니다.
    const got = await reveal(l, 'db-pass');
    expect(got.statusCode).toBe(200);
    expect(Buffer.from(got.json().valueBase64, 'base64').length).toBe(40);
    expect((await reveal(await lease(ch2), 'db-pass')).json().error.code).toBe('wrong_channel');
  });

  it('n4: 만들면 소유자에게 알린다 — 그 턴의 스레드에 서버 줄 + 소유자 인박스(설명·값은 싣지 않는다)', async () => {
    const l = await lease();
    const res = await create(l, 'notice-me', { generate: { type: 'token_hex' } }, { description: 'not in the notice' });
    expect(res.statusCode).toBe(201);
    const s = await secretRow('notice-me');
    const m = (await pool.query(
      `select id, body, kind, author_id, channel_id, meta from message where meta->'secretNotice'->>'secretId' = $1`, [s.id])).rows;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'system', author_id: agentId, channel_id: ch });
    expect(m[0].meta.secretNotice).toMatchObject({ action: 'created', name: 'notice-me', via: 'generate', ownerAccountId: alice.accountId });
    expect(m[0].body).toContain('`notice-me`');
    expect(m[0].body).not.toContain('not in the notice');
    const inbox = (await pool.query(`select reason from inbox where account_id = $1 and message_id = $2`, [alice.accountId, m[0].id])).rows;
    expect(inbox.length).toBeGreaterThan(0);
    // 회전도 알린다.
    const r = await rotate(await lease(), 'notice-me', { generate: { type: 'token_hex' } });
    expect(r.statusCode).toBe(200);
    const after = (await pool.query(
      `select meta from message where meta->'secretNotice'->>'secretId' = $1 order by created_at`, [s.id])).rows;
    expect(after.map((x) => x.meta.secretNotice.action)).toEqual(['created', 'rotated']);
  });

  it('ssh_ed25519: 공개키만 돌려준다', async () => {
    const res = await create(await lease(), 'deploy-key', { generate: { type: 'ssh_ed25519' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().secret.kind).toBe('file');
    expect(res.json().publicKey).toMatch(/^ssh-ed25519 \S+ harkroom:deploy-key$/);
    expect(res.body).not.toContain('PRIVATE KEY');
  });

  it('import: 값을 받아 봉하고, 이름이 겹치면 409 name_taken(L2)', async () => {
    const l = await lease();
    const res = await create(l, 'api-token', { import: { kind: 'text', valueBase64: b64(IMPORTED) } });
    expect(res.statusCode).toBe(201);
    expect(Buffer.from((await reveal(l, 'api-token')).json().valueBase64, 'base64').toString()).toBe(IMPORTED);
    const dup = await create(l, 'api-token', { generate: { type: 'password' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('name_taken');
  });

  it('F4: 같은 오퍼레이터에서 살아 있는 임대로 마운트된 남의 값은 import 하지 못한다(value_is_mounted)', async () => {
    const sid = (await app.inject({ method: 'POST', url: '/secrets', headers: auth(alice.token), payload: { name: 'sib-key', kind: 'text', value: OTHERS } })).json().secret.id as string;
    expect((await app.inject({ method: 'PUT', url: `/secrets/${sid}/grants`, headers: auth(alice.token), payload: { agentId: sibling, channelId: ch } })).statusCode).toBe(200);
    const sibLease = await lease(ch, alice.accountId, sibling);
    expect((await reveal(sibLease, 'sib-key', sibling)).statusCode).toBe(200);
    // 끝 줄바꿈을 붙여도 같은 값이다.
    const res = await create(await lease(), 'laundered', { import: { kind: 'text', valueBase64: b64(`${OTHERS}\n`) } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('value_is_mounted');
    expect(await secretRow('laundered')).toBeUndefined();
    // 그 임대가 끝나면 마운트된 값이 아니다.
    await app.inject({ method: 'POST', url: `/agent/turn-leases/${sibLease.id}/end`, headers: asAgent(sibling), payload: { token: sibLease.token } });
    expect((await create(await lease(), 'laundered', { import: { kind: 'text', valueBase64: b64(OTHERS) } })).statusCode).toBe(201);
  });

  it('L4: valueBase64 는 오류·감사·접근 기록 어디에도 남지 않는다', async () => {
    const marker = `leak_${'m'.repeat(24)}`;
    const bad = await create(await lease(), 'bad name!', { import: { kind: 'text', valueBase64: b64(marker) } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain(b64(marker));
    const wrongKind = await create(await lease(), 'needs-file', { import: { kind: 'file', valueBase64: b64(marker) } });
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.body).not.toContain(b64(marker));
    await create(await lease(), 'marker', { import: { kind: 'text', valueBase64: b64(marker) } });
    const audit = await pool.query(`select detail::text as d from audit_log where action like 'secret.%'`);
    const access = await pool.query(`select row_to_json(l)::text as d from secret_access_log l`);
    for (const r of [...audit.rows, ...access.rows]) {
      expect(r.d).not.toContain(marker);
      expect(r.d).not.toContain(b64(marker));
    }
  });

  it('F3: 회전은 자기가 만든 최신 판·자동 부여 한 줄일 때만 — 사람 비밀은 404, 입양되면 409 adopted_by_owner', async () => {
    const l = await lease();
    const r1 = await rotate(l, 'db-pass', { generate: { type: 'password' } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().secret.version).toBe(2);
    const s = await secretRow('db-pass');
    expect((await pool.query(`select version, sealed is null as gone from secret_version where secret_id = $1 order by version`, [s.id])).rows)
      .toEqual([{ version: 1, gone: true }, { version: 2, gone: false }]);
    expect((await rotate(l, 'sib-key', { generate: { type: 'password' } })).statusCode).toBe(404);
    // 종류가 다르면 안 된다.
    expect((await rotate(l, 'db-pass', { generate: { type: 'ssh_ed25519' } })).json().error.code).toBe('kind_mismatch');
    // 소유자가 다시 주면(granted_by = 사람) 입양이다.
    await app.inject({ method: 'PUT', url: `/secrets/${s.id}/grants`, headers: auth(alice.token), payload: { agentId, channelId: ch } });
    const r2 = await rotate(l, 'db-pass', { generate: { type: 'password' } });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe('adopted_by_owner');
    // 소유자가 값을 바꿔도 입양이다.
    const t = (await secretRow('api-token')).id as string;
    await app.inject({ method: 'PUT', url: `/secrets/${t}/value`, headers: auth(alice.token), payload: { value: `own_${'r'.repeat(20)}` } });
    expect((await rotate(l, 'api-token', { generate: { type: 'password' } })).json().error.code).toBe('adopted_by_owner');
  });

  it('L6: 정지(S2)는 자동 부여에도 걸린다 — reveal·회전 둘 다', async () => {
    const l = await lease();
    expect((await create(l, 'to-suspend', { generate: { type: 'token_hex' } })).statusCode).toBe(201);
    await suspendSecretGrants(pool, { agentId }, 'definition_changed');
    const l2 = await lease();
    expect((await reveal(l2, 'to-suspend')).json().error.code).toBe('grant_suspended');
    expect((await rotate(l2, 'to-suspend', { generate: { type: 'token_hex' } })).json().error.code).toBe('grant_suspended');
    await pool.query(`update secret_grant set suspended_at = null, suspend_reason = null where agent_id = $1`, [agentId]);
  });

  it(`상한: 자기가 만든 비밀 ${AGENT_SECRET_MAX}개 — 넘으면 too_many`, async () => {
    const have = (await pool.query(`select count(*)::int as n from secret where created_by_agent_id = $1`, [agentId])).rows[0].n as number;
    for (let i = have; i < AGENT_SECRET_MAX; i++) {
      await pool.query(`insert into secret (name, kind, owner_account_id, created_by_agent_id) values ($1, 'text', $2, $3)`, [`fill-${i}`, alice.accountId, agentId]);
    }
    const res = await create(await lease(), 'one-more', { generate: { type: 'password' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('too_many');
  });

  it('n2: 상한은 동시 호출에도 지킨다 — 한 자리 남았을 때 셋이 함께 와도 하나만 만든다', async () => {
    await pool.query(`delete from secret where created_by_agent_id = $1 and name like 'fill-%'`, [agentId]);
    const have = (await pool.query(`select count(*)::int as n from secret where created_by_agent_id = $1`, [agentId])).rows[0].n as number;
    for (let i = have; i < AGENT_SECRET_MAX - 1; i++) {
      await pool.query(`insert into secret (name, kind, owner_account_id, created_by_agent_id) values ($1, 'text', $2, $3)`, [`fill-${i}`, alice.accountId, agentId]);
    }
    const leases = [await lease(), await lease(), await lease()];
    const res = await Promise.all(leases.map((l, i) => create(l, `race-${i}`, { generate: { type: 'password' } })));
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    expect((await pool.query(`select count(*)::int as n from secret where created_by_agent_id = $1`, [agentId])).rows[0].n).toBe(AGENT_SECRET_MAX);
  });

  it('GET /agent/secret-create — 러너가 프롬프트 절을 고르는 값(capability 있음/없음)', async () => {
    const get = (id: string) => app.inject({ method: 'GET', url: '/agent/secret-create', headers: asAgent(id) });
    expect((await get(agentId)).json()).toEqual({ granted: true });
    expect((await get(sibling)).json()).toEqual({ granted: false });
  });

  it('사람·PAT 은 이 길을 못 쓴다', async () => {
    const res = await app.inject({ method: 'POST', url: '/agent/secrets', headers: auth(alice.token), payload: {} });
    expect(res.statusCode).toBe(403);
  });
});
