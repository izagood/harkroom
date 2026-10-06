import type { FastifyInstance } from 'fastify';
import { mintPat } from '../../src/services/pats.js';
import { currentTestPool } from './testDb.js';

export async function bootstrapAdmin(app: FastifyInstance): Promise<{ token: string; accountId: string }> {
  const boot = await app.inject({
    method: 'POST', url: '/bootstrap',
    payload: { handle: 'admin', loginId: 'admin', displayName: 'Admin', password: 'pw123456' },
  });
  const accountId = boot.json().id as string;
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { loginId: 'admin', password: 'pw123456' },
  });
  return { token: login.json().token as string, accountId };
}

/**
 * 초대 → 가입 → 로그인으로 **member** 하나를 만든다(role 기본값). 권한 테스트의 "아무 grant 도
 * 없는 사람"이 이것이다 — bootstrapAdmin 은 owner 라 거절 경로를 못 잰다.
 */
export async function createMember(
  app: FastifyInstance, adminToken: string, handle: string,
): Promise<{ token: string; accountId: string }> {
  const auth = { authorization: `Bearer ${adminToken}` };
  const invite = await app.inject({ method: 'POST', url: '/invites', headers: auth });
  const inviteToken = invite.json().token as string;
  const reg = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { inviteToken, handle, loginId: handle, displayName: handle, password: 'pw123456' },
  });
  const accountId = reg.json().id as string;
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: handle, password: 'pw123456' } });
  return { token: login.json().token as string, accountId };
}

/** 등록 코드 → claim 으로 오퍼레이터 하나를 만든다(스펙 2026-09-20 §3). 토큰은 `hkop_…`. */
export async function registerOperator(
  app: FastifyInstance, ownerToken: string, name: string,
): Promise<{ token: string; operatorId: string }> {
  const code = (await app.inject({
    method: 'POST', url: '/operators/register-codes', headers: { authorization: `Bearer ${ownerToken}` },
  })).json().code as string;
  const res = await app.inject({ method: 'POST', url: '/operators/claim', payload: { code, name } });
  return { token: res.json().token as string, operatorId: res.json().operator.id as string };
}

/**
 * 이미 있는 에이전트에 PAT 하나를 찍는다. 발급 라우트(`POST /accounts/:id/pats`)는 410 이라 서비스로
 * 직접 넣는다 — viaPat 인증이 남아 있는 동안 "에이전트로 서는 요청"을 재는 테스트용이다.
 */
export async function agentPat(accountId: string, label = 'test'): Promise<string> {
  const minted = await mintPat(currentTestPool(), accountId, label, { actorId: null, actorHandle: null });
  if (!minted.ok) throw new Error(`agentPat: PAT 를 찍지 못했다(${minted.reason})`);
  return minted.token;
}

export async function createAgent(
  app: FastifyInstance, adminToken: string, handle: string,
): Promise<{ accountId: string; pat: string }> {
  const auth = { authorization: `Bearer ${adminToken}` };
  const created = await app.inject({
    method: 'POST', url: '/accounts/agents', headers: auth,
    payload: { handle, displayName: handle },
  });
  const accountId = created.json().id as string;
  return { accountId, pat: await agentPat(accountId) };
}
