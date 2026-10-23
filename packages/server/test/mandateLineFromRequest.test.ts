import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { decide, resolveDecision } from '../src/services/decisions.js';
import { openPermissionRequest } from '../src/services/permissionRequests.js';

// 위임(mandate) W4 — 권한 요청 승인이 그 턴의 위임에 줄을 하나 더 적는다. 기존 grant 는 그대로.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const OPTIONS = [{ id: 'approve', label: '허락' }, { id: 'deny', label: '거절' }];
const SHA = 'b'.repeat(40);

describe('permission request → mandate line (W4)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let alice: { token: string; accountId: string };
  let agentId: string;
  let ch: string;
  let n = 0;

  const message = async (meta: Record<string, unknown>, authorId = agentId, threadRootId: string | null = null): Promise<string> =>
    (await pool.query(`insert into message (channel_id, author_id, body, kind, meta, thread_root_id) values ($1, $2, '카드', 'user', $3, $4) returning id`,
      [ch, authorId, JSON.stringify(meta), threadRootId])).rows[0].id as string;
  /** 소유자가 자기 에이전트를 부른 새 머리 — 위임이 하나 생긴다. */
  const mandateThread = async () => {
    const r = await postMessage(pool, { channelId: ch, authorId: alice.accountId, body: '@w4bot go', threadRootId: null });
    if (r.failure) throw new Error(String(r.failure));
    const root = r.message.id as string;
    const m = (await pool.query(`select mandate_id from message where id = $1`, [root])).rows[0].mandate_id as string | null;
    expect(m).toBeTruthy();
    return { root, mandateId: m! };
  };
  const request = async (o: { kind: 'tool' | 'merge' | 'command'; target: string; root: string; mandateId: string | null; denialId?: string }) => {
    const requestId = (await pool.query(
      `insert into permission_request (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at, mandate_id, denial_id)
       values ($1, $2, $3, '확인', '{}', $4, $5, now(), now() + interval '1 day', $6, $7) returning id`,
      [agentId, o.kind, o.target, ch, o.root, o.mandateId, o.denialId ?? null])).rows[0].id as string;
    const cardId = await message({ kind: 'ask', ask: { options: OPTIONS, to: { kind: 'human' } }, permissionRequest: { requestId, status: 'pending', ...(o.mandateId ? { mandateId: o.mandateId } : {}) } }, agentId, o.root);
    await pool.query(`update permission_request set card_message_id = $2 where id = $1`, [requestId, cardId]);
    return { requestId, cardId };
  };
  const linesOf = async (requestId: string) =>
    (await pool.query(`select mandate_id as "mandateId", cap, scope, limits, granted_by as "grantedBy", via, agent_ids as "agentIds" from mandate_line where request_id = $1`, [requestId])).rows;
  const audits = async (action: string, requestId: string) =>
    (await pool.query(`select detail from audit_log where action = $1 and detail->>'requestId' = $2`, [action, requestId])).rows.map((r) => r.detail);
  const rule = () => { n += 1; return `Bash(kubectl --context ops get pods${n}:*)`; };

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    const admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    agentId = (await createAgent(app, admin.token, 'w4bot')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'w4' } })).json().id as string;
    await pool.query(`insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`, [ch, [alice.accountId, agentId]]);
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('opening a request records the mandate on the row and in the card meta', async () => {
    const { root, mandateId } = await mandateThread();
    const opened = await openPermissionRequest(pool, { agentId, kind: 'tool', rule: rule(), reason: 'x', channelId: ch, threadRootId: root, mandateId });
    if (!opened.ok || !('created' in opened)) throw new Error(JSON.stringify(opened));
    expect(opened.created.meta.mandateId).toBe(mandateId);
    expect((await pool.query(`select mandate_id from permission_request where id = $1`, [opened.created.requestId])).rows[0].mandate_id).toBe(mandateId);
    const none = await openPermissionRequest(pool, { agentId, kind: 'tool', rule: rule(), reason: 'x', channelId: ch, threadRootId: root });
    if (!none.ok || !('created' in none)) throw new Error(JSON.stringify(none));
    expect(none.created.meta).not.toHaveProperty('mandateId');
  });

  it('tool request approved by button → 7-day grant and a tool line', async () => {
    const { root, mandateId } = await mandateThread();
    const target = rule();
    const { requestId, cardId } = await request({ kind: 'tool', target, root, mandateId });
    const ref = (await resolveDecision(pool, cardId))!;
    expect(await decide(pool, ref, alice.accountId, { option: 'approve', via: 'button' })).toMatchObject({ ok: true, result: { status: 'granted' } });
    expect((await pool.query(`select 1 from account_grant where account_id = $1 and capability = 'tool.allow' and scope like $2`, [agentId, `%${target}`])).rowCount).toBe(1);
    const lines = await linesOf(requestId);
    expect(lines).toEqual([{ mandateId, cap: 'tool', scope: target, limits: {}, grantedBy: alice.accountId, via: 'button', agentIds: null }]);
    const [a] = await audits('mandate.line.added', requestId);
    expect(a).toMatchObject({ mandateId, cap: 'tool', scope: target, via: 'button', requestId });
    expect(typeof a.lineId).toBe('string');
  });

  it('merge-once (refusal card) decided via chat → merge_approval and a merge line pinned to pr/head, uses 1', async () => {
    const { root, mandateId } = await mandateThread();
    const denialId = (await pool.query(
      `insert into merge_denial (agent_id, scope, pr_number, head_sha, channel_id, thread_root_id, lease_id, expires_at)
       values ($1, 'repo:acme-org/w4', 12, $2, $3, $4, gen_random_uuid(), now() + interval '1 hour') returning id`,
      [agentId, SHA, ch, root])).rows[0].id as string;
    const { requestId, cardId } = await request({ kind: 'merge', target: 'repo:acme-org/w4', root, mandateId, denialId });
    const ref = (await resolveDecision(pool, cardId))!;
    const chatMsg = await message({}, alice.accountId, root);
    const d = await decide(pool, ref, alice.accountId, {
      option: 'approve_once', via: 'chat', chat: { messageId: chatMsg }, once: { ghUser: null, relaxChecks: false, number: 12, headSha: SHA },
    });
    expect(d).toMatchObject({ ok: true, result: { status: 'approved_once' } });
    expect((await pool.query(`select 1 from merge_approval where denial_id = $1`, [denialId])).rowCount).toBe(1);
    expect(await linesOf(requestId)).toEqual([{
      mandateId, cap: 'merge', scope: 'repo:acme-org/w4', grantedBy: alice.accountId, via: 'chat', agentIds: null,
      limits: { pr: 12, head: SHA, uses: 1, ghUser: null, ciOverride: false },
    }]);
  });

  it('approve through a genuine mirror → line via mirror', async () => {
    const { root, mandateId } = await mandateThread();
    const target = rule();
    const { requestId, cardId } = await request({ kind: 'tool', target, root, mandateId });
    const mirror = await message({ kind: 'ask', ask: { options: OPTIONS, to: { kind: 'human' }, mirrorOf: cardId } });
    const ref = (await resolveDecision(pool, mirror))!;
    expect(ref.mirrorMessageId).toBe(mirror);
    expect(await decide(pool, ref, alice.accountId, { option: 'approve', via: 'mirror' })).toMatchObject({ ok: true, result: { status: 'granted' } });
    expect((await linesOf(requestId)).map((l) => l.via)).toEqual(['mirror']);
  });

  it('command approve_hour → command line with until; approve_once adds uses 1', async () => {
    const { root, mandateId } = await mandateThread();
    const cmd = 'kubectl --kubeconfig /etc/k/ops.yaml --context ops -n w4 rollout restart deploy/web';
    const hour = await request({ kind: 'command', target: cmd, root, mandateId });
    await decide(pool, (await resolveDecision(pool, hour.cardId))!, alice.accountId, { option: 'approve_hour', via: 'button' });
    const [h] = await linesOf(hour.requestId);
    expect(h).toMatchObject({ cap: 'command', scope: cmd });
    expect(Date.parse(h.limits.until) - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(h.limits.uses).toBeUndefined();
    const { root: root2, mandateId: m2 } = await mandateThread();
    const once = await request({ kind: 'command', target: cmd, root: root2, mandateId: m2 });
    await decide(pool, (await resolveDecision(pool, once.cardId))!, alice.accountId, { option: 'approve_once', via: 'button' });
    expect((await linesOf(once.requestId))[0].limits).toMatchObject({ uses: 1 });
  });

  it('deny → no line', async () => {
    const { root, mandateId } = await mandateThread();
    const { requestId, cardId } = await request({ kind: 'tool', target: rule(), root, mandateId });
    expect(await decide(pool, (await resolveDecision(pool, cardId))!, alice.accountId, { option: 'deny', via: 'button' })).toMatchObject({ ok: true, result: { status: 'denied' } });
    expect(await linesOf(requestId)).toEqual([]);
    expect(await audits('mandate.line.added', requestId)).toEqual([]);
  });

  it('expired request → no line', async () => {
    const { root, mandateId } = await mandateThread();
    const { requestId, cardId } = await request({ kind: 'tool', target: rule(), root, mandateId });
    await pool.query(`update permission_request set expires_at = now() - interval '1 minute' where id = $1`, [requestId]);
    expect(await decide(pool, (await resolveDecision(pool, cardId))!, alice.accountId, { option: 'approve', via: 'button' })).toMatchObject({ ok: false, code: 'request_expired' });
    expect(await linesOf(requestId)).toEqual([]);
  });

  it('request from a turn without a mandate → grant as before, no line, no audit', async () => {
    const root = await message({}, alice.accountId);
    const target = rule();
    const { requestId, cardId } = await request({ kind: 'tool', target, root, mandateId: null });
    expect(await decide(pool, (await resolveDecision(pool, cardId))!, alice.accountId, { option: 'approve', via: 'button' })).toMatchObject({ ok: true, result: { status: 'granted' } });
    expect((await pool.query(`select 1 from account_grant where account_id = $1 and capability = 'tool.allow' and scope like $2`, [agentId, `%${target}`])).rowCount).toBe(1);
    expect(await linesOf(requestId)).toEqual([]);
    expect(await audits('mandate.line.add_failed', requestId)).toEqual([]);
  });

  it('a scope the registry refuses → decision stands, no line, add_failed audited', async () => {
    const { root, mandateId } = await mandateThread();
    // 저장 뒤 판정이 좁아진 경우를 흉내 낸다 — 규칙 판정이 받지 않는 값.
    const { requestId, cardId } = await request({ kind: 'tool', target: 'Bash(rm -rf / ; echo)', root, mandateId });
    expect(await decide(pool, (await resolveDecision(pool, cardId))!, alice.accountId, { option: 'approve', via: 'button' })).toMatchObject({ ok: true, result: { status: 'granted' } });
    expect(await linesOf(requestId)).toEqual([]);
    expect(await audits('mandate.line.add_failed', requestId)).toEqual([expect.objectContaining({ mandateId, cap: 'tool', code: 'bad_scope', requestId })]);
  });
});
