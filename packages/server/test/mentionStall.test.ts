import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { STALL_HOP_LIMIT } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * **정체 홉 그림자**(146, 연쇄 한도 재설계 ②). 새 결과물 없이 이어진 에이전트 홉이 `STALL_HOP_LIMIT` 에 닿으면 그 부름을
 * `meta.mentionStallShadow` 에 남긴다 — **막지는 않는다**(그림자 단계). 결과물이 나오면 셈은 0 으로 돌아간다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let channelId: string;
const agents: Record<string, { id: string; pat: string }> = {};
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function post(token: string, body: string, threadRootId?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token),
    payload: threadRootId ? { body, threadRootId } : { body },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function metaOf(id: string): Promise<Record<string, unknown>> {
  return ((await app.inject({ method: 'GET', url: `/messages/${id}`, headers: auth(adminToken) })).json().meta ?? {}) as Record<string, unknown>;
}

async function woke(token: string, id: string): Promise<boolean> {
  const entries = (await app.inject({ method: 'GET', url: '/inbox', headers: auth(token) })).json().entries as { messageId: string }[];
  return entries.some((e) => e.messageId === id);
}

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  // 깊이 상한이 먼저 막지 않게 최댓값으로 둔다 — 이 파일은 정체 셈만 본다.
  await app.inject({ method: 'PUT', url: '/settings/mention-policy', headers: auth(adminToken), payload: { chainLimit: 50 } });
  for (const h of ['ada', 'bob']) {
    const made = await createAgent(app, adminToken, h);
    agents[h] = { id: made.accountId, pat: made.pat };
  }
  channelId = (await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'stalltalk', visibility: 'public' },
  })).json().id as string;
});

afterAll(async () => { await app.close(); await stop(); });

describe(`정체 홉 그림자(한도 ${STALL_HOP_LIMIT})`, () => {
  it('결과물 없는 핑퐁은 한도에서 기록되지만 부름은 그대로 간다', async () => {
    const root = await post(adminToken, '@ada 시작');
    let last = '';
    const turns: Array<['ada' | 'bob', 'ada' | 'bob']> = [['ada', 'bob'], ['bob', 'ada'], ['ada', 'bob'], ['bob', 'ada']];
    for (const [i, [author, next]] of turns.entries()) {
      last = await post(agents[author]!.pat, `@${next} 이미 봤다`, root);
      const shadow = (await metaOf(last)).mentionStallShadow;
      if (i + 1 < STALL_HOP_LIMIT) expect(shadow).toBeUndefined();
    }
    expect((await metaOf(last)).mentionStallShadow).toEqual({ wouldCap: [agents.ada!.id], stallDepth: STALL_HOP_LIMIT, limit: STALL_HOP_LIMIT });
    expect(await woke(agents.ada!.pat, last)).toBe(true);
  });

  it('새 결과물을 내는 홉은 셈을 0 으로 되돌린다 — 정상 협업은 한도에 닿지 않는다', async () => {
    const root = await post(adminToken, '@ada 구현');
    let last = '';
    for (let n = 0; n < STALL_HOP_LIMIT * 2; n++) {
      const [author, next] = n % 2 === 0 ? ['ada', 'bob'] : ['bob', 'ada'];
      last = await post(agents[author]!.pat, `@${next} #${2000 + n} head ab${n}cdef12 올림`, root);
      expect((await metaOf(last)).mentionStallShadow).toBeUndefined();
    }
  });

  it('같은 sha 를 되풀이하는 메아리는 결과물이 아니다', async () => {
    const root = await post(adminToken, '@ada 확인');
    let last = '';
    for (let n = 0; n < STALL_HOP_LIMIT; n++) {
      const [author, next] = n % 2 === 0 ? ['ada', 'bob'] : ['bob', 'ada'];
      last = await post(agents[author]!.pat, `@${next} head 4c3e7f2a 확인함`, root);
    }
    // 첫 홉은 sha 를 처음 냈으니 0, 그 뒤 셋이 정체다 — 한도 4 에는 한 홉 모자란다.
    expect((await metaOf(last)).mentionStallShadow).toBeUndefined();
    const more = await post(agents.ada!.pat, '@bob head 4c3e7f2a 확인함', root);
    expect((await metaOf(more)).mentionStallShadow).toMatchObject({ stallDepth: STALL_HOP_LIMIT });
  });

  it('서로의 앞 글 링크·맨 uuid 만 다는 핑퐁은 결과물이 아니다 — 정체로 센다(⑤)', async () => {
    const root = await post(adminToken, '@ada 링크 핑퐁');
    let last = root;
    for (let n = 0; n < STALL_HOP_LIMIT; n++) {
      const [author, next] = n % 2 === 0 ? ['ada', 'bob'] : ['bob', 'ada'];
      last = await post(agents[author]!.pat, `@${next} 앞 글 harkroom://message/${last} · 턴 ${crypto.randomUUID()}`, root);
    }
    expect((await metaOf(last)).mentionStallShadow).toMatchObject({ stallDepth: STALL_HOP_LIMIT });
  });

  it('다른 스레드 글 링크만으로 풀린 홉에는 그림자 표지가 선다(⑤)', async () => {
    const elsewhere = await post(adminToken, '다른 대화');
    const root = await post(adminToken, '@ada 바깥 링크');
    const id = await post(agents.ada!.pat, `@bob 저쪽 harkroom://message/${elsewhere}`, root);
    expect((await metaOf(id)).mentionStallLinkReset).toBe(true);
    const plain = await post(agents.bob!.pat, '@ada #4100 올림', root);
    expect((await metaOf(plain)).mentionStallLinkReset).toBeUndefined();
  });
});
