import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
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

  /** 옛 이름으로 써도 지운 에이전트는 불리지 않는다 — 이름은 묘비 이름으로 바뀌었고, 아무도 그 이름을 갖지 않는다. */
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

  /**
   * 지운 에이전트는 이름을 묘비 이름으로 내려놓는다(143) — 쥐고 있으면 같은 이름의 새 에이전트를
   * 만들 수 없다(`account_handle_key` 위반이 500 으로 나갔다). 지난 글은 `<@옛 id>` 라 묘비 이름으로
   * 보이고, 새 에이전트를 가리키지 않는다. 감사에는 옛 이름이 남는다.
   */
  it('지우면 이름이 풀려 같은 이름으로 다시 만들 수 있다 — 지난 멘션은 옛 계정을 가리킨다', async () => {
    const { accountId: oldId } = await createAgent(app, adminToken, 'reusebot');
    const mention = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
      payload: { body: '@reusebot 안녕' },
    });
    expect(mention.statusCode).toBe(201);
    expect(mention.json().body).toContain(`<@${oldId}>`);

    expect((await app.inject({
      method: 'DELETE', url: `/accounts/agents/${oldId}`, headers: auth(adminToken),
    })).statusCode).toBe(204);

    const row = await pool.query<{ handle: string }>(`select handle from account where id = $1`, [oldId]);
    expect(row.rows[0]!.handle).toBe(`deleted-${oldId.replace(/-/g, '').slice(0, 8)}`);
    const audit = await pool.query<{ detail: { handle: string } }>(
      `select detail from audit_log where action = 'agent.deleted' and target = $1`, [oldId]);
    expect(audit.rows[0]!.detail.handle).toBe('reusebot');

    const again = await app.inject({
      method: 'POST', url: '/accounts/agents', headers: auth(adminToken),
      payload: { handle: 'reusebot', displayName: 'reusebot' },
    });
    expect(again.statusCode).toBe(201);
    const newId = again.json().id as string;
    expect(newId).not.toBe(oldId);

    // 지난 글은 여전히 옛 계정의 토큰이다 — 새 에이전트를 가리키지 않는다.
    const msgs = await app.inject({ method: 'GET', url: `/channels/${channelId}/messages`, headers: auth(adminToken) });
    const old = (msgs.json().messages as { id: string; body: string }[]).find((m) => m.id === mention.json().id);
    expect(old?.body).toContain(`<@${oldId}>`);
    expect(old?.body).not.toContain(`<@${newId}>`);
  });

  /** 143 백필: 이 PR 전에 지운 에이전트(옛 이름을 쥔 행)도 묘비 이름으로 옮긴다. 겹치면 긴 꼬리로 물러선다. */
  it('143 마이그레이션이 옛 이름을 쥔 지운 에이전트를 묘비 이름으로 옮긴다', async () => {
    const { accountId: a } = await createAgent(app, adminToken, 'legacybot');
    const { accountId: b } = await createAgent(app, adminToken, 'legacybot2');
    const { accountId: live } = await createAgent(app, adminToken, 'livebot');
    // 이 PR 전의 삭제 모양 — 이름은 그대로, deleted_at 만 찍힘.
    await pool.query(`update account set deleted_at = now(), disabled_at = now() where id = any($1)`, [[a, b]]);
    // b 의 8자 묘비 이름을 누가 이미 쓰고 있다(접두를 막기 전의 이름).
    const hexB = b.replace(/-/g, '');
    await pool.query(`update account set handle = $1 where id = $2`, [`deleted-${hexB.slice(0, 8)}`, live]);

    const sql = await readFile(new URL('../src/db/migrations/143_deleted_agent_tombstone_handle.sql', import.meta.url), 'utf8');
    await pool.query(sql);

    const rows = await pool.query<{ id: string; handle: string }>(`select id, handle from account where id = any($1)`, [[a, b, live]]);
    const h = Object.fromEntries(rows.rows.map((r) => [r.id, r.handle]));
    expect(h[a]).toBe(`deleted-${a.replace(/-/g, '').slice(0, 8)}`);
    expect(h[b]).toBe(`deleted-${hexB.slice(0, 24)}`);
    expect(h[live]).toBe(`deleted-${hexB.slice(0, 8)}`); // 살아 있는 계정은 건드리지 않는다
    // 다시 돌려도 바뀌지 않는다(이미 deleted- 인 행은 건너뛴다).
    await pool.query(sql);
    const again = await pool.query<{ handle: string }>(`select handle from account where id = $1`, [a]);
    expect(again.rows[0]!.handle).toBe(h[a]);

    const created = await app.inject({
      method: 'POST', url: '/accounts/agents', headers: auth(adminToken),
      payload: { handle: 'legacybot', displayName: 'legacybot' },
    });
    expect(created.statusCode).toBe(201);
  });
});
