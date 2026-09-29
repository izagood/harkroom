import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MENTION_CHAIN_LIMIT } from '@harkroom/shared';
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
let mcpUrl: string;
/**
 * 이 파일의 사슬은 **상한 4** 로 짠다(078 이전의 상수). 기본값은 8 이지만 사슬마다 여덟
 * 고리를 쓰면 무엇을 지키는지가 흐려진다 — 상한을 설정으로 낮추는 것 자체가 설정 표면의
 * 회귀선이기도 하다.
 */
const TEST_LIMIT = 4;
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
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
  const before = await app.inject({ method: 'GET', url: '/settings/mention-policy', headers: auth(adminToken) });
  expect(before.json()).toEqual({ chainLimit: MENTION_CHAIN_LIMIT });
  const set = await app.inject({
    method: 'PUT', url: '/settings/mention-policy', headers: auth(adminToken), payload: { chainLimit: TEST_LIMIT },
  });
  expect(set.statusCode).toBe(200);
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

describe(`연쇄 깊이 상한 ${TEST_LIMIT} (4단계)`, () => {
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
    expect(meta.mentionChainLimit).toBe(TEST_LIMIT);
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

  /**
   * **다른 스레드의 옛 부름이 새 대화의 앞 고리가 되면 안 된다**(2026-09-14 실측).
   *
   * 깊이 스캔은 `thread_root_id` 로 좁히는데, 최상위 발화(`threadRootId` 없음)에서는 그
   * 조건이 통째로 비어 채널 전체 최근 50개를 훑었다. 그래서 한 스레드에서 에이전트가
   * 나를 부른 답(깊이 3)이 있으면, **같은 채널에 새로 여는 대화**가 깊이 4로 시작해
   * 곧바로 막혔다 — 사람이 새 턴을 띄워 줘도 깊이는 채널 이력에서 오므로 소용없었다.
   *
   * 실제로 이것 때문에 e2e 가 멈췄다: 한 에이전트를 시험한 채널에서 다른 에이전트를
   * 부르지 못했다.
   */
  it('다른 스레드에서 쌓인 깊이가 새 최상위 대화를 막지 않는다', async () => {
    // 스레드 하나에서 상한 직전까지 쌓는다 — **마지막 발화가 ada 를 깊이 3 으로 부른다.**
    // 이 깊이가 중요하다: 3 이어야 옛 코드가 새 대화를 4(상한)로 시작해 막는다. 2 면
    // 옛 코드로도 통과해 이 회귀선에 이빨이 없다(실제로 그렇게 썼다가 뮤테이션 검사에서
    // 드러났다 — 고치기 전 코드로도 초록이었다).
    const root = await post(adminToken, '@ada 깊은 스레드');          // 0
    await post(agents.ada!.pat, '@bob 이어서', root);                  // 1
    await post(agents.bob!.pat, '@cid 이어서', root);                  // 2
    const deep = await post(agents.cid!.pat, '@ada 다시 너에게', root); // 3
    expect(await inboxFor(agents.ada!.pat, deep)).toEqual(['mention']);

    // 이제 ada 가 **같은 채널에 새 대화**를 연다(스레드가 아니라 최상위). 위 스레드와
    // 아무 상관이 없으므로 깊이는 0 에서 시작해야 하고, eve 는 불려야 한다.
    const fresh = await post(agents.ada!.pat, '@eve 새 대화다');
    expect(await inboxFor(agents.eve!.pat, fresh)).toEqual(['mention']);
    expect(await metaOf(fresh)).not.toHaveProperty('mentionChainCapped');
  });

  it('최상위끼리의 연쇄는 그대로 막힌다 — 스레드를 안 쓰면 빠져나가는 길이 되면 안 된다', async () => {
    // 위 수정이 "최상위는 늘 깊이 0" 이었다면 폭주를 최상위로 옮기기만 하면 되는 셈이다.
    // 그래서 **최상위 발화들끼리는** 여전히 고리로 이어지는지 따로 못 박는다.
    const a = await post(adminToken, '@ada 최상위 시작');      // 0
    expect(await inboxFor(agents.ada!.pat, a)).toEqual(['mention']);
    const b = await post(agents.ada!.pat, '@bob 최상위로 넘긴다');   // 1
    expect(await inboxFor(agents.bob!.pat, b)).toEqual(['mention']);
    const c = await post(agents.bob!.pat, '@cid 최상위로 넘긴다');   // 2
    expect(await inboxFor(agents.cid!.pat, c)).toEqual(['mention']);
    const d = await post(agents.cid!.pat, '@dee 최상위로 넘긴다');   // 3
    expect(await inboxFor(agents.dee!.pat, d)).toEqual(['mention']);
    const capped = await post(agents.dee!.pat, '@eve 최상위로 넘긴다'); // 4 — 상한
    expect(await inboxFor(agents.eve!.pat, capped)).toEqual([]);
    expect((await metaOf(capped)).mentionChainCapped).toEqual(['eve']);
  });

  it('사람의 발화는 몇 번째든 상한에 걸리지 않는다 — 사람은 연쇄의 고리가 아니다', async () => {
    const root = await post(adminToken, '@ada 네 번째 시작');
    for (const [author, next] of [['ada', 'bob'], ['bob', 'cid'], ['cid', 'dee']] as Array<[string, string]>) {
      await post(agents[author]!.pat, `@${next} 이어서`, root);
    }
    const byHuman = await post(adminToken, '@eve 사람이 부른다', root);
    expect(await inboxFor(agents.eve!.pat, byHuman)).toEqual(['mention']);
  });

  /**
   * **깨운 적 없는 부름은 고리가 아니다**(2026-09-29). 본문만 다시 파싱하던 동안에는 상한에
   * 막힌 부름도 "eve 를 부른 메시지"로 보여, 불리지도 않은 eve 의 다음 발화가 깊이 5 로
   * 시작해 곧바로 막혔다. 막힌 부름이 깊이를 쌓으면 한 번 막힌 스레드는 사람이 나설 때까지
   * 아무도 못 부른다.
   */
  it('상한에 막힌 부름은 다음 깊이를 올리지 않는다', async () => {
    const root = await post(adminToken, '@ada 다섯 번째 시작');
    for (const [author, next] of [['ada', 'bob'], ['bob', 'cid'], ['cid', 'dee']] as Array<[string, string]>) {
      await post(agents[author]!.pat, `@${next} 이어서`, root);
    }
    const capped = await post(agents.dee!.pat, '@eve 이어서', root);
    expect((await metaOf(capped)).mentionChainCapped).toEqual(['eve']);
    // eve 는 깨지 않았다 — 그러니 eve 가 스스로 올린 말은 사슬의 고리가 아니다(깊이 0).
    const byEve = await post(agents.eve!.pat, '@ada 따로 할 말이 있다', root);
    expect(await inboxFor(agents.ada!.pat, byEve)).toEqual(['mention']);
    expect(await metaOf(byEve)).not.toHaveProperty('mentionChainCapped');
  });

  it('상한에 막히면 MCP 결과가 발화한 에이전트에게 그 사실을 말한다', async () => {
    const root = await post(adminToken, '@ada 여섯 번째 시작');
    for (const [author, next] of [['ada', 'bob'], ['bob', 'cid'], ['cid', 'dee']] as Array<[string, string]>) {
      await post(agents[author]!.pat, `@${next} 이어서`, root);
    }
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: auth(agents.dee!.pat) },
    }));
    try {
      const res = await client.callTool({
        name: 'message.post', arguments: { channelId, threadRootId: root, body: '@eve 이어서' },
      });
      const out = JSON.parse((res.content as { type: string; text: string }[])[0]!.text) as Record<string, unknown>;
      // 스레드를 연 사람(admin)은 답글 알림을 받는다 — 빠진 것은 eve 다.
      expect(out.notified).not.toContain(agents.eve!.id);
      // 조용히 끊기지 않는다: 누구를, 왜 못 불렀는지와 다음 할 일이 맨 앞에 온다.
      expect(Object.keys(out)[0]).toBe('warnings');
      const warnings = out.warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('@eve');
      expect(warnings[0]).toContain(`상한 ${TEST_LIMIT}`);
    } finally {
      await client.close();
    }
  });

  it('막히지 않은 발화의 MCP 결과에는 경고가 없다', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: auth(agents.ada!.pat) },
    }));
    try {
      const root = await post(adminToken, '@ada 일곱 번째 시작');
      const res = await client.callTool({
        name: 'message.post', arguments: { channelId, threadRootId: root, body: '@bob 확인 부탁' },
      });
      const out = JSON.parse((res.content as { type: string; text: string }[])[0]!.text) as Record<string, unknown>;
      expect(out).not.toHaveProperty('warnings');
      expect(out.notified).toContain(agents.bob!.id);
    } finally {
      await client.close();
    }
  });
});

describe('상한 설정 표면(/settings/mention-policy)', () => {
  it('누구나 읽고 admin 만 바꾼다', async () => {
    const read = await app.inject({ method: 'GET', url: '/settings/mention-policy', headers: auth(agents.ada!.pat) });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ chainLimit: TEST_LIMIT });
    const put = await app.inject({
      method: 'PUT', url: '/settings/mention-policy', headers: auth(agents.ada!.pat), payload: { chainLimit: 20 },
    });
    expect(put.statusCode).toBe(403);
  });

  it('범위 밖의 값은 거절한다 — 0 이면 아무도 못 부르고, 너무 크면 상한이 아니다', async () => {
    for (const chainLimit of [0, 51, 2.5]) {
      const res = await app.inject({
        method: 'PUT', url: '/settings/mention-policy', headers: auth(adminToken), payload: { chainLimit },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('바꾼 값이 곧바로 판정과 meta 에 실린다', async () => {
    const put = await app.inject({
      method: 'PUT', url: '/settings/mention-policy', headers: auth(adminToken), payload: { chainLimit: 2 },
    });
    expect(put.json()).toEqual({ chainLimit: 2 });
    try {
      const root = await post(adminToken, '@ada 상한 2');
      await post(agents.ada!.pat, '@bob 이어서', root);            // 1
      const capped = await post(agents.bob!.pat, '@cid 이어서', root); // 2 — 상한
      expect(await inboxFor(agents.cid!.pat, capped)).toEqual([]);
      expect((await metaOf(capped)).mentionChainLimit).toBe(2);
    } finally {
      await app.inject({
        method: 'PUT', url: '/settings/mention-policy', headers: auth(adminToken), payload: { chainLimit: TEST_LIMIT },
      });
    }
  });
});

/**
 * **턴의 원인에서 깊이를 물려받는다**(2026-09-29). jaebin 이 #task 의 task_manager 한 곳에만
 * 말하면, task_manager 가 담당을 부르는 작업 스레드에는 사람의 글이 없다. 스레드를 훑는 셈으로는
 * 두 번 왕복하면 반드시 막혔다(#harkroom seq 3336). 러너는 턴을 띄운 메시지를 안다 — 브릿지·
 * 오퍼레이터를 거쳐 `x-harkroom-cause` 로 온다.
 */
describe('턴의 원인(x-harkroom-cause)', () => {
  async function postVia(pat: string, cause: string | null, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { ...auth(pat), ...(cause ? { 'x-harkroom-cause': cause } : {}) } },
    }));
    try {
      const res = await client.callTool({ name: 'message.post', arguments: args });
      return JSON.parse((res.content as { type: string; text: string }[])[0]!.text) as Record<string, unknown>;
    } finally {
      await client.close();
    }
  }

  /**
   * 사람 없이 쌓인 작업 스레드 — **ada 를 실제로 깨운 마지막 부름이 깊이 3** 이다(dee → ada).
   * 옛 셈이면 ada 의 다음 발화는 4 로 상한이다. 이 모양이어야 회귀선에 이빨이 있다.
   */
  async function deepThread(label: string): Promise<string> {
    const root = await post(adminToken, `@bob ${label}`);   // 0
    await post(agents.bob!.pat, '@cid 이어서', root);        // 1
    await post(agents.cid!.pat, '@dee 이어서', root);        // 2
    const toAda = await post(agents.dee!.pat, '@ada 너 차례', root); // 3
    expect(await inboxFor(agents.ada!.pat, toAda)).toEqual(['mention']);
    return root;
  }

  it('원인이 없으면 옛 셈이다 — 사람 없는 작업 스레드에서 막힌다(3336 의 모양)', async () => {
    const root = await deepThread('원인 없음');
    const out = await postVia(agents.ada!.pat, null, { channelId, threadRootId: root, body: '@bob 다시 부탁' });
    expect(out.warnings).toBeDefined();
  });

  it('다른 대화에서 사람이 시킨 턴은 작업 스레드에서 깊이 1 로 시작한다 — 3336 재현', async () => {
    const root = await deepThread('원인 1');
    // 사람이 **다른 대화**(최상위)에서 ada 에게 시킨다 — 작업 스레드에는 사람의 새 글이 없다.
    const order = await post(adminToken, '@ada 작업 스레드에서 bob 을 다시 불러라');
    const out = await postVia(agents.ada!.pat, order, { channelId, threadRootId: root, body: '@bob 다시 부탁' });
    expect(out).not.toHaveProperty('warnings');
    const id = (out.message as { id: string }).id;
    expect(await inboxFor(agents.bob!.pat, id)).toEqual(['mention']);
  });

  it('원인에서 물려받은 사슬도 사람 없이 길어지면 상한에 걸린다 — 폭주 방지는 그대로다', async () => {
    const order = await post(adminToken, '@ada 시작 (원인 사슬)');
    const root = order;
    // ada(1) → bob(2) → cid(3) → dee(4, 상한). 각 고리는 앞 고리의 메시지를 원인으로 댄다.
    let cause = order;
    const hops: Array<[string, string]> = [['ada', 'bob'], ['bob', 'cid'], ['cid', 'dee']];
    for (const [author, next] of hops) {
      const out = await postVia(agents[author]!.pat, cause, { channelId, threadRootId: root, body: `@${next} 이어서` });
      expect(out).not.toHaveProperty('warnings');
      cause = (out.message as { id: string }).id;
    }
    const capped = await postVia(agents.dee!.pat, cause, { channelId, threadRootId: root, body: '@eve 이어서' });
    expect(capped.warnings).toBeDefined();
    expect((await metaOf((capped.message as { id: string }).id)).mentionChainCapped).toEqual(['eve']);
  });

  it('나를 깨우지 않은 메시지를 원인으로 대면 무시한다 — 깊이를 0 으로 되돌리는 우회로가 아니다', async () => {
    const root = await post(adminToken, '@ada 위조 시작');
    for (const [author, next] of [['ada', 'bob'], ['bob', 'cid'], ['cid', 'dee']] as Array<[string, string]>) {
      await post(agents[author]!.pat, `@${next} 이어서`, root);
    }
    // 사람 글이지만 dee 를 부르지 않았다 — dee 의 원인이 될 수 없다.
    const unrelated = await post(adminToken, '@eve 이건 dee 와 무관하다');
    const out = await postVia(agents.dee!.pat, unrelated, { channelId, threadRootId: root, body: '@eve 이어서' });
    expect(out.warnings).toBeDefined();
    expect((await metaOf((out.message as { id: string }).id)).mentionChainCapped).toEqual(['eve']);
  });

  it('형식이 틀린 원인은 무시하고 옛 셈으로 간다', async () => {
    const root = await post(adminToken, '@ada 형식');
    const out = await postVia(agents.ada!.pat, 'not-a-uuid', { channelId, threadRootId: root, body: '@bob 확인' });
    expect(out).not.toHaveProperty('warnings');
  });
});

