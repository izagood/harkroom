// 게시가 풀을 어떻게 쓰는가(2026-10-01 풀 포화). 커넥션을 쥔 채 풀에서 하나를 더 빌리면
// 풀이 찬 순간 자기 자신을 기다린다 — 커넥션 하나짜리 풀이 그 순간을 그대로 재현한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: pg.Pool;
let uri: string;
let adminId: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  ({ stop, pool, uri } = db);
  app = await buildServer({ pool });
  const admin = await bootstrapAdmin(app);
  adminId = admin.accountId;
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${admin.token}` }, payload: { name: 'pool' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

describe('postMessage 와 풀', () => {
  it('지워진 머리에 답할 때 커넥션을 돌려준 뒤에 머리 행을 읽는다', async () => {
    const root = await postMessage(pool, { channelId, authorId: adminId, body: '머리' });
    const rootId = (root as { message: { id: string } }).message.id;
    await pool.query(`update message set deleted_at = now() where id = $1`, [rootId]);

    // 커넥션 하나짜리 풀: 게시가 쥔 채로 `readListRow` 가 하나를 더 빌리면 시한에 걸린다.
    const tiny = new pg.Pool({ connectionString: uri, max: 1, connectionTimeoutMillis: 2_000 });
    try {
      const reply = await postMessage(tiny, { channelId, authorId: adminId, body: '답', threadRootId: rootId });

      if (!reply.message) throw new Error(`게시 실패: ${reply.failure}`);
      expect(reply.rootBack?.id).toBe(rootId);
      expect(tiny.totalCount - tiny.idleCount).toBe(0);
    } finally {
      await tiny.end();
    }
  });
});
