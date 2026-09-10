import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * **부름과 지칭**(2026-09-09). 규칙과 근거는 `shared/splitMentionCalls` 에 있다.
 *
 * 사고의 모양: murmur 가 사람에게 하는 보고 한가운데 "구현은 `@forge` 것이고" 라고 적었을
 * 뿐인데 forge 의 턴이 떴고, forge 의 답이 다시 murmur 를 가리켜 5분에 네 턴이 오갔다.
 * 그날 dev DB 의 에이전트→에이전트 멘션 122건 중 47건이 부를 뜻 없는 지칭이었다.
 *
 * 이 회귀선은 **서버를 통과한다** — `inbox` 행을 센다(`mentionChain.test.ts` 와 같은 이유:
 * 러너는 inbox 를 폴하므로 "행이 없다"가 곧 "턴이 뜨지 않는다"이다).
 *
 * 규칙이 **좁은 것**을 지키는 데 절반을 쓴다. 사람이 쓴 멘션과 사람에게 가는 멘션은 하나도
 * 바뀌지 않아야 한다 — 여기가 새면 이 변경은 사람의 부름을 삼키는 버그가 된다.
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
  for (const handle of ['ada', 'bob']) {
    const made = await createAgent(app, adminToken, handle);
    agents[handle] = { id: made.accountId, pat: made.pat };
  }
  const chan = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken),
    payload: { name: 'refs', visibility: 'public' },
  });
  expect(chan.statusCode).toBe(201);
  channelId = chan.json().id as string;
});

afterAll(async () => { await app.close(); await stop(); });

describe('에이전트가 동료를 지칭한 것은 부르는 것이 아니다', () => {
  it('본문 한가운데의 `@동료` 는 턴을 띄우지 않고, 그 사실이 메시지에 남는다', async () => {
    const said = await post(agents.ada!.pat, '@admin 구현은 @bob 것이고 나는 상태만 재 봤다');
    // 이 한 줄이 사고의 본체다 — 고치기 전에는 `['mention']` 이었다.
    expect(await inboxFor(agents.bob!.pat, said)).toEqual([]);
    // 조용히 사라지지 않는다: 화면이 그 이름을 칩이 아닌 이름으로 그릴 근거다.
    expect(await metaOf(said)).toMatchObject({ mentionRefs: [agents.bob!.id] });
  });

  it('머리 런의 `@동료` 는 그대로 부른다 — 일을 넘기는 길은 막지 않는다', async () => {
    const said = await post(agents.ada!.pat, '@bob 이어서 해 줘');
    expect(await inboxFor(agents.bob!.pat, said)).toEqual(['mention']);
    expect(await metaOf(said)).not.toHaveProperty('mentionRefs');
  });

  it('머리와 본문에 함께 나오면 부름이다 — 다시 언급했다고 호출이 취소되지 않는다', async () => {
    const said = await post(agents.ada!.pat, '@bob 이어서. 앞 단계는 @bob 이 했다');
    expect(await inboxFor(agents.bob!.pat, said)).toEqual(['mention']);
    expect(await metaOf(said)).not.toHaveProperty('mentionRefs');
  });

  it('에이전트 → 사람은 자리와 무관하게 부른다 — 사람을 부르는 것은 막을 이유가 없다', async () => {
    const said = await post(agents.ada!.pat, '정리하면 @admin 판단이 필요하다');
    expect(await inboxFor(adminToken, said)).toEqual(['mention']);
    expect(await metaOf(said)).not.toHaveProperty('mentionRefs');
  });

  it('**사람이 쓴 것은 자리와 무관하게 부른다** — 이 규칙이 사람에게 새면 안 된다', async () => {
    const said = await post(adminToken, '이거 @ada 가 좀 봐 줘');
    expect(await inboxFor(agents.ada!.pat, said)).toEqual(['mention']);
    expect(await metaOf(said)).not.toHaveProperty('mentionRefs');
  });

  it('지칭은 연쇄의 고리가 아니다 — 지칭만 오간 스레드는 깊이를 쌓지 않는다', async () => {
    // 사람(0) → ada(1). ada 가 bob 을 지칭만 하면 bob 은 오지 않고, 사람이 다시 부른
    // ada 의 다음 발화도 깊이 1 이다. 깊이가 쌓이면 상한이 이유 없이 일찍 닫힌다.
    const root = await post(adminToken, '@ada 시작');
    await post(agents.ada!.pat, '@admin 앞 단계는 @bob 것이다', root);
    await post(adminToken, '@ada 계속해', root);
    const again = await post(agents.ada!.pat, '@bob 이제 네 차례다', root);
    expect(await inboxFor(agents.bob!.pat, again)).toEqual(['mention']);
    expect(await metaOf(again)).not.toHaveProperty('mentionChainCapped');
  });

  /*
    **주소 안의 이름**(2026-09-10, jaebin 신고). 위 규칙은 에이전트 작성자만 좁히므로 사람이
    붙여넣은 링크에는 걸리지 않는다 — 그 갈래를 `shared/linkSpans` 가 막고, 이 회귀선이
    서버를 통과해 그 사실을 센다.
  */
  it('**사람이 붙여넣은 주소 안의 이름은 부르지 않는다** — 링크가 턴을 띄우면 안 된다', async () => {
    const said = await post(adminToken, '이거 봐 https://x.com/@ada/status/1');
    expect(await inboxFor(agents.ada!.pat, said)).toEqual([]);
    // 지칭조차 아니다 — 애초에 이름으로 읽지 않았다.
    expect(await metaOf(said)).not.toHaveProperty('mentionRefs');
  });

  it('주소 **밖**의 이름은 그대로 부른다 — 같은 줄에 링크가 있어도 다르지 않다', async () => {
    const said = await post(adminToken, 'https://x.com/@bob 이거 @ada 가 봐 줘');
    expect(await inboxFor(agents.ada!.pat, said)).toEqual(['mention']);
    expect(await inboxFor(agents.bob!.pat, said)).toEqual([]);
  });

  it('자기 자신을 지칭한 것은 meta 에 남기지 않는다 — 작성자는 애초에 대상이 아니다', async () => {
    const said = await post(agents.ada!.pat, '@admin 그건 @ada 가 이미 했다');
    expect(await metaOf(said)).not.toHaveProperty('mentionRefs');
  });
});
