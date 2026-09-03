import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let botPat: string;
let baseUrl: string;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: botPat } = await createAgent(app, adminToken, 'metricsbot'));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await app.close(); await stop(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const scrape = async (token = adminToken): Promise<string> =>
  (await app.inject({ method: 'GET', url: '/metrics', headers: auth(token) })).body;

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('GET /metrics', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('serves the prometheus exposition format to an agent PAT', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: auth(botPat) });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('# TYPE murmur_http_requests_total counter');
  });

  it('counts requests under the route pattern, not the concrete path', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'metrics-ch' },
    });
    const channelId = ch.json().id as string;
    await app.inject({ method: 'GET', url: `/channels/${channelId}/messages`, headers: auth(adminToken) });

    const text = await scrape();

    // 구체 경로가 라벨로 들어가면 채널마다 시계열이 하나씩 생긴다.
    expect(text).toContain('route="/channels/:id/messages"');
    expect(text).not.toContain(channelId);
  });

  it('separates error responses so an error rate is computable', async () => {
    await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'admin', password: 'wrong' },
    });

    const text = await scrape();

    expect(text).toMatch(/murmur_http_requests_total\{method="POST",route="\/auth\/login",status="401"\} \d+/);
  });

  it('reports live websocket connections as a gauge', async () => {
    const ticket = (await app.inject({
      method: 'POST', url: '/ws-ticket', headers: auth(adminToken),
    })).json().ticket as string;
    const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('message', (d) => {
        if ((JSON.parse(String(d)) as { type?: string }).type === 'presence.snapshot') resolve();
      });
    });

    expect(await scrape()).toMatch(/murmur_ws_connections 1/);

    ws.close();
    await waitFor(async () => /murmur_ws_connections 0/.test(await scrape()));
  });

  // #48 이 테스트로 고정한 결함: avcs 를 murmur 커서 뒤로 되돌리면 조용히 건너뛴다.
  // 채널에는 아무 일도 없어 보이므로, 그 침묵이 숫자로 보여야 한다.
  it('exposes the projection cursor per repo so a silent stall is visible', async () => {
    await pool.query(
      `insert into projection_cursor (repo, last_log_index) values ('metrics/repo', 42)
       on conflict (repo) do update set last_log_index = 42`,
    );

    expect(await scrape()).toContain('murmur_projection_cursor{repo="metrics/repo"} 42');
  });

  // /metrics 자체가 카운터를 올리면 스크레이프 주기가 곧 트래픽으로 보인다.
  it('does not count its own scrapes', async () => {
    await scrape();
    const text = await scrape();

    expect(text).not.toContain('route="/metrics"');
  });
});

// 2026-09-01 도그푸딩에서 실제로 난 실패: 사용자가 에이전트를 불렀는데 **러너 프로세스가 죽어**
// 답이 없었다. 서버는 정상이고 기존 메트릭도 정상이었다 — 어디에도 신호가 없었다.
// inbox 에 부름이 쌓이는 것만 보였으므로, 그 나이를 게이지로 노출해 침묵을 숫자로 만든다.
// (투영이 조용히 멈춘 것을 커서 게이지로 보이게 한 것과 같은 종류다.)
describe('에이전트 백로그 게이지', () => {
  const oldestFor = (text: string, handle: string): number | null => {
    const m = new RegExp(`murmur_agent_oldest_unread_seconds\\{handle="${handle}"\\} ([0-9.]+)`).exec(text);
    return m ? Number(m[1]) : null;
  };

  it('emits nothing while every call has been handled', async () => {
    const text = await scrape();

    // 이 파일의 다른 테스트가 만든 에이전트에게는 미처리 부름이 없다.
    expect(text).not.toContain('murmur_agent_oldest_unread_seconds{handle="metricsbot"}');
  });

  it('reports how long an agent has left a call unhandled', async () => {
    const bot = await createAgent(app, adminToken, 'stalledbot');
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'stalled' },
    });
    const msg = await app.inject({
      method: 'POST', url: `/channels/${ch.json().id}/messages`, headers: auth(adminToken),
      payload: { body: '@stalledbot 안녕?' },
    });
    // 나이를 결정적으로 재려면 시각을 밀어야 한다 — 5분 전에 불린 것으로 만든다.
    await pool.query(
      `update inbox set created_at = now() - interval '5 minutes'
       where message_id = $1 and account_id = (select id from account where handle = 'stalledbot')`,
      [msg.json().id],
    );

    const age = oldestFor(await scrape(), 'stalledbot');

    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(300);
    expect(bot.pat).toBeTruthy();
  });

  it('drops the series once the agent handles the call', async () => {
    const bot = await createAgent(app, adminToken, 'catchupbot');
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'catchup' },
    });
    await app.inject({
      method: 'POST', url: `/channels/${ch.json().id}/messages`, headers: auth(adminToken),
      payload: { body: '@catchupbot ping' },
    });
    expect(oldestFor(await scrape(), 'catchupbot')).not.toBeNull();

    const inbox = await app.inject({ method: 'GET', url: '/inbox', headers: auth(bot.pat) });
    const ids = (inbox.json().entries as { id: number }[]).map((e) => e.id);
    await app.inject({ method: 'POST', url: '/inbox/read', headers: auth(bot.pat), payload: { ids } });

    expect(oldestFor(await scrape(), 'catchupbot')).toBeNull();
  });

  // 사람이 멘션을 늦게 읽는 것은 운영 장애가 아니다(자고 있을 수 있다). 여기에 사람을 섞으면
  // 경보가 늘 울려서 경보가 신호를 잃는다.
  it('leaves humans out — a person reading late is not an outage', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'human-mention' },
    });
    const bot = await createAgent(app, adminToken, 'callerbot');
    await app.inject({
      method: 'POST', url: `/channels/${ch.json().id}/messages`, headers: auth(bot.pat),
      payload: { body: '@admin 봐주세요' },
    });

    expect(oldestFor(await scrape(), 'admin')).toBeNull();
  });
});

// 실사용에서 드러난 거짓 경보(2026-09-01, 병렬 세션 발견): `kind='agent'` 이지만 **러너가 없는**
// 계정이 있다 — avcs 투영용 시스템 계정(`murmur`)과 정의 없이 만들어진 계정들이다. 사용자는
// 사이드바에 보이니 자연스럽게 부르고, 그 미처리는 **영원히 쌓이며 절대 내려오지 않는다.**
// 경보가 몇 번 반복되면 사람이 경보를 무시하게 되고, 그때 진짜 러너가 죽으면 아무도 안 본다.
// 사람을 뺀 논리(늦게 읽는 것은 장애가 아니다)가 에이전트 안에 한 겹 더 있었다.
describe('백로그 게이지는 답할 의무가 있는 에이전트만 센다', () => {
  const seriesFor = (text: string, handle: string): boolean =>
    text.includes(`murmur_agent_oldest_unread_seconds{handle="${handle}"}`);

  const callInChannel = async (handle: string): Promise<void> => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: `call-${handle}` },
    });
    await app.inject({
      method: 'POST', url: `/channels/${ch.json().id}/messages`, headers: auth(adminToken),
      payload: { body: `@${handle} 부른다` },
    });
  };

  it('counts an agent that murmur can actually run', async () => {
    await createAgent(app, adminToken, 'runnablebot');
    await callInChannel('runnablebot');

    expect(seriesFor(await scrape(), 'runnablebot')).toBe(true);
  });

  // 정의(agent_config)가 없는 계정은 답할 러너가 없고 앞으로도 없다. 그 미처리는 장애가 아니다.
  it('leaves out an agent account that has no definition', async () => {
    await pool.query(
      `insert into account (handle, display_name, kind) values ('undefinedbot', 'undefinedbot', 'agent')`,
    );
    await callInChannel('undefinedbot');

    const text = await scrape();
    expect(seriesFor(text, 'undefinedbot')).toBe(false);
    // 같은 스크레이프에서 정의된 에이전트는 여전히 보여야 한다 — 통째로 사라지면 안 된다.
    expect(seriesFor(text, 'runnablebot')).toBe(true);
  });

  // avcs 투영용 시스템 계정. 투영 워커가 만들고 러너는 없다.
  it('leaves out the avcs projection system account', async () => {
    const { ensureSystemAccount } = await import('../src/avcs/projection.js');
    await ensureSystemAccount(pool);
    await callInChannel('murmur');

    expect(seriesFor(await scrape(), 'murmur')).toBe(false);
  });
});
