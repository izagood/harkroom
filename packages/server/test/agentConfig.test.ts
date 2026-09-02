import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let pool: import('pg').Pool;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

const admin = () => ({ authorization: `Bearer ${adminToken}` });

const create = (payload: object) =>
  app.inject({ method: 'POST', url: '/accounts/agents', headers: admin(), payload });

const patch = (id: string, payload: object) =>
  app.inject({ method: 'PATCH', url: `/accounts/agents/${id}`, headers: admin(), payload });

const list = () => app.inject({ method: 'GET', url: '/accounts/agents', headers: admin() });

/** 특정 감사 action 의 행. 라우트를 태워서 남은 것만 센다(직접 INSERT 하지 않는다). */
const entriesOf = async (action: string): Promise<{ target: string | null }[]> => (await pool.query(
  `select target from audit_log where action = $1 order by id`, [action],
)).rows;

describe('agent definition', () => {
  it('creates an agent with instructions and a harness', async () => {
    const res = await create({
      handle: 'fizz', displayName: 'Fizz',
      instructions: '느린 쿼리를 찾아 원인을 설명한다.',
      harness: 'claude-code',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      handle: 'fizz',
      instructions: '느린 쿼리를 찾아 원인을 설명한다.',
      harness: 'claude-code',
    });
  });

  // UI 로 만들 때 지시문을 아직 안 쓸 수 있다 — 생성이 막히면 안 된다.
  it('creates an agent with no configuration at all', async () => {
    const res = await create({ handle: 'bare', displayName: 'Bare' });

    expect(res.statusCode).toBe(201);
    expect(res.json().harness).toBe('claude-code');
    expect(res.json().instructions).toBe('');
  });

  it('refuses a harness murmur cannot run', async () => {
    const res = await create({ handle: 'nope', displayName: 'Nope', harness: 'devin' });

    expect(res.statusCode).toBe(400);
  });

  it('lists agents with their configuration', async () => {
    await create({ handle: 'listed', displayName: 'Listed', instructions: '목록 확인용' });

    const res = await list();

    expect(res.statusCode).toBe(200);
    expect(res.json().agents.some((a: { handle: string; instructions: string }) =>
      a.handle === 'listed' && a.instructions === '목록 확인용')).toBe(true);
  });

  it('does not list humans among the agents', async () => {
    const res = await list();

    expect(res.json().agents.every((a: { kind: string }) => a.kind === 'agent')).toBe(true);
  });
});

describe('editing an agent definition', () => {
  it('rewrites instructions and keeps everything else', async () => {
    const made = (await create({
      handle: 'editme', displayName: 'EditMe', instructions: '처음 지시문', model: 'claude-opus-5',
    })).json();

    const res = await patch(made.id, { instructions: '고친 지시문' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      instructions: '고친 지시문', model: 'claude-opus-5', displayName: 'EditMe',
    });
  });

  // 'harness 기본값 사용' 으로 되돌리는 조작이 UI 에 있다 — null 로 비울 수 있어야 한다.
  it('clears a model override with an explicit null', async () => {
    const made = (await create({ handle: 'clearme', displayName: 'ClearMe', model: 'claude-opus-5' })).json();

    const res = await patch(made.id, { model: null });

    expect(res.json().model).toBeNull();
  });

  it('refuses an edit from a non-admin', async () => {
    const made = (await create({ handle: 'guarded', displayName: 'Guarded' })).json();
    const { pat } = await createAgent(app, adminToken, 'intruder');

    const res = await app.inject({
      method: 'PATCH', url: `/accounts/agents/${made.id}`,
      headers: { authorization: `Bearer ${pat}` }, payload: { instructions: '남의 정의를 고친다' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('404s for an account that is not an agent', async () => {
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: admin() });

    const res = await patch(me.json().id, { instructions: '사람을 에이전트로 고친다' });

    expect(res.statusCode).toBe(404);
  });
});

describe('an agent reading its own definition', () => {
  // 러너가 자기 설정을 서버에서 읽어야 UI 수정이 반영된다. 환경변수로 두면 UI 가 장식이 된다.
  it('serves the definition to the agent that owns it', async () => {
    const made = (await create({
      handle: 'selfread', displayName: 'SelfRead', instructions: '내 지시문', effort: 'high',
    })).json();
    const patRes = await app.inject({
      method: 'POST', url: `/accounts/${made.id}/pats`, headers: admin(), payload: { label: 'runner' },
    });

    const res = await app.inject({
      method: 'GET', url: '/agent/config',
      headers: { authorization: `Bearer ${patRes.json().token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      handle: 'selfread', instructions: '내 지시문', effort: 'high', harness: 'claude-code',
    });
  });

  it('refuses to serve a definition to a human account', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/config', headers: admin() });

    expect(res.statusCode).toBe(403);
  });
});

describe('멘션 턴 권한과 러너 소유자', () => {
  it('에이전트 생성 시 mentionPermission 기본 auto, 생성자가 owner 가 된다', async () => {
    const res = await create({ handle: 'permtest', displayName: 'P' });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.mentionPermission).toBe('auto');
    expect(body.ownerAccountId).toBe(adminId);
  });

  it('mentionPermission 은 auto|readonly 만 받는다', async () => {
    const agent = (await create({ handle: 'permbad', displayName: 'PermBad' })).json();

    const bad = await patch(agent.id, { mentionPermission: 'bypassAll' });
    expect(bad.statusCode).toBe(400);

    const ok = await patch(agent.id, { mentionPermission: 'readonly' });
    expect(ok.json().mentionPermission).toBe('readonly');
  });

  it('GET /agent/config 가 mentionPermission 을 싣는다', async () => {
    const agent = (await create({ handle: 'permread', displayName: 'PermRead' })).json();
    const patRes = await app.inject({
      method: 'POST', url: `/accounts/${agent.id}/pats`, headers: admin(), payload: { label: 'runner' },
    });

    const res = await app.inject({
      method: 'GET', url: '/agent/config',
      headers: { authorization: `Bearer ${patRes.json().token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().mentionPermission).toBe('auto');
  });
});

describe('harness 실행 가능 목록 검증', () => {
  it('gemini 로 생성하려고 하면 거부된다 — RUNNABLE_HARNESSES 에 없으면 설정할 수 없다', async () => {
    const res = await create({ handle: 'gem-agent', displayName: 'GemAgent', harness: 'gemini' });
    expect(res.statusCode).toBe(400);
  });

  // codex 는 PRESETS 에 구현돼 있고 첫 턴도 실물로 완주했지만, 이 목록의 기준은
  // "resume 왕복까지 실물로 도는 것을 본 것"이고 그건 아직 확인되지 않았다
  // (docs/roadmap.md §5). 그래서 지금은 codex 도 거부된다 — 목록이 늘면 이 테스트가
  // 빨개져서 함께 고쳐야 한다는 사실을 알려 준다.
  it('codex 도 아직 거부된다 — 구현은 있지만 resume 왕복 실측이 남았다', async () => {
    const res = await create({ handle: 'codex-agent', displayName: 'CodexAgent', harness: 'codex' });
    expect(res.statusCode).toBe(400);
  });

  it('claude-code 는 받아들인다 — 유일한 실행 가능 harness 다', async () => {
    const res = await create({ handle: 'cc-agent', displayName: 'CcAgent', harness: 'claude-code' });
    expect(res.statusCode).toBe(201);
    expect(res.json().harness).toBe('claude-code');
  });

  it('기존 claude-code 에 다른 필드 수정은 되지만 harness 를 gemini 로 바꾸는 건 거부된다', async () => {
    const agent = (await create({ handle: 'claude-agent', displayName: 'ClaudeAgent' })).json();

    const otherFieldPatch = await patch(agent.id, { instructions: '수정된 지시문' });
    expect(otherFieldPatch.statusCode).toBe(200);

    const tryGemini = await patch(agent.id, { harness: 'gemini' });
    expect(tryGemini.statusCode).toBe(400);
  });
});

describe('에이전트 비활성화', () => {
  // 디렉터리는 **빼지 않고 표시한다.** 이 목록은 멘션 자동완성의 원천이면서 동시에 작성자
  // 이름을 푸는 표다(desktop 의 MessageItem 이 `accounts[authorId]` 를 본다) — 빼 버리면
  // 비활성화한 에이전트의 과거 메시지가 작성자를 잃고, 그건 "이력은 건드리지 않는다"는
  // 비활성화의 전제와 어긋난다. 후보에서 빼는 것은 이 플래그를 보는 화면의 몫이다.
  it('비활성화해도 GET /accounts 에는 남고 disabled 가 true 다 (이력 렌더링 보존)', async () => {
    const made = (await create({ handle: 'disappear', displayName: 'Disappear' })).json();

    await patch(made.id, { disabled: true });

    const after = await app.inject({ method: 'GET', url: '/accounts', headers: admin() });
    const row = after.json().accounts.find((a: { handle: string }) => a.handle === 'disappear');
    expect(row).toBeDefined();
    expect(row.disabled).toBe(true);
  });

  it('활성 계정의 disabled 는 false 다', async () => {
    const made = (await create({ handle: 'alive', displayName: 'Alive' })).json();
    expect(made.disabled).toBe(false);

    const res = await app.inject({ method: 'GET', url: '/accounts', headers: admin() });
    const row = res.json().accounts.find((a: { handle: string }) => a.handle === 'alive');
    expect(row.disabled).toBe(false);
  });

  it('비활성화해도 GET /accounts/agents 에는 남고 disabled 가 true 다', async () => {
    const made = (await create({ handle: 'stay', displayName: 'Stay' })).json();

    await patch(made.id, { disabled: true });

    const res = await list();
    const agent = res.json().agents.find((a: { handle: string }) => a.handle === 'stay');
    expect(agent).toBeDefined();
    expect(agent.disabled).toBe(true);
  });

  it('비활성화하면 그 계정의 PAT 가 더 이상 통하지 않는다', async () => {
    const made = (await create({ handle: 'revoke', displayName: 'Revoke' })).json();
    const patRes = await app.inject({
      method: 'POST', url: `/accounts/${made.id}/pats`, headers: admin(), payload: { label: 'runner' },
    });
    const pat = patRes.json().token as string;

    await patch(made.id, { disabled: true });

    const config = await app.inject({
      method: 'GET', url: '/agent/config',
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(config.statusCode).toBe(401);
  });

  it('다시 활성화하면 disabled 가 false 로 돌아간다', async () => {
    const made = (await create({ handle: 'reappear', displayName: 'Reappear' })).json();

    await patch(made.id, { disabled: true });
    await patch(made.id, { disabled: false });

    const res = await app.inject({ method: 'GET', url: '/accounts', headers: admin() });
    const row = res.json().accounts.find((a: { handle: string }) => a.handle === 'reappear');
    expect(row.disabled).toBe(false);
  });

  // 같은 값으로 다시 보내면 아무 일도 하지 않는다 — 이미 껐던 시각(disabled_at)을 now() 로
  // 밀어 버리면 "언제 껐나"를 잃고, 감사 로그도 같은 항목으로 부풀어 잡음이 된다.
  it('이미 비활성인 계정에 disabled:true 를 다시 보내도 감사 기록이 늘지 않는다', async () => {
    const made = (await create({ handle: 'idempotent', displayName: 'Idempotent' })).json();
    await patch(made.id, { disabled: true });
    const before = (await entriesOf('agent.disabled')).length;

    await patch(made.id, { disabled: true });

    expect((await entriesOf('agent.disabled')).length).toBe(before);
  });

  it('비활성화·활성화가 감사 기록에 남는다', async () => {
    const made = (await create({ handle: 'auditlog', displayName: 'AuditLog' })).json();

    await patch(made.id, { disabled: true });
    await patch(made.id, { disabled: false });

    const audit = await app.inject({
      method: 'GET', url: '/audit',
      headers: admin(),
    });
    const actions = audit.json().entries.map((r: { action: string }) => r.action);
    expect(actions).toContain('agent.disabled');
    expect(actions).toContain('agent.enabled');
  });

  it('비활성화된 에이전트가 쓴 과거 메시지는 그대로 남는다', async () => {
    const made = (await create({ handle: 'history', displayName: 'History' })).json();
    const patRes = await app.inject({
      method: 'POST', url: `/accounts/${made.id}/pats`, headers: admin(), payload: { label: 'runner' },
    });
    const pat = patRes.json().token as string;

    const channel = await app.inject({
      method: 'POST', url: '/channels', headers: admin(), payload: { name: 'test-history' },
    });
    const channelId = channel.json().id as string;

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${pat}` }, payload: { body: '과거 메시지' },
    });

    await patch(made.id, { disabled: true });

    const messages = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`,
      headers: admin(),
    });
    expect(messages.json().messages.some((m: { body: string }) => m.body === '과거 메시지')).toBe(true);
  });

  it('admin 이 아니면 비활성화 요청이 거부된다', async () => {
    const made = (await create({ handle: 'forbidden', displayName: 'Forbidden' })).json();
    const { pat } = await createAgent(app, adminToken, 'nonadmin');

    const res = await app.inject({
      method: 'PATCH', url: `/accounts/agents/${made.id}`,
      headers: { authorization: `Bearer ${pat}` }, payload: { disabled: true },
    });

    expect(res.statusCode).toBe(403);
  });
});
