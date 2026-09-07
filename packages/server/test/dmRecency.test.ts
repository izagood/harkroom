/**
 * `GET /dms` 가 **최근순의 근거를 싣는다** — 정본 문서 `docs/desktop-rail.html` 2단계.
 *
 * 문서: *"`DIRECT MESSAGES` 와 `AGENTS` 두 묶음을 최근순 한 목록으로."*
 *
 * 그 "최근"의 근거가 응답에 없었다. `DmView` 는 `{ id, memberIds }` 뿐이었고 정렬은
 * `order by c.created_at` — **DM 이 만들어진 순서**였다. 반년 전에 열고 오늘 대화한 DM 이
 * 어제 열고 안 쓴 DM 보다 아래에 섰다.
 *
 * ## 왜 서버 시험인가
 *
 * 화면에도 정렬이 있다(`Sidebar.tsx` 의 `dmPeers`) — 실시간으로 들어오는 메시지 때문에
 * 화면이 최종 판단을 한다. 그래도 **서버가 첫 화면을 맞게 줘야 한다**: 화면의 보정은
 * 스토어에 들어와 있는 메시지만 볼 수 있고, 한 번도 안 열어 본 DM 은 그것이 비어 있다.
 * 부트스트랩 직후의 순서는 전적으로 이 응답이 정한다.
 *
 * ## 되돌려 RED
 *
 * - `lastMessageAt` 컬럼을 응답에서 빼면 → 아래 세 시험 전부 빨개진다
 * - `order by` 를 `c.created_at`(앞 판본)으로 되돌리면 → "최근 대화가 위" 가 빨개진다
 *   (생성 순서와 대화 순서를 **일부러 반대로** 깔아 뒀다)
 * - `deleted_at is null` 을 빼면 → "지운 말로는 안 올라온다" 가 빨개진다
 * - 빈 DM 을 `c.created_at` 으로 채우면 → "말이 없으면 null" 이 빨개진다
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

interface DmRow { id: string; memberIds: string[]; lastMessageAt: string | null }

const listDms = async (token: string): Promise<DmRow[]> => {
  const res = await app.inject({ method: 'GET', url: '/dms', headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json().dms as DmRow[];
};

const startDm = async (token: string, peerId: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST', url: '/dms', headers: auth(token), payload: { accountIds: [peerId] },
  });
  expect(res.statusCode).toBeLessThan(300);
  return res.json().id as string;
};

const say = async (token: string, channelId: string, body: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body },
  });
  expect(res.statusCode).toBeLessThan(300);
  return res.json().id as string;
};

describe('GET /dms — 최근순의 근거 (docs/desktop-rail.html 2단계)', () => {
  it('최근 대화가 위에 선다 — 만들어진 순서가 아니다', async () => {
    /**
     * **생성 순서와 대화 순서를 반대로 깐다.** 이것이 이 시험의 핵심이다: 두 순서가 같으면
     * 앞 판본(`order by c.created_at`)도 통과해 버려 아무것도 재지 못한다.
     *
     * 실측으로 확인한 함정이다 — 첫 판본은 "먼저 만든 DM 에 나중에 말한다"로 깔았는데,
     * 그러면 `created_at` **오름차순**의 결과가 최근순과 우연히 같아져 정렬을 되돌려도
     * 초록이었다(RED 확인에서 잡혔다). 그래서 반대로 깐다: **나중에 만든 DM 에 나중에
     * 말한다.** 그러면 최근순은 `[newer, older]` 이고 생성 오름차순은 `[older, newer]` 라
     * 두 순서가 정면으로 갈린다.
     */
    const { accountId: firstId } = await createAgent(app, adminToken, 'recency-first');
    const { accountId: secondId } = await createAgent(app, adminToken, 'recency-second');
    const older = await startDm(adminToken, firstId);   // 먼저 만들어졌다
    const newer = await startDm(adminToken, secondId);  // 나중에 만들어졌다

    // 먼저 만든 쪽에 먼저 말하고, **나중에 만든 쪽에 나중에** 말한다.
    await say(adminToken, older, 'hello first');
    await say(adminToken, newer, 'hello second');

    const dms = await listDms(adminToken);
    const order = dms.map((d) => d.id);
    // 대화가 최근인 쪽(`newer`)이 위다. 생성 오름차순이라면 `older` 가 위여서 빨개진다.
    expect(order.indexOf(newer)).toBeLessThan(order.indexOf(older));

    // 순서만이 아니라 **근거도** 실린다. 화면이 실시간 메시지로 이 값을 갱신하므로
    // (Sidebar 의 `dmPeers`) 시각 자체가 없으면 화면은 비교할 것이 없다.
    const olderRow = dms.find((d) => d.id === older)!;
    const newerRow = dms.find((d) => d.id === newer)!;
    expect(olderRow.lastMessageAt).toEqual(expect.any(String));
    expect(newerRow.lastMessageAt).toEqual(expect.any(String));
    expect(newerRow.lastMessageAt! > olderRow.lastMessageAt!).toBe(true);
  });

  it('말이 하나도 없으면 null 이고 맨 아래다 — 채널 생성 시각으로 채우지 않는다', async () => {
    const { accountId: silentId } = await createAgent(app, adminToken, 'recency-silent');
    // **말이 없는 DM 을 먼저 만든다.** 생성 시각으로 빈 값을 채우는 구현이라면 이 DM 이
    // 아래 `talkative` 보다 오래된 것으로 계산되어 우연히 맨 아래에 남는다 — 그러면
    // 자리 단언이 아무것도 재지 못한다. 아래에서 그 우연을 없앤다.
    const silent = await startDm(adminToken, silentId);

    // 그다음 **더 나중에** 만든 DM 에 말을 남긴다. 이제 두 구현의 예측이 갈린다:
    // - 지금 구현(`null` + `nulls last`) → `silent` 가 맨 아래
    // - 빈 값을 `c.created_at` 으로 채우는 구현 → `silent`(먼저 생성)가 아래로 가지만
    //   그 값이 `talkative` 의 **대화** 시각보다 이르기 때문일 뿐이라, 아래 `toBeNull`
    //   단언이 먼저 빨개진다
    const { accountId: talkerId } = await createAgent(app, adminToken, 'recency-talker');
    const talkative = await startDm(adminToken, talkerId);
    await say(adminToken, talkative, 'i have something to say');

    const dms = await listDms(adminToken);
    const row = dms.find((d) => d.id === silent)!;
    // `null` 은 '대화한 적 없다'는 확정된 사실이다(서버가 세어 봤고 0이었다).
    expect(row.lastMessageAt).toBeNull();
    // 최근순 목록에서 대화가 없는 것이 있는 것보다 최근일 수는 없다.
    expect(dms[dms.length - 1]!.id).toBe(silent);
    // 그리고 말이 있는 쪽은 그보다 위다 — 나중에 만들어졌어도 그렇다.
    expect(dms.map((d) => d.id).indexOf(talkative)).toBeLessThan(dms.length - 1);
  });

  it('지운 말로는 DM 이 위로 올라오지 않는다', async () => {
    const { accountId: peerId } = await createAgent(app, adminToken, 'recency-deleted');
    const dmId = await startDm(adminToken, peerId);
    const kept = await say(adminToken, dmId, 'this one stays');

    const before = (await listDms(adminToken)).find((d) => d.id === dmId)!.lastMessageAt;
    expect(before).toEqual(expect.any(String));

    // 나중 말을 하나 더 하고 **그것만** 지운다.
    const doomed = await say(adminToken, dmId, 'this one goes away');
    const del = await app.inject({
      method: 'DELETE', url: `/channels/${dmId}/messages/${doomed}`, headers: auth(adminToken),
    });
    expect(del.statusCode).toBeLessThan(300);

    // 지운 말로 목록이 "여기 새 말이 있다"고 하면, 열어 본 사람은 아무것도 못 찾는다.
    const after = (await listDms(adminToken)).find((d) => d.id === dmId)!.lastMessageAt;
    expect(after).toBe(before);

    // 남아 있는 말이 그 시각의 주인이라는 것도 확인한다 — 위 단언만으로는 두 값이
    // 우연히 같은 경우(둘 다 null 등)를 배제하지 못한다.
    const keptAt = await pool.query('select created_at::text as at from message where id = $1', [kept]);
    expect(after).toBe(keptAt.rows[0].at);
  });
});
