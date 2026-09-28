import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import type { AutomationTrigger } from '@harkroom/shared';
import {
  createAutomationSweeper, nextOccurrence, renderBody, timeVars, RATE_LIMIT_PER_HOUR,
} from '../src/services/automations.js';

describe('schedule 계산 (064)', () => {
  const weeklyMon9: AutomationTrigger = { kind: 'schedule', freq: 'weekly', weekdays: [1], time: '09:00', tz: 'Asia/Seoul' };

  it('매주 월 09:00(서울) — 일요일 밤에서 다음 월요일 00:00Z', () => {
    // 2026-09-27(일) 12:00Z = 서울 21:00 일요일
    const next = nextOccurrence(weeklyMon9, new Date('2026-09-27T12:00:00Z'));
    expect(next?.toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });

  it('정각 그 순간이면 다음 주로 넘어간다(같은 회차를 두 번 잡지 않는다)', () => {
    const next = nextOccurrence(weeklyMon9, new Date('2026-09-28T00:00:00Z'));
    expect(next?.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  it('DST — 뉴욕 매일 09:00 은 전환 앞뒤로 UTC 시각이 한 시간 바뀐다', () => {
    const daily: AutomationTrigger = { kind: 'schedule', freq: 'daily', time: '09:00', tz: 'America/New_York' };
    expect(nextOccurrence(daily, new Date('2026-10-31T20:00:00Z'))?.toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(nextOccurrence(daily, new Date('2026-10-30T20:00:00Z'))?.toISOString()).toBe('2026-10-31T13:00:00.000Z');
  });

  it('매월 31일은 없는 달에 말일로 온다', () => {
    const monthly: AutomationTrigger = { kind: 'schedule', freq: 'monthly', monthDay: 31, time: '10:00', tz: 'UTC' };
    expect(nextOccurrence(monthly, new Date('2026-09-01T00:00:00Z'))?.toISOString()).toBe('2026-09-30T10:00:00.000Z');
  });

  it('timeVars — 월요일 회차의 지난주는 앞 주 월~일이다', () => {
    const v = timeVars(new Date('2026-09-28T00:00:00Z'), 'Asia/Seoul');
    expect(v.lastWeek).toBe('2026-09-21 ~ 2026-09-27');
    expect(v.date).toBe('2026-09-28');
  });

  it('renderBody — 모르는 변수는 그대로 둔다', () => {
    expect(renderBody('{{lastWeek}} {{nope}}', { lastWeek: 'X' })).toBe('X {{nope}}');
  });
});

describe('자동화 API · sweeper (064)', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let stop: () => Promise<void>;
  let adminToken: string;
  let user: { token: string; accountId: string };
  let channelId: string;
  const auth = () => ({ authorization: `Bearer ${user.token}` });

  beforeAll(async () => {
    const db = await startTestDb();
    stop = db.stop; pool = db.pool;
    app = await buildServer({ pool: db.pool });
    ({ token: adminToken } = await bootstrapAdmin(app));
    user = await createMember(app, adminToken, 'autouser');
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` }, payload: { name: 'auto-test' },
    });
    channelId = ch.json().id;
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountId: user.accountId },
    });
  });
  afterAll(async () => { await app.close(); await stop(); });

  const weekly = { kind: 'schedule', freq: 'weekly', weekdays: [1], time: '09:00', tz: 'Asia/Seoul' };

  async function create(body = '지난주({{lastWeek}}) 정리') {
    const res = await app.inject({
      method: 'POST', url: '/automations', headers: auth(),
      payload: { name: '회사일 정리', channelId, body, trigger: weekly },
    });
    expect(res.statusCode).toBe(201);
    return res.json().automation as { id: string; nextAt: string };
  }

  async function userMessages() {
    const res = await app.inject({ method: 'GET', url: `/channels/${channelId}/messages`, headers: auth() });
    return (res.json().messages as Array<{ kind: string; body: string; authorId: string; meta: Record<string, any> }>)
      .filter((m) => m.kind === 'user');
  }

  it('만들면 다음 회차가 잡히고, 목록은 만든 사람에게만 보인다', async () => {
    const a = await create();
    expect(new Date(a.nextAt).getTime()).toBeGreaterThan(Date.now());
    const mine = await app.inject({ method: 'GET', url: '/automations', headers: auth() });
    expect(mine.json().automations.map((x: { id: string }) => x.id)).toContain(a.id);
    const theirs = await app.inject({ method: 'GET', url: '/automations', headers: { authorization: `Bearer ${adminToken}` } });
    expect(theirs.json().automations).toHaveLength(0);
  });

  it('잘못된 tz·시각은 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/automations', headers: auth(),
      payload: { name: 'x', channelId, body: 'x', trigger: { ...weekly, tz: 'Mars/Base' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('에이전트는 만들 수 없다', async () => {
    const agent = await createAgent(app, adminToken, 'autobot');
    const res = await app.inject({
      method: 'POST', url: '/automations', headers: { authorization: `Bearer ${agent.pat}` },
      payload: { name: 'x', channelId, body: 'x', trigger: weekly },
    });
    expect(res.statusCode).toBe(403);
  });

  it('시각이 되면 만든 사람 이름으로 글이 나가고 meta.automation 이 붙는다. 밀린 회차는 한 번만', async () => {
    const a = await create('주간 {{lastWeek}}');
    // 3주 전 회차로 돌려 둔다 — 서버가 꺼져 있던 상황.
    await pool.query(`update automation set next_at = now() - interval '21 days' where id = $1`, [a.id]);
    const sweeper = createAutomationSweeper(pool);
    await sweeper.sweep();
    await sweeper.sweep();
    const msgs = (await userMessages()).filter((m) => m.meta?.automation?.id === a.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.authorId).toBe(user.accountId);
    expect(msgs[0]!.body).toMatch(/^주간 \d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/);
    const row = (await pool.query(`select next_at from automation where id = $1`, [a.id])).rows[0];
    expect(new Date(row.next_at).getTime()).toBeGreaterThan(Date.now());
    const detail = await app.inject({ method: 'GET', url: `/automations/${a.id}`, headers: auth() });
    expect(detail.json().runs).toHaveLength(1);
    expect(detail.json().runs[0]).toMatchObject({ status: 'sent', triggerKind: 'schedule' });
  });

  it('지금 한 번 돌리기는 꺼진 자동화도 돌린다', async () => {
    const a = await create('수동 실행');
    await app.inject({ method: 'PATCH', url: `/automations/${a.id}`, headers: auth(), payload: { enabled: false } });
    const run = await app.inject({ method: 'POST', url: `/automations/${a.id}/run`, headers: auth() });
    expect(run.statusCode).toBe(202);
    await createAutomationSweeper(pool).sweep();
    const msgs = (await userMessages()).filter((m) => m.meta?.automation?.id === a.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.meta.automation.trigger).toBe('manual');
  });

  it('게시가 거부되면(보관된 채널) 실패로 적고 일시정지한다', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` }, payload: { name: 'auto-archive' },
    });
    const cid = ch.json().id;
    await app.inject({
      method: 'POST', url: `/channels/${cid}/members`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountId: user.accountId },
    });
    const created = await app.inject({
      method: 'POST', url: '/automations', headers: auth(),
      payload: { name: 'y', channelId: cid, body: 'y', trigger: weekly },
    });
    const id = created.json().automation.id;
    await pool.query(`update channel set archived_at = now() where id = $1`, [cid]);
    await app.inject({ method: 'POST', url: `/automations/${id}/run`, headers: auth() });
    await createAutomationSweeper(pool).sweep();
    const detail = await app.inject({ method: 'GET', url: `/automations/${id}`, headers: auth() });
    expect(detail.json().automation).toMatchObject({ enabled: false, pausedReason: 'post_refused:channel_archived' });
    expect(detail.json().runs[0]).toMatchObject({ status: 'failed', error: 'channel_archived' });

    // 다시 켜면 사유가 비고 다음 회차가 새로 잡힌다.
    const re = await app.inject({ method: 'PATCH', url: `/automations/${id}`, headers: auth(), payload: { enabled: true } });
    expect(re.json().automation).toMatchObject({ enabled: true, pausedReason: null, consecutiveFailures: 0 });
    expect(re.json().automation.nextAt).not.toBeNull();
  });

  it(`한 시간에 ${RATE_LIMIT_PER_HOUR}회를 넘기면 멈춘다`, async () => {
    const a = await create('폭주');
    for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
      await pool.query(
        `insert into automation_run (automation_id, event_key, trigger_kind, status) values ($1, $2, 'manual', 'sent')`,
        [a.id, `seed:${i}`],
      );
    }
    const run = await app.inject({ method: 'POST', url: `/automations/${a.id}/run`, headers: auth() });
    expect(run.statusCode).toBe(429);
    const detail = await app.inject({ method: 'GET', url: `/automations/${a.id}`, headers: auth() });
    expect(detail.json().automation).toMatchObject({ enabled: false, pausedReason: 'rate_limited' });
  });

  it('지우면 목록에서 빠지고, 남은 대기 회차는 skipped 로 닫힌다', async () => {
    const a = await create('지울 것');
    await app.inject({ method: 'POST', url: `/automations/${a.id}/run`, headers: auth() });
    const del = await app.inject({ method: 'DELETE', url: `/automations/${a.id}`, headers: auth() });
    expect(del.statusCode).toBe(204);
    await createAutomationSweeper(pool).sweep();
    const run = (await pool.query(`select status, error from automation_run where automation_id = $1`, [a.id])).rows[0];
    expect(run).toMatchObject({ status: 'skipped', error: 'automation_deleted' });
    const mine = await app.inject({ method: 'GET', url: '/automations', headers: auth() });
    expect(mine.json().automations.map((x: { id: string }) => x.id)).not.toContain(a.id);
  });
});
