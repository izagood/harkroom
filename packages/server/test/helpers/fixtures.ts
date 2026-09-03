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
