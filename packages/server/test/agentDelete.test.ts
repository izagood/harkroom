import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * #836: 에이전트 삭제. 이 파일이 붙드는 것은 **삭제가 무엇을 지우고 무엇을 남기는가**다 —
 * 그 경계가 이 기능의 전부이기 때문이다(`deleteAgentAccount` 주석). 지우는 쪽만 보면 나중에
 * "이왕 지우는 김에" 메시지까지 끌고 가는 변경이 조용히 통과한다.
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let channelId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken),
    payload: { name: 'delete-test', kind: 'standard' },
  });
  channelId = ch.json().id as string;
});
afterAll(async () => { await app.close(); await stop(); });

describe('#836 에이전트 삭제', () => {
  it('삭제하면 목록·상세에서 사라지고 PAT 가 죽는다', async () => {
    const { accountId, pat } = await createAgent(app, adminToken, 'gonebot');

    const del = await app.inject({
      method: 'DELETE', url: `/accounts/agents/${accountId}`, headers: auth(adminToken),
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/accounts/agents', headers: auth(adminToken) });
    expect((list.json().agents as { id: string }[]).map((a) => a.id)).not.toContain(accountId);

    // 상세가 404 라는 것이 곧 수정·종료요청도 404 라는 뜻이다(`getAgent` 하나가 거른다).
    const patch = await app.inject({
      method: 'PATCH', url: `/accounts/agents/${accountId}`, headers: auth(adminToken),
      payload: { displayName: 'back' },
    });
    expect(patch.statusCode).toBe(404);

    // PAT 가 죽었다 — 러너가 401 을 받고 선다.
    const asAgent = await app.inject({ method: 'GET', url: '/agent/config', headers: auth(pat) });
    expect(asAgent.statusCode).toBe(401);
  });

  it('두 번 지우면 404 다 — 감사에 같은 삭제가 두 번 남지 않는다', async () => {
    const { accountId } = await createAgent(app, adminToken, 'twicebot');
    expect((await app.inject({
      method: 'DELETE', url: `/accounts/agents/${accountId}`, headers: auth(adminToken),
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: 'DELETE', url: `/accounts/agents/${accountId}`, headers: auth(adminToken),
    })).statusCode).toBe(404);
    const audits = await pool.query(
      `select 1 from audit_log where action = 'agent.deleted' and target = $1`, [accountId],
    );
    expect(audits.rowCount).toBe(1);
  });

  /**
   * 이 기능의 **핵심 경계**다. 삭제가 이력을 건드리면 사람들은 지워야 할 때 지우지 못한다 —
   * 대화는 그 에이전트 혼자의 것이 아니라 그 자리에 있던 사람들의 것이기도 하다.
   */
  it('과거 메시지는 남고 디렉터리도 작성자를 계속 푼다', async () => {
    const { accountId, pat } = await createAgent(app, adminToken, 'historybot');
    const posted = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(pat),
      payload: { body: '내가 여기 있었다' },
    });
    expect(posted.statusCode).toBe(201);

    await app.inject({ method: 'DELETE', url: `/accounts/agents/${accountId}`, headers: auth(adminToken) });

    const msgs = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
    });
    const bodies = (msgs.json().messages as { body: string; authorId: string }[]);
    expect(bodies.some((m) => m.body === '내가 여기 있었다' && m.authorId === accountId)).toBe(true);

    // 디렉터리는 행을 **남긴다** — 빼면 저 메시지가 작성자를 잃는다. 대신 `deleted` 로 표시한다.
    const dir = await app.inject({ method: 'GET', url: '/accounts', headers: auth(adminToken) });
    const row = (dir.json().accounts as { id: string; deleted: boolean }[]).find((a) => a.id === accountId);
    expect(row?.deleted).toBe(true);
  });

  /** 이름은 잡아 둔 채다 — 풀어 주면 과거 메시지의 `@handle` 이 **다른 에이전트**를 가리킨다. */
  it('삭제된 에이전트는 멘션으로 불리지 않는다', async () => {
    const { accountId } = await createAgent(app, adminToken, 'silentbot');
    await app.inject({ method: 'DELETE', url: `/accounts/agents/${accountId}`, headers: auth(adminToken) });

    const posted = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
      payload: { body: '@silentbot 있나' },
    });
    expect(posted.statusCode).toBe(201);
    // 정규화되지 않았으므로 본문은 글자 그대로다 — 없는 handle 과 같은 취급이다.
    expect(posted.json().body).toContain('@silentbot');
    const inbox = await pool.query(`select 1 from inbox where account_id = $1`, [accountId]);
    expect(inbox.rowCount).toBe(0);
  });
});
