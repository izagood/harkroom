import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'reacts' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const post = async (body: string, token = adminToken) => {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body },
  });
  return res.json().id as string;
};

const react = (messageId: string, emoji: string, token = adminToken) =>
  app.inject({
    method: 'PUT',
    url: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    headers: auth(token),
  });

const unreact = (messageId: string, emoji: string, token = adminToken) =>
  app.inject({
    method: 'DELETE',
    url: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    headers: auth(token),
  });

const list = async (token = adminToken) => {
  const res = await app.inject({
    method: 'GET', url: `/channels/${channelId}/messages`, headers: auth(token),
  });
  return res.json().messages as Array<{ id: string; reactions: Array<{ emoji: string; accountIds: string[] }> }>;
};

const reactionsOf = async (messageId: string, token = adminToken) =>
  (await list(token)).find((m) => m.id === messageId)!.reactions;

describe('reacting to a message', () => {
  it('records who reacted with what', async () => {
    const id = await post('리액션 대상');

    const res = await react(id, '👀');

    expect(res.statusCode).toBe(200);
    expect(await reactionsOf(id)).toEqual([{ emoji: '👀', accountIds: [adminId] }]);
  });

  // 같은 사람이 같은 이모지를 두 번 눌러도 2가 되면 안 된다 — 더블클릭이나 재전송으로 흔히 생긴다.
  it('counts one person once no matter how many times they press', async () => {
    const id = await post('두 번 누른다');

    await react(id, '👀');
    await react(id, '👀');

    expect((await reactionsOf(id))[0]!.accountIds).toEqual([adminId]);
  });

  it('gathers different people under the same emoji', async () => {
    const id = await post('둘이 누른다');
    const { pat } = await createAgent(app, adminToken, 'reactor');

    await react(id, '👀');
    await react(id, '👀', pat);

    expect((await reactionsOf(id))[0]!.accountIds).toHaveLength(2);
  });

  it('keeps different emoji apart', async () => {
    const id = await post('두 종류');

    await react(id, '👀');
    await react(id, '💬');

    expect((await reactionsOf(id)).map((r) => r.emoji).sort()).toEqual(['👀', '💬']);
  });

  it('removes only the caller’s own reaction', async () => {
    const id = await post('하나만 뗀다');
    const { pat } = await createAgent(app, adminToken, 'stays');
    await react(id, '👀');
    await react(id, '👀', pat);

    const res = await unreact(id, '👀');

    expect(res.statusCode).toBe(204);
    expect((await reactionsOf(id))[0]!.accountIds).not.toContain(adminId);
    expect((await reactionsOf(id))[0]!.accountIds).toHaveLength(1);
  });

  // 마지막 사람이 떼면 칩 자체가 사라져야 한다 — 0 이 적힌 칩이 남으면 UI 가 거짓말을 한다.
  it('drops the emoji entirely when the last person removes it', async () => {
    const id = await post('마지막 하나');
    await react(id, '👀');

    await unreact(id, '👀');

    expect(await reactionsOf(id)).toEqual([]);
  });

  it('is fine with removing a reaction that was never there', async () => {
    const id = await post('없는 것을 뗀다');

    expect((await unreact(id, '👀')).statusCode).toBe(204);
  });

  it('reports no reactions as an empty list, not a missing field', async () => {
    const id = await post('아무도 안 눌렀다');

    expect(await reactionsOf(id)).toEqual([]);
  });
});

describe('reactions on the message the server hands back', () => {
  // POST 응답이 곧 클라이언트의 첫 상태다. 필드가 없으면 UI 가 undefined 를 만진다.
  it('gives a new message an empty reaction list', async () => {
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: auth(adminToken), payload: { body: '갓 만든 메시지' },
    });

    expect(res.json().reactions).toEqual([]);
  });

  // 수정 응답은 WS message.updated 로도 나간다. 빈 배열을 실으면 받는 쪽이 리액션을 지운다.
  it('keeps the reactions on a message that was edited', async () => {
    const id = await post('고칠 메시지');
    await react(id, '👀');

    const res = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/messages/${id}`,
      headers: auth(adminToken), payload: { body: '고친 본문' },
    });

    expect(res.json().reactions).toEqual([{ emoji: '👀', accountIds: [adminId] }]);
  });
});

// idempotency 재생은 메시지를 내주는 네 번째 경로다. 재시도한 클라이언트가 리액션 없는
// 메시지를 받으면 화면에서 리액션이 사라진다.
describe('an idempotent retry', () => {
  it('replays the message with its reactions intact', async () => {
    const first = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { ...auth(adminToken), 'idempotency-key': 'retry-1' }, payload: { body: '재시도 대상' },
    });
    await react(first.json().id, '👀');

    const replay = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { ...auth(adminToken), 'idempotency-key': 'retry-1' }, payload: { body: '재시도 대상' },
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.json().reactions).toEqual([{ emoji: '👀', accountIds: [adminId] }]);
  });
});

describe('what may be a reaction', () => {
  // 임의 문자열을 받으면 리액션이 본문 우회 채널이 된다 — 길이 제한도 없는 두 번째 메시지 필드다.
  it('refuses text dressed up as a reaction', async () => {
    const id = await post('텍스트 리액션');

    expect((await react(id, 'lgtm')).statusCode).toBe(400);
  });

  it('refuses an empty reaction', async () => {
    const id = await post('빈 리액션');

    const res = await app.inject({
      method: 'PUT', url: `/channels/${channelId}/messages/${id}/reactions/`, headers: auth(adminToken),
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('accepts a multi-codepoint emoji', async () => {
    const id = await post('가족 이모지');

    expect((await react(id, '👨‍👩‍👧')).statusCode).toBe(200);
  });

  // 한 사람이 메시지 하나에 수백 개를 달면 저장소와 화면이 다 망가진다.
  it('caps how many different emoji one person can put on one message', async () => {
    const id = await post('무제한 리액션');
    const emojis = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊',
      '😋', '😎', '😍', '😘', '😗', '😙', '😚', '🙂', '🤗', '🤩'];
    for (const e of emojis) expect((await react(id, e)).statusCode).toBe(200);

    expect((await react(id, '🤔')).statusCode).toBe(409);
  });
});

describe('who may react', () => {
  it('refuses a reaction to a message in a dm the caller is not in', async () => {
    const { accountId: aId, pat: aPat } = await createAgent(app, adminToken, 'dmpair');
    const { pat: outsiderPat } = await createAgent(app, adminToken, 'outsider');
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: auth(adminToken), payload: { accountIds: [aId] },
    });
    const dmId = dm.json().id as string;
    const msg = await app.inject({
      method: 'POST', url: `/channels/${dmId}/messages`, headers: auth(aPat), payload: { body: '비밀' },
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${dmId}/messages/${msg.json().id}/reactions/${encodeURIComponent('👀')}`,
      headers: auth(outsiderPat),
    });

    expect(res.statusCode).toBe(403);
  });

  it('404s for a message that is not in the given channel', async () => {
    const other = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'elsewhere' },
    });
    const id = await post('여기 있는 메시지');

    const res = await app.inject({
      method: 'PUT',
      url: `/channels/${other.json().id}/messages/${id}/reactions/${encodeURIComponent('👀')}`,
      headers: auth(adminToken),
    });

    expect(res.statusCode).toBe(404);
  });

  // 삭제된 메시지는 목록에서 사라진다. 거기에 리액션이 붙으면 되살아난 것처럼 보인다.
  it('404s for a deleted message', async () => {
    const id = await post('지워질 메시지');
    await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/messages/${id}`, headers: auth(adminToken),
    });

    expect((await react(id, '👀')).statusCode).toBe(404);
  });
});
