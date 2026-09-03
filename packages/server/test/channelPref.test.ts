import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { readFile } from 'node:fs/promises';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let otherToken: string;
let otherId: string;
let channelId: string;
let dmId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));

  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  const inviteToken = inv.json().token as string;

  const register = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { handle: 'otheruser', displayName: 'Other User', password: 'pw123456', inviteToken },
  });
  otherId = register.json().id as string;
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { handle: 'otheruser', password: 'pw123456' },
  });
  otherToken = login.json().token as string;

  const created = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'test-channel' },
  });
  channelId = created.json().id as string;

  const dm = await app.inject({
    method: 'POST', url: '/dms', headers: { authorization: `Bearer ${adminToken}` },
    payload: { accountIds: [otherId] },
  });
  dmId = dm.json().id as string;
});
afterAll(async () => { await app.close(); await stop(); });

describe('channel pref', () => {
  it('sets notify level and appears in GET', async () => {
    const set = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notifyLevel: 'none' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().notifyLevel).toBe('none');

    const list = await app.inject({
      method: 'GET', url: '/channels/prefs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    const prefs = list.json().prefs as { channelId: string; notifyLevel: string }[];
    const found = prefs.find((p) => p.channelId === channelId);
    expect(found).not.toBeUndefined();
    expect(found?.notifyLevel).toBe('none');
  });

  it('accepts the middle level', async () => {
    const set = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notifyLevel: 'mentions' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().notifyLevel).toBe('mentions');
  });

  it('rejects an unknown level', async () => {
    const bad = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notifyLevel: 'sometimes' },
    });
    expect(bad.statusCode).toBe(400);
  });

  // `muted` 는 더 이상 받지 않는다(#224). 남겨 두면 아무것도 읽지 않는 스위치가 되어
  // "껐는데 왜 아직 울리나"가 그대로 돌아온다.
  it('no longer accepts a muted patch', async () => {
    const legacy = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { muted: true },
    });
    expect(legacy.statusCode).not.toBe(200);
  });

  it('leaves starred intact when only setting the level', async () => {
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { starred: true },
    });
    const levelOnly = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notifyLevel: 'none' },
    });
    expect(levelOnly.statusCode).toBe(200);
    expect(levelOnly.json().notifyLevel).toBe('none');
    expect(levelOnly.json().starredAt).not.toBeNull();
  });

  it('does not see other account prefs', async () => {
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notifyLevel: 'none' },
    });

    const otherList = await app.inject({
      method: 'GET', url: '/channels/prefs',
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(otherList.statusCode).toBe(200);
    const prefs = otherList.json().prefs as { channelId: string }[];
    const found = prefs.find((p) => p.channelId === channelId);
    expect(found).toBeUndefined();
  });

  it('404s on non-existent channel', async () => {
    const notFound = await app.inject({
      method: 'PATCH', url: '/channels/00000000-0000-0000-0000-000000000000/pref',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notifyLevel: 'none' },
    });
    expect(notFound.statusCode).toBe(404);
  });

  describe('section (#157)', () => {
    it('sets section on channel', async () => {
      const set = await app.inject({
        method: 'PATCH', url: `/channels/${channelId}/pref`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { section: 'My Section' },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json().section).toBe('My Section');
    });

    it('converts empty string to null', async () => {
      const set = await app.inject({
        method: 'PATCH', url: `/channels/${channelId}/pref`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { section: '' },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json().section).toBeNull();
    });

    it('converts whitespace-only to null', async () => {
      const set = await app.inject({
        method: 'PATCH', url: `/channels/${channelId}/pref`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { section: '   ' },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json().section).toBeNull();
    });

    it('rejects section longer than 40 characters', async () => {
      const set = await app.inject({
        method: 'PATCH', url: `/channels/${channelId}/pref`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { section: 'a'.repeat(41) },
      });
      expect(set.statusCode).toBe(400);
    });

    it('returns 400 when setting section on DM', async () => {
      const set = await app.inject({
        method: 'PATCH', url: `/channels/${dmId}/pref`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { section: 'Test Section' },
      });
      expect(set.statusCode).toBe(400);
      expect(set.json().error.code).toBe('cannot_section_dm');
    });

    it('only affects own preference - other account sees no section', async () => {
      await app.inject({
        method: 'PATCH', url: `/channels/${channelId}/pref`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { section: 'Admin Section' },
      });

      const otherList = await app.inject({
        method: 'GET', url: '/channels/prefs',
        headers: { authorization: `Bearer ${otherToken}` },
      });
      const prefs = otherList.json().prefs as { channelId: string; section: string | null }[];
      const found = prefs.find((p) => p.channelId === channelId);
      expect(found).toBeUndefined();
    });

    it('sets sortOrder', async () => {
      const set = await app.inject({
        method: 'PATCH', url: `/channels/${channelId}/pref`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { section: 'Test', sortOrder: 5 },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json().section).toBe('Test');
      expect(set.json().sortOrder).toBe(5);
    });

  // 조건부 `return` 으로 빠져나가지 않는다. 원래 여기에 "healthz 가 200 이 아니면 건너뛴다"
  // 가 있었는데, 그 분기는 마이그레이션 적용 여부와 아무 상관이 없고 초록으로 통과하는
  // 길만 하나 더 만든다 — 건너뛴 테스트는 지키지 않은 테스트다.
  it('removes section when set to null', async () => {
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { section: 'To Remove' },
    });

    const remove = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { section: null },
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json().section).toBeNull();
  });

  /**
   * 한쪽만 보낸 요청이 다른 쪽을 지우지 않는다(#157).
   *
   * 실측 결함이었다: `section` 과 `sort_order` 를 한 문장에서 함께 써서, "위로/아래로"가
   * 보내는 `sortOrder` 만 든 요청이 그 채널의 `section` 을 null 로 만들었다 — 누를 때마다
   * 채널이 방금 넣은 섹션에서 빠져나왔다.
   */
  it('sortOrder 만 보내도 section 이 남는다', async () => {
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { section: 'Keep Me' },
    });

    const moved = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { sortOrder: 3 },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().section).toBe('Keep Me');
    expect(moved.json().sortOrder).toBe(3);
  });

  it('section 만 보내도 sortOrder 가 남는다', async () => {
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { section: 'Anywhere', sortOrder: 7 },
    });

    const renamed = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { section: 'Renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().section).toBe('Renamed');
    expect(renamed.json().sortOrder).toBe(7);
  });

  it('sortOrder 를 명시적 null 로 지울 수 있다', async () => {
    await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { sortOrder: 9 },
    });
    const cleared = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { sortOrder: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().sortOrder).toBeNull();
  });

  /**
   * 볼 수 없는 채널에 대한 응답은 그 채널이 DM 이라는 사실도 말하지 않는다.
   *
   * DM 검사를 가시성 검사보다 앞에 두면 남의 DM 에 섹션을 붙여 보는 것만으로 400
   * (`cannot_section_dm`)과 403 이 갈려 종류가 새 나간다.
   */
  it('남의 DM 에 섹션을 붙이면 400 이 아니라 403 이다 — 종류를 흘리지 않는다', async () => {
    const { pat: strangerPat } = await createAgent(app, adminToken, 'section-stranger');
    const res = await app.inject({
      method: 'PATCH', url: `/channels/${dmId}/pref`,
      headers: { authorization: `Bearer ${strangerPat}` },
      payload: { section: 'Peek' },
    });
    expect(res.statusCode).toBe(403);
  });

  /**
   * 5. `listChannels` 의 SQL 을 **바꾸지 않았다**.
   *
   * `COLS` 와 `order by name` 을 건드리면 모든 채널 조회 경로가 영향을 받는다. 섹션은
   * 선호에 실려 오고 사이드바가 그룹핑하는 것이 이 작업의 결정이었다 — 문자열로 못박는다.
   */
  it('5. listChannels 의 SQL 이 그대로다 — COLS 와 order by name', async () => {
    const src = await readFile(new URL('../src/services/channels.ts', import.meta.url), 'utf8');
    const cols = /^const COLS = `([^`]*)`/m.exec(src);
    expect(cols).not.toBeNull();
    expect(cols![1]).toBe(
      'id, name, topic, kind, repo, archived_at as "archivedAt", visibility, created_at as "createdAt"',
    );
    expect(cols![1]).not.toContain('section');
    expect(cols![1]).not.toContain('sort_order');

    const listBody = src.slice(src.indexOf('export async function listChannels')).slice(0, 700);
    expect(listBody).toContain('order by name');
    expect(listBody).not.toContain('sort_order');
    expect(listBody).not.toContain('section');
  });
});
});
