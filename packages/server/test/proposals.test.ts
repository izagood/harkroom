// 제안 트리(협업 탭이 읽는 자리)의 조립과, 그 재료인 `/reduced` 읽기.
//
// 조립은 순수 함수라 픽스처로 본다. 읽기는 **실서버(in-process avcs-server)** 를 상대로 본다 —
// 자체 fake 를 상대로 통과하는 테스트는 wire 드리프트를 잡지 못한다(`avcsClient.test.ts` 의
// 같은 판단, CORS 부재가 82개 초록 뒤에 숨었던 계열).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startAvcsServer } from '@izagood/avcs-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchReduced, type AvcsLogEntry, type AvcsReduced } from '../src/avcs/client.js';
import { buildProposals } from '../src/avcs/proposals.js';

// ── 조립 (순수) ──────────────────────────────────────────────────────────────

let seq = 0;
const at = (): number => ++seq;

function entry(e: Partial<AvcsLogEntry> & Pick<AvcsLogEntry, 'oid' | 'type'>): AvcsLogEntry {
  return {
    logIndex: at(),
    actorKeyId: null,
    intentOid: null,
    summary: '',
    ...e,
  } as AvcsLogEntry;
}

function reduced(over: Partial<AvcsReduced> = {}): AvcsReduced {
  return {
    view: 'main',
    cursor: 12,
    materializer: 'avcs-reduce/1',
    treeHash: 'tree_abc',
    statuses: {},
    headOps: [],
    conflicts: [],
    fileConflicts: [],
    blockedReasons: {},
    untrustedEvidence: 0,
    etag: '"e1"',
    ...over,
  };
}

describe('buildProposals', () => {
  it('intent 를 뿌리로 op·evidence·decision 을 접고, 어느 시점의 판정인지 함께 싣는다', () => {
    const entries = [
      entry({ oid: 'intent_1', type: 'intent', intentOid: 'intent_1', summary: '008 을 되돌린다', actorKeyId: 'human:jaebin' }),
      entry({ oid: 'op_1', type: 'operation', intentOid: 'intent_1', summary: '마이그레이션을 지운다', actorKeyId: 'ai:alpha' }),
      entry({ oid: 'ev_1', type: 'evidence', intentOid: 'intent_1', summary: 'test pass' }),
      entry({ oid: 'dec_1', type: 'decision', intentOid: 'intent_1', summary: '되돌리는 쪽을 고른다', actorKeyId: 'human:jaebin' }),
    ];

    const view = buildProposals(entries, reduced({ statuses: { op_1: 'accepted' } }));

    expect(view.proposals).toHaveLength(1);
    const p = view.proposals[0]!;
    expect(p.title).toBe('008 을 되돌린다');
    expect(p.ownerKeyId).toBe('human:jaebin');
    expect(p.ops.map((o) => o.oid)).toEqual(['op_1']);
    expect(p.ops[0]!.status).toBe('accepted');
    expect(p.ops[0]!.evidence.map((e) => e.summary)).toEqual(['test pass']);
    expect(p.decisions.map((d) => d.reason)).toEqual(['되돌리는 쪽을 고른다']);
    expect(p.state).toBe('accepted');
    // 화면이 "어느 시점의, 어느 환원기의 판정인가" 를 말할 수 있어야 한다.
    expect(view.reducedAt).toEqual({ cursor: 12, materializer: 'avcs-reduce/1', treeHash: 'tree_abc' });
  });

  it('막는 것이 위로 온다 — 결정 필요 → 검증 실패 → 열림 → 승인', () => {
    const mk = (n: string): AvcsLogEntry[] => [
      entry({ oid: `intent_${n}`, type: 'intent', intentOid: `intent_${n}`, summary: n }),
      entry({ oid: `op_${n}`, type: 'operation', intentOid: `intent_${n}`, summary: n }),
    ];

    // 로그 순서는 acc → open → quar → need 다. 목록이 그 순서를 뒤집는 것이 이 테스트의 요점이다.
    const entries = [...mk('acc'), ...mk('open'), ...mk('quar'), ...mk('need')];
    const statuses = {
      op_acc: 'accepted', op_open: 'proposed', op_quar: 'quarantined', op_need: 'needs_decision',
    };

    const view = buildProposals(entries, reduced({ statuses }));

    expect(view.proposals.map((p) => p.state)).toEqual(['needs_decision', 'check_failed', 'open', 'accepted']);
  });

  it('충돌이 두 제안을 가로지르면 양쪽에 붙는다 — 한쪽만 알면 다른 쪽은 자기가 막힌 줄 모른다', () => {
    const entries = [
      entry({ oid: 'intent_a', type: 'intent', intentOid: 'intent_a', summary: 'alpha 의 제안' }),
      entry({ oid: 'op_a', type: 'operation', intentOid: 'intent_a', summary: 'messages.ts 를 고친다' }),
      entry({ oid: 'intent_b', type: 'intent', intentOid: 'intent_b', summary: 'codex 의 제안' }),
      entry({ oid: 'op_b', type: 'operation', intentOid: 'intent_b', summary: 'messages.ts 를 다르게 고친다' }),
    ];

    const view = buildProposals(entries, reduced({
      statuses: { op_a: 'needs_decision', op_b: 'needs_decision' },
      conflicts: [{
        id: 'c1',
        key: 'file:packages/server/src/services/messages.ts',
        kind: 'concurrent_write',
        reason: '같은 파일을 동시에 고쳤다',
        options: [{ opOid: 'op_a', actor: 'ai:alpha', purpose: '' }, { opOid: 'op_b', actor: 'ai:codex', purpose: '' }],
      }],
    }));

    expect(view.proposals.map((p) => p.conflicts.map((c) => c.id))).toEqual([['c1'], ['c1']]);
    expect(view.proposals.every((p) => p.state === 'needs_decision')).toBe(true);
  });

  it('환원 평면이 없으면 상태는 unknown 이다 — 머지된 제안을 열린 것으로 속이지 않는다', () => {
    const entries = [
      entry({ oid: 'intent_1', type: 'intent', intentOid: 'intent_1', summary: '이미 머지된 제안' }),
      entry({ oid: 'op_1', type: 'operation', intentOid: 'intent_1', summary: '' }),
    ];

    const view = buildProposals(entries, null);

    expect(view.proposals[0]!.state).toBe('unknown');
    expect(view.reducedAt).toBeNull();
  });

  it('파급은 op 들의 선언을 OR 로 접고, 아무도 선언하지 않았으면 모른다(null)', () => {
    const withEffects = buildProposals([
      entry({ oid: 'intent_1', type: 'intent', intentOid: 'intent_1', summary: 'x' }),
      entry({ oid: 'op_1', type: 'operation', intentOid: 'intent_1', summary: '', effects: { changesBehavior: true, breaksPublicApi: false } }),
      entry({ oid: 'op_2', type: 'operation', intentOid: 'intent_1', summary: '', effects: { changesBehavior: false, breaksPublicApi: true } }),
    ], reduced());
    expect(withEffects.proposals[0]!.effects).toEqual({ changesBehavior: true, breaksPublicApi: true });

    const none = buildProposals([
      entry({ oid: 'intent_2', type: 'intent', intentOid: 'intent_2', summary: 'y' }),
      entry({ oid: 'op_3', type: 'operation', intentOid: 'intent_2', summary: '' }),
    ], reduced());
    expect(none.proposals[0]!.effects).toBeNull();
  });

  it('뿌리 없는 가지는 버린다 — intent 가 없는 op 은 제안이 아니다', () => {
    const view = buildProposals([
      entry({ oid: 'op_orphan', type: 'operation', intentOid: 'intent_gone', summary: '앞선 배치의 intent' }),
    ], reduced());

    expect(view.proposals).toEqual([]);
  });
});

// ── /reduced 읽기 (실서버) ───────────────────────────────────────────────────

let hub: { url: string; close: () => Promise<void> };
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'murmur-reduced-'));
  hub = await startAvcsServer({ dataDir, host: '127.0.0.1' });
});

afterAll(async () => {
  await hub.close();
  await rm(dataDir, { recursive: true, force: true });
});

let repoSeq = 0;
const newRepo = (): string => `acme/r${++repoSeq}`;

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

describe('fetchReduced against a real avcs-server', () => {
  it('실제 제안이 있으면 상태·머리와 함께 어느 시점인지를 준다', async () => {
    const repo = newRepo();
    const intentOid = await put(repo, {
      type: 'intent',
      title: '제안 트리를 조립한다',
      owner: 'human:jaebin',
      kind: 'feature',
      priority: 'normal',
      constraints: [],
      successCriteria: ['협업 탭이 뜬다'],
      allowedScopes: ['file:packages/server/'],
      createdAt: new Date().toISOString(),
    });
    const sessionOid = await put(repo, {
      type: 'session',
      intentOid,
      actor: ACTOR,
      baseViewOid: null,
      summary: '조립 세션',
      openedEntities: ['file:packages/server/src/avcs/proposals.ts'],
      toolCalls: [],
      startedAt: new Date().toISOString(),
    });
    const opOid = await put(repo, {
      type: 'operation',
      sessionOid,
      intentOid,
      actor: ACTOR,
      target: { entityKind: 'file', entityId: 'packages/server/src/avcs/proposals.ts' },
      body: { kind: 'note' },
      causalDeps: [],
      declaredPurpose: '트리를 접는다',
      lamport: 1,
      createdAt: new Date().toISOString(),
    });

    const r = await fetchReduced(hub.url, repo);

    expect(r).not.toBeNull();
    expect(r).not.toBe('not-modified');
    const view = r as AvcsReduced;
    expect(view.view).toBe('main');
    // 이 op 을 환원이 알고 있어야 한다 — 상태 값 자체는 정책이 정하므로 존재만 본다.
    expect(Object.keys(view.statuses)).toContain(opOid);
    expect(view.cursor).toBeGreaterThan(0);
    expect(view.materializer).not.toBe('');
    expect(view.etag).toBeTruthy();
  });

  it('같은 ETag 로 다시 물으면 not-modified 다 — 환원을 두 번 돌리지 않는다', async () => {
    const repo = newRepo();
    await put(repo, {
      type: 'intent',
      title: 'etag',
      owner: 'human:jaebin',
      kind: 'feature',
      priority: 'normal',
      constraints: [],
      successCriteria: ['x'],
      allowedScopes: ['file:packages/'],
      createdAt: new Date().toISOString(),
    });

    const first = await fetchReduced(hub.url, repo);
    const etag = (first as AvcsReduced).etag;
    expect(etag).toBeTruthy();

    expect(await fetchReduced(hub.url, repo, 'main', etag)).toBe('not-modified');
  });

  it('없는 뷰는 null 이다 — 404 는 오류가 아니라 "이 평면을 서빙하지 않는다" 이다', async () => {
    const repo = newRepo();
    await put(repo, { type: 'blob', data: Buffer.from('x').toString('base64'), encoding: 'base64' });

    expect(await fetchReduced(hub.url, repo, 'no-such-view')).toBeNull();
  });
});
