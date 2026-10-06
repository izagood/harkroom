// 「내 작업」 보드(2026-10-03, S1) — `GET /inbox/board` 가 inbox 밖의 스레드 머리를 더한다:
// 내가 연·답한 스레드(30일) ∩ 에이전트가 낀 것. inbox 만으로는 "시켜 놓고 아직 답이 없는 일"과
// "남의 스레드에 말만 얹은 일"이 보드에 없었다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { InboxEntry, InboxThreadState, MessageRow } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listBoardRootIds, postMessage } from '../src/services/messages.js';
import { removeChannelMember } from '../src/services/channels.js';
import { refreshThreadStatus } from '../src/services/threadStatus.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let botId: string;
let channelId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: botId } = await createAgent(app, adminToken, 'workbot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'my-work' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

async function post(authorId: string, body: string, threadRootId: string | null = null, channel = channelId) {
  const posted = await postMessage(pool, { channelId: channel, authorId, body, threadRootId, meta: {} });
  return (posted as { message: { id: string } }).message.id;
}

/** 서버 판정을 지금 돌린다 — 감시자(이벤트)를 기다리지 않고 시험이 결정적으로 잰다. */
const settle = (rootId: string) => refreshThreadStatus(pool, rootId, null);

async function board() {
  const res = await app.inject({ method: 'GET', url: '/inbox/board', headers: auth(adminToken) });
  expect(res.statusCode).toBe(200);
  return res.json() as { entries: InboxEntry[]; threads: MessageRow[]; threadStates: InboxThreadState[]; truncated: boolean };
}

describe('GET /inbox/board', () => {
  it('내가 시켰는데 아직 아무도 답하지 않은 스레드가 선다 — inbox 항목 없이 머리만', async () => {
    const root = await post(adminId, '@workbot 이거 해 줘');
    await settle(root);
    const body = await board();
    expect(body.entries.some((e) => (e.threadRootId ?? e.messageId) === root)).toBe(false);
    const head = body.threads.find((m) => m.id === root);
    expect(head).toBeDefined();
    expect(head!.statusReaction?.status).toBe('received');
    // 옛 조회는 그대로다 — inbox 항목이 없으니 머리도 없다.
    const old = await app.inject({ method: 'GET', url: '/inbox?threads=1', headers: auth(adminToken) });
    expect((old.json().threads as MessageRow[]).some((m) => m.id === root)).toBe(false);
  });

  it('남이 연 스레드에 내가 말만 얹었어도 선다', async () => {
    const root = await post(botId, '조사 결과를 정리했다');
    await post(adminId, '좋다, 이어서 PR 로', root);
    await settle(root);
    const body = await board();
    expect(body.entries.some((e) => (e.threadRootId ?? e.messageId) === root)).toBe(false);
    expect(body.threads.some((m) => m.id === root)).toBe(true);
  });

  it('사람끼리만 나눈 스레드는 세우지 않는다 — 에이전트가 낀 것만', async () => {
    const root = await post(adminId, '점심 뭐 먹지');
    await settle(root);
    const { rows } = await pool.query('select 1 from thread_status where root_id = $1', [root]);
    expect(rows).toHaveLength(0);
    expect((await board()).threads.some((m) => m.id === root)).toBe(false);
  });

  it('30일 넘게 말하지 않은 스레드는 빠진다', async () => {
    const root = await post(adminId, '@workbot 옛날 일');
    await settle(root);
    expect((await board()).threads.some((m) => m.id === root)).toBe(true);
    await pool.query(`update message set created_at = now() - interval '31 days' where id = $1`, [root]);
    expect((await board()).threads.some((m) => m.id === root)).toBe(false);
  });

  it('내 말을 지웠으면 그 말로는 세우지 않는다', async () => {
    const root = await post(botId, '진행 보고');
    const mine = await post(adminId, '지울 말', root);
    await settle(root);
    expect((await board()).threads.some((m) => m.id === root)).toBe(true);
    await pool.query('update message set deleted_at = now() where id = $1', [mine]);
    expect((await board()).threads.some((m) => m.id === root)).toBe(false);
  });

  it('비공개 채널에서 내보내지면 빠진다 — 머리는 지금의 가시성으로 거른다', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'work-private', visibility: 'private' },
    });
    expect(ch.statusCode).toBe(201);
    const privateId = ch.json().id as string;
    await app.inject({
      method: 'POST', url: `/channels/${privateId}/members`, headers: auth(adminToken), payload: { accountId: botId },
    });
    const root = await post(adminId, '@workbot 비공개 일', null, privateId);
    await settle(root);
    expect((await board()).threads.some((m) => m.id === root)).toBe(true);
    await removeChannelMember(pool, privateId, adminId);
    expect((await board()).threads.some((m) => m.id === root)).toBe(false);
  });

  it('inbox 머리와 겹치면 한 번만 싣는다', async () => {
    const root = await post(adminId, '@workbot 겹치는 일');
    await post(botId, '@admin 하나 물어볼게', root);
    await settle(root);
    const body = await board();
    expect(body.entries.some((e) => e.threadRootId === root)).toBe(true);
    expect(body.threads.filter((m) => m.id === root)).toHaveLength(1);
  });

  it('상한을 넘으면 최근에 상태가 바뀐 것부터 남기고 truncated 를 알린다', async () => {
    const a = await post(adminId, '@workbot 하나');
    await settle(a);
    const b = await post(adminId, '@workbot 둘');
    await settle(b);
    await pool.query(`update thread_status set updated_at = now() + interval '1 minute' where root_id = $1`, [b]);
    const cut = await listBoardRootIds(pool, adminId, { days: 30, limit: 1 });
    expect(cut).toEqual({ rootIds: [b], truncated: true });
    expect((await board()).truncated).toBe(false);
  });

  /**
   * #1137 security 후속: 상한은 **볼 수 있는 머리**로 센다. 내보내진 비공개 채널의 머리가 몫을 먹으면
   * 보이는 카드가 상한보다 적은데도 `truncated` 가 참이었다.
   */
  it('볼 수 없게 된 머리는 상한 몫을 먹지 않는다', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'cap-private', visibility: 'private' },
    });
    const privateId = ch.json().id as string;
    await app.inject({
      method: 'POST', url: `/channels/${privateId}/members`, headers: auth(adminToken), payload: { accountId: botId },
    });
    const hidden = await post(adminId, '@workbot 곧 못 볼 일', null, privateId);
    await settle(hidden);
    const seen = await post(adminId, '@workbot 계속 볼 일');
    await settle(seen);
    // 숨을 머리를 가장 최근으로 — 거르기 전에 자르면 이것이 몫 하나를 차지한다.
    await pool.query(`update thread_status set updated_at = now() + interval '1 hour' where root_id = $1`, [hidden]);
    await pool.query(`update thread_status set updated_at = now() + interval '30 minutes' where root_id = $1`, [seen]);
    await removeChannelMember(pool, privateId, adminId);
    const cut = await listBoardRootIds(pool, adminId, { days: 30, limit: 1 });
    expect(cut.rootIds).toEqual([seen]);
  });
});
