import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { decide, resolveDecision } from '../src/services/decisions.js';
import { mandateChipName, openPermissionRequest, permissionCardOptions, renderPermissionMirror } from '../src/services/permissionRequests.js';

// 권한 카드 계약(W4b) — 선택지·위임장 줄·새 위임장·거울 칸·칩 이름.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const ids = (o: { id: string }[]) => o.map((x) => x.id);

describe('permission card options (W4b)', () => {
  it('tool / merge / merge refusal / CI refusal / command, with and without a mandate', () => {
    expect(ids(permissionCardOptions('tool', { mandate: true }))).toEqual(['approve_mandate', 'deny']);
    expect(ids(permissionCardOptions('tool', { mandate: false }))).toEqual(['approve_new_mandate', 'deny']);
    expect(ids(permissionCardOptions('merge', { mandate: true }))).toEqual(['approve_mandate', 'deny']);
    expect(ids(permissionCardOptions('merge', { mandate: false }))).toEqual(['approve_new_mandate', 'deny']);
    // 거절 카드의 [이번 한 번]은 PermissionOncePanel 이 그린다 — 선택지에 넣지 않는다(옛 화면에 버튼 둘 방지).
    expect(ids(permissionCardOptions('merge', { mandate: true, once: true }))).toEqual(['approve_mandate', 'deny']);
    expect(ids(permissionCardOptions('merge', { mandate: false, once: true }))).toEqual(['approve_new_mandate', 'deny']);
    expect(ids(permissionCardOptions('merge', { mandate: true, once: true, ciOnce: true }))).toEqual(['deny']);
    expect(ids(permissionCardOptions('merge', { mandate: false, once: true, ciOnce: true }))).toEqual(['deny']);
    expect(ids(permissionCardOptions('command', { mandate: true }))).toEqual(['approve_once', 'deny']);
    expect(ids(permissionCardOptions('command', { mandate: false }))).toEqual(['approve_once', 'deny']);
    expect(permissionCardOptions('tool', { mandate: true })[0]).toMatchObject({ recommended: true });
  });
});

describe('permission card decisions (W4b)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let agentId: string;
  let bobAgentId: string;
  let ch: string;
  let privCh: string;
  let adminToken: string;
  let n = 0;

  const rule = () => { n += 1; return `Bash(kubectl --context ops get pods${n}:*)`; };
  /** 소유자가 자기 에이전트를 부른 새 머리 — 위임이 하나 생긴다. */
  const mandateThread = async (authorId: string, body: string, channelId = ch) => {
    const r = await postMessage(pool, { channelId, authorId, body, threadRootId: null, authVia: 'session' });
    if (r.failure) throw new Error(String(r.failure));
    const root = r.message.id as string;
    const m = (await pool.query(`select mandate_id from message where id = $1`, [root])).rows[0].mandate_id as string | null;
    return { root, mandateId: m };
  };
  const plainRoot = async (channelId = ch) =>
    (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'plain', 'user') returning id`, [channelId, alice.accountId])).rows[0].id as string;
  /** 서버가 세우는 것과 같은 카드 — meta 는 openPermissionRequest 가 돌려준 값, 선택지는 permissionCardOptions. */
  const card = async (o: { kind: 'tool' | 'merge'; target: string; root: string; mandateId: string | null; channelId?: string }) => {
    const channelId = o.channelId ?? ch;
    const opened = await openPermissionRequest(pool, {
      agentId, kind: o.kind, ...(o.kind === 'tool' ? { rule: o.target } : { repo: o.target }), reason: '확인', channelId, threadRootId: o.root,
      ...(o.mandateId ? { mandateId: o.mandateId } : {}),
    });
    if (!opened.ok || !('created' in opened)) throw new Error(JSON.stringify(opened));
    const { requestId, meta } = opened.created;
    const ask = { options: permissionCardOptions(o.kind, { mandate: !!o.mandateId }), to: { kind: 'human' } };
    const cardId = (await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta, thread_root_id) values ($1, $2, '카드', 'user', $3, $4) returning id`,
      [channelId, agentId, JSON.stringify({ kind: 'ask', ask, permissionRequest: meta }), o.root])).rows[0].id as string;
    await pool.query(`update permission_request set card_message_id = $2 where id = $1`, [requestId, cardId]);
    return { requestId, cardId, meta };
  };
  const linesOf = async (requestId: string) =>
    (await pool.query(`select mandate_id as "mandateId", cap, scope, limits from mandate_line where request_id = $1`, [requestId])).rows;
  const decideCard = async (cardId: string, option: string, actor = alice.accountId) =>
    decide(pool, (await resolveDecision(pool, cardId))!, actor, { option, via: 'button' });

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    const admin = await bootstrapAdmin(app);
    adminToken = admin.token;
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    agentId = (await createAgent(app, admin.token, 'cardbot')).accountId;
    bobAgentId = (await createAgent(app, admin.token, 'bobbot')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [bobAgentId, bob.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'w4b' } })).json().id as string;
    privCh = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'w4b-private' } })).json().id as string;
    await pool.query(`update channel set visibility = 'private' where id = $1`, [privCh]);
    await pool.query(`insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`, [ch, [alice.accountId, bob.accountId, agentId, bobAgentId]]);
    await pool.query(`insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`, [privCh, [alice.accountId, agentId]]);
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('approve_mandate → 7-day grant and a line on the mandate ending at the grant expiry', async () => {
    const { root, mandateId } = await mandateThread(alice.accountId, '@cardbot go');
    expect(mandateId).toBeTruthy();
    const target = rule();
    const { requestId, cardId, meta } = await card({ kind: 'tool', target, root, mandateId });
    expect(meta).toMatchObject({ mandateId, mandate: { id: mandateId }, line: { cap: 'tool', limits: { approve_mandate: { untilMs: 7 * 86_400_000 } } } });
    expect(await decideCard(cardId, 'approve_mandate')).toMatchObject({ ok: true, result: { status: 'granted' } });
    const until = (await pool.query(`select expires_at from account_grant where account_id = $1 and capability = 'tool.allow' and scope like $2`, [agentId, `%${target}`])).rows[0].expires_at as Date;
    expect(await linesOf(requestId)).toEqual([{ mandateId, cap: 'tool', scope: target, limits: { until: until.toISOString() } }]);
    expect((await pool.query(`select meta from message where id = $1`, [cardId])).rows[0].meta.ask.answeredWith).toBe('approve_mandate');
  });

  it('approve_new_mandate on a no-mandate turn → mandate on the card thread for the owner, then a line', async () => {
    const root = await plainRoot();
    const target = rule();
    const { requestId, cardId, meta } = await card({ kind: 'tool', target, root, mandateId: null });
    expect(meta).not.toHaveProperty('mandateId');
    expect(meta.line?.limits).toHaveProperty('approve_new_mandate');
    expect(await decideCard(cardId, 'approve_new_mandate')).toMatchObject({ ok: true, result: { status: 'granted' } });
    const made = (await pool.query(`select mandate_id from permission_request where id = $1`, [requestId])).rows[0].mandate_id as string;
    expect(made).toBeTruthy();
    expect((await pool.query(`select owner_account_id, thread_root_id from mandate where id = $1`, [made])).rows[0]).toEqual({ owner_account_id: alice.accountId, thread_root_id: root });
    expect((await pool.query(`select mandate_id from message where id = $1`, [root])).rows[0].mandate_id).toBe(made);
    expect(await linesOf(requestId)).toMatchObject([{ mandateId: made, cap: 'tool', scope: target }]);
  });

  it('mandate.created via card — once when the card makes the mandate; a second card on that thread and a refused card add none', async () => {
    const created = async (root: string) =>
      (await pool.query(`select actor_id, target, detail from audit_log where action = 'mandate.created' and detail->>'rootMessageId' = $1`, [root])).rows;
    const root = await plainRoot();
    const first = await card({ kind: 'tool', target: rule(), root, mandateId: null });
    expect(await decideCard(first.cardId, 'approve_new_mandate')).toMatchObject({ ok: true });
    const made = (await pool.query(`select mandate_id from permission_request where id = $1`, [first.requestId])).rows[0].mandate_id as string;
    expect(await created(root)).toEqual([{ actor_id: alice.accountId, target: made, detail: { mandateId: made, rootMessageId: root, channelId: ch, threadRootId: root, via: 'card' } }]);
    const second = await card({ kind: 'tool', target: rule(), root, mandateId: null });
    expect(await decideCard(second.cardId, 'approve_new_mandate')).toMatchObject({ ok: true });
    expect(await created(root)).toHaveLength(1);
    // 머리가 소유자가 세운 위임 머리면(via root 로 이미 남았다) 카드는 그 위임을 쓸 뿐이다.
    const { root: ownRoot } = await mandateThread(alice.accountId, '@cardbot go');
    const third = await card({ kind: 'tool', target: rule(), root: ownRoot, mandateId: null });
    expect(await decideCard(third.cardId, 'approve_new_mandate')).toMatchObject({ ok: true });
    expect((await created(ownRoot)).map((r) => r.detail.via)).toEqual(['root']);
  });

  // 위임장을 세울 수 없는 스레드면 `decide` 가 7일 승인으로 한 번 더 한다 — 버튼도 글 승인과 같은 길(409 로 끝나지 않는다).
  it('approve_new_mandate falls back to the 7-day approval when the thread mandate belongs to another owner — no mandate, no line', async () => {
    const { root, mandateId } = await mandateThread(bob.accountId, '@bobbot go');
    expect(mandateId).toBeTruthy();
    const target = rule();
    const { requestId, cardId } = await card({ kind: 'tool', target, root, mandateId: null });
    expect(await decideCard(cardId, 'approve_new_mandate')).toMatchObject({ ok: true, result: { status: 'granted' } });
    expect((await pool.query(`select status, mandate_id from permission_request where id = $1`, [requestId])).rows[0]).toEqual({ status: 'granted', mandate_id: null });
    expect((await pool.query(`select 1 from account_grant where account_id = $1 and scope like $2`, [agentId, `%${target}`])).rowCount).toBe(1);
    expect(await linesOf(requestId)).toEqual([]);
  });

  it('approve_new_mandate on a thread another person started → 7-day approval, root keeps no mandate key (F2)', async () => {
    const root = (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'bob root', 'user') returning id`, [ch, bob.accountId])).rows[0].id as string;
    const target = rule();
    const { requestId, cardId } = await card({ kind: 'tool', target, root, mandateId: null });
    expect(await decideCard(cardId, 'approve_new_mandate')).toMatchObject({ ok: true, result: { status: 'granted' } });
    expect((await pool.query(`select mandate_id from message where id = $1`, [root])).rows[0].mandate_id).toBeNull();
    expect((await pool.query(`select status, mandate_id from permission_request where id = $1`, [requestId])).rows[0]).toEqual({ status: 'granted', mandate_id: null });
    expect((await pool.query(`select 1 from account_grant where account_id = $1 and scope like $2`, [agentId, `%${target}`])).rowCount).toBe(1);
    expect(await linesOf(requestId)).toEqual([]);
    // 다른 소유자의 에이전트가 쓴 머리도 같다 — 위임장 없이 7일 승인.
    const botRoot = (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'bobbot root', 'user') returning id`, [ch, bobAgentId])).rows[0].id as string;
    const b = await card({ kind: 'tool', target: rule(), root: botRoot, mandateId: null });
    expect(await decideCard(b.cardId, 'approve_new_mandate')).toMatchObject({ ok: true });
    expect((await pool.query(`select mandate_id from message where id = $1`, [botRoot])).rows[0].mandate_id).toBeNull();
  });

  it('approve_new_mandate on a thread the owner\'s own agent started → mandate for the owner', async () => {
    const root = (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'cardbot root', 'user') returning id`, [ch, agentId])).rows[0].id as string;
    const { requestId, cardId } = await card({ kind: 'tool', target: rule(), root, mandateId: null });
    expect(await decideCard(cardId, 'approve_new_mandate')).toMatchObject({ ok: true, result: { status: 'granted' } });
    const made = (await pool.query(`select mandate_id from permission_request where id = $1`, [requestId])).rows[0].mandate_id as string;
    expect((await pool.query(`select owner_account_id from mandate where id = $1`, [made])).rows[0].owner_account_id).toBe(alice.accountId);
  });

  it('chip name is withheld on a card whose channel audience cannot see the mandate root channel (F1)', async () => {
    const { mandateId } = await mandateThread(alice.accountId, '@cardbot 비공개 작업 이름', privCh);
    expect(mandateId).toBeTruthy();
    const started = (await pool.query(`select created_at from mandate where id = $1`, [mandateId])).rows[0].created_at as Date;
    // 위임장은 비공개 채널에서 시작했고, 카드는 공개 채널 스레드에 선다.
    const pub = await card({ kind: 'tool', target: rule(), root: await plainRoot(), mandateId });
    expect(pub.meta.mandate).toEqual({ id: mandateId, name: '', ownerId: alice.accountId, startedAt: started.toISOString() });
    expect(JSON.stringify(pub.meta)).not.toContain('비공개 작업');
    // 같은 비공개 채널의 카드에는 이름이 실린다.
    const priv = await card({ kind: 'tool', target: rule(), root: await plainRoot(privCh), mandateId, channelId: privCh });
    expect(priv.meta.mandate).toMatchObject({ id: mandateId, name: '비공개 작업 이름', ownerId: alice.accountId });
    // 거울은 원본 카드 이름을 옮기지 않고 거울 채널 기준으로 다시 판정한다 — 거울 청중(alice)이 위임장 뿌리 채널을 다 보므로 이름이 실린다.
    const privOther = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'w4b-priv2' } })).json().id as string;
    expect(privOther).toBeTruthy();
    await pool.query(`update channel set visibility = 'private' where id = $1`, [privOther]);
    await pool.query(`delete from channel_member where channel_id = $1 and account_id <> $2`, [privOther, alice.accountId]);
    await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`, [privOther, alice.accountId]);
    const m = await renderPermissionMirror(pool, priv.cardId, privOther);
    expect(m?.mirror).toMatchObject({ neutral: false, mandate: { id: mandateId, name: '비공개 작업 이름' } });
    // 공개 카드(이름 없음)의 거울은 공개 채널이어도 이름을 되살리지 않는다.
    const pm = await renderPermissionMirror(pool, pub.cardId, ch);
    expect(pm?.mirror.mandate).toEqual({ id: mandateId, name: '', ownerId: alice.accountId, startedAt: started.toISOString() });
  });

  it('old option ids are still accepted: approve (7 days, line when a mandate exists) and deny', async () => {
    const { root, mandateId } = await mandateThread(alice.accountId, '@cardbot again');
    const t1 = rule();
    const a = await card({ kind: 'tool', target: t1, root, mandateId });
    expect(await decideCard(a.cardId, 'approve')).toMatchObject({ ok: true, result: { status: 'granted' } });
    expect(await linesOf(a.requestId)).toMatchObject([{ mandateId, cap: 'tool', scope: t1 }]);
    const noMandate = await card({ kind: 'tool', target: rule(), root: await plainRoot(), mandateId: null });
    expect(await decideCard(noMandate.cardId, 'approve')).toMatchObject({ ok: true, result: { status: 'granted' } });
    expect((await pool.query(`select mandate_id from permission_request where id = $1`, [noMandate.requestId])).rows[0].mandate_id).toBeNull();
    const d = await card({ kind: 'tool', target: rule(), root, mandateId });
    expect(await decideCard(d.cardId, 'deny')).toMatchObject({ ok: true, result: { status: 'denied' } });
    expect(await linesOf(d.requestId)).toEqual([]);
    expect(await decideCard((await card({ kind: 'tool', target: rule(), root, mandateId })).cardId, 'approve_turn')).toMatchObject({ ok: false, code: 'unknown_option' });
  });

  it('command requests are not approved for a mandate', async () => {
    const { root, mandateId } = await mandateThread(alice.accountId, '@cardbot cmd');
    const requestId = (await pool.query(
      `insert into permission_request (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at, mandate_id)
       values ($1, 'command', 'kubectl --kubeconfig /k/config --context ops get pods', '확인', '{}', $2, $3, now(), now() + interval '1 day', $4) returning id`,
      [agentId, ch, root, mandateId])).rows[0].id as string;
    const cardId = (await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta, thread_root_id) values ($1, $2, '카드', 'user', $3, $4) returning id`,
      [ch, agentId, JSON.stringify({ kind: 'ask', ask: { options: permissionCardOptions('command'), to: { kind: 'human' } }, permissionRequest: { requestId, status: 'pending', kind: 'command', mandateId } }), root])).rows[0].id as string;
    await pool.query(`update permission_request set card_message_id = $2 where id = $1`, [requestId, cardId]);
    expect(await decideCard(cardId, 'approve_mandate')).toMatchObject({ ok: false, code: 'bad_decision' });
    expect(await decideCard(cardId, 'approve_new_mandate')).toMatchObject({ ok: false, code: 'bad_decision' });
    expect((await pool.query(`select status from permission_request where id = $1`, [requestId])).rows[0].status).toBe('pending');
  });

  it('mirror meta: genuine mirror copies once/line/mandate, neutral mirror carries only the link', async () => {
    const { root, mandateId } = await mandateThread(alice.accountId, '@cardbot mirror');
    const genuine = await card({ kind: 'tool', target: rule(), root, mandateId });
    const other = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'w4b-other' } })).json().id as string;
    expect(other).toBeTruthy();
    const g = await renderPermissionMirror(pool, genuine.cardId, other);
    expect(g?.mirror).toEqual({ rootId: genuine.cardId, neutral: false, kind: 'tool', line: genuine.meta.line, bodyTargetLine: `명령 허용 \`${genuine.meta.target}\``, mandate: genuine.meta.mandate, ownerAccountId: alice.accountId });
    expect(ids(g!.options)).toEqual(['approve_mandate', 'deny']);
    // r2: 거울 본문도 줄 카드 꼴(머리 + 이유) — 「이 채널의 모든 대화에서 · 7일」을 다시 말하지 않는다.
    // r5: 대상 줄(서버가 쓴 것)이 머리와 이유 사이에 선다.
    expect(g!.body.split('\n')).toEqual([expect.stringMatching(/^권한 요청 · /), `명령 허용 \`${genuine.meta.target}\``, expect.stringMatching(/^이유: /)]);
    expect(g!.body).not.toContain('승인하면 7일');

    const privRoot = await plainRoot(privCh);
    const hidden = await card({ kind: 'tool', target: rule(), root: privRoot, mandateId: null, channelId: privCh });
    const h = await renderPermissionMirror(pool, hidden.cardId, other);
    expect(h?.mirror).toEqual({ rootId: hidden.cardId, neutral: true });
    expect(h!.body).not.toContain('kubectl');
  });

  it('chip name: work item title of the thread, else the first post without mentions (40 chars)', async () => {
    const long = '@cardbot ' + '가'.repeat(50);
    const { root, mandateId } = await mandateThread(alice.accountId, long);
    expect(await mandateChipName(pool, mandateId!)).toBe(`${'가'.repeat(40)}…`);
    await pool.query(
      `insert into work_item (owner_account_id, source, external_key, title, state, thread_root_id) values ($1, 'other', $2, '사이트봇 DB 점검', 'active', $3)`,
      [alice.accountId, `k-${root}`, root]);
    expect(await mandateChipName(pool, mandateId!)).toBe('사이트봇 DB 점검');
    // 남의 작업 항목 제목은 쓰지 않는다.
    const t2 = await mandateThread(alice.accountId, '@cardbot 짧은 글');
    await pool.query(
      `insert into work_item (owner_account_id, source, external_key, title, state, thread_root_id) values ($1, 'other', $2, '밥의 제목', 'active', $3)`,
      [bob.accountId, `k-${t2.root}`, t2.root]);
    expect(await mandateChipName(pool, t2.mandateId!)).toBe('짧은 글');
  });
});
