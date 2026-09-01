// 실서버(in-process avcs-server)를 상대로 어댑터를 검증한다. 자체 fake를 상대로 통과하는
// 테스트는 wire 드리프트를 잡지 못한다 — CORS 부재가 82개 초록 뒤에 숨었던 것과 같은 계열.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startAvcsServer } from '@izagood/avcs-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpAvcsClient, FETCH_CHUNK } from '../src/avcs/client.js';

let hub: { url: string; close: () => Promise<void> };
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'murmur-avcs-'));
  hub = await startAvcsServer({ dataDir, host: '127.0.0.1' });
});

afterAll(async () => {
  await hub.close();
  await rm(dataDir, { recursive: true, force: true });
});

// objlog는 repo 단위 append-only다 — 테스트마다 새 repo를 써서 서로의 커서를 오염시키지 않는다.
let repoSeq = 0;
const newRepo = (): string => `acme/t${++repoSeq}`;

/** 객체 하나를 repo에 넣고 서버가 계산한 oid를 돌려준다. gated=false 기본값이라 서명이 필요 없다. */
async function put(repo: string, obj: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${hub.url}/${repo}/objects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });
  const body = (await res.json()) as { oid?: string; error?: string };
  if (!res.ok || !body.oid) throw new Error(`put failed: ${res.status} ${JSON.stringify(body)}`);
  return body.oid;
}

const ACTOR = { kind: 'ai_agent' as const, id: 'ai:claude-code', model: 'opus' };

function intent(title: string): Record<string, unknown> {
  return {
    type: 'intent',
    title,
    owner: 'human:jaebin',
    kind: 'feature',
    priority: 'normal',
    constraints: [],
    successCriteria: ['투영이 채널에 보인다'],
    allowedScopes: ['file:packages/server/'],
    createdAt: new Date().toISOString(),
  };
}

function session(intentOid: string): Record<string, unknown> {
  return {
    type: 'session',
    intentOid,
    actor: ACTOR,
    baseViewOid: null,
    summary: '어댑터 작업 세션',
    openedEntities: ['file:packages/server/src/avcs/client.ts'],
    toolCalls: [],
    startedAt: new Date().toISOString(),
  };
}

function operation(
  intentOid: string,
  sessionOid: string,
  declaredPurpose: string,
  lamport = 1,
): Record<string, unknown> {
  return {
    type: 'operation',
    sessionOid,
    intentOid,
    actor: ACTOR,
    target: { entityKind: 'file', entityId: 'packages/server/src/avcs/client.ts' },
    body: { kind: 'note' },
    causalDeps: [],
    declaredPurpose,
    lamport,
    createdAt: new Date().toISOString(),
  };
}

describe('httpAvcsClient against a real avcs-server', () => {
  it('projects an intent object as an intent entry carrying its title', async () => {
    const repo = newRepo();
    const oid = await put(repo, intent('avcs 투영 루프를 붙인다'));

    const { entries, next } = await httpAvcsClient(hub.url).fetchSince(repo, 0);

    expect(entries).toEqual([
      {
        logIndex: 1,
        oid,
        type: 'intent',
        actorKeyId: 'human:jaebin',
        intentOid: oid,
        summary: 'avcs 투영 루프를 붙인다',
      },
    ]);
    expect(next).toBe(1);
  });

  it('projects an operation with its declared purpose, threaded to its intent', async () => {
    const repo = newRepo();
    const intentOid = await put(repo, intent('스레드 귀속을 확인한다'));
    const sessionOid = await put(repo, session(intentOid));
    const opOid = await put(repo, operation(intentOid, sessionOid, 'client.ts의 wire 가정을 교체'));

    const { entries } = await httpAvcsClient(hub.url).fetchSince(repo, 0);

    expect(entries.find((e) => e.oid === opOid)).toEqual({
      logIndex: 3,
      oid: opOid,
      type: 'operation',
      actorKeyId: 'ai:claude-code',
      intentOid,
      summary: 'client.ts의 wire 가정을 교체',
    });
  });

  it('leaves non-projected objects out of the entries while still advancing the cursor', async () => {
    const repo = newRepo();
    await put(repo, { type: 'blob', data: Buffer.from('hello').toString('base64'), encoding: 'base64' });
    const intentOid = await put(repo, intent('blob은 투영하지 않는다'));

    const { entries, next } = await httpAvcsClient(hub.url).fetchSince(repo, 0);

    expect(entries.map((e) => e.oid)).toEqual([intentOid]);
    // blob이 objlog 1번을 차지했으므로 intent의 logIndex는 2다 — 필터가 번호를 당겨쓰지 않는다.
    expect(entries[0]!.logIndex).toBe(2);
    expect(next).toBe(2);
  });

  it('threads a decision to the intent of the operation it chose', async () => {
    const repo = newRepo();
    const intentOid = await put(repo, intent('충돌을 해소한다'));
    const sessionOid = await put(repo, session(intentOid));
    const opOid = await put(repo, operation(intentOid, sessionOid, '캐시를 Redis로'));
    const decisionOid = await put(repo, {
      type: 'decision',
      conflictId: 'cache-backend',
      chosenOps: [opOid],
      rejectedOps: [],
      reason: 'Redis 우선 — 기존 운영 스택과 일치',
      decidedBy: { kind: 'human', id: 'human:jaebin' },
      createdAt: new Date().toISOString(),
    });

    const { entries } = await httpAvcsClient(hub.url).fetchSince(repo, 0);

    expect(entries.find((e) => e.oid === decisionOid)).toEqual({
      logIndex: 4,
      oid: decisionOid,
      type: 'decision',
      actorKeyId: 'human:jaebin',
      intentOid,
      summary: 'Redis 우선 — 기존 운영 스택과 일치',
    });
  });

  it('summarises evidence as kind and result, threaded to the intent of the op it verifies', async () => {
    const repo = newRepo();
    const intentOid = await put(repo, intent('증거를 붙인다'));
    const sessionOid = await put(repo, session(intentOid));
    const opOid = await put(repo, operation(intentOid, sessionOid, '어댑터 구현'));
    const evidenceOid = await put(repo, {
      type: 'evidence',
      forOps: [opOid],
      kind: 'unit_test',
      result: 'pass',
      producedBy: ACTOR,
      createdAt: new Date().toISOString(),
    });

    const { entries } = await httpAvcsClient(hub.url).fetchSince(repo, 0);

    expect(entries.find((e) => e.oid === evidenceOid)).toEqual({
      logIndex: 4,
      oid: evidenceOid,
      type: 'evidence',
      actorKeyId: 'ai:claude-code',
      intentOid,
      summary: 'unit_test pass',
    });
  });

  it('fans a lease out to one entry per reserved write scope', async () => {
    const repo = newRepo();
    const intentOid = await put(repo, intent('스코프를 선점한다'));
    const sessionOid = await put(repo, session(intentOid));
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const leaseOid = await put(repo, {
      type: 'lease',
      intentOid,
      sessionOid,
      actor: ACTOR,
      writeScopes: ['file:packages/server/', 'file:packages/desktop/'],
      mode: 'exclusive',
      acquiredAt: new Date().toISOString(),
      expiresAt,
    });

    const { entries } = await httpAvcsClient(hub.url).fetchSince(repo, 0);
    const leases = entries.filter((e) => e.type === 'lease');

    expect(leases).toEqual([
      {
        logIndex: 3,
        oid: leaseOid,
        type: 'lease',
        actorKeyId: 'ai:claude-code',
        intentOid,
        summary: 'file:packages/server/',
        lease: { path: 'file:packages/server/', expiresAt, released: false },
      },
      {
        logIndex: 3,
        oid: leaseOid,
        type: 'lease',
        actorKeyId: 'ai:claude-code',
        intentOid,
        summary: 'file:packages/desktop/',
        lease: { path: 'file:packages/desktop/', expiresAt, released: false },
      },
    ]);
  });

  it('marks a lease released when it carries releasedAt', async () => {
    const repo = newRepo();
    const intentOid = await put(repo, intent('선점을 놓는다'));
    const sessionOid = await put(repo, session(intentOid));
    await put(repo, {
      type: 'lease',
      intentOid,
      sessionOid,
      actor: ACTOR,
      writeScopes: ['file:packages/server/'],
      mode: 'exclusive',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      releasedAt: new Date().toISOString(),
    });

    const { entries } = await httpAvcsClient(hub.url).fetchSince(repo, 0);

    expect(entries.find((e) => e.type === 'lease')?.lease?.released).toBe(true);
  });

  it('fetches a backlog larger than one fetch batch', async () => {
    const repo = newRepo();
    const total = FETCH_CHUNK + 20;
    for (let i = 0; i < total; i++) await put(repo, intent(`백로그 ${i}`));

    const { entries, next } = await httpAvcsClient(hub.url).fetchSince(repo, 0);

    expect(entries).toHaveLength(total);
    expect(next).toBe(total);
    expect(entries.at(-1)!.summary).toBe(`백로그 ${total - 1}`);
  });

  it('never advances the cursor past an object the batch could not carry', async () => {
    const repo = newRepo();
    const intentOid = await put(repo, intent('작은 객체가 먼저'));
    const sessionOid = await put(repo, session(intentOid));
    const opOid = await put(repo, operation(intentOid, sessionOid, '한도를 넘길 증거를 만든다'));
    // 서버는 바이트 한도를 넘긴 객체까지는 담고 거기서 멈춘다(truncated). 그래서 이 뒤의 객체는
    // 응답에 없다 — 커서가 거기까지 전진하면 그 객체는 영구히 투영되지 않는다.
    await put(repo, {
      type: 'evidence',
      forOps: [opOid],
      kind: 'unit_test',
      result: 'pass',
      detail: 'x'.repeat(5 * 1024 * 1024),
      producedBy: ACTOR,
      createdAt: new Date().toISOString(),
    });
    const tailOid = await put(repo, intent('잘린 뒤에 오는 객체'));

    const { entries, next } = await httpAvcsClient(hub.url).fetchSince(repo, 0);

    expect(entries.some((e) => e.oid === tailOid)).toBe(false);
    // objlog: 1 intent, 2 session, 3 operation, 4 evidence(거대), 5 intent(tail)
    // 4까지 받았으므로 커서는 4를 넘지 않아야 한다.
    expect(next).toBeLessThan(5);
  });

  it('reports no change when the long poll times out with nothing new', async () => {
    const repo = newRepo();
    await put(repo, intent('이미 소비된 객체'));

    // since=1 → objlog를 다 읽은 상태. 서버는 타임아웃 후 200 + 빈 oids로 답한다.
    const changed = await httpAvcsClient(hub.url).waitForChange(repo, 1, 50);

    expect(changed).toBe(false);
  });

  it('reports a change when the log holds objects past the cursor', async () => {
    const repo = newRepo();
    await put(repo, intent('아직 소비되지 않은 객체'));

    const changed = await httpAvcsClient(hub.url).waitForChange(repo, 0, 50);

    expect(changed).toBe(true);
  });

  it('returns nothing when re-read from the cursor it just handed back', async () => {
    const repo = newRepo();
    await put(repo, intent('한 번만 투영된다'));
    const client = httpAvcsClient(hub.url);

    const first = await client.fetchSince(repo, 0);
    const again = await client.fetchSince(repo, first.next);

    expect(first.entries).toHaveLength(1);
    expect(again.entries).toEqual([]);
    expect(again.next).toBe(first.next);
  });

  it('projects a checkpoint at channel level with its summary', async () => {
    const repo = newRepo();
    const oid = await put(repo, {
      type: 'checkpoint',
      viewOid: 'view_00000000000000000000000000000000',
      headOps: ['operation_00000000000000000000000000000000'],
      treeHash: 'deadbeef',
      policyOid: 'policy_00000000000000000000000000000000',
      materializerVersion: '1',
      evidence: { unit_test: 'pass' },
      status: 'verified',
      summary: '어댑터 검증 체크포인트',
      createdAt: new Date().toISOString(),
    });

    const { entries } = await httpAvcsClient(hub.url).fetchSince(repo, 0);

    expect(entries).toEqual([
      {
        logIndex: 1,
        oid,
        type: 'checkpoint',
        actorKeyId: null,
        intentOid: null,
        summary: '어댑터 검증 체크포인트',
      },
    ]);
  });

  it('projects a release with its version and credits the first signer', async () => {
    const repo = newRepo();
    const oid = await put(repo, {
      type: 'release',
      checkpointOid: 'checkpoint_00000000000000000000000000000000',
      treeHash: 'deadbeef',
      sbom: { bomFormat: 'CycloneDX', specVersion: '1.5', components: [] },
      artifacts: [],
      evidence: { unit_test: 'pass' },
      signedBy: ['human:jaebin'],
      status: 'released',
      version: '0.2.0',
      createdAt: new Date().toISOString(),
    });

    const { entries } = await httpAvcsClient(hub.url).fetchSince(repo, 0);

    expect(entries).toEqual([
      {
        logIndex: 1,
        oid,
        type: 'release',
        actorKeyId: 'human:jaebin',
        intentOid: null,
        summary: '0.2.0 released',
      },
    ]);
  });

  it('wakes from the long poll when an object arrives while parked', async () => {
    const repo = newRepo();
    const pending = httpAvcsClient(hub.url).waitForChange(repo, 0, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await put(repo, intent('park 중에 도착'));

    expect(await pending).toBe(true);
  });
});
