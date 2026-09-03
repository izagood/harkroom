import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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
    payload: { handle: 'otheruser', loginId: 'otheruser', displayName: 'Other User', password: 'pw123456', inviteToken },
  });
  otherId = register.json().id as string;
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { loginId: 'otheruser', password: 'pw123456' },
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

/**
 * 섹션 이름 바꾸기(#323).
 *
 * 이름 규칙과 재부여는 **만드는 경로(#157)와 같은 함수**를 쓴다 — 여기서는 그 사실을
 * 규칙을 다시 적어 확인하지 않고, 두 경로에 같은 입력을 넣어 **답이 같은지**로 확인한다.
 * 규칙을 테스트 안에 복제하면 두 경로가 갈라진 날 테스트만 초록으로 남는다.
 */
describe('섹션 이름 바꾸기 (#323)', () => {
  let channelId2: string;
  let channelId3: string;

  type Pref = { channelId: string; section: string | null; sortOrder: number | null };

  const setPref = async (token: string, id: string, section: string | null, sortOrder: number | null) => {
    const res = await app.inject({
      method: 'PATCH', url: `/channels/${id}/pref`,
      headers: { authorization: `Bearer ${token}` },
      payload: { section, sortOrder },
    });
    expect(res.statusCode).toBe(200);
    return res;
  };

  const rename = (oldName: string, newName: string | null, token = adminToken) => app.inject({
    method: 'PATCH', url: `/channels/sections/${encodeURIComponent(oldName)}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: newName },
  });

  const prefsOf = async (token: string): Promise<Pref[]> => {
    const res = await app.inject({
      method: 'GET', url: '/channels/prefs', headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json().prefs as Pref[];
  };

  /** 한 계정의 한 섹션을 `sortOrder` 순 채널 목록으로 뽑는다. 순서가 곧 요구다. */
  const inSection = (prefs: Pref[], section: string | null): Pref[] =>
    prefs.filter((p) => p.section === section)
      .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));

  beforeAll(async () => {
    const c2 = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'channel-2' },
    });
    channelId2 = c2.json().id as string;
    const c3 = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'channel-3' },
    });
    channelId3 = c3.json().id as string;
  });

  /**
   * 테스트마다 세 채널을 **두 계정 모두** 놓고 시작한다. 앞 테스트가 남긴 상태에 기대면
   * 순서를 바꾸는 것만으로 초록이 깨지고, 무엇보다 "남의 선호"가 비어 있는 채로 지나간다.
   */
  beforeEach(async () => {
    for (const id of [channelId, channelId2, channelId3]) {
      await setPref(adminToken, id, null, null);
      await setPref(otherToken, id, null, null);
    }
  });

  it('1. 이름을 바꾸면 그 섹션의 채널 전부가 따라간다', async () => {
    await setPref(adminToken, channelId, 'OldSection', 0);
    await setPref(adminToken, channelId2, 'OldSection', 1);
    await setPref(adminToken, channelId3, null, null);

    const res = await rename('OldSection', 'NewSection');
    expect(res.statusCode).toBe(200);

    // 응답이 곧 새로고침된 목록이다 — 다시 GET 해서 확인할 필요가 없어야 한다.
    const prefs = res.json().prefs as Pref[];
    expect(inSection(prefs, 'OldSection')).toHaveLength(0);
    // 한 채널만 옮기고 끝내면 여기가 1이 된다.
    expect(inSection(prefs, 'NewSection').map((p) => p.channelId)).toEqual([channelId, channelId2]);

    // 저장까지 갔는지 따로 본다. 응답만 만들고 커밋하지 않아도 위 단언은 통과한다.
    expect(inSection(await prefsOf(adminToken), 'NewSection').map((p) => p.channelId))
      .toEqual([channelId, channelId2]);
  });

  it('2. 남의 선호는 안 바뀐다 — 같은 이름을 쓰는 다른 계정이 있어도', async () => {
    // 같은 이름의 섹션을 **남도 쓰고 있어야** `account_id` 필터가 시험된다.
    // 남에게 그 섹션이 없으면 필터를 통째로 빼도 이 테스트는 초록이다.
    await setPref(adminToken, channelId, 'Shared', 0);
    await setPref(adminToken, channelId2, 'Shared', 1);
    await setPref(otherToken, channelId, 'Shared', 7);
    await setPref(otherToken, channelId3, 'Shared', 8);

    const before = await prefsOf(otherToken);

    const res = await rename('Shared', 'AdminOnly');
    expect(res.statusCode).toBe(200);

    // 요청자는 바뀐다.
    expect(inSection(res.json().prefs as Pref[], 'AdminOnly').map((p) => p.channelId))
      .toEqual([channelId, channelId2]);

    // 남은 섹션 이름도 순서도 그대로다.
    const after = await prefsOf(otherToken);
    expect(inSection(after, 'Shared').map((p) => [p.channelId, p.sortOrder]))
      .toEqual([[channelId, 7], [channelId3, 8]]);
    expect(inSection(after, 'AdminOnly')).toHaveLength(0);
    expect(after).toEqual(before);
  });

  it('3. 길이 규칙이 생성과 같다 — 41자는 400, 40자는 200', async () => {
    await setPref(adminToken, channelId, 'Work', 0);

    const long = 'A'.repeat(41);
    const tooLong = await rename('Work', long);
    expect(tooLong.statusCode).toBe(400);

    // 만드는 경로도 같은 답을 낸다. 두 경로가 갈라지면 여기서 갈린다.
    const createTooLong = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { section: long },
    });
    expect(createTooLong.statusCode).toBe(tooLong.statusCode);

    const ok = await rename('Work', 'A'.repeat(40));
    expect(ok.statusCode).toBe(200);
    expect(inSection(ok.json().prefs as Pref[], 'A'.repeat(40))).toHaveLength(1);
  });

  it('3b. 공백 규칙이 생성과 같다 — 앞뒤 공백은 떼고, 공백뿐이면 null', async () => {
    // 만드는 경로의 답을 먼저 받아 둔다. 규칙을 여기 다시 적지 않는 것이 요점이다.
    const created = await setPref(adminToken, channelId2, '  Spaced  ', null);
    const createdSection = (created.json() as Pref).section;

    await setPref(adminToken, channelId, 'Work', 0);
    const renamed = await rename('Work', '  Spaced  ');
    expect(renamed.statusCode).toBe(200);
    const mine = (renamed.json().prefs as Pref[]).find((p) => p.channelId === channelId)!;
    expect(mine.section).toBe(createdSection);

    // 공백뿐인 이름은 양쪽 다 null(섹션 없음)이다.
    const blankCreated = await setPref(adminToken, channelId3, '   ', null);
    expect((blankCreated.json() as Pref).section).toBeNull();
    const blankRenamed = await rename(createdSection!, '   ');
    expect(blankRenamed.statusCode).toBe(200);
    expect(inSection(blankRenamed.json().prefs as Pref[], createdSection)).toHaveLength(0);
  });

  it('4. 이미 있는 이름으로 바꾸면 합쳐지고 sortOrder 가 0..n-1 로 재부여된다', async () => {
    // 두 섹션의 sortOrder 가 겹치게 둔다 — 재부여를 빼면 그대로 중복이 남는다.
    await setPref(adminToken, channelId, 'A', 0);
    await setPref(adminToken, channelId2, 'A', 1);
    await setPref(adminToken, channelId3, 'B', 0);
    // 남도 같은 이름을 쓴다 — 합치기 경로의 `account_id` 필터까지 함께 지킨다.
    await setPref(otherToken, channelId, 'A', 3);
    await setPref(otherToken, channelId3, 'B', 4);

    const res = await rename('A', 'B');
    expect(res.statusCode).toBe(200);

    const merged = inSection(res.json().prefs as Pref[], 'B');
    // 받는 쪽(B)이 앞, 합쳐지는 쪽(A)이 뒤다.
    expect(merged.map((p) => p.channelId)).toEqual([channelId3, channelId, channelId2]);
    expect(merged.map((p) => p.sortOrder)).toEqual([0, 1, 2]);
    expect(new Set(merged.map((p) => p.sortOrder)).size).toBe(3);
    expect(inSection(res.json().prefs as Pref[], 'A')).toHaveLength(0);

    // 남의 A·B 는 이름도 순서도 그대로다.
    const other = await prefsOf(otherToken);
    expect(inSection(other, 'A').map((p) => [p.channelId, p.sortOrder])).toEqual([[channelId, 3]]);
    expect(inSection(other, 'B').map((p) => [p.channelId, p.sortOrder])).toEqual([[channelId3, 4]]);
  });

  it('빈 이름으로 바꾸면 그 섹션의 채널이 전부 null(섹션 없음)이 된다', async () => {
    await setPref(adminToken, channelId, 'Doomed', 0);
    await setPref(adminToken, channelId2, 'Doomed', 1);

    const res = await rename('Doomed', '');
    expect(res.statusCode).toBe(200);
    const prefs = res.json().prefs as Pref[];
    expect(inSection(prefs, 'Doomed')).toHaveLength(0);
    expect(inSection(prefs, null).map((p) => p.channelId)).toContain(channelId);
    expect(inSection(prefs, null).map((p) => p.channelId)).toContain(channelId2);
  });

  it('`name` 을 아예 안 보내면 400 이다 — 빈 본문이 조용히 섹션을 지우지 않는다', async () => {
    await setPref(adminToken, channelId, 'Kept', 0);
    const res = await app.inject({
      method: 'PATCH', url: '/channels/sections/Kept',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(inSection(await prefsOf(adminToken), 'Kept')).toHaveLength(1);
  });

  it('없는 섹션을 바꾸면 아무것도 바뀌지 않는다', async () => {
    await setPref(adminToken, channelId, 'Real', 0);
    const res = await rename('Ghost', 'Something');
    expect(res.statusCode).toBe(200);
    const prefs = res.json().prefs as Pref[];
    expect(inSection(prefs, 'Something')).toHaveLength(0);
    expect(inSection(prefs, 'Real').map((p) => p.channelId)).toEqual([channelId]);
  });
});
});
