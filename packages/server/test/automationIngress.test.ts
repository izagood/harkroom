import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AutomationGithubTrigger } from '@harkroom/shared';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';
import { createAutomationSweeper } from '../src/services/automations.js';
import { globToRegExp, matchGithub, neutralize } from '../src/services/automationIngress.js';
import { createSecretBox } from '../src/services/secretBox.js';

const adapterTrigger: AutomationGithubTrigger = {
  kind: 'github', repo: 'izagood/harkroom', event: 'push', branch: 'main',
  paths: ['packages/agent/src/adapters/*.ts'], change: 'added',
};

function pushPayload(added: string[], modified: string[] = [], ref = 'refs/heads/main') {
  return {
    ref, after: 'abc123', compare: 'https://github.com/x/y/compare/a...b',
    repository: { full_name: 'izagood/harkroom' }, pusher: { name: 'jaebin' },
    head_commit: { message: 'feat: new harness @forge' },
    commits: [{ added, modified, removed: [] }],
  };
}

describe('필터 (065)', () => {
  it('glob — * 는 한 칸, ** 는 여러 칸', () => {
    expect(globToRegExp('packages/agent/src/adapters/*.ts').test('packages/agent/src/adapters/cursor.ts')).toBe(true);
    expect(globToRegExp('packages/agent/src/adapters/*.ts').test('packages/agent/src/adapters/x/y.ts')).toBe(false);
    expect(globToRegExp('packages/**/*.ts').test('packages/a/b/c.ts')).toBe(true);
  });

  it('어댑터가 **새로** 들어온 push 만 맞는다 — 수정만 있으면 안 맞는다', () => {
    const hit = matchGithub({ ...adapterTrigger }, 'push', pushPayload(['packages/agent/src/adapters/cursor.ts']));
    expect(hit).toMatchObject({ match: true });
    if (hit.match) expect(hit.vars['files.added']).toBe('packages/agent/src/adapters/cursor.ts');
    const miss = matchGithub({ ...adapterTrigger }, 'push', pushPayload([], ['packages/agent/src/adapters/codex.ts']));
    expect(miss).toMatchObject({ match: false, reason: 'paths' });
  });

  it('다른 브랜치·다른 repo 는 안 맞는다', () => {
    expect(matchGithub({ ...adapterTrigger }, 'push', pushPayload(['packages/agent/src/adapters/a.ts'], [], 'refs/heads/dev')))
      .toMatchObject({ match: false, reason: 'branch' });
    const other = { ...pushPayload(['packages/agent/src/adapters/a.ts']), repository: { full_name: 'x/y' } };
    expect(matchGithub({ ...adapterTrigger }, 'push', other)).toMatchObject({ match: false, reason: 'repo' });
  });

  it('외부 글자의 @ 는 부르지 못하게 끊긴다', () => {
    const hit = matchGithub({ ...adapterTrigger }, 'push', pushPayload(['packages/agent/src/adapters/a.ts']));
    if (!hit.match) throw new Error('should match');
    expect(hit.vars['commit.message']).not.toContain('@forge');
    expect(neutralize('a\n@b')).toBe('a @​b');
  });

  it('PR 머지 — closed + merged 만', () => {
    const t = { kind: 'github', repo: 'izagood/harkroom', event: 'pull_request.merged', branch: 'main' } as const;
    const pr = (merged: boolean) => ({
      action: 'closed', repository: { full_name: 'izagood/harkroom' },
      pull_request: { merged, number: 7, title: 'x', base: { ref: 'main' }, user: { login: 'u' } },
    });
    expect(matchGithub(t, 'pull_request', pr(true))).toMatchObject({ match: true });
    expect(matchGithub(t, 'pull_request', pr(false))).toMatchObject({ match: false });
  });

  it('secretBox — 봉한 것을 연다, 다른 키로는 못 연다', () => {
    const a = createSecretBox('k1')!;
    expect(a.open(a.seal('hello'))).toBe('hello');
    expect(createSecretBox('k2')!.open(a.seal('hello'))).toBeNull();
    expect(createSecretBox('')).toBeNull();
  });
});

describe('수신 API (065)', () => {
  let app: FastifyInstance;
  let noKeyApp: FastifyInstance;
  let pool: Pool;
  let stop: () => Promise<void>;
  let user: { token: string; accountId: string };
  let channelId: string;
  const auth = () => ({ authorization: `Bearer ${user.token}` });

  beforeAll(async () => {
    const db = await startTestDb();
    stop = db.stop; pool = db.pool;
    app = await buildServer({ pool: db.pool, secretKey: 'test-secret' });
    noKeyApp = await buildServer({ pool: db.pool, secretKey: null });
    const { token: adminToken } = await bootstrapAdmin(app);
    user = await createMember(app, adminToken, 'hookuser');
    const ch = await app.inject({ method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` }, payload: { name: 'hook-test' } });
    channelId = ch.json().id;
    await app.inject({ method: 'POST', url: `/channels/${channelId}/members`, headers: { authorization: `Bearer ${adminToken}` }, payload: { accountId: user.accountId } });
  });
  afterAll(async () => { await app.close(); await noKeyApp.close(); await stop(); });

  async function create(trigger: unknown, body = '@forge 새 어댑터 검증\n```\n{{files.added}}\n```') {
    const res = await app.inject({ method: 'POST', url: '/automations', headers: auth(), payload: { name: 'hook', channelId, body, trigger } });
    expect(res.statusCode).toBe(201);
    return res.json().automation.id as string;
  }

  function sign(key: string, raw: string) {
    return 'sha256=' + createHmac('sha256', key).update(raw).digest('hex');
  }

  it('기본은 꺼져 있다 — 켜기 전 입구는 404', async () => {
    const id = await create(adapterTrigger);
    const res = await app.inject({ method: 'POST', url: `/hooks/github/${id}`, headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(404);
  });

  it('GitHub: 키를 받아 서명한 push 만 회차가 되고, 글에 파일 목록이 들어간다', async () => {
    const id = await create(adapterTrigger);
    const on = await app.inject({ method: 'POST', url: `/automations/${id}/ingress`, headers: auth() });
    expect(on.statusCode).toBe(201);
    const { key, githubPath } = on.json().ingress;
    expect(githubPath).toBe(`/hooks/github/${id}`);

    const raw = JSON.stringify(pushPayload(['packages/agent/src/adapters/cursor.ts']));
    const bad = await app.inject({ method: 'POST', url: githubPath, payload: raw, headers: {
      'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sign('wrong', raw), 'x-github-delivery': 'd1',
    } });
    expect(bad.statusCode).toBe(401);

    const headers = { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sign(key, raw), 'x-github-delivery': 'd1' };
    const ok = await app.inject({ method: 'POST', url: githubPath, payload: raw, headers });
    expect(ok.statusCode).toBe(202);
    // 같은 delivery 재전송은 회차를 또 만들지 않는다.
    const again = await app.inject({ method: 'POST', url: githubPath, payload: raw, headers });
    expect(again.json().status).toBe('duplicate');

    await createAutomationSweeper(pool).sweep();
    const msgs = await app.inject({ method: 'GET', url: `/channels/${channelId}/messages`, headers: auth() });
    const mine = (msgs.json().messages as Array<{ body: string; meta: Record<string, any> }>).filter((m) => m.meta?.automation?.id === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toContain('packages/agent/src/adapters/cursor.ts');
    expect(mine[0]!.meta.automation.trigger).toBe('github');
  });

  it('GitHub: 필터에 안 맞으면 200 ignored', async () => {
    const id = await create(adapterTrigger);
    const { key } = (await app.inject({ method: 'POST', url: `/automations/${id}/ingress`, headers: auth() })).json().ingress;
    const raw = JSON.stringify(pushPayload([], ['packages/agent/src/adapters/codex.ts']));
    const res = await app.inject({ method: 'POST', url: `/hooks/github/${id}`, payload: raw, headers: {
      'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sign(key, raw), 'x-github-delivery': 'd2',
    } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ignored', reason: 'paths' });
  });

  it('키를 다시 받으면 옛 키는 무효, 끄면 다시 404', async () => {
    const id = await create({ kind: 'webhook' }, '빌드 끝: {{payload.status}}');
    const first = (await app.inject({ method: 'POST', url: `/automations/${id}/ingress`, headers: auth() })).json().ingress.key;
    const second = (await app.inject({ method: 'POST', url: `/automations/${id}/ingress`, headers: auth() })).json().ingress.key;
    const call = (k: string) => app.inject({ method: 'POST', url: `/hooks/generic/${id}`, payload: { status: 'green' }, headers: { authorization: `Bearer ${k}` } });
    expect((await call(first)).statusCode).toBe(401);
    expect((await call(second)).statusCode).toBe(202);
    await app.inject({ method: 'DELETE', url: `/automations/${id}/ingress`, headers: auth() });
    expect((await call(second)).statusCode).toBe(404);
  });

  it('디바운스: 창 안에 온 이벤트는 회차 하나로 모이고 {{events}} 에 줄로 들어간다', async () => {
    const res = await app.inject({ method: 'POST', url: '/automations', headers: auth(), payload: {
      name: 'deb', channelId, body: '모인 것 {{events.count}}건\n{{events}}', trigger: { kind: 'webhook' }, debounceSec: 600,
    } });
    const id = res.json().automation.id as string;
    expect(res.json().automation.debounceSec).toBe(600);
    const key = (await app.inject({ method: 'POST', url: `/automations/${id}/ingress`, headers: auth() })).json().ingress.key;
    const call = (title: string, idem: string) => app.inject({
      method: 'POST', url: `/hooks/generic/${id}`, payload: { title },
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': idem },
    });
    expect((await call('첫째', 'e1')).json().status).toBe('queued');
    expect((await call('둘째', 'e2')).json().status).toBe('merged');
    expect((await call('둘째', 'e2')).json().status).toBe('duplicate');
    expect((await call('셋째', 'e3')).json().status).toBe('merged');

    // 창이 열려 있는 동안은 나가지 않는다.
    await createAutomationSweeper(pool).sweep();
    let runs = (await pool.query(`select status, not_before from automation_run where automation_id = $1`, [id])).rows;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('pending');

    // 창이 닫히면 한 번 나간다.
    await pool.query(`update automation_run set not_before = now() - interval '1 second' where automation_id = $1`, [id]);
    await createAutomationSweeper(pool).sweep();
    runs = (await pool.query(`select status from automation_run where automation_id = $1`, [id])).rows;
    expect(runs[0].status).toBe('sent');
    const msgs = await app.inject({ method: 'GET', url: `/channels/${channelId}/messages`, headers: auth() });
    const mine = (msgs.json().messages as Array<{ body: string; meta: Record<string, any> }>).filter((m) => m.meta?.automation?.id === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toBe('모인 것 3건\n- 첫째\n- 둘째\n- 셋째');
  });

  it('HARKROOM_SECRET_KEY 가 없으면 GitHub 수신은 켤 수 없다(범용은 된다)', async () => {
    const gid = await create(adapterTrigger);
    const res = await noKeyApp.inject({ method: 'POST', url: `/automations/${gid}/ingress`, headers: auth() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('needs_secret_key');
    const wid = await create({ kind: 'webhook' });
    expect((await noKeyApp.inject({ method: 'POST', url: `/automations/${wid}/ingress`, headers: auth() })).statusCode).toBe(201);
  });
});
