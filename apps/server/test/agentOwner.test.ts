import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listAgents } from '../src/services/agents.js';

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

  it('에이전트 목록은 소유자에게만 열린다 — 소유자가 없으면 빈 배열이다 (#299)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/accounts/agents', headers: auth(botPat),
    });
    // #299: 이전에는 admin 전용이었는데, 이제 인증된 사용자에게 열린다.
    // bot 은 어떤 에이전트도 소유하지 않으므로 빈 배열이다(403 아님).
    expect(res.statusCode).toBe(200);
    expect(res.json().agents).toEqual([]);
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

/**
 * #299: 에이전트 **목록**을 소유자에게 연다.
 *
 * 목록은 판정이 아니라 **필터**다 — 소유한 것이 없다고 403 을 주면 "권한이 없다"가 되는데,
 * 사실은 "내 것이 없다"다. 그리고 필터는 **SQL 에서** 건다: 전부 가져와 자바스크립트에서
 * 걸러내면 남의 설정(지시문·workingDir)이 이미 응답 객체 안에 실렸다가 지워지는 모양이 되고,
 * 한 줄만 어긋나도 그대로 나간다.
 */
describe('#299 에이전트 목록을 소유자에게 연다', () => {
  const listAgentHandles = async (token: string): Promise<string[]> => {
    const res = await app.inject({ method: 'GET', url: '/accounts/agents', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    return (res.json().agents as { handle: string }[]).map((a) => a.handle);
  };

  it('1. 소유자는 자기 것만 본다 — 남의 것은 응답에 아예 없다', async () => {
    const { accountId: mineId } = await createAgent(app, adminToken, 'mine299');
    await createAgent(app, adminToken, 'theirs299');
    // ownedbot 을 소유자로 세운다. 소유자는 계정이면 되고, 이 계정은 PAT 로 인증한다.
    const patched = await app.inject({
      method: 'PATCH', url: `/accounts/agents/${mineId}`, headers: auth(adminToken),
      payload: { ownerAccountId: ownedId },
    });
    expect(patched.statusCode).toBe(200);

    const handles = await listAgentHandles(botPat);
    expect(handles).toEqual(['mine299']);
    // 남의 것은 **한 글자도** 응답에 없어야 한다 — 필터가 SQL 이 아니면 여기까지는 통과해도
    // 아래 4번이 잡는다.
    const raw = await app.inject({ method: 'GET', url: '/accounts/agents', headers: auth(botPat) });
    expect(raw.body).not.toContain('theirs299');
  });

  it('3. admin 은 전부 본다', async () => {
    const handles = await listAgentHandles(adminToken);
    expect(handles).toContain('mine299');
    expect(handles).toContain('theirs299');
    expect(handles).toContain('ownedbot');
  });

  /**
   * 4. 필터가 **SQL 에서** 걸린다.
   *
   * 응답만 보면 가져와서 걸러낸 구현도 통과한다. 그래서 질의문 자체를 본다 —
   * `listAgents` 에 가짜 pool 을 물려 실제로 나가는 SQL 과 파라미터를 잡는다.
   */
  it('4. 필터가 질의에 있다 — owner_account_id 조건과 파라미터', async () => {
    const seen: { text: string; params: unknown[] }[] = [];
    const fake = {
      query: async (text: string, params: unknown[] = []) => {
        seen.push({ text, params });
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;

    await listAgents(fake, 'owner-id-1');
    expect(seen).toHaveLength(1);
    // COLS 에도 `owner_account_id` 가 있으니 **조건절 모양**으로 단언한다.
    expect(seen[0]!.text).toContain('c.owner_account_id = $1');
    expect(seen[0]!.params).toEqual(['owner-id-1']);

    // admin(필터 없음)은 조건도 파라미터도 없다 — 조건을 늘 붙이고 값만 바꾸면
    // 실수로 null 이 흘렀을 때 "아무것도 없는" 목록이 조용히 나간다.
    seen.length = 0;
    await listAgents(fake, null);
    expect(seen[0]!.text).not.toContain('c.owner_account_id = $1');
    expect(seen[0]!.params).toEqual([]);
  });
});
