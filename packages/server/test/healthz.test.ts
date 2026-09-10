import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
});
afterAll(async () => { await app.close(); await stop(); });

describe('healthz', () => {
  it('GET /healthz returns ok with avcs status', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.avcs).toEqual({ connected: false });
  });

  /**
   * 서버가 **자기 릴리스 번호**를 말한다(#693). 값을 여기에 적어 두면 릴리즈마다 이 줄을
   * 고쳐야 하므로, 정본 파일에서 읽어 견준다 — 이 회귀선이 지키는 것은 숫자가 아니라
   * **"화면에 뜨는 버전과 릴리즈가 올리는 버전이 같은 자리에서 나온다"** 는 사실이다.
   * 그 둘이 갈리면 배포 뒤에야 드러난다(`src/version.ts` 주석).
   */
  it('GET /healthz reports the release version from tauri.conf.json', async () => {
    const conf = JSON.parse(readFileSync(
      new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8',
    )) as { version: string };
    const body = healthBody(await app.inject({ method: 'GET', url: '/healthz' }));
    expect(body.version).toBe(conf.version);
  });

  /**
   * 기동 시각은 **프로세스가 뜬 때**여야 한다. 요청 때마다 새로 재면 항상 '방금'이라
   * "언제 배포된 서버인가"에 답하지 못한다 — 두 번 물어 같은 값인지로 그것을 잰다.
   */
  it('startedAt is fixed for the life of the process', async () => {
    const first = healthBody(await app.inject({ method: 'GET', url: '/healthz' }));
    const second = healthBody(await app.inject({ method: 'GET', url: '/healthz' }));
    expect(first.startedAt).toBe(second.startedAt);
    expect(Number.isFinite(Date.parse(first.startedAt))).toBe(true);
  });

  /**
   * 커밋은 빌드가 심는다(`MURMUR_COMMIT`). **안 심었으면 `null`** — 이 회귀선이 막는 것은
   * 빈 문자열이 화면까지 올라가 '빌드 ' 라는 반쪽 문구가 뜨는 것이다.
   */
  it('commit is null when the build did not stamp one', async () => {
    expect(process.env.MURMUR_COMMIT ?? '').toBe('');
    expect(healthBody(await app.inject({ method: 'GET', url: '/healthz' })).commit).toBeNull();
  });
  it('GET /readyz checks db', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
  });
});

/** 응답 본문을 한 자리에서 꺼낸다 — 위 세 회귀선이 같은 모양을 되풀이하지 않게. */
function healthBody(res: { json(): unknown }): { version: string | null; commit: string | null; startedAt: string } {
  return res.json() as { version: string | null; commit: string | null; startedAt: string };
}
