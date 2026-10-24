import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { mintPat } from '../src/services/pats.js';
import { CAPABILITIES, CAPS, CAP_CARD_TEXT, lineMatches, type LineFacts } from '../src/services/capabilities.js';
import { addMandateLine, findLine, listMandateLines } from '../src/services/mandateLines.js';

// 위임(mandate) W2 — 능력 등록부·위임장 줄·상시 줄·그림자 판정·n4(임대 수명)·읽기 라우트.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const SHA = 'd'.repeat(40);
const REPO = 'izagood/harkroom';
const line = (o: Partial<LineFacts> & Pick<LineFacts, 'cap' | 'scope'>): LineFacts => ({ limits: {}, usedCount: 0, revokedAt: null, ...o });

describe('capability registry', () => {
  it('every cap has validate, match and ko/en card text', () => {
    for (const c of CAPS) {
      expect(typeof CAPABILITIES[c].validateScope).toBe('function');
      expect(CAP_CARD_TEXT[CAPABILITIES[c].cardKey]).toMatchObject({ ko: expect.any(String), en: expect.any(String) });
    }
  });

  it('merge: repo scope, pr/head limits, org scope', () => {
    expect(CAPABILITIES.merge.validateScope('repo:Izagood/Harkroom')).toEqual({ ok: true, scope: 'repo:izagood/harkroom' });
    expect(CAPABILITIES.merge.validateScope('izagood/harkroom').ok).toBe(false);
    expect(CAPABILITIES.merge.validateScope('repo:*').ok).toBe(false);
    const l = line({ cap: 'merge', scope: `repo:${REPO}` });
    expect(lineMatches(l, { cap: 'merge', repo: 'Izagood/Harkroom' })).toBe(true);
    expect(lineMatches(l, { cap: 'merge', repo: 'izagood/other' })).toBe(false);
    const pinned = line({ cap: 'merge', scope: `repo:${REPO}`, limits: { pr: 7, head: SHA } });
    expect(lineMatches(pinned, { cap: 'merge', repo: REPO, pr: 7, head: SHA })).toBe(true);
    expect(lineMatches(pinned, { cap: 'merge', repo: REPO, pr: 8, head: SHA })).toBe(false);
    expect(lineMatches(pinned, { cap: 'merge', repo: REPO, pr: 7, head: 'e'.repeat(40) })).toBe(false);
    expect(lineMatches(line({ cap: 'merge', scope: 'repo:izagood/*' }), { cap: 'merge', repo: 'izagood/x' })).toBe(true);
    expect(lineMatches(line({ cap: 'merge', scope: 'repo:izagood/*' }), { cap: 'merge', repo: 'other/x' })).toBe(false);
  });

  it('tool / command / bypass: validation and exact match', () => {
    expect(CAPABILITIES.tool.validateScope('Bash(git status:*)').ok).toBe(true);
    expect(CAPABILITIES.tool.validateScope('Bash(rm -rf / ; echo)').ok).toBe(false);
    expect(lineMatches(line({ cap: 'tool', scope: 'Bash(git status:*)' }), { cap: 'tool', rule: 'Bash(git status:*)' })).toBe(true);
    expect(lineMatches(line({ cap: 'tool', scope: 'Bash(git status:*)' }), { cap: 'tool', rule: 'Bash(git status -s)' })).toBe(false);
    const cmd = 'kubectl --kubeconfig /k/config --context dev get pods';
    const v = CAPABILITIES.command.validateScope(cmd);
    expect(v.ok).toBe(true);
    expect(CAPABILITIES.command.validateScope('ls; rm -rf /').ok).toBe(false);
    expect(lineMatches(line({ cap: 'command', scope: cmd }), { cap: 'command', command: ` ${cmd}` })).toBe(true);
    expect(lineMatches(line({ cap: 'command', scope: cmd }), { cap: 'command', command: `${cmd} -A` })).toBe(false);
    expect(CAPABILITIES.bypass.validateScope('make  deploy')).toEqual({ ok: true, scope: 'make deploy' });
    expect(CAPABILITIES.bypass.validateScope('a\nb').ok).toBe(false);
    expect(lineMatches(line({ cap: 'bypass', scope: 'make deploy' }), { cap: 'bypass', command: 'make deploy' })).toBe(true);
    // cap 이 다르면 안 맞는다.
    expect(lineMatches(line({ cap: 'bypass', scope: 'make deploy' }), { cap: 'command', command: 'make deploy' })).toBe(false);
  });

  it('revoked / until / uses', () => {
    const base = { cap: 'merge' as const, scope: `repo:${REPO}` };
    const act = { cap: 'merge' as const, repo: REPO };
    expect(lineMatches(line({ ...base, revokedAt: new Date() }), act)).toBe(false);
    expect(lineMatches(line({ ...base, limits: { until: new Date(Date.now() - 1000).toISOString() } }), act)).toBe(false);
    expect(lineMatches(line({ ...base, limits: { until: new Date(Date.now() + 60_000).toISOString() } }), act)).toBe(true);
    expect(lineMatches(line({ ...base, limits: { uses: 1 }, usedCount: 1 }), act)).toBe(false);
    expect(lineMatches(line({ ...base, limits: { uses: 2 }, usedCount: 1 }), act)).toBe(true);
  });
});

describe('mandate lines (db)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let tm: string; let sec: string; let stranger: string;
  let op: { token: string; operatorId: string };
  let ch: string;

  const asAgent = (id: string) => ({ ...auth(op.token), 'x-harkroom-agent': id });
  const post = async (authorId: string, body: string, o: { threadRootId?: string; chainCause?: string } = {}) => {
    const r = await postMessage(pool, { channelId: ch, authorId, body, threadRootId: o.threadRootId ?? null, chainCause: o.chainCause ?? null, authVia: 'session' });
    if (r.failure) throw new Error(String(r.failure));
    return r.message.id as string;
  };
  const mandateOf = async (messageId: string) =>
    (await pool.query(`select mandate_id from message where id = $1`, [messageId])).rows[0]?.mandate_id as string | null;
  const lease = async (causeMessageId: string, agent: string) =>
    (await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(agent), payload: { causeMessageId } })).json().lease as { id: string; token: string };

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    tm = (await createAgent(app, admin.token, 'tm')).accountId;
    sec = (await createAgent(app, admin.token, 'sec')).accountId;
    stranger = (await createAgent(app, admin.token, 'stranger')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = any($1::uuid[])`, [[tm, sec], alice.accountId]);
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [stranger, bob.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    for (const a of [tm, sec, stranger]) {
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a, op.operatorId, admin.accountId]);
    }
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'lines' } })).json().id as string;
    await pool.query(
      `insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`,
      [ch, [alice.accountId, bob.accountId, tm, sec, stranger]]);
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('stored lines: owner only, H3 agent filter, other owner gets nothing, revoke', async () => {
    const root = await post(alice.accountId, '@tm @sec lines');
    const m = (await mandateOf(root))!;
    expect(m).toBeTruthy();
    // 소유자가 아닌 사람·standing·남의 에이전트는 적을 수 없다.
    expect(await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: `repo:${REPO}`, grantedBy: bob.accountId, via: 'button' })).toMatchObject({ ok: false, code: 'not_owner' });
    expect(await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: `repo:${REPO}`, grantedBy: alice.accountId, via: 'standing' })).toMatchObject({ ok: false, code: 'bad_via' });
    expect(await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: `repo:${REPO}`, grantedBy: alice.accountId, via: 'button', agentIds: [stranger] })).toMatchObject({ ok: false, code: 'bad_agent' });
    expect(await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'nope', grantedBy: alice.accountId, via: 'button' })).toMatchObject({ ok: false, code: 'bad_scope' });

    const all = await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: `repo:${REPO}`, grantedBy: alice.accountId, via: 'chat' });
    expect(all.ok).toBe(true);
    const act = { cap: 'merge' as const, repo: REPO };
    // H3: agent_ids null → 같은 소유자 에이전트 모두.
    expect((await findLine(pool, { mandateId: m, agentId: tm, cap: 'merge', action: act }))?.via).toBe('chat');
    expect((await findLine(pool, { mandateId: m, agentId: sec, cap: 'merge', action: act }))?.via).toBe('chat');
    // 다른 소유자의 에이전트 → 줄 없음.
    expect(await findLine(pool, { mandateId: m, agentId: stranger, cap: 'merge', action: act })).toBeNull();

    // 에이전트를 고른 줄은 그 에이전트에만.
    const only = await addMandateLine(pool, { mandateId: m, cap: 'tool', scope: 'Bash(git status:*)', grantedBy: alice.accountId, via: 'button', agentIds: [sec] });
    expect(only.ok).toBe(true);
    const tact = { cap: 'tool' as const, rule: 'Bash(git status:*)' };
    expect(await findLine(pool, { mandateId: m, agentId: tm, cap: 'tool', action: tact })).toBeNull();
    expect(await findLine(pool, { mandateId: m, agentId: sec, cap: 'tool', action: tact })).toBeTruthy();

    // 회수 → 목록·판정에서 사라진다.
    await pool.query(`update mandate_line set revoked_at = now() where id = $1`, [all.ok && all.line.id]);
    expect(await findLine(pool, { mandateId: m, agentId: tm, cap: 'merge', action: act })).toBeNull();
    expect((await listMandateLines(pool, m)).some((l) => all.ok && l.id === all.line.id)).toBe(false);

    // uses·until.
    const once = await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/once', grantedBy: alice.accountId, via: 'button', limits: { uses: 1 } });
    expect(await findLine(pool, { mandateId: m, agentId: tm, cap: 'merge', action: { cap: 'merge', repo: 'izagood/once' } })).toBeTruthy();
    await pool.query(`update mandate_line set used_count = 1 where id = $1`, [once.ok && once.line.id]);
    expect(await findLine(pool, { mandateId: m, agentId: tm, cap: 'merge', action: { cap: 'merge', repo: 'izagood/once' } })).toBeNull();
    await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/old', grantedBy: alice.accountId, via: 'button', limits: { until: new Date(Date.now() - 1000).toISOString() } });
    expect(await findLine(pool, { mandateId: m, agentId: tm, cap: 'merge', action: { cap: 'merge', repo: 'izagood/old' } })).toBeNull();

    // 에이전트의 소유자가 바뀌면 그 위임의 줄은 그 에이전트에 걸리지 않는다.
    await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/moved', grantedBy: alice.accountId, via: 'button' });
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [sec, bob.accountId]);
    expect(await findLine(pool, { mandateId: m, agentId: sec, cap: 'merge', action: { cap: 'merge', repo: 'izagood/moved' } })).toBeNull();
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [sec, alice.accountId]);
  });

  it('standing lines come from the owner\'s live grants (derived, read-only, granting agent only)', async () => {
    const root = await post(alice.accountId, '@tm standing');
    const m = (await mandateOf(root))!;
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', 'repo:izagood/standing', $2, $3)`,
      [tm, alice.accountId, new Date(Date.now() + 7 * 86_400_000)]);
    // 소유자가 아닌 사람이 준 grant 는 상시 줄이 아니다.
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', 'repo:izagood/byadmin', $2, $3)`,
      [tm, admin.accountId, new Date(Date.now() + 7 * 86_400_000)]);
    // bob 의 에이전트 grant 는 alice 의 위임에 안 나온다.
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', 'repo:izagood/standing', $2, $3)`,
      [stranger, bob.accountId, new Date(Date.now() + 7 * 86_400_000)]);
    const lines = await listMandateLines(pool, m);
    const st = lines.filter((l) => l.via === 'standing');
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ cap: 'merge', scope: 'repo:izagood/standing', agentIds: [tm], readOnly: true, grantedBy: alice.accountId });
    expect(await pool.query(`select 1 from mandate_line where mandate_id = $1 and via = 'standing'`, [m]).then((r) => r.rowCount)).toBe(0);
    const act = { cap: 'merge' as const, repo: 'izagood/standing' };
    expect((await findLine(pool, { mandateId: m, agentId: tm, cap: 'merge', action: act }))?.via).toBe('standing');
    // 상시 줄은 그 grant 를 받은 에이전트에만.
    expect(await findLine(pool, { mandateId: m, agentId: sec, cap: 'merge', action: act })).toBeNull();
    expect(await findLine(pool, { mandateId: m, agentId: stranger, cap: 'merge', action: act })).toBeNull();
    // grant 를 거두면 바로 사라진다.
    await pool.query(`delete from account_grant where account_id = $1 and scope = 'repo:izagood/standing'`, [tm]);
    expect(await findLine(pool, { mandateId: m, agentId: tm, cap: 'merge', action: act })).toBeNull();
  });

  it('shadow verdict uses findLine (stored chat line) and the real verdict is unchanged', async () => {
    const root = await post(alice.accountId, '@tm merge via line');
    const m = (await mandateOf(root))!;
    await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/lineonly', grantedBy: alice.accountId, via: 'chat' });
    const l = await lease(root, tm);
    const res = await app.inject({ method: 'POST', url: '/agent/merge-checks', headers: asAgent(tm), payload: { leaseId: l.id, token: l.token, repo: 'izagood/lineonly', number: 3, headSha: SHA } });
    // 실제 판정은 grant 가 없으니 그대로 거절.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_granted');
    const shadow = (await pool.query(`select detail from audit_log where action = 'mandate.shadow' and detail->>'leaseId' = $1`, [l.id])).rows[0]?.detail;
    expect(shadow).toMatchObject({ chainVerdict: 'not_granted', mandateVerdict: 'allowed', mandateId: m, lineVia: 'chat' });
  });

  it('n4: agent post >60 min after inbox but within a live lease still gets the mandate; cause chain unchanged', async () => {
    const root = await post(alice.accountId, '@tm long turn');
    const m = (await mandateOf(root))!;
    const l = await lease(root, tm);
    await pool.query(`update inbox set created_at = now() - interval '61 minutes' where account_id = $1 and message_id = $2`, [tm, root]);
    const late = await post(tm, 'still working', { threadRootId: root, chainCause: root });
    expect(await mandateOf(late)).toBe(m);
    // 사슬 고리는 60분 규칙 그대로 — 끊긴다.
    expect((await pool.query(`select cause_message_id from message where id = $1`, [late])).rows[0].cause_message_id).toBeNull();
    // 임대가 끝나면 위임도 잇지 않는다.
    await pool.query(`update secret_turn_lease set ended_at = now() where id = $1`, [l.id]);
    expect(await mandateOf(await post(tm, 'after end', { threadRootId: root, chainCause: root }))).toBeNull();
  });

  it('GET /mandates/:id/lines: owner human session only, 404 otherwise', async () => {
    const root = await post(alice.accountId, '@tm route');
    const m = (await mandateOf(root))!;
    await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/route', grantedBy: alice.accountId, via: 'button' });
    const ok = await app.inject({ method: 'GET', url: `/mandates/${m}/lines`, headers: auth(alice.token) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().lines.some((l: { scope: string; via: string }) => l.scope === 'repo:izagood/route' && l.via === 'button')).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/mandates/${m}/lines`, headers: auth(bob.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/mandates/${m}/lines`, headers: auth(admin.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/mandates/${m}/lines`, headers: asAgent(tm) })).statusCode).toBe(404);
    const pat = await mintPat(pool, alice.accountId, 'w2-pat', { actorId: null, actorHandle: null });
    if (!pat.ok) throw new Error('pat');
    // 사람 PAT: 지금은 인증 단계에서 401. 그 경로가 생겨도 이 라우트는 세션만 받는다(404).
    expect([401, 404]).toContain((await app.inject({ method: 'GET', url: `/mandates/${m}/lines`, headers: auth(pat.token) })).statusCode);
    expect((await app.inject({ method: 'GET', url: `/mandates/not-a-uuid/lines`, headers: auth(alice.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/mandates/${m}/lines` })).statusCode).toBe(401);
  });
  it('DELETE /mandates/:id/lines/:lineId: owner session only, own lines only, standing 409, card marked, audited', async () => {
    const root = await post(alice.accountId, '@tm revoke');
    const m = (await mandateOf(root))!;
    const added = await addMandateLine(pool, { mandateId: m, cap: 'merge', scope: 'repo:izagood/revoke', grantedBy: alice.accountId, via: 'button' });
    if (!added.ok) throw new Error('add');
    const url = `/mandates/${m}/lines/${added.line.id}`;
    expect((await app.inject({ method: 'DELETE', url, headers: auth(bob.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url, headers: auth(admin.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url, headers: asAgent(tm) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(401);
    // 다른 위임의 줄 id 는 이 위임에서 404.
    const other = (await mandateOf(await post(alice.accountId, '@tm revoke other')))!;
    expect((await app.inject({ method: 'DELETE', url: `/mandates/${other}/lines/${added.line.id}`, headers: auth(alice.token) })).statusCode).toBe(404);
    const ok = await app.inject({ method: 'DELETE', url, headers: auth(alice.token) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, lineId: added.line.id });
    expect((await listMandateLines(pool, m)).some((l) => l.id === added.line.id)).toBe(false);
    expect((await app.inject({ method: 'DELETE', url, headers: auth(alice.token) })).json().error.code).toBe('already_revoked');
    const audit = await pool.query(`select actor_id as "actorId", detail from audit_log where action = 'mandate.line.revoked' and detail->>'lineId' = $1`, [added.line.id]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actorId).toBe(alice.accountId);
    // 상시 줄(grant 에서 펼친 것)은 뺄 수 없다.
    const g = await pool.query<{ id: string }>(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'repo.merge', 'repo:izagood/revoke-standing', $2, $3) returning id`,
      [tm, alice.accountId, new Date(Date.now() + 86_400_000)]);
    const st = await app.inject({ method: 'DELETE', url: `/mandates/${m}/lines/${g.rows[0]!.id}`, headers: auth(alice.token) });
    expect(st.statusCode).toBe(409);
    expect(st.json().error.code).toBe('standing_line');
  });
});
