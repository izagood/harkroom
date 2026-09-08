import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MENTION_CHAIN_LIMIT } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * **멘션 연쇄 깊이 상한**(Agents 관제 4단계).
 *
 * 사고의 모양: 에이전트의 답에는 서로를 부른 `@handle` 이 들어 있고, 그 답이 다시 호출로
 * 읽히면 한 스레드에서 턴이 스스로 이어진다. 1단계(#683)가 그것을 보이게 하고 2단계(#685)가
 * 붙여넣기 쪽을 막았지만, **에이전트가 스스로 이어 가는 연쇄**에는 상한이 없었다.
 *
 * 이 회귀선은 **서버를 통과한다** — `inbox` 행을 센다. 러너는 inbox 를 폴하므로 "행이
 * 없다"가 곧 "턴이 뜨지 않는다"이고, 그것이 이 기능의 정의다.
 *
 * 지키는 것 셋:
 * 1. 상한까지는 정상으로 이어진다(사람 → A → B → C 는 평범한 위임이다).
 * 2. 상한에 닿으면 **에이전트만** 막히고 사람은 계속 불린다.
 * 3. **사람이 끼어들면 깊이가 다시 0** 이다 — 상한이 스레드를 영구히 잠그지 않는다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let channelId: string;
const agents: Record<string, { id: string; pat: string }> = {};

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** 그 계정 자격으로 스레드에 한 줄 올린다. 반환은 메시지 id. */
async function post(token: string, body: string, threadRootId?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token),
    payload: threadRootId ? { body, threadRootId } : { body },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** 이 메시지가 그 계정의 inbox 에 남긴 사유들. 빈 배열이 곧 "부르지 않았다"다. */
async function inboxFor(token: string, messageId: string): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: '/inbox', headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return (res.json().entries as Array<{ reason: string; messageId: string }>)
    .filter((e) => e.messageId === messageId).map((e) => e.reason);
}

async function metaOf(messageId: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: `/messages/${messageId}`, headers: auth(adminToken) });
  expect(res.statusCode).toBe(200);
  return (res.json().meta ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  // 상한(4)보다 한 걸음 더 갈 수 있어야 상한이 실제로 닫히는 것을 볼 수 있다.
  for (const handle of ['ada', 'bob', 'cid', 'dee', 'eve']) {
    const made = await createAgent(app, adminToken, handle);
    agents[handle] = { id: made.accountId, pat: made.pat };
  }
  const chan = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken),
    payload: { name: 'chaintalk', visibility: 'public' },
  });
  expect(chan.statusCode).toBe(201);
  channelId = chan.json().id as string;
});

afterAll(async () => { await app.close(); await stop(); });

describe(`연쇄 깊이 상한 ${MENTION_CHAIN_LIMIT} (4단계)`, () => {
  it('상한 전까지는 이어진다 — 사람 → A → B 는 평범한 위임이다', async () => {
    const root = await post(adminToken, '@ada 이거 봐 줘');
    expect(await inboxFor(agents.ada!.pat, root)).toEqual(['mention']);
    // 깊이 1: ada 를 부른 것은 사람(0)이다.
    const first = await post(agents.ada!.pat, '@bob 확인 부탁', root);
    expect(await inboxFor(agents.bob!.pat, first)).toEqual(['mention']);
    expect(await metaOf(first)).not.toHaveProperty('mentionChainCapped');
  });

  it('상한에 닿으면 에이전트를 부르지 못하고, 그 사실이 메시지에 남는다', async () => {
    const root = await post(adminToken, '@ada 시작해');
    let last = root;
    // 사람(0) → ada(1) → bob(2) → cid(3) → dee(4). dee 의 발화가 상한에 닿는다.
    const chain: Array<[string, string]> = [['ada', 'bob'], ['bob', 'cid'], ['cid', 'dee']];
    for (const [author, next] of chain) {
      last = await post(agents[author]!.pat, `@${next} 이어서`, root);
      expect(await inboxFor(agents[next]!.pat, last)).toEqual(['mention']);
    }
    const capped = await post(agents.dee!.pat, '@eve 이어서', root);
    // **턴이 뜨지 않는다** — 러너는 inbox 를 폴하므로 행이 없다는 것이 그 뜻이다.
    expect(await inboxFor(agents.eve!.pat, capped)).toEqual([]);
    // 조용히 사라지지 않는다: 무엇이 막혔는지와 상한값이 그 메시지에 남는다.
    const meta = await metaOf(capped);
    expect(meta.mentionChainCapped).toEqual(['eve']);
    expect(meta.mentionChainLimit).toBe(MENTION_CHAIN_LIMIT);
  });

  it('상한에 닿아도 사람은 계속 불린다 — 그때가 사람이 필요한 순간이다', async () => {
    const root = await post(adminToken, '@ada 다시 시작');
    let last = root;
    for (const [author, next] of [['ada', 'bob'], ['bob', 'cid'], ['cid', 'dee']] as Array<[string, string]>) {
      last = await post(agents[author]!.pat, `@${next} 이어서`, root);
    }
    const capped = await post(agents.dee!.pat, '@eve 이어서 @admin 봐 주세요', root);
    expect(await inboxFor(agents.eve!.pat, capped)).toEqual([]);
    // 사람(admin)은 그대로 불린다 — 막힌 것은 기계 쪽 연쇄뿐이다.
    expect(await inboxFor(adminToken, capped)).toContain('mention');
  });

  it('사람이 끼어들면 깊이가 다시 0 이다 — 상한이 스레드를 영구히 잠그지 않는다', async () => {
    const root = await post(adminToken, '@ada 세 번째 시작');
    for (const [author, next] of [['ada', 'bob'], ['bob', 'cid'], ['cid', 'dee']] as Array<[string, string]>) {
      await post(agents[author]!.pat, `@${next} 이어서`, root);
    }
    // 사람이 한 줄 넣는다 — 이 줄의 깊이는 0 이고, 이 줄이 부른 dee 의 다음 발화는 1 이다.
    await post(adminToken, '@dee 여기서 이어 가자', root);
    const revived = await post(agents.dee!.pat, '@eve 이어서', root);
    expect(await inboxFor(agents.eve!.pat, revived)).toEqual(['mention']);
    expect(await metaOf(revived)).not.toHaveProperty('mentionChainCapped');
  });

  it('사람의 발화는 몇 번째든 상한에 걸리지 않는다 — 사람은 연쇄의 고리가 아니다', async () => {
    const root = await post(adminToken, '@ada 네 번째 시작');
    for (const [author, next] of [['ada', 'bob'], ['bob', 'cid'], ['cid', 'dee']] as Array<[string, string]>) {
      await post(agents[author]!.pat, `@${next} 이어서`, root);
    }
    const byHuman = await post(adminToken, '@eve 사람이 부른다', root);
    expect(await inboxFor(agents.eve!.pat, byHuman)).toEqual(['mention']);
  });
});
