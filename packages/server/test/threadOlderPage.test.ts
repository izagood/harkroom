import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

/**
 * 스레드의 옛 답글 페이지(`?thread=<루트>&before=<seq>`)와 스레드 안에서 센 `hasMore`.
 *
 * 전에는 스레드 조회가 최신 limit 개만 주고 `hasMore` 는 늘 false 였다 — limit 을 넘는 긴
 * 스레드의 앞부분은 앱에서 볼 길이 없었다. 여기서는 **다른 스레드·최상위 글·다른 채널 글이
 * 사이사이 끼어 있게** 데이터를 세워, 페이지가 그것들을 섞지 않는지를 본다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let token: string;
let channelId: string;
let otherChannelId: string;
let rootId: string;
let otherRootId: string;
const replySeqs: number[] = [];

const auth = () => ({ authorization: `Bearer ${token}` });
const post = async (chId: string, body: string, threadRootId?: string) => {
  const r = await app.inject({
    method: 'POST', url: `/channels/${chId}/messages`, headers: auth(),
    payload: threadRootId ? { body, threadRootId } : { body },
  });
  expect(r.statusCode).toBe(201);
  return r.json() as { id: string; seq: number };
};
const get = async (query: string) => {
  const r = await app.inject({ method: 'GET', url: `/channels/${channelId}/messages?${query}`, headers: auth() });
  expect(r.statusCode).toBe(200);
  return r.json() as { messages: { id: string; seq: number; body: string; threadRootId: string | null }[]; hasMore: boolean };
};

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  token = (await bootstrapAdmin(app)).token;
  const mk = async (name: string) => (await app.inject({
    method: 'POST', url: '/channels', headers: auth(), payload: { name },
  })).json().id as string;
  channelId = await mk('long-thread');
  otherChannelId = await mk('elsewhere');

  rootId = (await post(channelId, '원글')).id;
  otherRootId = (await post(channelId, '다른 스레드 원글')).id;
  // 답글 7개. 사이마다 다른 스레드 답글·최상위 글·다른 채널 글을 끼운다.
  for (let i = 1; i <= 7; i++) {
    replySeqs.push((await post(channelId, `답글 ${i}`, rootId)).seq);
    await post(channelId, `다른 스레드 답글 ${i}`, otherRootId);
    await post(channelId, `최상위 ${i}`);
    await post(otherChannelId, `다른 채널 ${i}`);
  }
});
afterAll(async () => { await app.close(); await stop(); });

describe('스레드 옛 답글 페이지', () => {
  it('첫 페이지는 원글 + 최신 답글 limit 개, 앞에 답글이 남았으면 hasMore', async () => {
    const page = await get(`thread=${rootId}&limit=3`);
    expect(page.messages.map((m) => m.body)).toEqual(['원글', '답글 5', '답글 6', '답글 7']);
    expect(page.hasMore).toBe(true);
  });

  it('before 로 그 스레드의 더 오래된 답글만 받는다 — 다른 스레드·최상위·다른 채널 글은 섞이지 않는다', async () => {
    const second = await get(`thread=${rootId}&limit=3&before=${replySeqs[4]}`);
    expect(second.messages.map((m) => m.body)).toEqual(['답글 2', '답글 3', '답글 4']);
    expect(second.messages.every((m) => m.threadRootId === rootId)).toBe(true);
    expect(second.hasMore).toBe(true);

    const last = await get(`thread=${rootId}&limit=3&before=${replySeqs[1]}`);
    expect(last.messages.map((m) => m.body)).toEqual(['답글 1']);
    expect(last.hasMore).toBe(false);
  });

  it('옛 클라이언트(limit 안 넘김·before 없음)는 전과 같은 응답을 받는다 — 짧은 스레드는 hasMore false', async () => {
    const page = await get(`thread=${rootId}`);
    expect(page.messages.map((m) => m.body)).toEqual(['원글', ...replySeqs.map((_, i) => `답글 ${i + 1}`)]);
    expect(page.hasMore).toBe(false);
  });

  it('since(증분)·around(점프)는 과거를 말하지 않는다 — hasMore false', async () => {
    expect((await get(`thread=${rootId}&since=${replySeqs[5]}`)).hasMore).toBe(false);
    expect((await get(`thread=${rootId}&around=${replySeqs[3]}&limit=2`)).hasMore).toBe(false);
  });

  it('채널 조회의 hasMore 는 그대로다', async () => {
    const page = await get('limit=2');
    expect(page.hasMore).toBe(true);
  });
});
