import type { FastifyInstance } from 'fastify';

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

export async function createAgent(
  app: FastifyInstance, adminToken: string, handle: string,
): Promise<{ accountId: string; pat: string }> {
  const auth = { authorization: `Bearer ${adminToken}` };
  const created = await app.inject({
    method: 'POST', url: '/accounts/agents', headers: auth,
    payload: { handle, displayName: handle },
  });
  const accountId = created.json().id as string;
  const patRes = await app.inject({
    method: 'POST', url: `/accounts/${accountId}/pats`, headers: auth,
    payload: { label: 'test' },
  });
  return { accountId, pat: patRes.json().token as string };
}
