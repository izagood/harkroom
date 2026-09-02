import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
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

  it('codex 로 생성할 수 있다 — RUNNABLE_HARNESSES 에 있다', async () => {
    const res = await create({ handle: 'codex-agent', displayName: 'CodexAgent', harness: 'codex' });
    expect(res.statusCode).toBe(201);
    expect(res.json().harness).toBe('codex');
  });

  it('기존 claude-code 에 다른 필드 수정은 되지만 harness 를 gemini 로 바꾸는 건 거부된다', async () => {
    const agent = (await create({ handle: 'claude-agent', displayName: 'ClaudeAgent' })).json();

    const otherFieldPatch = await patch(agent.id, { instructions: '수정된 지시문' });
    expect(otherFieldPatch.statusCode).toBe(200);

    const tryGemini = await patch(agent.id, { harness: 'gemini' });
    expect(tryGemini.statusCode).toBe(400);
  });
});
