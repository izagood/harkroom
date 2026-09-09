// **답하지 않기로 하는 길**(2026-09-09). `ask-answer` 옆에 선 문 하나다.
//
// 왜 이 문이 있는가: 물음이 닫히는 길이 고르기 하나뿐이라, 그 작업을 그만두기로 한 사람에게
// 남은 수단은 **그 메시지를 지우는 것**뿐이었고 그러면 무엇을 물었는지까지 사라졌다. 턴을
// 중단해도(`/agent-sessions/:id/cancel`) `meta.ask` 는 그대로여서 대기 줄이 물어본 턴보다
// 오래 살았다(jaebin 보고).
//
// 이 파일이 지키는 것 넷: (1) 닫히면 **집계에서 빠진다**(대기 줄·내 차례 배지의 원천),
// (2) **물어본 쪽이 깨어난다**(안 그러면 그 결정을 영영 모른다), (3) 정해진 것을 덮지
// 않는다(409), (4) 남의 물음을 아무나 닫지 못한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listMessages, postMessage } from '../src/services/messages.js';
import type { AskMeta } from '@murmur/shared';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let agentId: string;
let agentPat: string;
let otherPat: string;
let otherId: string;
let channelId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: agentId, pat: agentPat } = await createAgent(app, adminToken, 'closebot'));
  ({ accountId: otherId, pat: otherPat } = await createAgent(app, adminToken, 'bystander'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'closes' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

/** 스레드 머리 하나 + 그 아래 물음 하나. 집계는 **머리에만** 실리므로 둘이 필요하다. */
async function seedAsk(to: AskMeta['ask']['to']): Promise<{ rootId: string; askId: string }> {
  const root = await postMessage(pool, { channelId, authorId: agentId, body: '작업 시작' });
  const rootId = (root as { message: { id: string } }).message.id;
  const meta: AskMeta = {
    kind: 'ask',
    ask: { options: [{ id: 'a', label: '이대로' }, { id: 'b', label: '되돌린다' }], to },
  };
  const posted = await postMessage(pool, {
    channelId, authorId: agentId, threadRootId: rootId, body: '골라 줘',
    meta: meta as unknown as Record<string, unknown>,
  });
  return { rootId, askId: (posted as { message: { id: string } }).message.id };
}

/** 머리에 실린 대기 마디. 화면(`WaitChainSection`·`threadState`)이 보는 그 값이다. */
async function rootFacts(rootId: string) {
  const rows = await listMessages(pool, channelId, {});
  const root = rows.find((m) => m.id === rootId)!;
  return { links: root.openAskLinks, humanCount: root.openAskHumanCount, accountIds: root.openAskAccountIds };
}

const close = (askId: string, token: string) => app.inject({
  method: 'POST', url: `/channels/${channelId}/messages/${askId}/ask-close`, headers: auth(token),
});

describe('POST /channels/:id/messages/:messageId/ask-close', () => {
  it('답 없이 닫힌다 — 고른 것은 없고, 본문과 editedAt 은 그대로다', async () => {
    const { askId } = await seedAsk({ kind: 'human' });
    const res = await close(askId, adminToken);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.ask.closedAt).toBeTruthy();
    expect(body.meta.ask.closedBy).toBe(adminId);
    expect(body.meta.ask.closedReason).toBe('declined');
    // **고른 것이 없다**는 것이 이 경로의 요점이다 — 답과 뭉치면 "무엇으로 정해졌나"에
    // 답할 수 없는 값이 그 자리에 앉는다.
    expect(body.meta.ask.answeredWith).toBeUndefined();
    // 닫기는 수정이 아니다(답과 같은 규약).
    expect(body.editedAt).toBeNull();
    expect(body.body).toBe('골라 줘');
  });

  /** **이것이 이 기능의 목적이다** — 화면에서 그 줄이 사라지는 것. */
  it('닫히면 대기 마디에서 빠진다', async () => {
    const { rootId, askId } = await seedAsk({ kind: 'human' });
    expect((await rootFacts(rootId)).links).toHaveLength(1);
    expect((await rootFacts(rootId)).humanCount).toBe(1);

    expect((await close(askId, adminToken)).statusCode).toBe(200);

    const after = await rootFacts(rootId);
    expect(after.links).toEqual([]);
    expect(after.humanCount).toBe(0);
  });

  it('특정 계정에게 간 물음도 닫히면 그 계정 목록에서 빠진다', async () => {
    const { rootId, askId } = await seedAsk({ kind: 'account', accountId: otherId });
    expect((await rootFacts(rootId)).accountIds).toEqual([otherId]);
    expect((await close(askId, otherPat)).statusCode).toBe(200);
    expect((await rootFacts(rootId)).accountIds).toEqual([]);
  });

  /**
   * 깨우지 않으면 물어본 에이전트는 그 결정을 영영 모른다 — `message.ask` 는 발화라서 그
   * 턴은 물음을 올린 뒤 회수된다(043 이 답에 대해 같은 문제를 고쳤다).
   */
  it('물어본 쪽이 ask_closed 로 깨어난다', async () => {
    const { askId } = await seedAsk({ kind: 'human' });
    await close(askId, adminToken);
    const woke = await pool.query(
      `select reason from inbox where account_id = $1 and message_id = $2`, [agentId, askId],
    );
    expect(woke.rows[0]?.reason).toBe('ask_closed');
  });

  it('정해진 것을 덮지 않는다 — 답이 먼저면 409', async () => {
    const { askId } = await seedAsk({ kind: 'human' });
    const answered = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${askId}/ask-answer`,
      headers: auth(adminToken), payload: { optionId: 'a' },
    });
    expect(answered.statusCode).toBe(200);
    expect((await close(askId, adminToken)).statusCode).toBe(409);
  });

  /** 두 번 닫는 것은 **멱등**이다 — 다른 창에서 먼저 닫은 뒤 이 창에서 누르는 것은 정상이다. */
  it('두 번 닫아도 같은 결과다', async () => {
    const { askId } = await seedAsk({ kind: 'human' });
    expect((await close(askId, adminToken)).statusCode).toBe(200);
    const again = await close(askId, adminToken);
    expect(again.statusCode).toBe(200);
    expect(again.json().meta.ask.closedBy).toBe(adminId);
  });

  it('물어본 쪽은 자기 물음을 거둘 수 있다 — 그 길이 없으면 자기 대기 줄을 지울 수 없다', async () => {
    const { askId } = await seedAsk({ kind: 'account', accountId: otherId });
    expect((await close(askId, agentPat)).statusCode).toBe(200);
  });

  it('남에게 간 물음을 관계없는 계정이 닫을 수는 없다', async () => {
    const { rootId, askId } = await seedAsk({ kind: 'account', accountId: agentId });
    expect((await close(askId, otherPat)).statusCode).toBe(403);
    // 거절이 조용히 절반만 적용되지 않는다.
    expect((await rootFacts(rootId)).accountIds).toEqual([agentId]);
  });

  it('선택 요청이 아닌 메시지는 404', async () => {
    const plain = await postMessage(pool, { channelId, authorId: agentId, body: '그냥 말' });
    const id = (plain as { message: { id: string } }).message.id;
    expect((await close(id, adminToken)).statusCode).toBe(404);
  });
});
