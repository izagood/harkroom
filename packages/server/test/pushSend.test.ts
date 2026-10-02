// 모바일 푸시 2단계(093): inbox → push_job → 보내기 직전 다시 확인 → 전송·정리.
// 전송부는 가짜(기록만 한다). 실제 HTTP/2 는 apnsTransport.test.ts 가 잰다.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { removeChannelMember } from '../src/services/channels.js';
import { createPushSweeper } from '../src/services/push/pushJobs.js';
import type { ApnsResult, ApnsSendInput, PushTransport } from '../src/services/push/apns.js';

let app: FastifyInstance; let pool: Pool; let stop: () => Promise<void>;
let adminToken: string; let adminId: string; let botId: string; let channelId: string;
let memberId: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const DEVICE = 'ab'.repeat(32);

const sent: ApnsSendInput[] = [];
let reply: ApnsResult = { status: 200 };
const fake: PushTransport = { async send(i) { sent.push(i); return reply; }, close() {} };
const logs: string[] = [];
const sweeper = () => createPushSweeper(pool, { transport: fake, log: (m) => logs.push(m) });

async function post(body: string, ch = channelId, threadRootId: string | null = null) {
  const posted = await postMessage(pool, { channelId: ch, authorId: botId, body, threadRootId, meta: {} });
  return (posted as { message: { id: string } }).message.id;
}
const due = () => pool.query(`update push_job set not_before = now()`);
const jobs = async () => (await pool.query(`select reason, attempts, device_id from push_job order by id`)).rows;
const register = (t: string, prefs?: object) => app.inject({
  method: 'PUT', url: '/push/devices', headers: auth(t), payload: { token: DEVICE, platform: 'ios', env: 'production', ...(prefs ? { prefs } : {}) },
});

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  // 서버 안의 worker 는 끈다(push: null) — 시험이 sweep 을 직접 부른다.
  app = await buildServer({ pool, push: null });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: memberId } = await createMember(app, adminToken, 'pm'));
  ({ accountId: botId } = await createAgent(app, adminToken, 'pushbot'));
  channelId = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'push-ch' } })).json().id;
  expect((await register(adminToken)).statusCode).toBe(200);
});
afterAll(async () => { await app.close(); await stop(); });
beforeEach(async () => {
  sent.length = 0; logs.length = 0; reply = { status: 200 };
  await pool.query(`delete from push_job`);
  await pool.query(`delete from push_thread_sound`);
  await pool.query(`update inbox set read_at = now() where read_at is null`);
});

describe('enqueue', () => {
  it('사람의 멘션은 job 하나 — 기본 15초 뒤', async () => {
    await post('@admin 봐 줘');
    const r = await pool.query(`select reason, not_before > now() + interval '10 seconds' as later from push_job`);
    expect(r.rows).toEqual([{ reason: 'mention', later: true }]);
  });

  it('기기가 없는 사람에게는 job 을 만들지 않는다', async () => {
    await post('@pm 봐 줘');
    expect(await jobs()).toEqual([]);
  });

  it('15초가 지나기 전에는 보내지 않는다', async () => {
    await post('@admin 아직');
    await sweeper().sweep();
    expect(sent).toHaveLength(0);
    expect(await jobs()).toHaveLength(1);
  });
});

describe('보내기 직전 다시 확인 (G1·G2)', () => {
  it('살아 있으면 보낸다 — 제목·사유 키·배지·collapse-id, 미리보기는 꺼져 있다', async () => {
    const id = await post('@admin 비밀스러운 본문 xyz');
    await due(); await sweeper().sweep();
    expect(sent).toHaveLength(1);
    const p = sent[0]!.payload as { aps: { alert: Record<string, string>; badge: number }; hk: Record<string, unknown> };
    expect(p.aps.alert).toEqual({ title: '#push-ch', 'subtitle-loc-key': 'PUSH_SUB_MENTION', 'subtitle-loc-args': ['pushbot'], 'loc-key': 'PUSH_REASON_MENTION' });
    expect(p.aps.badge).toBe(1);
    expect(p.hk).toEqual({ v: 1, accountId: adminId, messageId: id, channelId, threadRootId: null });
    expect(sent[0]!.collapseId).toBe(id);
    // 다른 스레드에서 에이전트가 부름 — 사람의 부름과 같이 소리 내는 active, 묶음은 그 글(앞으로의 스레드 루트).
    expect(p.aps).toMatchObject({ sound: 'default', 'interruption-level': 'active', 'thread-id': id });
    expect(JSON.stringify(p)).not.toContain('xyz');
    expect(await jobs()).toEqual([]);
  });

  it('배지를 끈 기기에는 badge 를 싣지 않는다 — 나머지는 그대로', async () => {
    await register(adminToken, { badge: false });
    await post('@admin 배지 없이');
    await due(); await sweeper().sweep();
    await register(adminToken, { badge: true });
    const aps = (sent[0]!.payload as { aps: Record<string, unknown> }).aps;
    expect(aps).not.toHaveProperty('badge');
    expect(aps.alert).toEqual({ title: '#push-ch', 'subtitle-loc-key': 'PUSH_SUB_MENTION', 'subtitle-loc-args': ['pushbot'], 'loc-key': 'PUSH_REASON_MENTION' });
  });

  it('그 사이에 읽었으면 보내지 않는다', async () => {
    await post('@admin 읽을 것');
    await pool.query(`update inbox set read_at = now()`);
    await due(); await sweeper().sweep();
    expect(sent).toHaveLength(0);
    expect(await jobs()).toEqual([]);
  });

  it('글이 지워졌으면 보내지 않는다', async () => {
    const id = await post('@admin 지울 글');
    await pool.query(`update message set deleted_at = now() where id = $1`, [id]);
    await due(); await sweeper().sweep();
    expect(sent).toHaveLength(0);
  });

  it('채널에서 빠졌으면 보내지 않는다', async () => {
    const priv = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'push-priv', visibility: 'private' } })).json().id as string;
    await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`, [priv, botId]);
    await post('@admin 비공개', priv);
    await removeChannelMember(pool, priv, adminId);
    await due(); await sweeper().sweep();
    expect(sent).toHaveLength(0);
  });

  it('채널을 none 으로 돌렸으면 보내지 않는다', async () => {
    await post('@admin 조용히');
    await pool.query(
      `insert into channel_pref (account_id, channel_id, notify_level) values ($1, $2, 'none')
       on conflict (account_id, channel_id) do update set notify_level = 'none'`, [adminId, channelId]);
    await due(); await sweeper().sweep();
    expect(sent).toHaveLength(0);
    await pool.query(`update channel_pref set notify_level = 'mentions' where account_id = $1`, [adminId]);
  });

  it.each([
    ['지운 계정', `deleted_at = now()`, `deleted_at = null`],
    ['끈 계정', `disabled_at = now()`, `disabled_at = null`],
  ])('%s 에는 보내지 않는다', async (_n, set, unset) => {
    await post('@admin 계정');
    await pool.query(`update account set ${set} where id = $1`, [adminId]);
    await due(); await sweeper().sweep();
    await pool.query(`update account set ${unset} where id = $1`, [adminId]);
    expect(sent).toHaveLength(0);
  });

  it('세션이 만료된 기기에는 보내지 않는다', async () => {
    await post('@admin 만료');
    await pool.query(`update session set expires_at = now() - interval '1 second' where account_id = $1`, [adminId]);
    await due(); await sweeper().sweep();
    await pool.query(`update session set expires_at = now() + interval '1 day' where account_id = $1`, [adminId]);
    expect(sent).toHaveLength(0);
  });

  it('사유를 끈 기기에는 보내지 않는다', async () => {
    await register(adminToken, { mention: false });
    await post('@admin 끈 사유');
    await due(); await sweeper().sweep();
    await register(adminToken, { mention: true });
    expect(sent).toHaveLength(0);
  });

  it('미리보기를 켜면 그 시점의 본문(수정 반영)을 이름으로 바꿔 싣는다', async () => {
    await register(adminToken, { preview: true });
    const id = await post('@admin 처음 글');
    await pool.query(`update message set body = $2 where id = $1`, [id, `<@${adminId}> 고친 글`]);
    await due(); await sweeper().sweep();
    await register(adminToken, { preview: false });
    expect((sent[0]!.payload as { aps: { alert: unknown } }).aps.alert).toEqual({ title: '#push-ch', 'subtitle-loc-key': 'PUSH_SUB_MENTION', 'subtitle-loc-args': ['pushbot'], body: '@admin 고친 글' });
  });

  it('미리보기에 그 에이전트의 비밀이 들어 있으면 본문을 빼고 사유만 보낸다', async () => {
    await register(adminToken, { preview: true });
    await post('@admin 토큰은 s3cr3t-value 다');
    await due();
    const guarded = createPushSweeper(pool, {
      transport: fake,
      leakGuard: {
        async findInTexts(agentId, texts) {
          return agentId === botId && texts.some((t) => t.includes('s3cr3t-value'))
            ? [{ secretId: 'x', name: 'k', kind: 'text' } as never] : [];
        },
        async findInBytes() { return []; },
        async record() {},
      },
    });
    await guarded.sweep();
    await register(adminToken, { preview: false });
    const alert = (sent[0]!.payload as { aps: { alert: Record<string, string> } }).aps.alert;
    expect(alert['loc-key']).toBe('PUSH_REASON_MENTION');
    expect(JSON.stringify(sent[0]!.payload)).not.toContain('s3cr3t');
  });
});

describe('APNs 응답 처리', () => {
  it('410 이면 기기 행을 지운다 — 로그에 토큰은 앞 8자만', async () => {
    await post('@admin 사라진 기기');
    await due(); reply = { status: 410, reason: 'Unregistered' };
    await sweeper().sweep();
    expect((await pool.query(`select 1 from push_device where account_id = $1`, [adminId])).rowCount).toBe(0);
    expect(logs.join('\n')).toContain(DEVICE.slice(0, 8));
    expect(logs.join('\n')).not.toContain(DEVICE);
    expect((await register(adminToken)).statusCode).toBe(200);
  });

  it('400 BadDeviceToken 도 지운다', async () => {
    await post('@admin 나쁜 토큰');
    await due(); reply = { status: 400, reason: 'BadDeviceToken' };
    await sweeper().sweep();
    expect((await pool.query(`select 1 from push_device where account_id = $1`, [adminId])).rowCount).toBe(0);
    expect((await register(adminToken)).statusCode).toBe(200);
  });

  it('429·5xx 는 그 기기만 다시 시도하고 세 번 뒤에 버린다', async () => {
    await post('@admin 바쁨');
    reply = { status: 503, reason: 'ServiceUnavailable' };
    const s = sweeper();
    for (let i = 0; i < 4; i++) { await due(); await s.sweep(); }
    expect(sent).toHaveLength(4);
    expect(await jobs()).toEqual([]);
    expect(logs.some((l) => l.includes('gave up after 3'))).toBe(true);
  });

  it('403 은 기기를 지우지 않고 degraded 다 — 다음 200 에 풀린다', async () => {
    const s = sweeper();
    await post('@admin 키 오류');
    await due(); reply = { status: 403, reason: 'InvalidProviderToken' };
    await s.sweep();
    expect(s.health()).toBe('degraded');
    expect((await pool.query(`select 1 from push_device where account_id = $1`, [adminId])).rowCount).toBe(1);
    await post('@admin 다시');
    await due(); reply = { status: 200 };
    await s.sweep();
    expect(s.health()).toBe('ok');
  });
});

describe('ask (G4)', () => {
  it('받는 사람을 이름으로 정한 물음은 그 사람에게 간다', async () => {
    // 이 경로는 MCP 핸들러에 있다 — 여기서는 job 을 만드는 함수의 사람·기기 조건만 잰다.
    const { enqueueAskPush } = await import('../src/services/push/pushJobs.js');
    const id = await post('고를 것');
    await enqueueAskPush(pool, adminId, id);
    await enqueueAskPush(pool, botId, id);
    await enqueueAskPush(pool, memberId, id);
    expect(await jobs()).toEqual([{ reason: 'ask', attempts: 0, device_id: null }]);
    await due(); await sweeper().sweep();
    const askAps = (sent[0]!.payload as { aps: { alert: Record<string, string>; 'interruption-level': string } }).aps;
    expect(askAps.alert['loc-key']).toBe('PUSH_REASON_ASK');
    expect(askAps.alert['subtitle-loc-key']).toBe('PUSH_SUB_ASK');
    expect(askAps['interruption-level']).toBe('time-sensitive');
    expect(sent[0]!.collapseId).toBe(`ask:${id}`);
  });
});

describe('종류별 규칙 (P1 — harkroom://message/5afd59e0-9e38-4273-8e9a-2aebcc426d55)', () => {
  type Aps = { alert: Record<string, unknown>; sound?: string; badge?: number; 'interruption-level': string; 'thread-id': string };
  const aps = (i: number) => (sent[i]!.payload as { aps: Aps }).aps;
  /** admin 이 연 스레드. */
  async function myThread(): Promise<string> {
    const posted = await postMessage(pool, { channelId, authorId: adminId, body: '이것 좀 해 줘', threadRootId: null, meta: {} });
    return (posted as { message: { id: string } }).message.id;
  }
  const reply = async (root: string, body: string, meta: Record<string, unknown> = {}) => {
    const posted = await postMessage(pool, { channelId, authorId: botId, body, threadRootId: root, meta });
    return (posted as { message: { id: string } }).message.id;
  };

  it('내 스레드의 에이전트 답은 부름이 아니라 "답 N" — 60초 뒤, 한 장을 갈아쓰고 10분에 첫 한 번만 운다', async () => {
    const root = await myThread();
    await reply(root, '@admin 첫 답');
    const r = await pool.query(`select not_before > now() + interval '50 seconds' as later from push_job`);
    expect(r.rows).toEqual([{ later: true }]);
    await due(); await sweeper().sweep();
    await reply(root, '@admin 둘째 답');
    await due(); await sweeper().sweep();
    expect(sent).toHaveLength(2);
    expect(aps(0).alert).toEqual({
      title: '#push-ch', 'subtitle-loc-key': 'PUSH_SUB_REPLIES', 'subtitle-loc-args': ['1', 'pushbot'],
      'loc-key': 'PUSH_REASON_REPLIES', 'loc-args': ['1'],
    });
    expect(aps(0)).toMatchObject({ sound: 'default', 'interruption-level': 'active', 'thread-id': root });
    expect(aps(1).alert).toMatchObject({ 'subtitle-loc-args': ['2', 'pushbot'], 'loc-args': ['2'] });
    expect(aps(1)).not.toHaveProperty('sound');
    expect(aps(1)['interruption-level']).toBe('passive');
    expect(sent.map((x) => x.collapseId)).toEqual([`reply:${root}`, `reply:${root}`]);
    // 배지: 같은 스레드의 답 둘은 하나로 센다.
    expect(aps(1).badge).toBe(1);
  });

  it('10분이 지나면 다시 한 번 운다', async () => {
    const root = await myThread();
    await reply(root, '@admin 답');
    await due(); await sweeper().sweep();
    await pool.query(`update push_thread_sound set sounded_at = now() - interval '11 minutes'`);
    await reply(root, '@admin 한참 뒤 답');
    await due(); await sweeper().sweep();
    expect(aps(1)).toMatchObject({ sound: 'default', 'interruption-level': 'active' });
  });

  it('실패는 "실패" — 15초, 소리 + time-sensitive, 글마다 따로 남는다', async () => {
    const root = await myThread();
    const id = await reply(root, '@admin 못 끝냈다', { kind: 'failure', failure: { retryable: true } });
    const r = await pool.query(`select not_before < now() + interval '20 seconds' as soon from push_job`);
    expect(r.rows).toEqual([{ soon: true }]);
    await due(); await sweeper().sweep();
    expect(aps(0).alert).toEqual({
      title: '#push-ch', 'subtitle-loc-key': 'PUSH_SUB_FAIL', 'subtitle-loc-args': ['pushbot'], 'loc-key': 'PUSH_REASON_FAIL',
    });
    expect(aps(0)).toMatchObject({ sound: 'default', 'interruption-level': 'time-sensitive', 'thread-id': root });
    expect(sent[0]!.collapseId).toBe(`fail:${id}`);
  });

  it('결정·실패가 1분 안에 또 오면 알림은 따로 남되 소리·time-sensitive 는 첫 것만 (L1)', async () => {
    const root = await myThread();
    const a = await reply(root, '@admin 실패 1', { kind: 'failure', failure: { retryable: true } });
    await due(); await sweeper().sweep();
    const b = await reply(root, '@admin 실패 2', { kind: 'failure', failure: { retryable: true } });
    await due(); await sweeper().sweep();
    expect(aps(0)).toMatchObject({ sound: 'default', 'interruption-level': 'time-sensitive' });
    expect(aps(1)).not.toHaveProperty('sound');
    expect(aps(1)['interruption-level']).toBe('active');
    expect(sent.map((x) => x.collapseId)).toEqual([`fail:${a}`, `fail:${b}`]);
    // 보통 답의 10분 간격과는 따로 센다 — 같은 스레드의 답은 여전히 첫 것이 운다.
    await reply(root, '@admin 보통 답');
    await due(); await sweeper().sweep();
    expect(aps(2)).toMatchObject({ sound: 'default', 'interruption-level': 'active' });
    // 1분이 지나면 다시 뚫는다.
    await pool.query(`update push_thread_sound set sounded_at = now() - interval '2 minutes' where thread_key like 'urgent:%'`);
    await reply(root, '@admin 실패 3', { kind: 'failure', failure: { retryable: true } });
    await due(); await sweeper().sweep();
    expect(aps(3)).toMatchObject({ sound: 'default', 'interruption-level': 'time-sensitive' });
  });

  it('하루 넘게 안 울린 소리 기록은 sweep 이 지운다 (L2)', async () => {
    await pool.query(
      `insert into push_thread_sound (account_id, thread_key, sounded_at) values
         ($1, 'old', now() - interval '2 days'), ($1, 'fresh', now() - interval '1 hour')`, [adminId]);
    await sweeper().sweep();
    const r = await pool.query(`select thread_key from push_thread_sound order by thread_key`);
    expect(r.rows.map((x) => x.thread_key)).toEqual(['fresh']);
  });

  it('로그인 관문 실패는 "로그인 필요"', async () => {
    const root = await myThread();
    await reply(root, '@admin 로그인', { kind: 'failure', failure: { retryable: true, code: 'account_gate' } });
    await due(); await sweeper().sweep();
    expect(aps(0).alert).toMatchObject({ 'subtitle-loc-key': 'PUSH_SUB_GATE', 'loc-key': 'PUSH_REASON_GATE' });
    expect(aps(0)['interruption-level']).toBe('time-sensitive');
  });

  it('완료 보고는 "완료" — 소리 있는 active, 답과 같은 한 장을 갈아쓴다', async () => {
    const root = await myThread();
    await reply(root, '@admin 끝났다', { kind: 'report', report: { checks: ['ok'] } });
    await due(); await sweeper().sweep();
    expect(aps(0).alert).toMatchObject({ 'subtitle-loc-key': 'PUSH_SUB_DONE', 'loc-key': 'PUSH_REASON_DONE' });
    expect(aps(0)).toMatchObject({ sound: 'default', 'interruption-level': 'active' });
    expect(sent[0]!.collapseId).toBe(`reply:${root}`);
  });

  it('미리보기가 꺼져 있으면 스레드 제목(루트 본문)도 싣지 않는다', async () => {
    const root = await myThread();
    await reply(root, '@admin 답');
    await due(); await sweeper().sweep();
    expect(JSON.stringify(sent[0]!.payload)).not.toContain('이것 좀');
  });
});

describe('/healthz', () => {
  it('push 는 상태 낱말만 낸다', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json().push).toBe('off');
    expect(JSON.stringify(res.json())).not.toMatch(/APNS|keyId|teamId/i);
  });
});
