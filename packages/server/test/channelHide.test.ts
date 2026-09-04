import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
// 바꾼 프로덕션 파일을 **직접** 부른다. 라우트만 통과시키면 응답이 맞는데 저장이 틀린 경우가
// 초록으로 남는다 — 숨김은 저장된 상태가 곧 사실이므로 저장을 직접 읽는다.
import { getChannelPref, updateChannelPref } from '../src/services/channels.js';
import { postMessage } from '../src/services/messages.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let meToken: string;
let meId: string;
let channelId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** 사람이 실제로 쓰는 길(메뉴 → PATCH)로 숨긴다. 서비스를 직접 부르면 라우트가 막는 경우를 못 본다. */
async function setHidden(token: string, id: string, hidden: boolean): Promise<number> {
  const res = await app.inject({
    method: 'PATCH', url: `/channels/${id}/pref`, headers: auth(token), payload: { hidden },
  });
  return res.statusCode;
}

const hiddenAtOf = async (accountId: string, id: string): Promise<string | null> =>
  (await getChannelPref(pool, accountId, id))?.hiddenAt ?? null;

async function messageCount(id: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `select count(*)::text as n from message where channel_id = $1`, [id],
  );
  return Number(res.rows[0]!.n);
}

/**
 * 바꾼 프로덕션 파일(`postMessage`)로 직접 게시하고 **불린 사람들**을 돌려준다.
 *
 * 합 타입을 여기서 한 번 좁힌다 — 첨부 거절 분기에는 `notified` 가 없으므로, 좁히지 않으면
 * 각 테스트가 `!` 로 뭉개게 되고 게시가 조용히 실패한 채 초록이 될 자리가 생긴다.
 */
async function post(authorId: string, body: string): Promise<string[]> {
  const res = await postMessage(pool, { channelId, authorId, body });
  if (!res.message) throw new Error(`게시가 거절됐다: ${JSON.stringify(res.failure)}`);
  return res.notified;
}

async function memberCount(id: string, accountId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `select count(*)::text as n from channel_member where channel_id = $1 and account_id = $2`,
    [id, accountId],
  );
  return Number(res.rows[0]!.n);
}

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));

  const inv = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken) });
  const inviteToken = inv.json().token as string;
  const register = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: { handle: 'hider', loginId: 'hider', displayName: 'Hider', password: 'pw123456', inviteToken },
  });
  meId = register.json().id as string;
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: 'hider', password: 'pw123456' },
  });
  meToken = login.json().token as string;
});

/** 채널은 테스트마다 새로 만든다 — 숨김·보관·메시지가 앞 테스트에서 넘어오면 뜻이 흐려진다. */
beforeEach(async () => {
  const created = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken),
    payload: { name: `hide-${Math.random().toString(36).slice(2, 8)}`, visibility: 'private' },
  });
  channelId = created.json().id as string;
  const added = await app.inject({
    method: 'POST', url: `/channels/${channelId}/members`, headers: auth(adminToken),
    payload: { accountId: meId },
  });
  expect(added.statusCode).toBeLessThan(300);
});

afterAll(async () => { await app.close(); await stop(); });

describe('채널 숨기기(#376)', () => {
  it('1 — 숨기면 사이드바가 읽는 목록에서 그 채널이 숨김으로 나온다', async () => {
    expect(await hiddenAtOf(meId, channelId)).toBeNull();
    expect(await setHidden(meToken, channelId, true)).toBe(200);

    // 저장이 사실이다.
    expect(await hiddenAtOf(meId, channelId)).not.toBeNull();
    // 사이드바가 실제로 읽는 응답에도 실려 나간다 — 저장만 맞고 목록이 안 주면 화면은 모른다.
    const list = await app.inject({ method: 'GET', url: '/channels/prefs', headers: auth(meToken) });
    const pref = (list.json().prefs as { channelId: string; hiddenAt: string | null }[])
      .find((p) => p.channelId === channelId);
    expect(pref?.hiddenAt).not.toBeNull();
    expect(pref?.hiddenAt).not.toBeUndefined();

    // **남의 사이드바는 그대로다.** 숨김이 계정별이 아니면 한 사람이 치운 채널이 모두에게서 사라진다.
    expect(await hiddenAtOf(adminId, channelId)).toBeNull();
  });

  it('2 — 숨겨도 멤버십은 남는다(나가기와 다른 점)', async () => {
    expect(await memberCount(channelId, meId)).toBe(1);
    expect(await setHidden(meToken, channelId, true)).toBe(200);

    // 행이 **실제로 남았는지**까지 단언한다. "숨김이 저장됐다"만 보면 멤버십을 지우는
    // 구현도 초록이 된다.
    expect(await memberCount(channelId, meId)).toBe(1);

    // 남아 있는 멤버십은 쓸 수 있어야 뜻이 있다 — private 채널의 메시지를 여전히 읽는다.
    const read = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`, headers: auth(meToken),
    });
    expect(read.statusCode).toBe(200);
  });

  it('3 — 숨기기는 시스템 메시지를 남기지 않는다(나가기는 남긴다)', async () => {
    const before = await messageCount(channelId);
    expect(await setHidden(meToken, channelId, true)).toBe(200);
    // 메시지 **수**로 본다. "system kind 가 없다" 같은 약한 단언은 문구가 달라지면 통과한다.
    expect(await messageCount(channelId)).toBe(before);

    // 대조군 — 나가기는 같은 채널에서 메시지를 하나 남긴다(#322). 이 대조가 없으면
    // "이 채널에는 원래 시스템 메시지가 안 생긴다"와 구분되지 않는다.
    const left = await app.inject({
      method: 'DELETE', url: `/channels/${channelId}/members/${meId}`, headers: auth(meToken),
    });
    expect(left.statusCode).toBeLessThan(300);
    expect(await messageCount(channelId)).toBe(before + 1);
  });

  it('4 — 숨긴 채널에 나를 부르는 멘션이 오면 다시 나타난다', async () => {
    expect(await setHidden(meToken, channelId, true)).toBe(200);
    expect(await hiddenAtOf(meId, channelId)).not.toBeNull();

    // 게시는 바꾼 프로덕션 파일(`postMessage`)을 직접 부른다 — 부름 판정 자체를 보는 자리라
    // 라우트의 게이트를 통과했는지와 섞이면 무엇이 빨간지 알 수 없다.
    const notified = await post(adminId, '<@' + meId + '> 이것 좀 봐 주세요');
    expect(notified).toContain(meId);

    // 숨김이 **풀렸다.** 사이드바는 이 값만 보므로 이것이 곧 "다시 나타난다"다.
    expect(await hiddenAtOf(meId, channelId)).toBeNull();
  });

  it('4b — `@channel` 로 불려도 다시 나타난다(부름 경로가 넷이다)', async () => {
    expect(await setHidden(meToken, channelId, true)).toBe(200);
    expect(await post(adminId, '@channel 배포 시작합니다')).toContain(meId);
    expect(await hiddenAtOf(meId, channelId)).toBeNull();
  });

  it('5 — 멘션이 아닌 일반 메시지는 다시 나타나게 하지 않는다', async () => {
    expect(await setHidden(meToken, channelId, true)).toBe(200);
    const hiddenBefore = await hiddenAtOf(meId, channelId);
    expect(hiddenBefore).not.toBeNull();

    // 평범한 메시지 — 아무도 부르지 않는다.
    await post(adminId, '오늘 점심 뭐 먹지');
    // 남을 부르는 멘션 — 나는 불리지 않았다. 이것이 없으면 "멘션 토큰이 있으면 풀린다"도 초록이다.
    expect(await post(adminId, '<@' + adminId + '> 자기 자신을 부른다')).not.toContain(meId);

    // **숨김은 그대로다.** 시각까지 같은지 본다 — 지웠다 다시 적는 구현도 걸러진다.
    // `toEqual` 인 이유: pg 가 timestamptz 를 Date 로 준다(타입 선언은 string 이지만
    // 이 저장소의 다른 시각 컬럼도 같은 처지다) — 같은 시각의 다른 객체다.
    expect(await hiddenAtOf(meId, channelId)).toEqual(hiddenBefore);
  });

  it('6 — 스스로 되돌릴 수 있다(남에게 요청할 일이 없다)', async () => {
    expect(await setHidden(meToken, channelId, true)).toBe(200);
    expect(await hiddenAtOf(meId, channelId)).not.toBeNull();

    // 되돌리기는 **명시적 false** 다. 키를 빼는 것("안 보냈다")으로는 되돌 수 없다.
    const untouched = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/pref`, headers: auth(meToken), payload: { starred: true },
    });
    expect(untouched.statusCode).toBe(200);
    expect(await hiddenAtOf(meId, channelId)).not.toBeNull();

    expect(await setHidden(meToken, channelId, false)).toBe(200);
    expect(await hiddenAtOf(meId, channelId)).toBeNull();
    // 되돌린 뒤에도 다른 선호는 살아 있다 — 숨김 컬럼만 쓴다는 뜻이다.
    expect((await getChannelPref(pool, meId, channelId))?.starredAt).not.toBeNull();
  });

  it('7 — 보관과 독립이다(보관된 채널도 숨길 수 있고, 숨김이 보관을 바꾸지 않는다)', async () => {
    const archive = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: auth(adminToken), payload: { archived: true },
    });
    expect(archive.statusCode).toBe(200);

    // 보관된 채널을 숨긴다 — #376 이 세운 문제가 바로 이것이다(치우려고 나가면 권한을 버린다).
    expect(await setHidden(meToken, channelId, true)).toBe(200);
    expect(await hiddenAtOf(meId, channelId)).not.toBeNull();
    // 숨김이 채널 전체의 상태를 건드리지 않는다.
    const state = await pool.query<{ archived_at: Date | null }>(
      `select archived_at from channel where id = $1`, [channelId],
    );
    expect(state.rows[0]!.archived_at).not.toBeNull();
    // 멤버십도 그대로다 — 보관 채널에서 나가면(#344) 사라지는 그것이다.
    expect(await memberCount(channelId, meId)).toBe(1);

    // 보관을 풀어도 숨김은 유지된다. 한 필드로 합쳤다면 여기서 숨김이 사라진다.
    const unarchive = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}`, headers: auth(adminToken), payload: { archived: false },
    });
    expect(unarchive.statusCode).toBe(200);
    expect(await hiddenAtOf(meId, channelId)).not.toBeNull();
  });
});
