// 상태 보드(2026-10-01)가 받는 **스레드의 지금 상태**. 보드는 메시지가 아니라 일(스레드)
// 단위로 서고, 열은 옛 줄의 meta 가 아니라 머리의 상태(`THREAD_STATS`)가 정한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { InboxEntry, MessageRow } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let botId: string;
let channelId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ accountId: botId } = await createAgent(app, adminToken, 'boardbot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'inbox-board' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

async function post(body: string, threadRootId: string | null = null, meta: object = {}) {
  const posted = await postMessage(pool, {
    channelId, authorId: botId, body, threadRootId, meta: meta as Record<string, unknown>,
  });
  return (posted as { message: { id: string } }).message.id;
}

async function inbox(query: string) {
  const res = await app.inject({ method: 'GET', url: `/inbox${query}`, headers: auth(adminToken) });
  expect(res.statusCode).toBe(200);
  return res.json() as { entries: InboxEntry[]; threads?: MessageRow[] };
}

describe('GET /inbox?threads=1', () => {
  it('묻지 않으면 응답 모양이 그대로다 — 옛 앱·러너의 폴', async () => {
    await post('@admin 하나');
    const body = await inbox('');
    expect(body.threads).toBeUndefined();
    expect(Object.keys(body)).toEqual(['entries']);
  });

  it('같은 스레드의 여러 줄은 머리 하나로 모이고, 머리는 지금 상태를 싣는다', async () => {
    const root = await post('@admin 이 일 좀 봐 줘');
    await post('@admin 하나 더', root);
    await post('@admin 고를 것', root, {
      kind: 'ask',
      ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to: { kind: 'human' } },
    });
    const body = await inbox('?threads=1');
    const fromThread = body.entries.filter((e) => (e.threadRootId ?? e.messageId) === root);
    expect(fromThread.length).toBe(3);
    const heads = body.threads!.filter((m) => m.id === root);
    expect(heads).toHaveLength(1);
    expect(heads[0]!.openAskHumanCount).toBe(1);
    expect(heads[0]!.replyCount).toBe(2);
    // 머리만 실린다 — 답글 행이 섞이면 보드가 같은 일을 두 장으로 그린다.
    expect(body.threads!.every((m) => m.threadRootId === null)).toBe(true);
  });

  it('지운 말만 남은 스레드는 머리를 싣지 않는다', async () => {
    const root = await post('@admin 곧 지울 말');
    await pool.query('update message set deleted_at = now() where id = $1', [root]);
    const body = await inbox('?threads=1');
    expect(body.threads!.some((m) => m.id === root)).toBe(false);
  });
});
