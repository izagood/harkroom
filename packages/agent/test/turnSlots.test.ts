// 동시 턴 상한(오퍼레이터 R1) — 러너 쪽 회귀선.
//
// 사고(2026-10-02 22:05 KST, 스레드 3b0f0255): 러너 15개 아래 턴이 상한 없이 겹쳐 맥이 메모리 부족으로 꺼졌다.
// 상한은 오퍼레이터가 러너 전부를 합쳐 센다(`operator/src/turnSlots.ts`). 여기서는 러너 둘이 **같은 자리 장부**를
// 보게 해, 자리가 없을 때 멘션이 읽음 처리되지 않고 남았다가 자리가 나면 뜨는지 잰다.
import { describe, expect, it } from 'vitest';
import { createMentionScheduler, type BatchContext, type MentionSchedulerDeps } from '../src/mentionScheduler.js';
import { TurnRegistry } from '../src/turnRegistry.js';
import { MentionQueue } from '../src/mentionQueue.js';
import type { InboxBatch } from '../src/harkroom.js';
import type { MentionTurnResult } from '../src/mentionTurn.js';

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

/** 오퍼레이터의 자리 장부와 같은 규칙: (러너, 키) 하나에 한 자리, 다시 잡으면 이미 쥔 것. */
function fakeOperator(max: number, mode: { v: 'normal' | 'old-operator' } = { v: 'normal' }) {
  const held = new Set<string>();
  return {
    held,
    mode,
    forRunner(runnerId: string): NonNullable<MentionSchedulerDeps['turnSlots']> {
      return {
        async acquire(key) {
          if (mode.v === 'old-operator') return 'unsupported';
          const k = `${runnerId}|${key}`;
          if (held.has(k)) return 'granted';
          if (held.size >= max) return 'full';
          held.add(k);
          return 'granted';
        },
        async release(key) { held.delete(`${runnerId}|${key}`); },
      };
    },
  };
}

function runner(turnSlots: NonNullable<MentionSchedulerDeps['turnSlots']>) {
  const started: string[] = [];
  const pending: { resolve: (v: MentionTurnResult) => void }[] = [];
  const markedRead: number[] = [];
  const scheduler = createMentionScheduler({
    harkroom: {
      markRead: async (ids) => { markedRead.push(...ids); return ids.length; },
      post: async () => 1,
      fail: async () => 1,
    },
    registry: new TurnRegistry(),
    queue: new MentionQueue(),
    accountLane: [null],
    runMentionTurn: (_deps, target) => {
      started.push(target.threadRootId ?? '(top)');
      const d = deferred<MentionTurnResult>();
      pending.push(d);
      return d.promise;
    },
    buildTurnDeps: () => ({} as never),
    hooks: { stopRequested: () => {}, exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {} },
    startedAtMs: 0,
    turnSlots,
  });
  const finishFirst = async () => { pending.shift()!.resolve({ ok: true } as never); await flush(); await flush(); };
  return { scheduler, started, markedRead, finishFirst };
}

describe('동시 턴 상한 — 러너들을 합쳐 센다', () => {
  /** 되돌려 RED: 스케줄러의 `slot === 'full'` 분기를 지우면 b 가 상한을 넘어 띄워 started 가 ['B'] 가 된다. */
  it('상한 2 에서 세 번째 턴은 다른 러너라도 뜨지 않고 읽음 처리되지 않으며, 자리가 나면 뜬다', async () => {
    const op = fakeOperator(2);
    const a = runner(op.forRunner('runner-a'));
    const b = runner(op.forRunner('runner-b'));

    const ra = await a.scheduler.admit(batchOf([
      { entryId: 1, messageId: 'm1', threadRootId: 'A1' },
      { entryId: 2, messageId: 'm2', threadRootId: 'A2' },
    ]), ctx);
    expect(ra.started).toBe(2);
    await flush();

    const rb = await b.scheduler.admit(batchOf([{ entryId: 3, messageId: 'm3', threadRootId: 'B' }]), ctx);
    expect(rb.blocked).toBe(1);
    expect(b.started).toEqual([]);
    // 인박스가 대기열이다 — 막힌 멘션은 미읽음으로 남는다.
    expect(b.markedRead).toEqual([]);

    await a.finishFirst();
    // 끝난 턴의 자리는 돌려준다.
    expect(op.held.size).toBe(1);

    const rb2 = await b.scheduler.admit(batchOf([{ entryId: 3, messageId: 'm3', threadRootId: 'B' }]), ctx);
    expect(rb2.started).toBe(1);
    await flush();
    expect(b.started).toEqual(['B']);
  });

  it('막힌 멘션은 시도 횟수를 올리지 않는다 — 오래 붐벼도 MAX_ATTEMPTS 로 버려지지 않는다', async () => {
    const op = fakeOperator(1);
    const a = runner(op.forRunner('runner-a'));
    const b = runner(op.forRunner('runner-b'));
    await a.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1', threadRootId: 'A' }]), ctx);
    for (let i = 0; i < 10; i++) {
      const r = await b.scheduler.admit(batchOf([{ entryId: 2, messageId: 'm2', threadRootId: 'B' }]), ctx);
      expect(r.blocked).toBe(1);
    }
    expect(b.markedRead).toEqual([]);
    await a.finishFirst();
    const r = await b.scheduler.admit(batchOf([{ entryId: 2, messageId: 'm2', threadRootId: 'B' }]), ctx);
    expect(r.started).toBe(1);
  });

  it('옛 오퍼레이터(자리 요청을 모름)면 상한 없이 지금처럼 띄운다', async () => {
    const op = fakeOperator(1, { v: 'old-operator' });
    const a = runner(op.forRunner('runner-a'));
    const r = await a.scheduler.admit(batchOf([
      { entryId: 1, messageId: 'm1', threadRootId: 'A1' },
      { entryId: 2, messageId: 'm2', threadRootId: 'A2' },
    ]), ctx);
    expect(r.started).toBe(2);
  });
});
