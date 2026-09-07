import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { createFakeAvcs, type FakeAvcs } from './helpers/fakeAvcs.js';
import { buildServer } from '../src/buildServer.js';
import { ProjectionWorker } from '../src/avcs/projection.js';
import { listBoundRepos, channelMemberIds } from '../src/services/channels.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let fake: FakeAvcs;
let worker: ProjectionWorker;

// `/leases` 가 지금 투영이 보고 있는 서버로 거르므로(042_projection_state_per_server.sql),
// 워커와 서버가 같은 URL 을 보고 있다고 알려 줘야 한다.
const AVCS_URL = 'http://avcs.smoke-test';

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  fake = createFakeAvcs();
  worker = new ProjectionWorker({ pool, avcs: fake.client, baseUrl: AVCS_URL });
  app = await buildServer({
    pool,
    getAvcsStatus: () => worker.status(),
    projection: { envBaseUrl: null, reconfigure: async () => {}, currentUrl: () => AVCS_URL },
  });
});
afterAll(async () => { await app.close(); await stop(); });

/**
 * 통합선의 시나리오가 바뀌었다. 예전 이름은 `mention → work → projection into linked thread`
 * 였고, 마지막 칸이 "avcs 객체가 그 스레드에 답글로 붙는다"였다. 그 칸이 없어졌으므로
 * 남은 것을 이어 붙인다: 사람이 멘션으로 요청하고, repo 바인딩이 실제로 읽히고, avcs
 * 로그의 lease 가 상태로 접히고, DM 이 inbox 를 채운다.
 *
 * **investment 를 줄이지 않고 옮겼다.** 이 파일이 지키는 것은 개별 함수가 아니라 "여러
 * 조각이 한 서버에서 실제로 이어져 있는가"이고, 그 성질은 그대로다 — 이어지는 조각의
 * 목록이 바뀌었을 뿐이다.
 */
describe('smoke: mention → work → lease state', () => {
  it('runs the whole loop', async () => {
    const { token: adminToken, accountId: adminId } = await bootstrapAdmin(app);
    const { pat, accountId } = await createAgent(app, adminToken, 'worker1');
    await app.inject({
      method: 'PUT', url: `/accounts/${accountId}/keys`,
      headers: { authorization: `Bearer ${pat}` },
      payload: { keyId: 'wk1', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----' },
    });
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'dev', repo: 'smoke-repo' },
    });
    const channelId = ch.json().id as string;

    // 1) 사람이 스레드로 작업 요청
    const ask = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: '@worker1 fix the flaky test' },
    });
    expect(ask.statusCode).toBe(201);

    // 2) listBoundRepos가 실제로 채널-repo 바인딩을 읽어오는지 검증 — 워커가 어느 저장소를
    //    따라갈지 정하는 유일한 출처다.
    const bound = await listBoundRepos(pool);
    expect(bound).toEqual([{ repo: 'smoke-repo', channelId }]);

    // 3) avcs 서버에 작업 오브젝트 도착. intent·operation 은 지나가고 lease 만 접힌다 —
    //    거버넌스 객체를 채팅으로 번역하지 않는다는 결정이 서버 전체에서도 성립하는지 본다.
    fake.push('smoke-repo', { oid: 'int-1', type: 'intent', actorKeyId: 'wk1', intentOid: 'int-1', summary: 'fix flaky test' });
    fake.push('smoke-repo', { oid: 'op-1', type: 'operation', actorKeyId: 'wk1', intentOid: 'int-1', summary: 'put_file test/x' });
    fake.push('smoke-repo', { oid: 'ls-1', type: 'lease', actorKeyId: 'wk1', intentOid: null, summary: 'lease test/x',
      lease: { path: 'test/x.ts', expiresAt: new Date(Date.now() + 60_000).toISOString(), released: false } });
    expect(await worker.runOnce('smoke-repo')).toBe(3);

    // lease 는 라우트로 보인다 — 협업 탭이 읽을 표면이 실제로 값을 준다.
    const leases = await app.inject({
      method: 'GET', url: '/leases', headers: { authorization: `Bearer ${adminToken}` },
    });
    const smokeLeases = (leases.json().leases as { repo: string; path: string }[])
      .filter((l) => l.repo === 'smoke-repo');
    expect(smokeLeases.map((l) => l.path)).toEqual(['test/x.ts']);

    // 채널에는 avcs 발 시스템 메시지가 없다 — 사람이 쓴 요청 하나뿐이다.
    const listed = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const kinds = listed.json().messages.map((m: { kind: string }) => m.kind);
    expect(kinds).toEqual(['user']);

    // 4) 커서가 유지되어 이전 엔트리는 재적용되지 않음
    fake.push('smoke-repo', { oid: 'd-1', type: 'decision', actorKeyId: 'wk1', intentOid: 'int-1', summary: 'resolved L1' });
    const applied = await worker.runOnce('smoke-repo');
    expect(applied).toBe(1); // 이전 3개는 재적용되지 않는다

    // 5) admin↔agent DM 생성 후 channelMemberIds가 실제 두 계정을 반환하는지 검증
    const dm = await app.inject({
      method: 'POST', url: '/dms', headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountIds: [accountId] },
    });
    const dmId = dm.json().id as string;
    const members = await channelMemberIds(pool, dmId);
    expect(members.sort()).toEqual([accountId, adminId].sort());

    // 6) DM에 admin이 메시지를 보내면 agent의 inbox(unread)에 reason 'dm' 엔트리가 생긴다
    await app.inject({
      method: 'POST', url: `/channels/${dmId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'hi worker1, direct message' },
    });
    const inbox = await app.inject({
      method: 'GET', url: '/inbox?unread=1',
      headers: { authorization: `Bearer ${pat}` },
    });
    const entries = inbox.json().entries as { reason: string }[];
    expect(entries.some((e) => e.reason === 'dm')).toBe(true);
  });
});
