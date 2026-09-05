// Task 3 — 선택지에 답하는 REST 경로. 화면(`AskCard`)이 누르는 그 문이다.
//
// MCP 쪽 계약은 `mcp.test.ts` 가 지키고, 여기서는 **사람이 브라우저에서 답하는 경로**를
// 지킨다: 상태 코드가 화면의 분기와 1:1이어야 하기 때문이다 — 특히 409(이미 답함)는
// 오류가 아니라 경합의 정상 결과이고, 화면은 그것을 "이미 정해졌다"로 읽어야 한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import type { AskMeta } from '@murmur/shared';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let agentId: string;
let agentPat: string;
let channelId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: agentId, pat: agentPat } = await createAgent(app, adminToken, 'askbot'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'asks' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

/** 선택 요청 하나를 심는다. 도구를 거치지 않고 직접 넣어 이 파일이 MCP 에 묶이지 않게 한다. */
async function seedAsk(to: AskMeta['ask']['to']): Promise<string> {
  const meta: AskMeta = {
    kind: 'ask',
    ask: { options: [{ id: 'new', label: '새 마이그레이션' }, { id: 'edit', label: '008 수정' }], to },
  };
  const posted = await postMessage(pool, {
    channelId, authorId: agentId, body: '골라 줘', meta: meta as unknown as Record<string, unknown>,
  });
  return (posted as { message: { id: string } }).message.id;
}

describe('POST /channels/:id/messages/:messageId/ask-answer', () => {
  it('사람이 고르면 원본에 답이 기록되고 editedAt 은 그대로다', async () => {
    const id = await seedAsk({ kind: 'human' });
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${id}/ask-answer`,
      headers: auth(adminToken), payload: { optionId: 'new' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.ask.answeredWith).toBe('new');
    expect(body.meta.ask.answeredBy).toBe(adminId);
    // **답은 수정이 아니다** — 사람이 글을 고친 것이 아니므로 (edited) 가 붙으면 안 된다.
    expect(body.editedAt).toBeNull();
    expect(body.body).toBe('골라 줘');
  });

  it('두 번째 답은 409 — 먼저 온 것이 이긴다', async () => {
    const id = await seedAsk({ kind: 'human' });
    const first = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${id}/ask-answer`,
      headers: auth(adminToken), payload: { optionId: 'new' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${id}/ask-answer`,
      headers: auth(agentPat), payload: { optionId: 'edit' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('already_answered');

    // 진 답이 원본을 덮지 않았다.
    const after = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`, headers: auth(adminToken),
    });
    const row = after.json().messages.find((m: { id: string }) => m.id === id);
    expect(row.meta.ask.answeredWith).toBe('new');
  });

  it('수신자가 정해진 물음은 그 계정만 답한다', async () => {
    const id = await seedAsk({ kind: 'account', accountId: agentId });
    const stolen = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${id}/ask-answer`,
      headers: auth(adminToken), payload: { optionId: 'new' },
    });
    // 가로챌 수 있으면 `to` 를 실은 뜻이 사라진다.
    expect(stolen.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${id}/ask-answer`,
      headers: auth(agentPat), payload: { optionId: 'new' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('없는 옵션은 400, 선택 요청이 아닌 메시지는 404', async () => {
    const id = await seedAsk({ kind: 'human' });
    const bad = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${id}/ask-answer`,
      headers: auth(adminToken), payload: { optionId: 'nope' },
    });
    expect(bad.statusCode).toBe(400);

    const plain = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: auth(adminToken), payload: { body: '그냥 말' },
    });
    const notAsk = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${plain.json().id}/ask-answer`,
      headers: auth(adminToken), payload: { optionId: 'new' },
    });
    expect(notAsk.statusCode).toBe(404);
  });
});
