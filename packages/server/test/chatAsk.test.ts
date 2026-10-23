import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { matchAskPick, parseAskPick } from '../src/services/chatApproval.js';

// 선택 카드에 글로 답한다(P5, 권한·승인 재설계 설계 1판 2절 「선택 카드」 줄).
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const link = (id: string) => `harkroom://message/${id}`;
const OPTIONS = [{ id: 'a', label: 'A안' }, { id: 'b', label: '보류', recommended: true }, { id: 'c', label: 'Ship it' }];

describe('parseAskPick·matchAskPick — 번호·차례·추천대로·이름 그대로', () => {
  const pick = (body: string) => {
    const p = parseAskPick(body);
    if (!p) return null;
    const m = matchAskPick(OPTIONS, p.pick);
    return m.ok ? m.id : m.why;
  };
  it.each([
    ['1', 'a'], ['2번', 'b'], ['(3)', 'c'], ['1번으로 해', 'a'], ['2번 안으로 가자', 'b'], ['1번 진행해', 'a'],
    ['(가)', 'a'], ['나안', 'b'], ['다 안으로 해줘', 'c'],
    ['추천대로', 'b'], ['추천대로 진행해', 'b'], ['추천안으로 해', 'b'], ['as recommended', 'b'],
    ['A안', 'a'], ['a안으로 해', 'a'], ['「A안」으로 해', 'a'], ['ship it', 'c'], ['Ship it!', 'c'],
    ['4번', 'askNoMatch'], ['(라)', 'askNoMatch'],
  ])('%j → %s', (body, want) => {
    expect(pick(body)).toBe(want);
  });
  it.each([
    '1번 말고 2번', '2번?',
    // 부정 낱말이 든 선택지 이름(「보류」)은 이름으로 고르지 않는다 — 번호로 고른다(fail closed).
    '보류', '추천대로 할까', '추천대로 하지 마', '보류 아니고 A안', '바이패스 1번', '`1`', '> 1',
  ])('답이 아닌 글 %j', (body) => {
    expect(parseAskPick(body)).toBeNull();
  });
  it('이름이 아닌 보통 글은 선택지에 맞지 않는다', () => {
    expect(pick('A안이 좋긴 한데 하루 더 보자')).toBe('askNoMatch');
    expect(parseAskPick('A안이 좋긴 한데 하루 더 보자')!.pick.explicit).toBe(false);
  });
  it('추천이 없거나 둘이면 「추천대로」는 고르지 않는다', () => {
    const p = parseAskPick('추천대로')!.pick;
    expect(matchAskPick([{ id: 'x', label: 'x' }, { id: 'y', label: 'y' }], p)).toEqual({ ok: false, why: 'askNoRecommended' });
    expect(matchAskPick([{ id: 'x', label: 'x', recommended: true }, { id: 'y', label: 'y', recommended: true }], p)).toEqual({ ok: false, why: 'askNoRecommended' });
  });
  it('카드 링크를 뽑는다', () => {
    expect(parseAskPick(`${link(ID)} 2번`)).toEqual({ cardIds: [ID], pick: { kind: 'index', n: 2, explicit: true } });
  });
});

describe('글 답 → 선택 카드(버튼과 같은 답)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let agentId: string;
  let ch: string; let otherCh: string;

  const root = async (channelId = ch): Promise<string> =>
    (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'do it', 'user') returning id`,
      [channelId, alice.accountId])).rows[0].id as string;
  /** 에이전트가 사람에게 묻는 선택 카드 하나. */
  const askCard = async (threadRootId: string, opts: { channelId?: string; to?: Record<string, unknown>; irreversible?: boolean; body?: string } = {}) =>
    (await pool.query(
      `insert into message (channel_id, thread_root_id, author_id, body, kind, meta) values ($1, $2, $3, $4, 'user', $5) returning id`,
      [opts.channelId ?? ch, threadRootId, agentId, opts.body ?? '어느 쪽으로 갈까', JSON.stringify({
        kind: 'ask', ask: { options: OPTIONS, to: opts.to ?? { kind: 'human' }, ...(opts.irreversible ? { irreversible: true } : {}) },
      })])).rows[0].id as string;
  const say = (token: string, body: string, threadRootId?: string, channelId = ch) =>
    app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body, ...(threadRootId ? { threadRootId } : {}) } });
  const askOf = async (id: string) => (await pool.query(`select meta from message where id = $1`, [id])).rows[0].meta.ask;
  const systemLines = async (threadRootId: string) =>
    (await pool.query(`select body, meta from message where thread_root_id = $1 and kind = 'system' and meta ? 'chatApproval' order by seq`, [threadRootId])).rows as { body: string; meta: any }[];
  const wakes = async (cardId: string) =>
    (await pool.query(`select 1 from inbox where account_id = $1 and message_id = $2 and reason = 'ask_answered'`, [agentId, cardId])).rowCount;

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    ({ accountId: agentId } = await createAgent(app, admin.token, 'sitebot'));
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'sitebot' } })).json().id as string;
    otherCh = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'task' } })).json().id as string;
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('T2 — 카드 스레드의 「2번」은 그 카드의 답이다(replied 로 닫히지 않는다)', async () => {
    const thread = await root();
    const cardId = await askCard(thread);
    const res = await say(alice.token, '2번으로 해', thread);
    expect(res.statusCode).toBe(201);
    const ask = await askOf(cardId);
    expect(ask).toMatchObject({ answeredWith: 'b', answeredBy: alice.accountId, answeredVia: 'chat' });
    expect(ask.closedReason).toBeUndefined();
    expect(await systemLines(thread)).toHaveLength(0);
    // 물어본 에이전트는 한 번만 깬다 — 이 글로 이미 깨었으면(thread_reply) ask_answered 를 더 넣지 않는다.
    const byReply = (await pool.query(`select 1 from inbox where account_id = $1 and message_id = $2`, [agentId, res.json().id])).rowCount!;
    expect(byReply + (await wakes(cardId))!).toBe(1);
  });

  it('T2 — 이름 그대로·「추천대로」', async () => {
    const t1 = await root(); const c1 = await askCard(t1);
    await say(alice.token, 'Ship it', t1);
    expect((await askOf(c1)).answeredWith).toBe('c');
    const t2 = await root(); const c2 = await askCard(t2);
    await say(alice.token, '추천대로 진행해', t2);
    expect((await askOf(c2)).answeredWith).toBe('b');
  });

  it('T1 — 다른 채널에서 카드 링크와 번호로 답하고, 물어본 에이전트를 깨운다', async () => {
    const cardId = await askCard(await root());
    const elsewhere = await root(otherCh);
    await say(alice.token, `${link(cardId)} 1번`, elsewhere, otherCh);
    expect((await askOf(cardId)).answeredWith).toBe('a');
    expect(await wakes(cardId)).toBe(1);
  });

  it('보통 대화는 답이 아니다 — 지금처럼 replied 로 닫힌다', async () => {
    const thread = await root();
    const cardId = await askCard(thread);
    await say(alice.token, 'A안이 좋긴 한데 하루 더 보자', thread);
    const ask = await askOf(cardId);
    expect(ask.answeredWith).toBeUndefined();
    expect(ask.closedReason).toBe('replied');
    expect(await systemLines(thread)).toHaveLength(0);
  });

  it('맞는 선택지가 없는 번호는 답하지 않고 「답 안 됨」 한 줄', async () => {
    const thread = await root();
    const cardId = await askCard(thread);
    await say(alice.token, '5번', thread);
    expect((await askOf(cardId)).answeredWith).toBeUndefined();
    const line = (await systemLines(thread)).at(-1)!;
    expect(line.body.startsWith('⚠️ 답 안 됨:')).toBe(true);
    expect(line.meta.i18n).toEqual({ key: 'system.chatApproval.askNoMatch', args: {} });
  });

  it('되돌릴 수 없는 카드에는 「추천대로」가 고르지 않는다', async () => {
    const thread = await root();
    const cardId = await askCard(thread, { body: '이 PR 머지할까' });
    await say(alice.token, '추천대로', thread);
    expect((await askOf(cardId)).answeredWith).toBeUndefined();
    expect((await systemLines(thread)).at(-1)!.meta.i18n.key).toBe('system.chatApproval.askIrreversible');
  });

  // 되돌릴 수 없는 카드: 링크 없이(T2) 번호·차례만 쓴 글은 고르지 않는다. 링크(T1)가 있거나 이름 그대로면 된다(security n19).
  it.each([
    ['T2 번호', '1', false, null],
    ['T2 「2번」', '2번', false, null],
    ['T2 「(3)」', '(3)', false, null],
    ['T2 한글 차례', '(가)', false, null],
    ['T2 「1번으로 해」', '1번으로 해', false, null],
    ['T2 이름 그대로', 'Ship it', false, 'c'],
    ['T2 이름 그대로(따옴표)', '「A안」으로 해', false, 'a'],
    ['T1 링크와 번호', '1번', true, 'a'],
    ['T1 링크와 한글 차례', '(다)', true, 'c'],
    ['T1 링크와 이름', 'A안', true, 'a'],
  ] as const)('되돌릴 수 없는 카드 — %s', async (_name, body, withLink, want) => {
    const thread = await root();
    const cardId = await askCard(thread, { irreversible: true });
    await say(alice.token, withLink ? `${link(cardId)} ${body}` : body, thread);
    const ask = await askOf(cardId);
    if (want) {
      expect(ask.answeredWith).toBe(want);
      expect(await systemLines(thread)).toHaveLength(0);
    } else {
      expect(ask.answeredWith).toBeUndefined();
      const line = (await systemLines(thread)).at(-1)!;
      expect(line.body.startsWith('⚠️ 답 안 됨:')).toBe(true);
      expect(line.body).toContain('링크');
      expect(line.meta.i18n).toEqual({ key: 'system.chatApproval.askIrreversible', args: {} });
    }
  });

  it('스레드 카드가 여럿일 때 안내는 「다시 쓴다」로 끝맺는다(security n20)', async () => {
    const thread = await root();
    await askCard(thread); await askCard(thread);
    await say(alice.token, '2번', thread);
    const line = (await systemLines(thread)).at(-1)!;
    expect(line.body).toContain('링크를 붙여 다시 쓴다:');
    expect(line.body).not.toContain('써라');
  });

  it('스레드에 열린 선택 카드가 둘이면 고르지 않고 링크를 단다', async () => {
    const thread = await root();
    const a = await askCard(thread);
    const b = await askCard(thread);
    await say(alice.token, '1번', thread);
    expect((await askOf(a)).answeredWith).toBeUndefined();
    expect((await askOf(b)).answeredWith).toBeUndefined();
    const line = (await systemLines(thread)).at(-1)!;
    expect(line.body).toContain(link(a));
    expect(line.body).toContain(link(b));
  });

  it('남에게 간 카드는 답하지 않고 아무 줄도 남기지 않는다', async () => {
    const thread = await root();
    const cardId = await askCard(thread, { to: { kind: 'account', accountId: bob.accountId } });
    await say(alice.token, '1번', thread);
    expect((await askOf(cardId)).answeredWith).toBeUndefined();
    expect(await systemLines(thread)).toHaveLength(0);
    await say(bob.token, '1번', thread);
    expect((await askOf(cardId)).answeredWith).toBe('a');
  });

  it('이미 답한 카드를 링크해 번호를 쓰면 「이미 답한 카드」', async () => {
    const cardId = await askCard(await root());
    await pool.query(`update message set meta = jsonb_set(meta, '{ask,answeredWith}', '"a"') where id = $1`, [cardId]);
    const elsewhere = await root(otherCh);
    await say(alice.token, `${link(cardId)} 2번`, elsewhere, otherCh);
    expect((await askOf(cardId)).answeredWith).toBe('a');
    expect((await systemLines(elsewhere)).at(-1)!.meta.i18n.key).toBe('system.chatApproval.askAnswered');
  });

  it('부정·물음이 든 글은 답이 아니다', async () => {
    const thread = await root();
    const cardId = await askCard(thread);
    await say(alice.token, '1번 말고', thread);
    expect((await askOf(cardId)).answeredWith).toBeUndefined();
  });
});
