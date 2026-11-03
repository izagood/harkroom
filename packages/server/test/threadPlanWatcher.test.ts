import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { PlanDoc } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { emitEvent, emitPosted, onEvent, type WorkspaceEvent } from '../src/events.js';
import { getThreadPlan, setThreadPlan } from '../src/services/threadPlan.js';
import { postMessage } from '../src/services/messages.js';
import { applyAnsweredCard, applyMergedPr, readyDiff } from '../src/services/threadPlanWatcher.js';

/**
 * 스레드 계획판 P6 — 자동 갱신 구독기(buildServer 가 띄운 것을 그대로 쓴다).
 *
 * 1. 래퍼 머지 줄(system·merged)만 같은 스레드의 pr 단계를 done 으로 — queued·사람 글·다른 스레드는 그대로(W3).
 * 2. 카드 답 → 그 card 를 단 blocked 단계만 active.
 * 3. 자동 갱신으로 **앞 판에도 있던** 노드가 새로 ready 가 되면 시스템 줄 하나(N2, 멘션 없음).
 * 4. 자식 계획 변화 → 부모 이벤트(via linked, 청중 맵) — 1단만(W5·W6).
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let admin: { token: string; accountId: string };
let botId: string;
let ch: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const root = async (body = 'root') =>
  (await app.inject({ method: 'POST', url: `/channels/${ch}/messages`, headers: auth(admin.token), payload: { body } })).json().id as string;
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 3000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 800));
const stepState = async (rootId: string, id: string) => (await getThreadPlan(pool, rootId))!.doc.steps.find((s) => s.id === id)!.state;
const readyLines = async (rootId: string) => (await pool.query(
  `select body, meta, author_id from message where thread_root_id = $1 and kind = 'system' and meta ? 'planReady' order by seq`, [rootId],
)).rows as { body: string; author_id: string; meta: { planReady: { ids: string[]; titles: Record<string, string> }; i18n: { args: Record<string, unknown> } } }[];
const mergeLine = async (rootId: string, result: 'merged' | 'queued', number = 7, kind: 'system' | 'user' = 'system') => emitPosted(await postMessage(pool, {
  channelId: ch, threadRootId: rootId, authorId: botId, body: `🔀 o/r#${number}`, kind,
  meta: { merge: { repo: 'O/R', number, headSha: 'a'.repeat(40), mergeSha: null, result, grantedBy: null, viaApproval: false, error: null } },
} as Parameters<typeof postMessage>[1]), 'all');

const doc = (): PlanDoc => ({
  goal: '머지까지',
  groups: [],
  steps: [
    { id: 's1', title: '구현', state: 'active', links: [{ kind: 'pr', repo: 'o/r', number: 7 }], dependsOn: [] },
    { id: 's2', title: '배포', state: 'pending', links: [], dependsOn: ['s1'] },
  ],
});

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  admin = await bootstrapAdmin(app);
  ({ accountId: botId } = await createAgent(app, admin.token, 'planbot'));
  ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'plan-watch' } })).json().id;
  await app.inject({ method: 'POST', url: `/channels/${ch}/members`, headers: auth(admin.token), payload: { accountId: botId } });
});
afterAll(async () => { await app.close(); await stop(); });

describe('순수 함수', () => {
  it('applyMergedPr 는 repo 대소문자를 가리지 않고, 이미 done 이면 null', () => {
    expect(applyMergedPr(doc(), 'O/R', 7)!.steps[0]!.state).toBe('done');
    expect(applyMergedPr(doc(), 'o/r', 8)).toBeNull();
    const d = doc(); d.steps[0]!.state = 'done';
    expect(applyMergedPr(d, 'o/r', 7)).toBeNull();
  });
  it('applyAnsweredCard 는 blocked 만 active 로', () => {
    const d = doc();
    d.steps[0] = { ...d.steps[0]!, state: 'blocked', blockedReason: '답 대기', links: [{ kind: 'card', messageId: '00000000-0000-4000-8000-000000000001' }] };
    const out = applyAnsweredCard(d, '00000000-0000-4000-8000-000000000001')!;
    expect(out.steps[0]).toMatchObject({ state: 'active', blockedReason: null });
    d.steps[0]!.state = 'active';
    expect(applyAnsweredCard(d, '00000000-0000-4000-8000-000000000001')).toBeNull();
  });
  it('readyDiff 는 앞 판에 없던 노드를 세지 않는다(N2)', () => {
    const w = { derived: 'waiting' as const, waitingOn: [], startedEarly: false };
    const r = { derived: 'ready' as const, waitingOn: [], startedEarly: false };
    expect(readyDiff({ s1: w }, { s1: r, s2: r })).toEqual(['s1']);
  });
});

describe('자동 갱신', () => {
  it('머지 줄 → 같은 스레드 pr 단계 done, 뒤 단계가 새로 ready 면 줄 하나', async () => {
    const r = await root();
    const other = await root('다른 스레드');
    for (const id of [r, other]) expect((await setThreadPlan(pool, { rootId: id, doc: doc(), actor: { accountId: admin.accountId } })).ok).toBe(true);
    await mergeLine(r, 'merged');
    await until(async () => (await stepState(r, 's1')) === 'done');
    const lines = await until(async () => { const l = await readyLines(r); return l.length ? l : null; });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.meta.planReady.ids).toEqual(['s2']);
    expect(lines[0]!.body).not.toMatch(/@/);
    // 다른 스레드는 그대로(W3)
    expect(await stepState(other, 's1')).toBe('active');
  });

  it('queued·사람이 쓴 같은 꼴 meta 는 손대지 않는다', async () => {
    const r = await root();
    await setThreadPlan(pool, { rootId: r, doc: doc(), actor: { accountId: admin.accountId } });
    const rev = (await getThreadPlan(pool, r))!.rev;
    await mergeLine(r, 'queued');
    await mergeLine(r, 'merged', 7, 'user');
    await settle();
    expect(await stepState(r, 's1')).toBe('active');
    expect((await getThreadPlan(pool, r))!.rev).toBe(rev);
  });

  it('카드 답 → 그 카드를 단 blocked 단계 active', async () => {
    const r = await root();
    const card = '00000000-0000-4000-8000-0000000000aa';
    const d = doc();
    d.steps[0] = { ...d.steps[0]!, state: 'blocked', blockedReason: '고르기 대기', links: [{ kind: 'card', messageId: card }] };
    await setThreadPlan(pool, { rootId: r, doc: d, actor: { accountId: admin.accountId } });
    emitEvent({
      type: 'message.updated', channelId: ch,
      message: { id: card, threadRootId: r, channelId: ch, authorId: botId, kind: 'user', meta: { kind: 'ask', ask: { answeredWith: 'a' } } },
      audience: 'all',
    } as unknown as WorkspaceEvent);
    await until(async () => (await stepState(r, 's1')) === 'active');
  });
});

describe('architect R1~R3', () => {
  it('R1: 단계 제목은 본문·i18n 인자에 싣지 않는다 — 제목의 @handle 이 멘션으로 풀리지 않는다(meta.planReady.titles 에만)', async () => {
    const r = await root();
    const d = doc();
    d.steps[1] = { ...d.steps[1]!, title: '@planbot @channel 배포' };
    await setThreadPlan(pool, { rootId: r, doc: d, actor: { accountId: admin.accountId } });
    await mergeLine(r, 'merged');
    const [line] = await until(async () => { const l = await readyLines(r); return l.length ? l : null; });
    expect(line!.body).toBe('▶ 이제 시작할 수 있는 단계 1개: s2');
    expect(JSON.stringify(line!.meta.i18n)).not.toContain('@');
    expect(line!.meta.planReady.titles).toEqual({ s2: '@planbot @channel 배포' });
    const refs = await pool.query(`select meta from message where thread_root_id = $1 and kind = 'system' and meta ? 'planReady'`, [r]);
    expect(JSON.stringify(refs.rows[0].meta.mentionRefs ?? [])).toBe('[]');
  });

  it('R2: 같은 카드 글의 갱신이 또 와도 두 번째는 단계를 바꾸지 않는다', async () => {
    const r = await root();
    const card = '00000000-0000-4000-8000-0000000000bb';
    const d = doc();
    d.steps[0] = { ...d.steps[0]!, state: 'blocked', blockedReason: '고르기 대기', links: [{ kind: 'card', messageId: card }] };
    await setThreadPlan(pool, { rootId: r, doc: d, actor: { accountId: admin.accountId } });
    const answered = () => emitEvent({
      type: 'message.updated', channelId: ch,
      message: { id: card, threadRootId: r, channelId: ch, authorId: botId, kind: 'user', meta: { kind: 'ask', ask: { answeredWith: 'a' } } },
      audience: 'all',
    } as unknown as WorkspaceEvent);
    answered();
    await until(async () => (await stepState(r, 's1')) === 'active');
    // 에이전트가 새 이유로 다시 막는다 → 같은 카드 글에 갱신이 또 와도 뒤집히지 않는다.
    const cur = (await getThreadPlan(pool, r))!;
    await setThreadPlan(pool, {
      rootId: r, guard: { updatedAt: cur.updatedAt }, actor: { accountId: admin.accountId },
      doc: { ...cur.doc, steps: [{ ...cur.doc.steps[0]!, state: 'blocked', blockedReason: '다른 이유' }, cur.doc.steps[1]!] },
    });
    answered();
    await settle();
    expect(await stepState(r, 's1')).toBe('blocked');
  });

  it('R3: 부모 줄의 저자는 부모 채널을 보는 계정 — 자식을 쓴 에이전트가 못 보면 부모 계획을 쓴 계정', async () => {
    const priv = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'plan-watch-priv', visibility: 'private' } })).json().id as string;
    const parent = (await app.inject({ method: 'POST', url: `/channels/${priv}/messages`, headers: auth(admin.token), payload: { body: '비공개 부모' } })).json().id as string;
    const child = await root('공개 자식');
    await setThreadPlan(pool, { rootId: child, doc: { goal: '자식', groups: [], steps: [{ id: 's1', title: '일', state: 'active', links: [], dependsOn: [] }] }, actor: { accountId: botId } });
    await setThreadPlan(pool, {
      rootId: parent, actor: { accountId: admin.accountId },
      doc: { goal: '부모', groups: [{ id: 'g1', title: '자식 일', linkedRootId: child, dependsOn: [] }], steps: [{ id: 's1', title: '마무리', state: 'pending', links: [], dependsOn: ['g1'] }] },
    });
    await settle();
    const cur = (await getThreadPlan(pool, child))!;
    await setThreadPlan(pool, {
      rootId: child, guard: { updatedAt: cur.updatedAt }, actor: { accountId: botId },
      doc: { ...cur.doc, steps: [{ ...cur.doc.steps[0]!, state: 'done' }] },
    });
    const [line] = await until(async () => { const l = await readyLines(parent); return l.length ? l : null; });
    expect(line!.author_id).toBe(admin.accountId);
  });
});

describe('S1 — 시스템 알림 줄은 부르지 않는다', () => {
  /**
   * 그 스레드의 system 줄이 만든 **부름** inbox. 머리 주인에게 가는 `thread_reply` 는 부름이 아니라 답글 알림이라 세지 않는다
   * (봇 이름 줄이 사람 머리 아래 서면 원래 간다 — `serverNotice` 주석의 「머리 주인 thread_reply 는 그대로」).
   */
  const calls = (rootId: string, onlyReady = false) => pool.query(
    `select i.reason from inbox i join message m on m.id = i.message_id
      where m.thread_root_id = $1 and m.kind = 'system' and i.reason <> 'thread_reply' and ($2::boolean is false or m.meta ? 'planReady')`, [rootId, onlyReady],
  ).then((r) => r.rowCount);
  const callBody = () => `@channel @planbot <@${botId}> <@${admin.accountId}> <@team:00000000-0000-4000-8000-000000000000>`;

  it('noMentions 줄은 본문의 부름 토큰을 풀지 않고 inbox 를 만들지 않는다(빼면 부른다 — 대조군)', async () => {
    const quiet = await root();
    emitPosted(await postMessage(pool, {
      channelId: ch, threadRootId: quiet, authorId: admin.accountId, body: callBody(), kind: 'system', serverNotice: true, noMentions: true,
    } as Parameters<typeof postMessage>[1]), 'all');
    await settle();
    expect(await calls(quiet)).toBe(0);

    const loud = await root();
    emitPosted(await postMessage(pool, {
      channelId: ch, threadRootId: loud, authorId: admin.accountId, body: callBody(), kind: 'system', serverNotice: true,
    } as Parameters<typeof postMessage>[1]), 'all');
    await settle();
    expect(await calls(loud)).toBeGreaterThan(0);
  });

  it('ready 줄: 단계 제목이 @channel·@handle·<@uuid>·<@team:uuid> 여도 inbox 0', async () => {
    const r = await root();
    const d = doc();
    // 제목 상한(120자) 안에 들게 두 단계로 나눈다 — 둘 다 s1 뒤라 함께 ready 가 된다.
    d.steps[1] = { ...d.steps[1]!, title: `@channel @planbot <@${botId}>` };
    d.steps.push({ id: 's3', title: `<@${admin.accountId}> <@team:00000000-0000-4000-8000-000000000000>`, state: 'pending', links: [], dependsOn: ['s1'] });
    await setThreadPlan(pool, { rootId: r, doc: d, actor: { accountId: admin.accountId } });
    await mergeLine(r, 'merged');
    const [line] = await until(async () => { const l = await readyLines(r); return l.length ? l : null; });
    expect(line!.meta.planReady.ids).toEqual(['s2', 's3']);
    await settle();
    expect(await calls(r, true)).toBe(0);
  });
});

describe('부모 전파', () => {
  it('자식 계획이 끝나면 부모에 via linked 이벤트, 부모 뒤 단계 ready 줄 — 조부모로는 가지 않는다', async () => {
    const grand = await root('조부모');
    const parent = await root('부모');
    const child = await root('자식');
    await setThreadPlan(pool, { rootId: child, doc: { goal: '자식', groups: [], steps: [{ id: 's1', title: '일', state: 'active', links: [], dependsOn: [] }] }, actor: { accountId: admin.accountId } });
    await setThreadPlan(pool, {
      rootId: parent, actor: { accountId: admin.accountId },
      doc: { goal: '부모', groups: [{ id: 'g1', title: '자식 일', linkedRootId: child, dependsOn: [] }], steps: [{ id: 's1', title: '마무리', state: 'pending', links: [], dependsOn: ['g1'] }] },
    });
    await setThreadPlan(pool, {
      rootId: grand, actor: { accountId: admin.accountId },
      doc: { goal: '조부모', groups: [{ id: 'g1', title: '부모 일', linkedRootId: parent, dependsOn: [] }], steps: [] },
    });
    await settle(); // 부모·조부모의 앞 판(청중 파생)을 구독기가 기억하게

    const seen: WorkspaceEvent[] = [];
    const off = onEvent((e) => { if (e.type === 'thread.plan.changed') seen.push(e); });
    const cur = (await getThreadPlan(pool, child))!;
    await setThreadPlan(pool, {
      rootId: child, guard: { updatedAt: cur.updatedAt }, actor: { accountId: admin.accountId },
      doc: { ...cur.doc, steps: [{ ...cur.doc.steps[0]!, state: 'done' }] },
    });
    const lines = await until(async () => { const l = await readyLines(parent); return l.length ? l : null; });
    off();
    expect(lines[0]!.meta.planReady.ids).toEqual(['s1']);
    const linked = seen.filter((e) => e.type === 'thread.plan.changed' && e.via === 'linked');
    expect(linked.map((e) => (e as { rootId: string }).rootId)).toEqual([parent]);
  });
});
