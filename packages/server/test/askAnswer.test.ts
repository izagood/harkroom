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
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import type { AskMeta } from '@harkroom/shared';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let agentId: string;
let agentPat: string;
let channelId: string;
let memberToken: string;
let memberId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: agentId, pat: agentPat } = await createAgent(app, adminToken, 'askbot'));
  ({ token: memberToken, accountId: memberId } = await createMember(app, adminToken, 'askmember'));
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
      headers: auth(memberToken), payload: { optionId: 'edit' },
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

// ── 답이 오면 물어본 에이전트를 깨운다(2026-09-09 프로덕션 관측)
//
// `message.ask` 의 설명은 *"갈림길에서 선택지를 내놓는다(고르면 즉시 진행)"* 인데, 그
// "즉시 진행"을 만드는 코드가 없었다. 답은 meta 에 기록되지만 물어본 에이전트는 그 사실을
// 영영 모른다 — 게다가 `message.ask` 는 발화라서 그 턴은 답을 올린 뒤 회수된다.
//
// 실측(03:41): 사람이 답을 고른 뒤 **15분 동안** 그 스레드에 아무 일도 없었다.
describe('선택에 답하면 물어본 에이전트가 깨어난다', () => {
  it('inbox 에 ask_answered 항목이 생긴다', async () => {
    const ask = await postMessage(pool, {
      channelId, authorId: agentId, body: '어느 쪽으로 갈까?', threadRootId: null,
      meta: {
        kind: 'ask',
        ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to: { kind: 'human' } },
      } as unknown as Record<string, unknown>,
    });
    const messageId = ask.message!.id;

    const before = await pool.query(
      `select count(*)::int as n from inbox where account_id = $1`, [agentId],
    );

    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${messageId}/ask-answer`,
      headers: auth(adminToken), payload: { optionId: 'b' },
    });
    expect(res.statusCode).toBe(200);

    const after = await pool.query(
      `select reason, message_id from inbox where account_id = $1 order by id desc limit 1`, [agentId],
    );
    expect(after.rows[0]?.reason).toBe('ask_answered');
    // 물음 자신을 가리킨다 — 러너가 그 메시지의 meta 에서 `answeredWith` 를 읽는다.
    expect(after.rows[0]?.message_id).toBe(messageId);
    const cnt = await pool.query(`select count(*)::int as n from inbox where account_id = $1`, [agentId]);
    expect(cnt.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('이미 답한 물음에 다시 답해도 깨움이 두 번 생기지 않는다', async () => {
    // 409 는 경합의 정상 결과다(위 테스트들). 그때 깨움을 또 만들면 에이전트가 같은
    // 선택으로 두 번 깨어나 같은 일을 두 번 한다.
    const ask = await postMessage(pool, {
      channelId, authorId: agentId, body: '두 번 답해 보자', threadRootId: null,
      meta: {
        kind: 'ask',
        ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to: { kind: 'human' } },
      } as unknown as Record<string, unknown>,
    });
    const messageId = ask.message!.id;
    const url = `/channels/${channelId}/messages/${messageId}/ask-answer`;

    await app.inject({ method: 'POST', url, headers: auth(adminToken), payload: { optionId: 'a' } });
    const second = await app.inject({ method: 'POST', url, headers: auth(adminToken), payload: { optionId: 'b' } });
    expect(second.statusCode).toBe(409);

    const n = await pool.query(
      `select count(*)::int as n from inbox where account_id = $1 and message_id = $2`,
      [agentId, messageId],
    );
    expect(n.rows[0].n).toBe(1);
  });
});

// ── 사람 앞 물음은 사람만 답한다(2026-09-29)
//
// 전에는 `to.kind === 'account'` 만 검사해서, 채널을 볼 수 있는 계정이면 에이전트도 HTTP 로
// 사람 카드를 누를 수 있었다. MCP 에 도구가 없어 막혀 있었을 뿐이다.
describe('사람 앞 물음 — 에이전트는 답하지도 닫지도 못한다', () => {
  it('에이전트가 사람 카드에 답하면 403, 사람은 된다', async () => {
    const { pat: otherPat } = await createAgent(app, adminToken, 'askintruder');
    const id = await seedAsk({ kind: 'human' });
    const url = `/channels/${channelId}/messages/${id}/ask-answer`;
    for (const pat of [otherPat, agentPat]) {
      const res = await app.inject({ method: 'POST', url, headers: auth(pat), payload: { optionId: 'new' } });
      expect(res.statusCode).toBe(403);
    }
    const ok = await app.inject({ method: 'POST', url, headers: auth(memberToken), payload: { optionId: 'new' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().meta.ask.answeredBy).toBe(memberId);
  });

  it('남의 에이전트는 사람 카드를 닫지 못하고, 물어본 에이전트는 자기 카드를 거둘 수 있다', async () => {
    const { pat: otherPat } = await createAgent(app, adminToken, 'askintruder2');
    const id = await seedAsk({ kind: 'human' });
    const url = `/channels/${channelId}/messages/${id}/ask-close`;
    const denied = await app.inject({ method: 'POST', url, headers: auth(otherPat) });
    expect(denied.statusCode).toBe(403);
    const own = await app.inject({ method: 'POST', url, headers: auth(agentPat) });
    expect(own.statusCode).toBe(200);
    expect(own.json().meta.ask.closedBy).toBe(agentId);
  });
});

// ── 거울 카드(`mirrorOf`, 2026-09-29) — 관리 에이전트가 다른 채널에 같은 선택지로 다시 세운 카드
//
// 정본은 원본이다. 사람이 어느 쪽을 누르든 원본에 그 사람 이름으로 적히고, 열린 거울은
// 같은 결과로 닫힌다. 원본을 낸 쪽과 거울을 낸 쪽이 **둘 다** 깨어난다.
describe('거울 카드', () => {
  let mirrorBotId: string;
  let mirrorBotPat: string;
  let otherChannelId: string;

  beforeAll(async () => {
    ({ accountId: mirrorBotId, pat: mirrorBotPat } = await createAgent(app, adminToken, 'mirrorbot'));
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'task-mirror' },
    });
    otherChannelId = ch.json().id;
  });

  async function seedMirror(rootId: string): Promise<string> {
    const meta: AskMeta = {
      kind: 'ask',
      ask: {
        options: [{ id: 'edit', label: '008 을 고친다' }, { id: 'new', label: '새 009' }],
        to: { kind: 'human' }, mirrorOf: rootId,
      },
    };
    const posted = await postMessage(pool, {
      channelId: otherChannelId, authorId: mirrorBotId, body: '[원래 스레드] 골라 줘',
      meta: meta as unknown as Record<string, unknown>,
    });
    return (posted as { message: { id: string } }).message.id;
  }

  const lastWake = async (accountId: string, messageId: string) => (await pool.query(
    `select reason from inbox where account_id = $1 and message_id = $2 order by id desc`, [accountId, messageId],
  )).rows.map((r) => r.reason as string);

  const metaOf = async (id: string) => (await pool.query(`select meta from message where id = $1`, [id])).rows[0].meta.ask;

  it('거울에 답하면 원본에도 그 사람 이름으로 적히고, 두 쪽이 다 깨어난다', async () => {
    const root = await seedAsk({ kind: 'human' });
    const mirror = await seedMirror(root);
    const res = await app.inject({
      method: 'POST', url: `/channels/${otherChannelId}/messages/${mirror}/ask-answer`,
      headers: auth(memberToken), payload: { optionId: 'edit' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.ask).toMatchObject({ answeredWith: 'edit', answeredBy: memberId, mirrorOf: root });
    expect(await metaOf(root)).toMatchObject({ answeredWith: 'edit', answeredBy: memberId });
    expect(await lastWake(agentId, root)).toEqual(['ask_answered']);
    expect(await lastWake(mirrorBotId, mirror)).toEqual(['ask_answered']);
  });

  it('원본에 먼저 답하면 거울은 그 답으로 닫히고, 뒤늦은 거울 답은 409', async () => {
    const root = await seedAsk({ kind: 'human' });
    const mirror = await seedMirror(root);
    const first = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${root}/ask-answer`,
      headers: auth(adminToken), payload: { optionId: 'new' },
    });
    expect(first.statusCode).toBe(200);
    expect(await metaOf(mirror)).toMatchObject({ answeredWith: 'new', answeredBy: adminId });
    expect(await lastWake(mirrorBotId, mirror)).toEqual(['ask_answered']);

    const late = await app.inject({
      method: 'POST', url: `/channels/${otherChannelId}/messages/${mirror}/ask-answer`,
      headers: auth(memberToken), payload: { optionId: 'edit' },
    });
    expect(late.statusCode).toBe(409);
    // 진 답은 어디에도 남지 않는다.
    expect((await metaOf(root)).answeredWith).toBe('new');
    expect((await metaOf(mirror)).answeredWith).toBe('new');
    expect(await lastWake(agentId, root)).toEqual(['ask_answered']);
  });

  it('에이전트는 거울을 거쳐서도 사람 카드에 답하지 못한다', async () => {
    const root = await seedAsk({ kind: 'human' });
    const mirror = await seedMirror(root);
    const res = await app.inject({
      method: 'POST', url: `/channels/${otherChannelId}/messages/${mirror}/ask-answer`,
      headers: auth(mirrorBotPat), payload: { optionId: 'edit' },
    });
    expect(res.statusCode).toBe(403);
    expect((await metaOf(root)).answeredWith).toBeUndefined();
  });

  it('사람이 거울에서 "답하지 않기로" 하면 원본도 닫힌다', async () => {
    const root = await seedAsk({ kind: 'human' });
    const mirror = await seedMirror(root);
    const res = await app.inject({
      method: 'POST', url: `/channels/${otherChannelId}/messages/${mirror}/ask-close`, headers: auth(memberToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.ask.closedBy).toBe(memberId);
    expect(await metaOf(root)).toMatchObject({ closedBy: memberId, closedReason: 'declined' });
    expect(await lastWake(agentId, root)).toEqual(['ask_closed']);
    expect(await lastWake(mirrorBotId, mirror)).toEqual(['ask_closed']);
  });

  it('거울을 낸 에이전트가 자기 거울을 거두면 원본은 열린 채로 남는다', async () => {
    const root = await seedAsk({ kind: 'human' });
    const mirror = await seedMirror(root);
    const res = await app.inject({
      method: 'POST', url: `/channels/${otherChannelId}/messages/${mirror}/ask-close`, headers: auth(mirrorBotPat),
    });
    expect(res.statusCode).toBe(200);
    const rootAsk = await metaOf(root);
    expect(rootAsk.closedAt).toBeUndefined();
    expect(rootAsk.answeredWith).toBeUndefined();
  });

  it('원본이 닫히면 열린 거울도 닫힌다', async () => {
    const root = await seedAsk({ kind: 'human' });
    const mirror = await seedMirror(root);
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${root}/ask-close`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(await metaOf(mirror)).toMatchObject({ closedBy: adminId, closedReason: 'declined' });
    expect(await lastWake(mirrorBotId, mirror)).toEqual(['ask_closed']);
  });
});
