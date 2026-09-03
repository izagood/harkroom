import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { createFakeAvcs, type FakeAvcs } from './helpers/fakeAvcs.js';
import { buildServer } from '../src/buildServer.js';
import { ProjectionWorker, ensureSystemAccount } from '../src/avcs/projection.js';
import { listBoundRepos, channelMemberIds } from '../src/services/channels.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let fake: FakeAvcs;
let worker: ProjectionWorker;

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  fake = createFakeAvcs();
  worker = new ProjectionWorker({
    pool, avcs: fake.client, systemAccountId: await ensureSystemAccount(pool),
  });
  app = await buildServer({ pool, getAvcsStatus: () => worker.status() });
});
afterAll(async () => { await app.close(); await stop(); });

describe('smoke: mention → work → projection into linked thread', () => {
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
    const rootId = ask.json().id as string;

    // 2) 에이전트가 intent를 만들고 work.link한 상황을 재현 (REST로 work_thread 직접 upsert 대신
    //    MCP 경유는 mcp.test.ts에서 검증했으므로 여기선 DB upsert)
    await pool.query(
      `insert into work_thread (repo, intent_oid, thread_root_message_id) values ('smoke-repo','int-1',$1)`,
      [rootId],
    );

    // listBoundRepos가 실제로 채널-repo 바인딩을 읽어오는지 검증
    const bound = await listBoundRepos(pool);
    expect(bound).toEqual([{ repo: 'smoke-repo', channelId }]);

    // 3) avcs 서버에 작업 오브젝트 도착 → 투영이 그 스레드로
    fake.push('smoke-repo', { oid: 'int-1', type: 'intent', actorKeyId: 'wk1', intentOid: 'int-1', summary: 'fix flaky test' });
    fake.push('smoke-repo', { oid: 'op-1', type: 'operation', actorKeyId: 'wk1', intentOid: 'int-1', summary: 'put_file test/x' });
    await worker.runOnce('smoke-repo', channelId);

    const thread = await app.inject({
      method: 'GET', url: `/channels/${channelId}/messages?thread=${rootId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const bodies = thread.json().messages.map((m: { body: string }) => m.body);
    expect(bodies.some((b: string) => b.includes('@worker1') && b.includes('operation'))).toBe(true);

    // 4) 커서가 유지되어 이전 엔트리는 재적용되지 않음
    fake.push('smoke-repo', { oid: 'd-1', type: 'decision', actorKeyId: 'wk1', intentOid: 'int-1', summary: 'resolved L1' });
    const applied = await worker.runOnce('smoke-repo', channelId);
    expect(applied).toBe(1); // 이전 2개(int-1, op-1)는 재적용되지 않음

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
