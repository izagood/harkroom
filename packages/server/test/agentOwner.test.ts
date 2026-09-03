import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

// #181: 에이전트를 누가 운영하는지는 비밀이 아니라 **책임 소재**다. 그래서 소유자 id
// 하나만 계정 디렉터리에 공개한다 — harness·model·workingDir·지시문은 운영 설정이라
// 계속 admin 전용이고, 이 파일이 그 경계를 회귀선으로 붙든다.
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let ownedId: string;
let orphanId: string;
let botPat: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  // 에이전트를 만든 admin 이 소유자가 된다(`createAgentAccount`).
  ({ accountId: ownedId, pat: botPat } = await createAgent(app, adminToken, 'ownedbot'));
  ({ accountId: orphanId } = await createAgent(app, adminToken, 'orphanbot'));
  // 소유자가 없는 것이 정상 상태다 — backfill 없이 컬럼이 추가됐기 때문이다.
  await app.inject({
    method: 'PATCH', url: `/accounts/agents/${orphanId}`, headers: auth(adminToken),
    payload: { ownerAccountId: null },
  });
});
afterAll(async () => { await app.close(); await stop(); });

const directory = async (token: string): Promise<Record<string, Record<string, unknown>>> => {
  const res = await app.inject({ method: 'GET', url: '/accounts', headers: auth(token) });
  expect(res.statusCode).toBe(200);
  const rows = res.json().accounts as { handle: string }[];
  return Object.fromEntries(rows.map((a) => [a.handle, a as Record<string, unknown>]));
};

describe('#181 에이전트 소유자 공개', () => {
  it('소유자가 있는 에이전트는 계정 디렉터리에 소유자 id 를 싣는다', async () => {
    const byHandle = await directory(adminToken);
    expect(byHandle.ownedbot?.ownerAccountId).toBe(adminId);
  });

  it('소유자가 없는 에이전트는 null 이다', async () => {
    const byHandle = await directory(adminToken);
    expect(byHandle.orphanbot?.ownerAccountId).toBeNull();
  });

  it('사람 계정도 필드를 갖고 값은 null 이다', async () => {
    const byHandle = await directory(adminToken);
    // 옵셔널이 아니라 필수 필드다 — 없는 것과 null 이 섞이면 화면이 둘을 구분할 수 없다.
    expect(byHandle.admin).toHaveProperty('ownerAccountId');
    expect(byHandle.admin?.ownerAccountId).toBeNull();
  });

  it('admin 이 아닌 호출자도 소유자를 본다', async () => {
    const byHandle = await directory(botPat);
    expect(byHandle.ownedbot?.ownerAccountId).toBe(adminId);
  });

  it('공개되는 것은 소유자 id 뿐이다 — 운영 설정은 여전히 안 나온다', async () => {
    const byHandle = await directory(botPat);
    const row = byHandle.ownedbot!;
    for (const secret of ['harness', 'instructions', 'model', 'workingDir', 'mentionPermission']) {
      expect(row).not.toHaveProperty(secret);
    }
  });

  it('에이전트 상세는 계속 admin 전용이다', async () => {
    const res = await app.inject({
      method: 'GET', url: '/accounts/agents', headers: auth(botPat),
    });
    expect(res.statusCode).toBe(403);
  });

  it('소유자 계정이 사라지면 소유자는 null 로 돌아온다', async () => {
    // 컬럼이 `on delete set null` 이라 "소유자 없음"과 같은 상태가 된다 — 따로 다루지 않는다.
    const { accountId: tempOwner } = await createAgent(app, adminToken, 'tempowner');
    const { accountId: ownedByTemp } = await createAgent(app, adminToken, 'ownedbytemp');
    await app.inject({
      method: 'PATCH', url: `/accounts/agents/${ownedByTemp}`, headers: auth(adminToken),
      payload: { ownerAccountId: tempOwner },
    });
    expect((await directory(adminToken)).ownedbytemp?.ownerAccountId).toBe(tempOwner);

    // 테스트 픽스처가 PAT 를 함께 만들어 두므로 그것부터 지운다 — 이 회귀선이 보려는 것은
    // `agent_config.owner_account_id` 의 `on delete set null` 이다.
    await pool.query('delete from pat where account_id = $1', [tempOwner]);
    await pool.query('delete from account where id = $1', [tempOwner]);
    expect((await directory(adminToken)).ownedbytemp?.ownerAccountId).toBeNull();
  });
});
