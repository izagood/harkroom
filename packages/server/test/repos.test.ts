// 저장소 설정(051). 이 시험이 지키는 것은 **이행이 조용하다**는 것이다 —
// 마이그레이션이 기존 바인딩을 들여오되 아무 동작도 바꾸지 않아야 한다.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { ensureRepo, getRepo, listRepos, resolveRepoBaseUrl, updateRepo } from '../src/services/repos.js';

let pool: Pool;
let stop: () => Promise<void>;

beforeAll(async () => { const db = await startTestDb(); pool = db.pool; stop = db.stop; });
afterAll(async () => { await stop(); });
beforeEach(async () => { await pool.query(`delete from repo`); });

describe('repo 레코드', () => {
  it('기본값은 지금까지의 모양이다 — linked · 전역을 따른다', async () => {
    const row = await ensureRepo(pool, 'izagood/murmur');

    expect(row.slug).toBe('izagood/murmur');
    expect(row.mode).toBe('linked');
    // null 은 '없음' 이 아니라 '전역을 따른다' 다. 그래서 051 뒤에도 동작이 같다.
    expect(row.baseUrl).toBeNull();
  });

  it('두 번 불러도 행은 하나다 — 읽는 쪽이 아무 때나 부를 수 있어야 한다', async () => {
    const first = await ensureRepo(pool, 'izagood/avcs');
    const second = await ensureRepo(pool, 'izagood/avcs');

    expect(second.id).toBe(first.id);
    expect(await listRepos(pool)).toHaveLength(1);
  });

  it('저장소가 자기 주소를 들면 그것이 전역을 이긴다', async () => {
    await ensureRepo(pool, 'acme/web');
    await updateRepo(pool, 'acme/web', { baseUrl: 'http://repo.avcs.test:8420' });

    const row = await getRepo(pool, 'acme/web');
    expect(resolveRepoBaseUrl(row, 'http://global.avcs.test:4000')).toBe('http://repo.avcs.test:8420');
  });

  it('주소를 null 로 되돌리면 다시 전역을 따른다 — 지우기가 아니라 되돌리기다', async () => {
    await ensureRepo(pool, 'acme/web');
    await updateRepo(pool, 'acme/web', { baseUrl: 'http://repo.avcs.test:8420' });
    await updateRepo(pool, 'acme/web', { baseUrl: null });

    const row = await getRepo(pool, 'acme/web');
    expect(row?.baseUrl).toBeNull();
    expect(resolveRepoBaseUrl(row, 'http://global.avcs.test:4000')).toBe('http://global.avcs.test:4000');
  });

  it('전역도 저장소 주소도 없으면 읽을 곳이 없다(null)', async () => {
    const row = await ensureRepo(pool, 'acme/web');
    expect(resolveRepoBaseUrl(row, null)).toBeNull();
  });

  it('hosted 는 murmur 자신의 주소를 쓴다 — 전역이 있어도 그쪽을 보지 않는다', async () => {
    await ensureRepo(pool, 'acme/web');
    const row = await updateRepo(pool, 'acme/web', { mode: 'hosted' });

    expect(row?.mode).toBe('hosted');
    expect(resolveRepoBaseUrl(row, 'http://global.avcs.test:4000', 'http://127.0.0.1:1234'))
      .toBe('http://127.0.0.1:1234');
  });

  it('hosted 인데 호스트가 안 떴으면 읽을 곳이 없다 — 조용히 전역으로 떨어지지 않는다', async () => {
    await ensureRepo(pool, 'acme/web');
    const row = await updateRepo(pool, 'acme/web', { mode: 'hosted' });

    // 떨어지면 hosted 로 바꾼 저장소가 계속 바깥 서버를 읽고, 화면은 그 사실을 말할 수 없다.
    expect(resolveRepoBaseUrl(row, 'http://global.avcs.test:4000', null)).toBeNull();
  });

  it('모르는 mode 는 DB 가 거절한다', async () => {
    await ensureRepo(pool, 'acme/web');
    await expect(
      pool.query(`update repo set mode = 'mirror' where slug = 'acme/web'`),
    ).rejects.toThrow();
  });

  it('같은 slug 는 두 번 들어가지 않는다', async () => {
    await ensureRepo(pool, 'acme/web');
    await expect(pool.query(`insert into repo (slug) values ('acme/web')`)).rejects.toThrow();
  });
});
