// 스레드 임대(서버 095) — 러너 쪽 회귀선.
//
// 사고(2026-10-02, 스레드 ca992991): 앱을 업데이트하자 옛 러너가 하던 턴을 마저 끝내는 동안 새 러너가 같은
// 스레드에 새로 온 멘션을 집어 **같은 스레드·같은 claude 세션에 두 번째 턴**을 띄웠다. 스레드 잠금이 러너
// 프로세스 안에만 있어서다. 여기서는 옛 러너·새 러너 두 스케줄러가 **같은 가짜 서버**를 보게 해 그 장면을
// 그대로 재현하고, 임대가 그것을 막는지 잰다. 가짜 서버의 판정은 서버 `services/threadClaims.ts` 의 SQL 과
// 같은 규칙이다(같은 holder 면 민다 · 만료됐으면 넘겨받는다 · 놓기는 자기 것만).
import { describe, expect, it } from 'vitest';
import { createMentionScheduler, fencedNotice, type BatchContext } from '../src/mentionScheduler.js';
import { TurnRegistry } from '../src/turnRegistry.js';
import { MentionQueue } from '../src/mentionQueue.js';
import type { InboxBatch } from '../src/harkroom.js';
import type { MentionTurnResult } from '../src/mentionTurn.js';
import {
  createThreadClaims, type ClaimOutcome, type ThreadClaimClient, type ThreadClaimTimers,
} from '../src/threadClaims.js';

const CH = 'ch-1';
const ctx: BatchContext = { channelName: () => 'general', handles: {} };

function batchOf(items: { entryId: number; messageId: string; threadRootId?: string | null }[]): InboxBatch {
  return {
    entries: items.map((i) => ({
      id: i.entryId, messageId: i.messageId, reason: 'mention' as const, readAt: null, channelId: CH,
    })) as unknown as InboxBatch['entries'],
    messages: items.map((i, n) => ({
      id: i.messageId, seq: n + 1, channelId: CH, threadRootId: i.threadRootId ?? null, authorId: 'human-1',
      body: 'hi', kind: 'message', meta: null, createdAt: '2026-10-02T00:00:00Z', alsoInChannel: false, deletedAt: null,
    })) as unknown as InboxBatch['messages'],
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 서버 `claimThread`·`releaseThread` 와 같은 규칙. 시계는 손으로 민다. */
function fakeServer() {
  let nowMs = 0;
  const rows = new Map<string, { holder: string; exp: number }>();
  const calls: { op: 'claim' | 'release'; holder: string }[] = [];
  let mode: 'normal' | 'old-server' | 'down' = 'normal';
  const client: ThreadClaimClient = {
    async claimThread(channelId, threadRootId, holder, ttlSec): Promise<ClaimOutcome> {
      calls.push({ op: 'claim', holder });
      if (mode === 'old-server') return 'unsupported';
      if (mode === 'down') throw new Error('no healthy upstream');
      const k = `${channelId}/${threadRootId}`;
      const r = rows.get(k);
      if (!r || r.holder === holder || r.exp <= nowMs) {
        rows.set(k, { holder, exp: nowMs + ttlSec * 1000 });
        return 'held';
      }
      return 'taken';
    },
    async releaseThread(channelId, threadRootId, holder) {
      calls.push({ op: 'release', holder });
      const k = `${channelId}/${threadRootId}`;
      if (rows.get(k)?.holder === holder) rows.delete(k);
    },
  };
  return {
    client, rows, calls,
    advance: (ms: number) => { nowMs += ms; },
    setMode: (m: typeof mode) => { mode = m; },
  };
}

/** 박동을 손으로 울리는 타이머. */
function manualTimers() {
  const live = new Map<number, () => void>();
  let next = 1;
  const timers: ThreadClaimTimers = {
    setInterval: (fn) => { const id = next++; live.set(id, fn); return id; },
    clearInterval: (h) => { live.delete(h as number); },
  };
  return { timers, tick: () => { for (const fn of [...live.values()]) fn(); }, live };
}

/** 러너 하나. holder 가 다르면 다른 러너(이관 중의 옛 세대·새 세대)다. */
function runner(server: ReturnType<typeof fakeServer>, holder: string, timers = manualTimers().timers) {
  const started: string[] = [];
  const pending: { resolve: (v: MentionTurnResult) => void }[] = [];
  const markedRead: number[] = [];
  const posted: string[] = [];
  /** 턴이 받은 펜싱 신호 — 진짜 턴처럼 울리면 접힌다(143 으로 실패). */
  const fences: (AbortSignal | undefined)[] = [];
  const claims = createThreadClaims({ client: server.client, holder, timers, log: () => {} });
  const scheduler = createMentionScheduler({
    harkroom: {
      markRead: async (ids) => { markedRead.push(...ids); return ids.length; },
      post: async (_c, body) => { posted.push(body); return 1; },
      fail: async (_c, body) => { posted.push(body); return 1; },
    },
    registry: new TurnRegistry(),
    queue: new MentionQueue(),
    accountLane: [null],
    runMentionTurn: (_deps, target) => {
      started.push(target.threadRootId ?? '(top)');
      fences.push(target.fence);
      const d = deferred<MentionTurnResult>();
      pending.push(d);
      // 진짜 턴은 신호가 울리면 SIGTERM 으로 접혀 실패로 돌아온다(mentionTurn 의 onFenceLost).
      return new Promise<MentionTurnResult>((res, rej) => {
        d.promise.then(res);
        target.fence?.addEventListener('abort', () => rej(new Error('fenced')), { once: true });
      });
    },
    buildTurnDeps: () => ({} as never),
    hooks: { stopRequested: () => {}, exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {} },
    startedAtMs: 0,
    threadClaims: claims,
  });
  /** 가장 먼저 뜬 턴을 끝낸다. */
  const finishFirst = async () => { pending.shift()!.resolve({ ok: true } as never); await scheduler.drain(); await flush(); };
  return { scheduler, started, markedRead, posted, fences, claims, finishFirst };
}

describe('스레드 임대 — 이관 중 같은 스레드에 턴이 둘 뜨지 않는다', () => {
  /**
   * 10-02 장면 그대로: 옛 러너가 스레드 T 에서 턴을 돌린다(entry 1). 그 사이 T 에 새 멘션(entry 2)이 왔다 —
   * 옛 러너의 이관 보류 목록에는 entry 1 만 있으므로 entry 2 는 그대로 새 러너에게 간다.
   *
   * 되돌려 RED: 스케줄러의 `threadClaims.hold` 검사를 지우면 새 러너가 entry 2 를 띄워 started 가 ['T'] 가 된다.
   */
  it('옛 러너가 T 를 돌리는 동안 새 러너는 T 의 새 멘션을 띄우지 않고, 옛 턴이 끝나 놓으면 띄운다', async () => {
    const server = fakeServer();
    const old = runner(server, 'runner-old');
    const neo = runner(server, 'runner-new');

    await old.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1', threadRootId: 'T' }]), ctx);
    await flush();
    expect(old.started).toEqual(['T']);

    const r1 = await neo.scheduler.admit(batchOf([{ entryId: 2, messageId: 'm2', threadRootId: 'T' }]), ctx);
    expect(r1.blocked).toBe(1);
    expect(neo.started).toEqual([]);
    // 막힌 멘션은 읽음 처리하지 않는다 — 인박스가 그대로 큐다.
    expect(neo.markedRead).toEqual([]);

    await old.finishFirst();
    expect(server.rows.size).toBe(0);

    const r2 = await neo.scheduler.admit(batchOf([{ entryId: 2, messageId: 'm2', threadRootId: 'T' }]), ctx);
    expect(r2.started).toBe(1);
    await flush();
    expect(neo.started).toEqual(['T']);
  });

  it('다른 스레드는 막지 않는다 — #866 이 없앤 이관 공백을 되살리지 않는다', async () => {
    const server = fakeServer();
    const old = runner(server, 'runner-old');
    const neo = runner(server, 'runner-new');
    await old.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1', threadRootId: 'T' }]), ctx);
    const r = await neo.scheduler.admit(batchOf([{ entryId: 2, messageId: 'm2', threadRootId: 'U' }]), ctx);
    expect(r.started).toBe(1);
    await flush();
    expect(neo.started).toEqual(['U']);
  });

  it('옛 러너가 죽어 박동이 끊기면 만료 뒤 새 러너가 넘겨받는다', async () => {
    const server = fakeServer();
    const old = runner(server, 'runner-old');
    const neo = runner(server, 'runner-new');
    await old.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1', threadRootId: 'T' }]), ctx);

    // 아직 살아 있는 동안은 못 잡는다.
    server.advance(60_000);
    expect((await neo.scheduler.admit(batchOf([{ entryId: 2, messageId: 'm2', threadRootId: 'T' }]), ctx)).blocked).toBe(1);

    // 옛 러너는 박동을 못 보냈다(죽었다) — 만료(90초)가 지나면 넘겨받는다.
    server.advance(31_000);
    const r = await neo.scheduler.admit(batchOf([{ entryId: 2, messageId: 'm2', threadRootId: 'T' }]), ctx);
    expect(r.started).toBe(1);
    expect(server.rows.get(`${CH}/T`)?.holder).toBe('runner-new');
  });

  it('박동이 살아 있으면 오래 도는 턴도 임대를 지킨다', async () => {
    const server = fakeServer();
    const beat = manualTimers();
    const old = runner(server, 'runner-old', beat.timers);
    const neo = runner(server, 'runner-new');
    await old.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1', threadRootId: 'T' }]), ctx);
    for (let i = 0; i < 10; i++) {
      server.advance(30_000);
      beat.tick();
      await flush();
    }
    // 5분이 지났지만 30초마다 밀었으므로 여전히 옛 러너 것이다.
    expect((await neo.scheduler.admit(batchOf([{ entryId: 2, messageId: 'm2', threadRootId: 'T' }]), ctx)).blocked).toBe(1);
    expect(neo.started).toEqual([]);
  });

  it('옛 서버(404)면 임대 없이 지금처럼 띄운다', async () => {
    const server = fakeServer();
    server.setMode('old-server');
    const neo = runner(server, 'runner-new');
    const r = await neo.scheduler.admit(batchOf([{ entryId: 2, messageId: 'm2', threadRootId: 'T' }]), ctx);
    expect(r.started).toBe(1);
  });

  it('임대를 확인하지 못하면(서버 오류) 띄우지 않고 다음 폴에서 다시 묻는다', async () => {
    const server = fakeServer();
    server.setMode('down');
    const neo = runner(server, 'runner-new');
    const r1 = await neo.scheduler.admit(batchOf([{ entryId: 2, messageId: 'm2', threadRootId: 'T' }]), ctx);
    expect(r1.blocked).toBe(1);
    expect(neo.started).toEqual([]);
    expect(neo.markedRead).toEqual([]);
    server.setMode('normal');
    const r2 = await neo.scheduler.admit(batchOf([{ entryId: 2, messageId: 'm2', threadRootId: 'T' }]), ctx);
    expect(r2.started).toBe(1);
  });
});

describe('createThreadClaims', () => {
  it('박동은 같은 holder 로 민다. 놓으면 박동이 멈추고 서버에서 지운다', async () => {
    const server = fakeServer();
    const beat = manualTimers();
    const claims = createThreadClaims({ client: server.client, holder: 'h', timers: beat.timers, log: () => {} });
    const c = await claims.hold(CH, 'T');
    expect(c).not.toBeNull();
    beat.tick();
    await flush();
    expect(server.calls.filter((x) => x.op === 'claim')).toHaveLength(2);
    await c!.release();
    expect(beat.live.size).toBe(0);
    expect(server.rows.size).toBe(0);
  });

  it('놓기가 끝나기 전에는 같은 프로세스도 같은 스레드를 다시 못 잡는다(앞 놓기가 뒤 임대를 지우지 않게)', async () => {
    const server = fakeServer();
    let releaseGate!: () => void;
    const slow: ThreadClaimClient = {
      claimThread: server.client.claimThread,
      releaseThread: async (...a) => { await new Promise<void>((r) => { releaseGate = r; }); await server.client.releaseThread(...a); },
    };
    const claims = createThreadClaims({ client: slow, holder: 'h', timers: manualTimers().timers, log: () => {} });
    const c = await claims.hold(CH, 'T');
    const releasing = c!.release();
    await flush();
    expect(await claims.hold(CH, 'T')).toBeNull();
    releaseGate();
    await releasing;
    expect(await claims.hold(CH, 'T')).not.toBeNull();
  });

  it('날아가는 박동이 있으면 놓기는 그것을 기다린 뒤 지운다 — 늦게 도착한 박동이 임대를 되살리지 않는다', async () => {
    const server = fakeServer();
    const beat = manualTimers();
    let beatGate!: () => void;
    let n = 0;
    const client: ThreadClaimClient = {
      claimThread: async (...a) => {
        n += 1;
        if (n === 2) await new Promise<void>((r) => { beatGate = r; });
        return server.client.claimThread(...a);
      },
      releaseThread: server.client.releaseThread,
    };
    const claims = createThreadClaims({ client, holder: 'h', timers: beat.timers, log: () => {} });
    const c = await claims.hold(CH, 'T');
    beat.tick(); // 두 번째 claim(박동)이 걸린 채 멈춘다
    const releasing = c!.release();
    await flush();
    beatGate();
    await releasing;
    expect(server.rows.size).toBe(0);
    expect(server.calls.map((x) => x.op)).toEqual(['claim', 'claim', 'release']);
  });

  it('박동이 끊긴 사이 남이 넘겨받으면 잃었다고 남긴다', async () => {
    const server = fakeServer();
    const beat = manualTimers();
    const lines: string[] = [];
    const claims = createThreadClaims({ client: server.client, holder: 'old', timers: beat.timers, log: (l) => lines.push(l) });
    await claims.hold(CH, 'T');
    server.advance(91_000);
    await server.client.claimThread(CH, 'T', 'new', 90);
    beat.tick();
    await flush();
    expect(lines.some((l) => l.includes('임대를 잃었다'))).toBe(true);
    expect(server.rows.get(`${CH}/T`)?.holder).toBe('new');
  });

  it('옛 서버 경고는 한 번만 남긴다', async () => {
    const server = fakeServer();
    server.setMode('old-server');
    const lines: string[] = [];
    const claims = createThreadClaims({ client: server.client, holder: 'h', timers: manualTimers().timers, log: (l) => lines.push(l) });
    await claims.hold(CH, 'T');
    await claims.hold(CH, 'U');
    expect(lines).toHaveLength(1);
  });
});

describe('스레드 임대 펜싱 — 잃으면 턴을 접는다 (security L1)', () => {
  /**
   * 링크가 90초 넘게 끊긴 러너: 그 사이 임대가 만료돼 다른 러너가 넘겨받았는데, 옛 러너의 턴은 아직 산다.
   * 링크가 돌아와 첫 박동이 409 를 받는 순간 그 턴을 접어야 겹침이 끝난다.
   *
   * 되돌려 RED: `threadClaims.ts` 의 `lost.abort()` 를 지우면 옛 턴이 계속 돌아(pending) 표지가 없다.
   */
  it('박동이 409 를 받으면 옛 턴이 접히고, 표지를 남기고, 읽음 처리하지 않는다', async () => {
    const server = fakeServer();
    const beat = manualTimers();
    const old = runner(server, 'runner-old', beat.timers);
    const neo = runner(server, 'runner-new');
    await old.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1', threadRootId: 'T' }]), ctx);
    await flush();

    // 옛 러너가 끊긴 사이 만료 → 새 러너가 넘겨받아 같은 멘션을 띄운다.
    server.advance(91_000);
    expect((await neo.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1', threadRootId: 'T' }]), ctx)).started).toBe(1);

    // 링크가 돌아온 옛 러너의 첫 박동.
    beat.tick();
    await old.scheduler.drain();
    await flush();

    expect(old.fences[0]?.aborted).toBe(true);
    expect(old.posted).toEqual([fencedNotice()]);
    // 그 멘션은 이제 넘겨받은 쪽 것이다 — 옛 러너가 읽음 처리하면 새 러너가 끝낸 뒤의 판단을 빼앗는다.
    expect(old.markedRead).toEqual([]);
    // 넘겨받은 쪽의 임대는 그대로다(옛 러너의 놓기는 남의 것을 안 지운다).
    expect(server.rows.get(`${CH}/T`)?.holder).toBe('runner-new');
    // 박동도 멈췄다 — 되찾으려 두드리지 않는다.
    expect(beat.live.size).toBe(0);
  });

  it('일시적인 5xx·링크 끊김으로는 접히지 않는다 — 잃었는지 모르는 것이지 잃은 것이 아니다', async () => {
    const server = fakeServer();
    const beat = manualTimers();
    const old = runner(server, 'runner-old', beat.timers);
    await old.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1', threadRootId: 'T' }]), ctx);
    await flush();

    server.setMode('down');
    for (let i = 0; i < 2; i++) { server.advance(30_000); beat.tick(); await flush(); }
    expect(old.fences[0]?.aborted).toBe(false);
    expect(old.posted).toEqual([]);

    // 돌아온 박동이 다시 민다 — 아무도 넘겨받지 않았으므로 여전히 내 것이다.
    server.setMode('normal');
    server.advance(20_000);
    beat.tick();
    await flush();
    expect(old.fences[0]?.aborted).toBe(false);
    expect(server.rows.get(`${CH}/T`)?.holder).toBe('runner-old');

    await old.finishFirst();
    expect(old.markedRead).toEqual([1]);
  });

  it('createThreadClaims: 409 면 lost 가 울리고 박동이 멈춘다. 오류(던짐)로는 울리지 않는다', async () => {
    const server = fakeServer();
    const beat = manualTimers();
    const claims = createThreadClaims({ client: server.client, holder: 'old', timers: beat.timers, log: () => {} });
    const c = await claims.hold(CH, 'T');

    server.setMode('down');
    beat.tick();
    await flush();
    expect(c!.lost.aborted).toBe(false);
    expect(beat.live.size).toBe(1);

    server.setMode('normal');
    server.advance(91_000);
    await server.client.claimThread(CH, 'T', 'new', 90);
    beat.tick();
    await flush();
    expect(c!.lost.aborted).toBe(true);
    expect(beat.live.size).toBe(0);
  });

  it('옛 서버(404)의 손잡이는 울리지 않는다', async () => {
    const server = fakeServer();
    server.setMode('old-server');
    const claims = createThreadClaims({ client: server.client, holder: 'h', timers: manualTimers().timers, log: () => {} });
    expect((await claims.hold(CH, 'T'))!.lost.aborted).toBe(false);
  });
});
