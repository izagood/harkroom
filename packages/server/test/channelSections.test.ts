import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';

/**
 * 사이드바 섹션 표(136). 확인하는 것은 셋이다 —
 * ① 새 길(`/channel-sections`, `sectionId`)이 빈 섹션·순서·접힘·지우기/되돌리기를 담는다
 * ② 옛 길(`section` 이름, `/channels/sections/:name`)이 같은 행을 쓴다 — 거울이 어긋나지 않는다
 * ③ 남의 섹션은 없는 것과 같다
 */

let app: FastifyInstance;
let pool: pg.Pool;
let stop: () => Promise<void>;
let meToken: string;
let otherToken: string;
let otherId: string;
const channels: string[] = [];
let dmId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

type Section = { id: string; name: string; position: number; collapsed: boolean };
type Pref = { channelId: string; section: string | null; sectionId: string | null; sortOrder: number | null };

const prefsOf = async (token: string) => {
  const res = await app.inject({ method: 'GET', url: '/channels/prefs', headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json() as { prefs: Pref[]; sections: Section[] };
};
const create = (token: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/channel-sections', headers: auth(token), payload });
const patchSection = (token: string, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/channel-sections/${id}`, headers: auth(token), payload });
const setPref = (token: string, channelId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/channels/${channelId}/pref`, headers: auth(token), payload });

/** 이 계정의 섹션을 모두 지운다 — 각 it 가 빈 사이드바에서 시작하게. */
const clearSections = async (token: string) => {
  for (const s of (await prefsOf(token)).sections) {
    await app.inject({ method: 'DELETE', url: `/channel-sections/${s.id}`, headers: auth(token) });
  }
};

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: meToken } = await bootstrapAdmin(app));
  ({ token: otherToken, accountId: otherId } = await createMember(app, meToken, 'sectionother'));
  for (const name of ['sec-a', 'sec-b', 'sec-c']) {
    const res = await app.inject({ method: 'POST', url: '/channels', headers: auth(meToken), payload: { name } });
    channels.push(res.json().id as string);
    await app.inject({
      method: 'POST', url: `/channels/${res.json().id}/members`, headers: auth(meToken),
      payload: { accountId: otherId },
    });
  }
  const dm = await app.inject({ method: 'POST', url: '/dms', headers: auth(meToken), payload: { accountIds: [otherId] } });
  dmId = dm.json().id as string;
});
afterAll(async () => { await app.close(); await stop(); });

describe('channel sections (136)', () => {
  it('빈 섹션을 만들고, 순서대로 돌려준다', async () => {
    await clearSections(meToken);
    const a = await create(meToken, { name: ' 회사 ' });
    expect(a.statusCode).toBe(201);
    expect(a.json().section).toMatchObject({ name: '회사', position: 0, collapsed: false });
    await create(meToken, { name: '개인' });
    const first = await create(meToken, { name: '실험', position: 0 });
    expect(first.json().section.position).toBe(0);

    const { sections } = await prefsOf(meToken);
    expect(sections.map((s) => [s.name, s.position])).toEqual([['실험', 0], ['회사', 1], ['개인', 2]]);
  });

  it('이름이 비었거나 이미 있으면 거절한다', async () => {
    await clearSections(meToken);
    expect((await create(meToken, { name: '   ' })).statusCode).toBe(400);
    expect((await create(meToken, { name: 'x'.repeat(41) })).statusCode).toBe(400);
    await create(meToken, { name: '회사' });
    expect((await create(meToken, { name: '회사' })).json().error.code).toBe('section_exists');
    const b = (await create(meToken, { name: '개인' })).json().section as Section;
    const clash = await patchSection(meToken, b.id, { name: '회사' });
    expect(clash.statusCode).toBe(409);
    // 같은 이름은 계정마다 따로다(D1).
    expect((await create(otherToken, { name: '회사' })).statusCode).toBe(201);
  });

  it('sectionId 로 넣고 빼면 이름 거울도 같이 바뀐다', async () => {
    await clearSections(meToken);
    const s = (await create(meToken, { name: '회사' })).json().section as Section;
    const put = await setPref(meToken, channels[0]!, { sectionId: s.id });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ sectionId: s.id, section: '회사' });

    await patchSection(meToken, s.id, { name: '본업' });
    const after = (await prefsOf(meToken)).prefs.find((p) => p.channelId === channels[0]);
    expect(after).toMatchObject({ sectionId: s.id, section: '본업' });

    const out = await setPref(meToken, channels[0]!, { sectionId: null });
    expect(out.json()).toMatchObject({ sectionId: null, section: null });
  });

  it('접기만 보내면 이름은 그대로다', async () => {
    await clearSections(meToken);
    const s = (await create(meToken, { name: '회사' })).json().section as Section;
    const res = await patchSection(meToken, s.id, { collapsed: true });
    expect(res.json().section).toMatchObject({ name: '회사', collapsed: true });
  });

  it('지우면 채널은 미분류로 가고, 응답으로 원래 모양 그대로 되살릴 수 있다', async () => {
    await clearSections(meToken);
    await create(meToken, { name: '앞' });
    const s = (await create(meToken, { name: '회사' })).json().section as Section;
    await create(meToken, { name: '뒤' });
    await setPref(meToken, channels[0]!, { sectionId: s.id });
    await setPref(meToken, channels[1]!, { sectionId: s.id });

    const del = await app.inject({ method: 'DELETE', url: `/channel-sections/${s.id}`, headers: auth(meToken) });
    expect(del.statusCode).toBe(200);
    const removed = del.json() as { section: Section; channelIds: string[] };
    expect(removed.section).toMatchObject({ name: '회사', position: 1 });
    expect(removed.channelIds).toEqual([channels[0], channels[1]].sort());

    let state = await prefsOf(meToken);
    expect(state.sections.map((x) => [x.name, x.position])).toEqual([['앞', 0], ['뒤', 1]]);
    expect(state.prefs.filter((p) => removed.channelIds.includes(p.channelId)).every((p) => p.sectionId === null && p.section === null)).toBe(true);

    // 되돌리기 — 지운 응답만으로 한 번에.
    const undo = await create(meToken, {
      name: removed.section.name, position: removed.section.position, channelIds: removed.channelIds,
    });
    expect(undo.statusCode).toBe(201);
    state = await prefsOf(meToken);
    expect(state.sections.map((x) => x.name)).toEqual(['앞', '회사', '뒤']);
    const restoredId = undo.json().section.id as string;
    expect(state.prefs.filter((p) => p.sectionId === restoredId).map((p) => p.channelId).sort()).toEqual(removed.channelIds);
  });

  it('순서 바꾸기는 섹션 전부를 받고, 집합이 다르면 409', async () => {
    await clearSections(meToken);
    const ids = [] as string[];
    for (const name of ['a', 'b', 'c']) ids.push(((await create(meToken, { name })).json().section as Section).id);
    const ok = await app.inject({
      method: 'PUT', url: '/channel-sections/order', headers: auth(meToken), payload: { ids: [ids[2], ids[0], ids[1]] },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json().sections as Section[]).map((s) => s.name)).toEqual(['c', 'a', 'b']);

    const partial = await app.inject({
      method: 'PUT', url: '/channel-sections/order', headers: auth(meToken), payload: { ids: [ids[0], ids[1]] },
    });
    expect(partial.statusCode).toBe(409);
    const dup = await app.inject({
      method: 'PUT', url: '/channel-sections/order', headers: auth(meToken), payload: { ids: [ids[0], ids[0], ids[1]] },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('남의 섹션은 없는 것과 같다', async () => {
    await clearSections(meToken);
    const mine = (await create(meToken, { name: '내것' })).json().section as Section;
    expect((await patchSection(otherToken, mine.id, { name: '뺏기' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/channel-sections/${mine.id}`, headers: auth(otherToken) })).statusCode).toBe(404);
    const steal = await setPref(otherToken, channels[0]!, { sectionId: mine.id });
    expect(steal.statusCode).toBe(404);
    expect(steal.json().error.code).toBe('section_not_found');
    const reorder = await app.inject({
      method: 'PUT', url: '/channel-sections/order', headers: auth(otherToken), payload: { ids: [mine.id] },
    });
    expect(reorder.statusCode).toBe(409);
    expect((await prefsOf(meToken)).sections[0]).toMatchObject({ id: mine.id, name: '내것' });
  });

  it('DM 은 섹션에 넣을 수 없고, section 과 sectionId 를 함께 보내면 400', async () => {
    await clearSections(meToken);
    const s = (await create(meToken, { name: '회사' })).json().section as Section;
    expect((await setPref(meToken, dmId, { sectionId: s.id })).json().error.code).toBe('cannot_section_dm');
    expect((await create(meToken, { name: '디엠', channelIds: [dmId] })).json().error.code).toBe('cannot_section_dm');
    expect((await setPref(meToken, channels[0]!, { section: '회사', sectionId: s.id })).statusCode).toBe(400);
  });

  it('옛 길: 이름으로 넣으면 섹션 행을 찾거나 맨 뒤에 만든다', async () => {
    await clearSections(meToken);
    const s = (await create(meToken, { name: '회사' })).json().section as Section;
    const same = await setPref(meToken, channels[0]!, { section: '회사' });
    expect(same.json()).toMatchObject({ sectionId: s.id, section: '회사' });
    const fresh = await setPref(meToken, channels[1]!, { section: '새것' });
    const { sections } = await prefsOf(meToken);
    expect(sections.map((x) => [x.name, x.position])).toEqual([['회사', 0], ['새것', 1]]);
    expect(fresh.json().sectionId).toBe(sections[1]!.id);
  });

  it('옛 길: 이름 바꾸기·합치기·빼기가 섹션 행에 그대로 비친다', async () => {
    await clearSections(meToken);
    await setPref(meToken, channels[0]!, { section: '하나', sortOrder: 0 });
    await setPref(meToken, channels[1]!, { section: '둘', sortOrder: 0 });
    await setPref(meToken, channels[2]!, { section: '둘', sortOrder: 1 });
    const renameLegacy = (from: string, to: string | null) => app.inject({
      method: 'PATCH', url: `/channels/sections/${encodeURIComponent(from)}`, headers: auth(meToken), payload: { name: to },
    });

    // 이름만 바꾸기 — 같은 행, 이름만 바뀐다.
    const before = (await prefsOf(meToken)).sections.find((x) => x.name === '하나')!;
    await renameLegacy('하나', '첫째');
    let state = await prefsOf(meToken);
    expect(state.sections.find((x) => x.id === before.id)?.name).toBe('첫째');
    expect(state.prefs.find((p) => p.channelId === channels[0])).toMatchObject({ sectionId: before.id, section: '첫째' });

    // 합치기 — 받는 쪽이 앞, 옮긴 섹션 행은 사라진다.
    await renameLegacy('둘', '첫째');
    state = await prefsOf(meToken);
    expect(state.sections.map((x) => [x.name, x.position])).toEqual([['첫째', 0]]);
    const merged = state.prefs.filter((p) => p.sectionId === before.id)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((p) => [p.channelId, p.section]);
    expect(merged).toEqual([[channels[0], '첫째'], [channels[1], '첫째'], [channels[2], '첫째']]);

    // 빼기 — 옛 앱에는 빈 섹션이 없으므로 행도 지운다.
    await renameLegacy('첫째', null);
    state = await prefsOf(meToken);
    expect(state.sections).toEqual([]);
    expect(state.prefs.filter((p) => channels.includes(p.channelId)).every((p) => p.sectionId === null && p.section === null)).toBe(true);
  });

  it('136 옮겨 담기: 이름 문자열마다 섹션 행 하나, 이름순 자리, 채널이 그 행을 가리킨다', async () => {
    await clearSections(meToken);
    await clearSections(otherToken);
    // 136 이전 모양을 손으로 만든다 — 이름 문자열만 있고 section_id 는 없다.
    await pool.query(`delete from channel_section where account_id = $1`, [otherId]);
    for (const [channelId, name] of [[channels[0], '나중'], [channels[1], '가나'], [channels[2], '나중']] as const) {
      await pool.query(
        `insert into channel_pref (account_id, channel_id, section, section_id) values ($1, $2, $3, null)
         on conflict (account_id, channel_id) do update set section = $3, section_id = null`,
        [otherId, channelId, name],
      );
    }
    const sql = await readFile(new URL('../src/db/migrations/136_channel_section.sql', import.meta.url), 'utf8');
    const backfill = sql.slice(sql.indexOf('-- 옮겨 담기'));
    expect(backfill).toContain('insert into channel_section');
    // 위 clearSections 로 다른 계정에는 섹션이 없다 — 이미 136 을 지난 DB 에 다시 돌려도 겹치지 않는다.
    await pool.query(backfill);

    const { sections, prefs } = await prefsOf(otherToken);
    expect(sections.map((x) => [x.name, x.position])).toEqual([['가나', 0], ['나중', 1]]);
    const idOf = (name: string) => sections.find((x) => x.name === name)!.id;
    expect(prefs.find((p) => p.channelId === channels[0])?.sectionId).toBe(idOf('나중'));
    expect(prefs.find((p) => p.channelId === channels[1])?.sectionId).toBe(idOf('가나'));
    expect(prefs.find((p) => p.channelId === channels[2])?.sectionId).toBe(idOf('나중'));
  });
});
