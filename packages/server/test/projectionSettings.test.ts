/**
 * 앱에서 투영 URL 을 켜는 표면(설계 §5). `agentDefaults.test.ts` 와 같은 게이트를 쓴다 —
 * 읽기도 admin 이다: URL 은 인프라 설정이고, 상태(`/projection/status`, requireAccount)와
 * 설정은 다른 표면이다.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let plainToken: string;
const reconfigure = vi.fn(async (_url: string | null) => { /* supervisor 대역 */ });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({
    pool: db.pool,
    // 이 파일은 `/settings/projection` 만 본다 — `/leases`·커서 메트릭이 쓰는 currentUrl 은
    // 여기서 의미 있는 값이 없으므로 스텁만 둔다.
    projection: { envBaseUrl: 'http://env.example:4000', reconfigure, currentUrl: () => null },
  });
  ({ token: adminToken } = await bootstrapAdmin(app));

  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      handle: 'plainuser', loginId: 'plainuser', displayName: 'Plain User', password: 'pw123456',
      inviteToken: inv.json().token as string,
    },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: 'plainuser', password: 'pw123456' },
  });
  plainToken = login.json().token as string;
});
afterAll(async () => { await app.close(); await stop(); });

const admin = () => ({ authorization: `Bearer ${adminToken}` });
const get = (headers = admin()) =>
  app.inject({ method: 'GET', url: '/settings/projection', headers });
const put = (payload: object, headers = admin()) =>
  app.inject({ method: 'PUT', url: '/settings/projection', headers, payload });

beforeEach(async () => {
  reconfigure.mockClear();
  await pool.query(`update projection_config set avcs_base_url = null where id = true`);
});

describe('GET /settings/projection', () => {
  /** 지우기가 무엇으로 복귀하는지 화면이 말해야 한다 — 그래서 envUrl 도 내보낸다. */
  it('앱 값이 없으면 env 를 쓰고 두 출처를 함께 준다', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      url: 'http://env.example:4000', source: 'env',
      appUrl: null, envUrl: 'http://env.example:4000',
    });
  });

  it('앱 값이 있으면 그것이 이긴다', async () => {
    await put({ url: 'http://app.example:5000' });
    expect((await get()).json()).toEqual({
      url: 'http://app.example:5000', source: 'app',
      appUrl: 'http://app.example:5000', envUrl: 'http://env.example:4000',
    });
  });

  it('admin 이 아니면 403 이다', async () => {
    expect((await get({ authorization: `Bearer ${plainToken}` })).statusCode).toBe(403);
  });
});

describe('PUT /settings/projection', () => {
  it('저장한 URL 로 워커를 갈아 끼운다', async () => {
    const res = await put({ url: 'http://app.example:5000' });

    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe('app');
    expect(reconfigure).toHaveBeenCalledWith('http://app.example:5000');
  });

  /** 지우기는 명시적 null 이다. 지운 뒤 돌아갈 곳이 env 이므로 그 값으로 재설정된다. */
  it('null 로 지우면 env 로 복귀하고 그 값으로 재설정한다', async () => {
    await put({ url: 'http://app.example:5000' });
    reconfigure.mockClear();

    const res = await put({ url: null });

    expect(res.json()).toMatchObject({ appUrl: null, source: 'env', url: 'http://env.example:4000' });
    expect(reconfigure).toHaveBeenCalledWith('http://env.example:4000');
  });

  /** `z.string().url()` 만으로는 file:·ftp: 가 통과한다. 그것을 서버의 아웃바운드 대상으로
   *  두면 avcs 가 아닌 것을 투영하려 든다. */
  it('http(s) 가 아니면 400 이고 저장도 재설정도 하지 않는다', async () => {
    const res = await put({ url: 'ftp://avcs.example' });

    expect(res.statusCode).toBe(400);
    expect((await get()).json().appUrl).toBeNull();
    expect(reconfigure).not.toHaveBeenCalled();
  });

  it('URL 형태가 아니면 400 이다', async () => {
    expect((await put({ url: 'not a url' })).statusCode).toBe(400);
  });

  it('빈 문자열은 400 이다 — 지우기는 null 이다', async () => {
    expect((await put({ url: '' })).statusCode).toBe(400);
  });

  /**
   * 터미널·Slack 에서 복사해 붙여넣으면 앞뒤 공백이 흔히 딸려 온다. `new URL()` 은 그
   * 공백을 조용히 허용하므로, 자르지 않으면 공백까지 저장되어 매 폴링마다
   * `httpAvcsClient` 가 URL 생성에 실패한다 — 화면에는 멀쩡해 보이는 URL 옆에 `stalled` 만
   * 뜨고 원인은 안 보인다.
   */
  it('앞뒤 공백은 잘라내고 저장한다', async () => {
    const res = await put({ url: '  http://app.example:5000  ' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: 'http://app.example:5000', appUrl: 'http://app.example:5000' });
    expect(reconfigure).toHaveBeenCalledWith('http://app.example:5000');
    expect((await get()).json().appUrl).toBe('http://app.example:5000');
  });

  /** 공백만 있는 값은 트리밍 후 빈 문자열이 되어 지우기(null)와 섞이지 않게 거절한다. */
  it('공백만 있는 값은 400 이다', async () => {
    expect((await put({ url: '   ' })).statusCode).toBe(400);
  });

  it('admin 이 아니면 403 이고 값도 바뀌지 않는다', async () => {
    const res = await put({ url: 'http://intruder.example' }, { authorization: `Bearer ${plainToken}` });

    expect(res.statusCode).toBe(403);
    expect((await get()).json().appUrl).toBeNull();
  });

  /** "누가 서버의 아웃바운드 대상을 바꿨나" 가 이 기록의 존재 이유다. */
  it('변경을 감사에 남긴다', async () => {
    await put({ url: 'http://app.example:5000' });

    const rows = await pool.query(
      `select detail from audit_log where action = 'projection.url.updated' order by id desc limit 1`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.detail).toMatchObject({
      before: { appUrl: null, source: 'env' },
      after: { appUrl: 'http://app.example:5000', source: 'app' },
    });
  });
});

/**
 * 이 표면 없이 서버를 띄우는 테스트가 많다. 등록해 두고 500 을 내는 것보다 404 가 정직하다 —
 * 500 은 "고장났다" 는 뜻이고, 여기서 참인 것은 "그 표면이 없다" 다.
 */
describe('deps.projection 이 없으면', () => {
  it('두 라우트가 404 다', async () => {
    const db = await startTestDb();
    const bare = await buildServer({ pool: db.pool });
    const { token } = await bootstrapAdmin(bare);
    const headers = { authorization: `Bearer ${token}` };

    expect((await bare.inject({ method: 'GET', url: '/settings/projection', headers })).statusCode).toBe(404);
    expect((await bare.inject({
      method: 'PUT', url: '/settings/projection', headers, payload: { url: null },
    })).statusCode).toBe(404);

    await bare.close();
    await db.stop();
  });
});
