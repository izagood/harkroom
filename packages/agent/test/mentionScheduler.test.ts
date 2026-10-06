// mentionScheduler 의 승인 관문 회귀선.
//
// 이 파일이 존재하는 이유: 이 회계가 main.ts 에 있었다면 소스 문자열 정규식으로만 검사할 수
// 있었다(main.ts 는 top-level await 로 진짜 서버에 붙어 import 가 불가능하다). 동시성 회계는
// 이 저장소가 가장 자주 깨뜨린 종류의 코드라, 그것을 가장 약한 검사에 맡기지 않으려고 모듈로
// 뺐다 — 그 선택이 값을 하는 자리가 여기다.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMentionScheduler, DONE_UNREAD_MAX_MS, GATE_REQUEUE_MAX, GATE_WAIT_MAX_MS, RECENTLY_DONE_MS, type BatchContext } from '../src/mentionScheduler.js';
import { AccountGateRequeueError } from '../src/mentionTurn.js';
import { TurnRegistry } from '../src/turnRegistry.js';
import { MentionQueue } from '../src/mentionQueue.js';
import type { InboxBatch } from '../src/harkroom.js';
import type { MentionTarget, MentionTurnResult } from '../src/mentionTurn.js';
import { PromptNotDeliveredError } from '../src/pty.js';

const CH = 'ch-1';

/** 한 건짜리 배치. `threadRootId` 가 없으면 채널 최상위 멘션이라 앵커가 그 메시지 자신이다. */
function batchOf(items: { entryId: number; messageId: string; threadRootId?: string | null; body?: string }[]): InboxBatch {
  return {
    entries: items.map((i) => ({
      id: i.entryId, messageId: i.messageId, reason: 'mention' as const,
      readAt: null, channelId: CH,
    })) as unknown as InboxBatch['entries'],
    messages: items.map((i, n) => ({
      id: i.messageId, seq: n + 1, channelId: CH,
      threadRootId: i.threadRootId ?? null, authorId: 'human-1',
      body: i.body ?? 'hi', kind: 'message', meta: null,
      createdAt: '2026-09-08T00:00:00Z', alsoInChannel: false, deletedAt: null,
    })) as unknown as InboxBatch['messages'],
  };
}

const ctx: BatchContext = { channelName: () => 'general', handles: {} };

/** 테스트가 손으로 끝내는 턴. resolve 를 부를 때까지 인플라이트로 남는다. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(opts: {
  runTurn: () => Promise<MentionTurnResult>;
  now?: () => number;
  /** 이관 중 앞 세대 러너가 들고 있는 entry — `heldEntryIds` 회귀선이 쓴다. */
  held?: Set<number>;
  /** 계정 축. 없으면 `[null]`. 함수면 턴마다 불린다. */
  lane?: Parameters<typeof createMentionScheduler>[0]['accountLane'];
  /** buildTurnDeps 가 받은 계정 — 턴이 어느 계정으로 떴는지 본다. */
  seenAccounts?: (string | null)[];
  /** 참을 돌려주는 동안 `markRead` 가 서버 링크 실패처럼 던진다(2026-10-02 회귀선). */
  markReadFails?: () => boolean;
  /** 앞 세대가 끝냈는데 읽음 처리만 못 한 entry(`HARKROOM_HANDOVER_DONE`, L2). */
  handoverDone?: Set<number>;
}) {
  const markedRead: number[] = [];
  /** `markRead` 가 불린 **호출** 단위 — 묶음 호출(L1) 회귀선이 본다. */
  const markReadCalls: number[][] = [];
  const posted: { channelId: string; body: string; anchor: string | null }[] = [];
  const failed: { body: string; retryable: boolean }[] = [];
  const registry = new TurnRegistry();
  const scheduler = createMentionScheduler({
    harkroom: {
      markRead: async (ids) => {
        markReadCalls.push([...ids]);
        if (opts.markReadFails?.()) throw new Error('MCP error -32001: Request timed out');
        markedRead.push(...ids); return ids.length;
      },
      post: async (channelId, body, anchor) => { posted.push({ channelId, body, anchor }); return 1; },
      // 실패 발화도 `posted` 에 담는다 — 회귀선이 보는 것은 "그 스레드에 무슨 말이
      // 나갔나" 이고, 실패도 그 스레드에 나간 말이다. 종류는 `failed` 가 따로 담는다.
      fail: async (channelId, body, anchor, o) => {
        posted.push({ channelId, body, anchor });
        failed.push({ body, retryable: o.retryable });
        return 1;
      },
    },
    registry,
    queue: new MentionQueue(),
    accountLane: opts.lane ?? [null],
    runMentionTurn: opts.runTurn,
    buildTurnDeps: ({ account }) => { opts.seenAccounts?.push(account?.name ?? null); return {} as never; },
    hooks: {
      stopRequested: () => {},
      exitIfUnrecoverable: () => {},
      noticeHarnessLogin: async () => {},
    },
    startedAtMs: 0,
    ...(opts.held ? { heldEntryIds: () => opts.held! } : {}),
    ...(opts.handoverDone ? { handoverDone: opts.handoverDone } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { scheduler, registry, markedRead, markReadCalls, posted, failed };
}

describe('mentionScheduler 승인 관문', () => {
  /**
   * 이관 보류(2026-09-28). 회수된 앞 러너는 폴을 놓는 순간 **아직 도는 턴의 entry** 를
   * 함께 넘긴다. `markRead` 는 턴 완료 후라 그 항목들은 여전히 미읽음이고, 교체 러너가
   * 그대로 집으면 **같은 멘션에 두 번 답한다** — `#430`·`#174` 의 중복이 되살아나는 자리다.
   *
   * 되돌려 RED: `admit` 의 `heldEntryIds` 검사를 지우면 이 턴이 떠서 `started` 가 1 이 된다.
   */
  it('앞 세대가 들고 있는 entry 는 띄우지 않는다 — 이관 중 중복 답변을 막는다', async () => {
    const held = new Set([41]);
    const h = harness({ runTurn: async () => ({ ok: true }) as never, held });

    const 막힘 = await h.scheduler.admit(batchOf([{ entryId: 41, messageId: 'm-41' }]), ctx);
    expect(막힘).toMatchObject({ started: 0, blocked: 1 });
    // **markRead 도 하지 않는다** — 내 것이 아니므로 소비하면 앞 러너의 답이 사라진다.
    expect(h.markedRead).toEqual([]);

    // 유예가 끝나 집합이 비면 평범한 멘션으로 돌아온다 — 늦어질 뿐 잃지 않는다.
    held.clear();
    const 통과 = await h.scheduler.admit(batchOf([{ entryId: 41, messageId: 'm-41' }]), ctx);
    expect(통과).toMatchObject({ started: 1 });
  });

  /**
   * 지운 계정이 되살아나던 결함(2026-09-29). 축이 함수면 **턴마다** 다시 불러 그 턴의 축을
   * 쓴다 — 기동 때 값을 붙들면 사람이 지운 계정 경로로 claude 가 떠서 디렉터리를 다시 만든다.
   *
   * 되돌려 RED: 스케줄러가 함수를 한 번만 부르거나 배열만 받으면 두 번째 턴도 `lime` 으로 뜬다.
   */
  it('계정 축이 함수면 턴마다 다시 읽는다', async () => {
    const seen: (string | null)[] = [];
    let lane = [{ name: 'lime', configDir: '/x/lime' }, { name: 'plum', configDir: '/x/plum' }];
    const h = harness({ runTurn: async () => ({ ok: true }) as never, lane: async () => lane, seenAccounts: seen });

    await h.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await h.scheduler.drain();
    lane = [{ name: 'plum', configDir: '/x/plum' }];
    await h.scheduler.admit(batchOf([{ entryId: 2, messageId: 'm2' }]), ctx);
    await h.scheduler.drain();

    expect(seen).toEqual(['lime', 'plum']);
  });

  /** 물러나는 러너가 교체 러너에게 넘길 목록이다 — 없으면 오퍼레이터가 무엇을 넘길지 모른다. */
  it('holdingEntries 가 지금 도는 턴의 entry 를 준다', async () => {
    const gate = deferred<MentionTurnResult>();
    const h = harness({ runTurn: () => gate.promise });

    await h.scheduler.admit(batchOf([{ entryId: 77, messageId: 'm-77' }]), ctx);
    expect(h.scheduler.holdingEntries()).toEqual([77]);

    gate.resolve({ ok: true } as never);
    await h.scheduler.drain();
    expect(h.scheduler.holdingEntries()).toEqual([]);
  });

  it('서로 다른 스레드 3건을 동시에 띄운다', async () => {
    let calls = 0;
    const gate = deferred<MentionTurnResult>();
    const { scheduler } = harness({ runTurn: () => { calls += 1; return gate.promise; } });

    const out = await scheduler.admit(batchOf([
      { entryId: 1, messageId: 'm1' },
      { entryId: 2, messageId: 'm2' },
      { entryId: 3, messageId: 'm3' },
    ]), ctx);

    // admit 은 턴을 await 하지 않는다 — 셋 다 이미 시작돼 있어야 한다.
    expect(calls).toBe(3);
    expect(out.started).toBe(3);
    expect(scheduler.inFlight()).toBe(3);

    gate.resolve({ stopRequestedAt: null });
    await scheduler.drain();
    expect(scheduler.inFlight()).toBe(0);
  });

  it('같은 스레드 2건은 하나만 띄운다', async () => {
    let calls = 0;
    const gate = deferred<MentionTurnResult>();
    const { scheduler } = harness({ runTurn: () => { calls += 1; return gate.promise; } });

    // 같은 스레드 루트를 가리키는 두 멘션.
    const out = await scheduler.admit(batchOf([
      { entryId: 1, messageId: 'm1', threadRootId: 'root-1' },
      { entryId: 2, messageId: 'm2', threadRootId: 'root-1' },
    ]), ctx);

    expect(calls).toBe(1);
    expect(out.started).toBe(1);
    expect(out.blocked).toBe(1);

    gate.resolve({ stopRequestedAt: null });
    await scheduler.drain();
  });

  it('같은 entry 가 두 폴에 걸쳐 와도 한 번만 띄운다', async () => {
    let calls = 0;
    const gate = deferred<MentionTurnResult>();
    const { scheduler } = harness({ runTurn: () => { calls += 1; return gate.promise; } });

    // markRead 는 턴 완료 후이므로 그 entry 는 다음 폴에도 미읽음으로 다시 온다.
    await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    const second = await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);

    expect(calls).toBe(1);
    expect(second.blocked).toBe(1);

    gate.resolve({ stopRequestedAt: null });
    await scheduler.drain();
  });

  /**
   * wake 두 번 뜸(2026-10-06, task_manager wake 턴 70건 중 9건). 폴 루프는 묶음을 받은 뒤 `channels()`·
   * `accounts()` 를 await 하고서야 admit 한다. 그 사이 턴이 끝나 읽음 처리되면, 묵은 묶음에 남은 같은
   * entry 가 장부(`inFlightEntries`)에도 `doneUnread` 에도 없어 턴을 한 번 더 띄웠다.
   *
   * 되돌려 RED: admit 의 `recentlyDone` 검사(또는 finishMany 의 기록)를 지우면 `calls` 가 2 가 된다.
   */
  it('턴이 끝난 뒤에 도착한 묵은 묶음에 같은 entry 가 있으면 다시 띄우지 않는다 — 읽음 처리도 다시 안 한다', async () => {
    let calls = 0;
    const gate = deferred<MentionTurnResult>();
    const { scheduler, markReadCalls } = harness({ runTurn: () => { calls += 1; return gate.promise; } });
    const batch = () => batchOf([{ entryId: 5, messageId: 'm-wake', threadRootId: 'root-5' }]);

    expect(await scheduler.admit(batch(), ctx)).toMatchObject({ started: 1 });
    // 폴 루프가 턴이 도는 동안 받은 묶음 — entry 5 는 아직 미읽음이라 실려 있다.
    const stale = batch();
    // 그 묶음이 channels()·accounts() 를 기다리는 사이 턴이 끝나 읽음 처리된다.
    gate.resolve({ stopRequestedAt: null });
    await scheduler.drain();
    expect(markReadCalls).toEqual([[5]]);

    const out = await scheduler.admit(stale, ctx);
    expect(out).toMatchObject({ started: 0, skipped: 1, blocked: 0 });
    await scheduler.drain();
    expect(calls).toBe(1);
    expect(markReadCalls).toEqual([[5]]);
  });

  it('끝낸 entry 의 기억은 RECENTLY_DONE_MS 뒤에 지운다 — 표가 러너 수명 내내 자라지 않게', async () => {
    let t = 1_000;
    let calls = 0;
    const { scheduler } = harness({ now: () => t, runTurn: async () => { calls += 1; return { stopRequestedAt: null }; } });
    const batch = () => batchOf([{ entryId: 6, messageId: 'm-6' }]);

    await scheduler.admit(batch(), ctx);
    await scheduler.drain();
    t += RECENTLY_DONE_MS - 1;
    expect(await scheduler.admit(batch(), ctx)).toMatchObject({ started: 0, skipped: 1 });
    // 상한 뒤엔 inbox 를 믿는다 — 서버가 같은 entry 를 다시 주면 그것은 진짜 미읽음이다.
    t += 2;
    expect(await scheduler.admit(batch(), ctx)).toMatchObject({ started: 1 });
    await scheduler.drain();
    expect(calls).toBe(2);
  });

  it('재시도로 미룬 entry 는 끝낸 것으로 기억하지 않는다 — 백오프 뒤 다시 뜬다', async () => {
    let t = 1_000;
    let calls = 0;
    const { scheduler, markedRead } = harness({
      now: () => t,
      runTurn: async () => { calls += 1; if (calls === 1) throw new Error('boom'); return { stopRequestedAt: null }; },
    });
    const batch = () => batchOf([{ entryId: 8, messageId: 'm-8' }]);

    await scheduler.admit(batch(), ctx);
    await scheduler.drain();
    expect(markedRead).toEqual([]);
    t += 10 * 60 * 1000;
    expect(await scheduler.admit(batch(), ctx)).toMatchObject({ started: 1 });
    await scheduler.drain();
    expect(calls).toBe(2);
    expect(markedRead).toEqual([8]);
  });

  it('메시지가 없는 고아 entry 는 턴 없이 읽음 처리한다', async () => {
    const { scheduler, markedRead } = harness({ runTurn: async () => ({ stopRequestedAt: null }) });

    const out = await scheduler.admit(
      { entries: [{ id: 9, messageId: 'gone', reason: 'mention', readAt: null, channelId: CH }], messages: [] } as unknown as InboxBatch,
      ctx,
    );

    expect(out.skipped).toBe(1);
    expect(out.started).toBe(0);
    expect(markedRead).toEqual([9]);
  });

  it('턴이 끝나면 읽음 처리하고 장부를 비운다', async () => {
    const { scheduler, markedRead } = harness({ runTurn: async () => ({ stopRequestedAt: null }) });

    await scheduler.admit(batchOf([{ entryId: 7, messageId: 'm7' }]), ctx);
    await scheduler.drain();

    expect(markedRead).toEqual([7]);
    expect(scheduler.inFlight()).toBe(0);
  });

  it('resumeHandoff 가 던져도 인플라이트 장부를 비운다', async () => {
    const registry = new TurnRegistry();
    const scheduler = createMentionScheduler({
      harkroom: { markRead: async (ids) => ids.length, post: async () => 1, fail: async () => 1 },
      registry,
      queue: new MentionQueue(),
      accountLane: [null],
      runMentionTurn: async () => ({ stopRequestedAt: null }),
      buildTurnDeps: () => ({}) as never,
      hooks: {
        stopRequested: () => {},
        exitIfUnrecoverable: () => {},
        noticeHarnessLogin: async () => {},
      },
      startedAtMs: 0,
    });

    await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await scheduler.drain();

    expect(scheduler.inFlight()).toBe(0);
    // 같은 스레드를 다시 띄울 수 있어야 한다.
    const again = await scheduler.admit(batchOf([{ entryId: 2, messageId: 'm1' }]), ctx);
    expect(again.started).toBe(1);
    await scheduler.drain();
  });
  it('사람이 조종 중인 스레드의 멘션은 유예하고 통지는 entry 당 1회다', async () => {
    let calls = 0;
    const { scheduler, registry, posted, markedRead } = harness({
      runTurn: async () => { calls += 1; return { stopRequestedAt: null }; },
    });
    // 사람이 이 스레드를 조종 중이다.
    registry.register(`${CH}/root-1`, { kind: 'interactive', sessionId: 's1', openedByHandle: 'jaebin' });

    const first = await scheduler.admit(batchOf([
      { entryId: 1, messageId: 'm1', threadRootId: 'root-1' },
    ]), ctx);
    const second = await scheduler.admit(batchOf([
      { entryId: 1, messageId: 'm1', threadRootId: 'root-1' },
    ]), ctx);

    expect(first.deferred).toBe(1);
    expect(second.deferred).toBe(1);
    expect(calls).toBe(0);
    // 유예는 markRead 하지 않는다 — inbox 의 at-least-once 가 그대로 큐다.
    expect(markedRead).toEqual([]);
    // 재폴링마다 올리면 조종이 길수록 스레드가 도배된다.
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain('jaebin');
  });

  /**
   * **유예를 무한으로 두지 않는다.** 유예는 요청을 잃지 않지만(inbox 가 큐다) 그 대가로
   * 조용하다 — 대기 통지가 entry 당 1회라, 조종이 풀리지 않으면 그 스레드는 아무 신호
   * 없이 영구 정지한다. 실측된 사건에서 남은 흔적은 대기 수가 1→2→3 으로 늘어난 것뿐이고
   * 스레드 머리는 그동안 `끝남` 이었다.
   */
  it('조종이 상한을 넘기면 스레드에 막힘으로 한 번 세운다 — 유예는 유지한다', async () => {
    let clock = 1_000;
    let calls = 0;
    const { scheduler, registry, posted, failed, markedRead } = harness({
      runTurn: async () => { calls += 1; return { stopRequestedAt: null }; },
      now: () => clock,
    });
    registry.register(`${CH}/root-1`, { kind: 'interactive', sessionId: 's1', openedByHandle: 'jaebin' });

    const batch = () => batchOf([{ entryId: 1, messageId: 'm1', threadRootId: 'root-1' }]);
    await scheduler.admit(batch(), ctx);
    // 아직 상한 전이다 — 대기 통지 하나뿐이고 실패는 없다.
    expect(failed).toEqual([]);

    clock += 10 * 60_000;
    await scheduler.admit(batch(), ctx);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.body).toContain('jaebin');
    // 재시도로 낫는 실패가 아니다 — 사람이 조종을 끝내야 풀린다.
    expect(failed[0]!.retryable).toBe(false);

    // **에피소드당 1회.** 폴마다 세우면 그 경고가 곧 도배가 된다.
    clock += 10 * 60_000;
    await scheduler.admit(batch(), ctx);
    expect(failed).toHaveLength(1);

    // 유예는 그대로다: 턴은 안 돌고, markRead 도 안 한다(멘션이 사라지면 안 된다).
    expect(calls).toBe(0);
    expect(markedRead).toEqual([]);
    expect(posted).toHaveLength(2); // 대기 통지 1 + 막힘 1
  });

  it('대기가 셋이 되면 시간과 무관하게 막힘으로 세운다 — 답을 못 받는 사람이 셋이다', async () => {
    const { scheduler, registry, failed } = harness({
      runTurn: async () => ({ stopRequestedAt: null }),
      now: () => 1_000,
    });
    registry.register(`${CH}/root-1`, { kind: 'interactive', sessionId: 's1', openedByHandle: 'jaebin' });

    await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1', threadRootId: 'root-1' }]), ctx);
    await scheduler.admit(batchOf([{ entryId: 2, messageId: 'm1', threadRootId: 'root-1' }]), ctx);
    expect(failed).toEqual([]);
    await scheduler.admit(batchOf([{ entryId: 3, messageId: 'm1', threadRootId: 'root-1' }]), ctx);
    expect(failed).toHaveLength(1);
  });

  it('유예 통지가 실패해도 유예는 유지된다', async () => {
    const registry = new TurnRegistry();
    let calls = 0;
    const scheduler = createMentionScheduler({
      harkroom: {
        markRead: async (ids) => ids.length,
        post: async () => { throw new Error('발화 실패'); },
        fail: async () => 1,
      },
      registry,
      queue: new MentionQueue(),
      accountLane: [null],
      runMentionTurn: async () => { calls += 1; return { stopRequestedAt: null }; },
      buildTurnDeps: () => ({}) as never,
      hooks: {
        stopRequested: () => {},
        exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {},
      },
      startedAtMs: 0,
    });
    registry.register(`${CH}/root-1`, { kind: 'interactive', sessionId: 's1', openedByHandle: 'jaebin' });

    const out = await scheduler.admit(batchOf([
      { entryId: 1, messageId: 'm1', threadRootId: 'root-1' },
    ]), ctx);

    // 통지는 관측이고 큐는 inbox 다 — 통지가 실패해도 턴을 시작하면 안 된다.
    expect(out.deferred).toBe(1);
    expect(calls).toBe(0);
  });
  it('실패한 entry 는 백오프 전에는 다시 띄우지 않는다', async () => {
    let calls = 0;
    let now = 1_000;
    const scheduler = createMentionScheduler({
      harkroom: { markRead: async (ids) => ids.length, post: async () => 1, fail: async () => 1 },
      registry: new TurnRegistry(),
      queue: new MentionQueue(),
      accountLane: [null],
      runMentionTurn: async () => { calls += 1; throw new Error('턴 실패'); },
      buildTurnDeps: () => ({}) as never,
      hooks: {
        stopRequested: () => {},
        exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {},
      },
      startedAtMs: 0,
      now: () => now,
    });

    await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await scheduler.drain();
    expect(calls).toBe(1);

    // 백오프가 아직 안 지났다 — 다시 띄우지 않는다.
    const blocked = await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    expect(blocked.blocked).toBe(1);
    expect(calls).toBe(1);

    // 백오프가 지나면 다시 띄운다.
    now += 60_000;
    const retried = await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    expect(retried.started).toBe(1);
    await scheduler.drain();
    expect(calls).toBe(2);
  });

  it('실패 백오프가 다른 스레드의 멘션을 막지 않는다', async () => {
    const started: string[] = [];
    const now = 1_000;
    const scheduler = createMentionScheduler({
      harkroom: { markRead: async (ids) => ids.length, post: async () => 1, fail: async () => 1 },
      registry: new TurnRegistry(),
      queue: new MentionQueue(),
      accountLane: [null],
      runMentionTurn: async (_d, target) => {
        started.push(target.mentionId);
        if (target.mentionId === 'bad') throw new Error('턴 실패');
        return { stopRequestedAt: null };
      },
      buildTurnDeps: () => ({}) as never,
      hooks: {
        stopRequested: () => {},
        exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {},
      },
      startedAtMs: 0,
      now: () => now,
    });

    await scheduler.admit(batchOf([{ entryId: 1, messageId: 'bad' }]), ctx);
    await scheduler.drain();

    // bad 는 백오프 중이지만 good 은 그대로 흐른다 — 전역 sleep 이었다면 둘 다 멈춘다.
    const out = await scheduler.admit(batchOf([
      { entryId: 1, messageId: 'bad' },
      { entryId: 2, messageId: 'good' },
    ]), ctx);
    expect(out.started).toBe(1);
    expect(out.blocked).toBe(1);
    await scheduler.drain();
    expect(started).toEqual(['bad', 'good']);
  });

  /**
   * **정지는 재시도 회계에 들어가지 않는다**(2026-09-09 실측). 한도·세션 충돌과 같은 갈래다.
   *
   * 왜: 정지의 대표 원인은 고장이 아니라 사람을 기다리는 확인 화면이고, 같은 프롬프트를 다시
   * 넣으면 모델이 같은 명령을 다시 시도해 **같은 자리에 다시 선다.** 실측에서 그 값이 정지
   * 한도 10분 × 3회 = 30분이었고, 그 30분 동안 스레드에 남은 말은 "다시 시도합니다" 였다.
   */
  it('하네스 정지는 재시도하지 않고 한 번에 실패로 남긴다', async () => {
    const markedRead: number[] = [];
    const 발화: { body: string; retryable: boolean }[] = [];
    let 시도 = 0;
    const scheduler = createMentionScheduler({
      harkroom: {
        markRead: async (ids) => { markedRead.push(...ids); return ids.length; },
        post: async () => 1,
        fail: async (_c, body, _a, o) => { 발화.push({ body, retryable: o.retryable }); return 1; },
      },
      registry: new TurnRegistry(),
      queue: new MentionQueue(),
      accountLane: [null],
      runMentionTurn: async () => {
        시도 += 1;
        // `mentionTurn.ts` 가 실어 보내는 표시 그대로다 — 문구로 판정하지 않는다.
        const err = new Error('harness 정지 600000ms — 기록이 자라지 않았다(답 없음)') as Error & { harnessStalledMs?: number };
        err.harnessStalledMs = 600_000;
        throw err;
      },
      buildTurnDeps: () => ({}) as never,
      hooks: {
        stopRequested: () => {},
        exitIfUnrecoverable: () => {},
        noticeHarnessLogin: async () => {},
      },
      startedAtMs: 0,
    });

    await scheduler.admit(batchOf([{ entryId: 9, messageId: 'm-stall' }]), ctx);
    await scheduler.drain();

    expect(시도).toBe(1);
    /**
     * **읽음 처리가 곧 "다시 안 부른다" 다.** 재시도 경로는 `markRead` 를 하지 않고 백오프
     * 시각만 찍어 다음 폴에서 그 항목을 다시 받는다 — 그래서 이 단언이 두 동작을 가른다.
     * (분기 순서까지 함께 지키는 회귀선은 아래 `재시도 회계 앞에서 빠진다` 다.)
     */
    expect(markedRead).toEqual([9]);
    // **평문이 아니라 실패로 남는다**: 사람이 손을 대야 풀리므로 화면에 `막힘` 으로 서야 한다.
    expect(발화).toHaveLength(1);
    expect(발화[0]!.retryable).toBe(false);
    // 볼 곳을 말한다 — "운영자 확인이 필요합니다" 가 실패했던 자리다.
    expect(발화[0]!.body).toContain('터미널');
    expect(발화[0]!.body).toContain('10분');
  });

  it('스레드 지정 모델 거절은 재시도하지 않고 기계가 읽는 표지(code)를 실어 실패로 남긴다(결정 6)', async () => {
    const markedRead: number[] = [];
    const 발화: { body: string; retryable: boolean; code?: string }[] = [];
    let 시도 = 0;
    const scheduler = createMentionScheduler({
      harkroom: {
        markRead: async (ids) => { markedRead.push(...ids); return ids.length; },
        post: async () => 1,
        fail: async (_c, body, _a, o) => { 발화.push({ body, retryable: o.retryable, code: o.code }); return 1; },
      },
      registry: new TurnRegistry(),
      queue: new MentionQueue(),
      accountLane: [null],
      runMentionTurn: async () => {
        시도 += 1;
        throw Object.assign(new Error('harness API 에러'), {
          harnessApiError: "There's an issue with the selected model (bogus).",
          threadModel: { model: 'bogus', effort: null, source: { model: 'thread', effort: 'agent' } },
        });
      },
      buildTurnDeps: () => ({}) as never,
      hooks: { stopRequested: () => {}, exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {} },
      startedAtMs: 0,
    });
    await scheduler.admit(batchOf([{ entryId: 7, messageId: 'm-model' }]), ctx);
    await scheduler.drain();
    expect(시도).toBe(1);
    expect(markedRead).toEqual([7]);
    expect(발화).toEqual([expect.objectContaining({ retryable: false, code: 'thread_model_rejected' })]);
    expect(발화[0]!.body).toContain('bogus');
  });

  it('정지 분기는 재시도 회계 앞에서 빠진다 — 순서가 계약이다', async () => {
    // `credentialNoticeWiring` 의 한도 회귀선과 같은 판례다: 분기가 `답변 실패 (n/MAX)`
    // 줄 **앞**에서 `return` 해야 3회를 태우지 않는다. 뒤로 밀리면 통지 문구는 그대로인데
    // 30분을 태우는 옛 동작으로 조용히 되돌아간다.
    const src = readFileSync(path.resolve(__dirname, '../src/mentionScheduler.ts'), 'utf8');
    const stall = src.indexOf('isHarnessStall(err)');
    const failed = src.indexOf('답변 실패 (', stall);
    expect(stall).toBeGreaterThan(0);
    expect(src.slice(stall, failed)).toContain('return;');
  });

  it('MAX_ATTEMPTS 를 소진하면 통지하고 읽음 처리해 큐를 비운다', async () => {
    let now = 1_000;
    const markedRead: number[] = [];
    const posted: string[] = [];
    const scheduler = createMentionScheduler({
      harkroom: {
        markRead: async (ids) => { markedRead.push(...ids); return ids.length; },
        post: async (_c, body) => { posted.push(body); return 1; },
        // 재시도 통지와 최종 실패 통지는 이제 `fail` 로 나간다(스레드 머리가 `끝남` 으로
        // 뒤집히던 것을 고쳤다) — 이 회귀선이 보는 것은 "무슨 말이 나갔나" 이므로 같은
        // 배열에 담는다.
        fail: async (_c, body) => { posted.push(body); return 1; },
      },
      registry: new TurnRegistry(),
      queue: new MentionQueue(),
      accountLane: [null],
      runMentionTurn: async () => { throw new Error('턴 실패'); },
      buildTurnDeps: () => ({}) as never,
      hooks: {
        stopRequested: () => {},
        exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {},
      },
      startedAtMs: 0,
      now: () => now,
    });

    for (let i = 0; i < 3; i += 1) {
      await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
      await scheduler.drain();
      now += 60_000;
    }

    // 한도까지 실패하면 읽음 처리해 흘려보낸다 — 안 그러면 이 항목이 큐를 막는다.
    expect(markedRead).toEqual([1]);
    expect(posted.some((b) => b.includes('실패'))).toBe(true);
  });
});

// ── 선택에 답이 오면 그 답을 프롬프트에 싣는다(2026-09-09)
//
// 서버가 `ask_answered` 로 깨워도, 러너가 그것을 평범한 멘션으로 다루면 **아무 일도
// 일어나지 않는다**: 사람은 버튼만 눌렀지 새 메시지를 쓰지 않았으므로 델타가 비고,
// 비면 하네스가 돌지 않는다(040 이 `wake` 를 따로 만든 이유와 같은 자리).
describe('깨움 보고처·접힌 예약을 턴에 넘긴다 (2026-10-06)', () => {
  it('wake 항목은 메시지 meta 의 reportTo 를, 부름 항목은 canceledWakes 를 대상에 싣는다', async () => {
    const seen: MentionTarget[] = [];
    const runTurn = (async (_d: unknown, t: MentionTarget) => { seen.push(t); return { stopRequestedAt: null }; }) as never;
    const { scheduler } = harness({ runTurn });
    const wake = batchOf([{ entryId: 1, messageId: 'w1', threadRootId: 'root-1', body: '#1174 CI 확인' }]);
    (wake.entries[0] as { reason: string }).reason = 'wake';
    (wake.messages[0] as { meta: unknown }).meta = { kind: 'wake', wake: { wakeAt: 'x', reason: '#1174 CI 확인', reportTo: { channelId: 'ch-9', threadRootId: 'task-root' } } };
    const call = batchOf([{ entryId: 2, messageId: 'm2', threadRootId: 'root-2' }]);
    (call.entries[0] as { canceledWakes?: unknown }).canceledWakes = [{ reason: '회수', wakeAt: '2026-10-06T02:00:00.000Z' }];

    await scheduler.admit({ entries: [...wake.entries, ...call.entries], messages: [...wake.messages, ...call.messages] }, ctx);
    await scheduler.drain();

    expect(seen.find((t) => t.mentionId === 'w1')?.wake).toEqual({ reason: '#1174 CI 확인', reportTo: { channelId: 'ch-9', threadRootId: 'task-root' } });
    expect(seen.find((t) => t.mentionId === 'm2')?.canceledWakes).toEqual([{ reason: '회수', wakeAt: '2026-10-06T02:00:00.000Z' }]);
  });

  it('옛 서버의 깨움(meta 에 reportTo 없음)은 지금처럼 사유만 싣는다', async () => {
    const seen: MentionTarget[] = [];
    const runTurn = (async (_d: unknown, t: MentionTarget) => { seen.push(t); return { stopRequestedAt: null }; }) as never;
    const { scheduler } = harness({ runTurn });
    const wake = batchOf([{ entryId: 1, messageId: 'w1', threadRootId: 'root-1', body: 'CI 확인' }]);
    (wake.entries[0] as { reason: string }).reason = 'wake';
    await scheduler.admit(wake, ctx);
    await scheduler.drain();
    expect(seen[0]?.wake).toEqual({ reason: 'CI 확인' });
    expect(seen[0]?.canceledWakes).toBeUndefined();
  });
});

describe('ask_answered 깨움', () => {
  const source = readFileSync(path.resolve(__dirname, '../src/mentionScheduler.ts'), 'utf8');

  it("reason 이 ask_answered 면 깨어난 턴으로 조립한다 — 평범한 멘션이 아니다", () => {
    expect(source).toContain("ask_answered");
  });

  it('고른 옵션을 사유에 싣는다 — 스레드를 다시 읽지 않아도 무엇이 정해졌는지 안다', () => {
    // meta 에 `answeredWith` 가 있고(`inbox.poll` 이 실어 준다), 옵션 목록도 함께 온다.
    expect(source).toContain('answeredWith');
  });
});

// ── 재시도를 스레드에 말한다(2026-09-09 프로덕션 관측)
//
// 그날 한 턴이 30분을 서 있다가 접혔다. 러너 로그에는 `답변 실패 (1/3)` 이 남았는데
// **스레드에는 아무것도 남지 않았다** — 스레드 행의 `failureCount` 조차 0이라 화면이 알
// 방법이 없었다. 사람이 본 것은 👀 하나 붙은 `끝남` 배지뿐이었고, 그래서 나온 말이
// "이거 왜 답변 안 하고 있어" 다.
//
// `FAILURE_NOTICE` 로는 못 메운다: 그것은 3회를 다 태운 뒤에 나오므로, 재시도가 도는
// 동안(백오프까지 90초 이상)은 여전히 침묵이다.
describe('재시도 통지 (2026-09-09)', () => {
  it('첫 실패에서 사유와 함께 스레드에 남긴다', async () => {
    const { scheduler, posted } = harness({
      runTurn: () => Promise.reject(new Error('harness 정지 600000ms — 기록이 자라지 않았다(답 없음)')),
    });

    await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await scheduler.drain();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain('다시 시도');
    expect(posted[0]!.body).toContain('1/3');
    // 사유가 실려야 값을 한다 — "실패했다"만으로는 사람이 기다릴지 손댈지 못 고른다.
    expect(posted[0]!.body).toContain('정지');
    // 아직 끝난 게 아니다: "운영자 확인이 필요합니다"는 3회를 태운 뒤의 말이다.
    expect(posted[0]!.body).not.toContain('운영자');
  });

  it('시도마다 올리지 않는다 — entry 당 1회다', async () => {
    // 빠르게 실패하는 오류에서 매번 올리면 스레드가 몇 초 만에 도배된다.
    let clock = 0;
    const { scheduler, posted, markedRead } = harness({
      runTurn: () => Promise.reject(new Error('harness 종료 1: boom')),
      now: () => clock,
    });

    await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await scheduler.drain();
    clock += 120_000;   // 백오프를 넘긴다
    await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await scheduler.drain();

    // 재시도 통지는 하나뿐이다.
    expect(posted.filter((p) => p.body.includes('다시 시도'))).toHaveLength(1);

    clock += 120_000;
    await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await scheduler.drain();

    // 3회를 태우면 기존 실패 통지가 그대로 나오고 읽음 처리로 흘러간다 — 이 변경이
    // 그 경로를 건드리지 않았다는 회귀선이다.
    expect(posted.at(-1)?.body).toContain('운영자');
    expect(markedRead).toContain(1);
  });

  it('사유에서 PAT 를 가린다 — 통지는 스레드에 영구히 남는다', async () => {
    // 실패 문구에는 tail 이 섞일 수 있고(`harness 종료 N: …`), tail 은 PTY 원문이다.
    const { scheduler, posted } = harness({
      runTurn: () => Promise.reject(new Error('harness 종료 1: HARKROOM_PAT=murp_deadbeefcafe 로 붙는다')),
    });

    await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await scheduler.drain();

    expect(posted[0]!.body).not.toContain('murp_deadbeefcafe');
    expect(posted[0]!.body).toContain('(가림)');
  });
});

describe('mentionScheduler 스레드별 계정 순서(C ②)', () => {
  /**
   * 계정은 스레드 단위로 고정된다(`accountAssign.ts`). 스케줄러가 기동 때 축을 그대로 쓰면 모든
   * 새 스레드가 첫 계정으로 몰린다 — 되돌려 RED: `runOne` 이 `deps.accountLane` 을 쓰면 첫
   * 시도 계정이 'a' 가 된다.
   */
  it('laneFor 가 준 순서로 시도하고, 그 스레드 키를 넘긴다', async () => {
    const a = { name: 'a', configDir: '/x/a' };
    const b = { name: 'b', configDir: '/x/b' };
    const asked: string[] = [];
    const tried: (string | null)[] = [];
    const scheduler = createMentionScheduler({
      harkroom: { markRead: async (ids) => ids.length, post: async () => 1, fail: async () => 1 },
      registry: new TurnRegistry(),
      queue: new MentionQueue(),
      accountLane: [a, b],
      laneFor: async (key) => { asked.push(key); return [b, a]; },
      runMentionTurn: async (d) => { tried.push(d as unknown as string); return { stopRequestedAt: null }; },
      buildTurnDeps: ({ account }) => (account?.name ?? null) as never,
      hooks: { stopRequested: () => {}, exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {} },
      startedAtMs: 0,
    });
    await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1', threadRootId: 'root-9' }]), ctx);
    await scheduler.drain();
    expect(asked).toEqual([`${CH}/root-9`]);
    expect(tried).toEqual(['b']);
  });
});

// ── 계정 축이 다 돈 실패의 통지(2026-10-02). 2026-10-01 에 배정 1등 계정이 첫 실행 승인
// 화면에 서 있었는데, 스레드에는 마지막 계정의 "11pm 에 풀립니다"만 남아 사람이 바로 풀 수
// 있는 계정이 있다는 사실이 가려졌다.
describe('계정 축 소진 통지', () => {
  const SECRET = 'ORG-SETTING-https://collector.example.com/v1';
  const quota = (at: string) => Object.assign(new Error('harness 종료 1'), {
    harnessApiError: `You've hit your session limit · resets ${at} (Asia/Seoul)`,
  });
  const lane = ['gated', 'plum', 'lychee'].map((name) => ({ name, configDir: `/tmp/${name}` }));

  it('한도로 끝나도 계정마다 이유를 싣고, 관문 계정이 있으면 할 일을 적는다 — 화면 원문은 싣지 않는다', async () => {
    const errs: unknown[] = [new PromptNotDeliveredError(300, SECRET, 'waiting'), quota('11:10pm'), quota('11pm')];
    const h = harness({ runTurn: async () => { throw errs.shift(); }, lane });
    await h.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await h.scheduler.drain();

    expect(h.failed).toHaveLength(1);
    const body = h.failed[0]!.body;
    expect(body).toContain('11pm (Asia/Seoul) 에 풀립니다');
    expect(body).toContain('gated: 설정 확인 화면에서 사람의 선택을 기다림');
    expect(body).toContain('plum: 사용량 한도(11:10pm (Asia/Seoul) 에 풀림)');
    expect(body).toContain('lychee: 사용량 한도(11pm (Asia/Seoul) 에 풀림)');
    expect(body).toContain('터미널에서 한 번 실행해');
    expect(body).not.toContain('collector');
    // 한도는 기다리면 낫는다 — 재시도 가능으로 남기고 읽음 처리한다(기존 갈래 그대로).
    expect(h.failed[0]!.retryable).toBe(true);
    expect(h.markedRead).toEqual([1]);
  });

  it('관문이 없으면 할 일 줄을 싣지 않는다', async () => {
    const errs: unknown[] = [quota('11:10pm'), quota('11pm'), quota('10pm')];
    const h = harness({ runTurn: async () => { throw errs.shift(); }, lane });
    await h.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await h.scheduler.drain();
    expect(h.failed[0]!.body).toContain('계정별 이유:');
    expect(h.failed[0]!.body).not.toContain('터미널');
  });

  it('계정이 하나면 지금 문구 그대로다', async () => {
    const h = harness({ runTurn: async () => { throw quota('11pm'); }, lane: [lane[0]!] });
    await h.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await h.scheduler.drain();
    expect(h.failed[0]!.body).toBe('(사용량 한도에 걸렸습니다 — 11pm (Asia/Seoul) 에 풀립니다. 그 뒤에 다시 불러 주세요)');
  });

  it('준비 실패가 재시도 통지로 가도 화면 원문 대신 종류만 싣는다', async () => {
    const h = harness({ runTurn: async () => { throw new PromptNotDeliveredError(60_000, SECRET); } });
    await h.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await h.scheduler.drain();
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]!.body).toContain('TUI 준비 신호를 못 봤다(timeout, 60000ms)');
    expect(h.failed[0]!.body).not.toContain('collector');
  });
});

describe('mentionScheduler 관문 표식 (사람이 지나야 하는 관문, 2026-10-01)', () => {
  // 설정 화면의 [터미널 열기]가 이 표식을 보고 선다. 화면 원문은 넘기지 않는다.
  const a = { name: 'a', configDir: '/x/a' };
  const b = { name: 'b', configDir: '/x/b' };
  const GATE_SCREEN = 'Managed settings require approval\n\u276f 1. Yes, I trust these settings\n  2. No, exit\nEnter to confirm';

  /** `deliveredA`: a 계정 시도에서 프롬프트가 입력창에 들어갔는가(관문 표식 지우기의 근거). b 는 언제나 들어간다. */
  function run(failA: Error | null, deliveredA = true) {
    const marked: string[] = [];
    const cleared: string[] = [];
    const scheduler = createMentionScheduler({
      harkroom: { markRead: async (ids) => ids.length, post: async () => 1, fail: async () => 1 },
      registry: new TurnRegistry(),
      queue: new MentionQueue(),
      accountLane: [a, b],
      accountAttention: {
        mark: async (acc) => { marked.push(acc.name); },
        clear: async (acc) => { cleared.push(acc.name); },
      },
      runMentionTurn: async (d) => {
        const { name, delivered } = d as unknown as { name: string | null; delivered?: () => void };
        if (name !== 'a' || deliveredA) delivered?.();
        if (name === 'a' && failA) throw failA;
        return { stopRequestedAt: null };
      },
      buildTurnDeps: ({ account, onPromptDelivered }) => ({ name: account?.name ?? null, delivered: onPromptDelivered }) as never,
      hooks: { stopRequested: () => {}, exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {} },
      startedAtMs: 0,
    });
    return { scheduler, marked, cleared };
  }

  it('선택 대기(waiting)로 넘긴 계정은 표시하고, 돌아간 계정의 표식은 지운다', async () => {
    const h = run(new PromptNotDeliveredError(3_000, GATE_SCREEN, 'waiting'), false);
    await h.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await h.scheduler.drain();
    expect(h.marked).toEqual(['a']);
    expect(h.cleared).toEqual(['b']);
  });

  it('상한에 닿은 준비 실패(timeout)는 표시하지 않는다 — 화면에 관문 글자가 있어도 상태가 기준이다', async () => {
    const h = run(new PromptNotDeliveredError(60_000, GATE_SCREEN, 'timeout'), false);
    await h.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await h.scheduler.drain();
    expect(h.marked).toEqual([]);
  });

  it('입력창까지 간 실패(한도)면 그 계정의 표식을 지운다 — 관문은 이미 지나 있다(2026-10-02)', async () => {
    const quota = Object.assign(new Error('harness 종료 1'), { harnessApiError: "You've hit your session limit · resets 11pm" });
    const h = run(quota);
    await h.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await h.scheduler.drain();
    expect(h.marked).toEqual([]);
    expect(h.cleared).toContain('a');
  });

  it('관문 때문에 접힌 턴(queued·passed)은 표식을 지우지 않는다 — 막힌 턴끼리 서로 지우며 끝없이 다시 뜨지 않게(#1047 F1)', async () => {
    for (const why of ['queued', 'passed'] as const) {
      const h = run(new AccountGateRequeueError(why, '/x/a'), false);
      await h.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
      await h.scheduler.drain();
      expect(h.cleared).toEqual([]);
    }
  });

  it('관문 앞에서 사람을 기다리다 시간이 다 된 턴(주입 없음)은 표식을 남긴다(#1047 F1)', async () => {
    const h = run(new Error('harness 무발화 1800000ms — 답 없이 시간 한도를 넘겼다'), false);
    await h.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await h.scheduler.drain();
    expect(h.cleared).not.toContain('a');
  });

  it('성공한 첫 계정의 표식도 지운다 — 사람이 지난 뒤 다시 후보가 된다', async () => {
    const h = run(null);
    await h.scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await h.scheduler.drain();
    expect(h.marked).toEqual([]);
    expect(h.cleared).toEqual(['a']);
  });
});



// ── 계정 관문으로 접은 멘션(2026-10-02). 실패가 아니다 — 읽음 처리·실패 통지·재시도 회계 없이 다시 띄운다.
describe('계정 관문으로 접은 멘션', () => {
  function run(errs: unknown[], active: () => boolean, now: () => number = () => 1_000) {
    const markedRead: number[] = [];
    const failed: string[] = [];
    let calls = 0;
    const scheduler = createMentionScheduler({
      harkroom: { markRead: async (ids) => { markedRead.push(...ids); return ids.length; }, post: async () => 1, fail: async (_c, b) => { failed.push(b); return 1; } },
      registry: new TurnRegistry(),
      queue: new MentionQueue(),
      accountLane: [null],
      accountAttention: { mark: async () => {}, clear: async () => {}, active: async () => active() },
      runMentionTurn: async () => { calls += 1; const e = errs.shift(); if (e) throw e; return { stopRequestedAt: null }; },
      buildTurnDeps: () => ({}) as never,
      hooks: { stopRequested: () => {}, exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {} },
      startedAtMs: 0,
      now,
    });
    return { scheduler, markedRead, failed, calls: () => calls };
  }
  const batch = () => batchOf([{ entryId: 1, messageId: 'm1' }]);

  it("'queued' 는 읽음 처리하지 않고, 표식이 서 있는 동안 다시 띄우지 않다가 지워지면 띄운다", async () => {
    let active = true;
    const h = run([new AccountGateRequeueError('queued', '/x/a')], () => active);
    await h.scheduler.admit(batch(), ctx); await h.scheduler.drain();
    expect(h.calls()).toBe(1);
    expect(h.markedRead).toEqual([]);
    expect(h.failed).toEqual([]);
    expect((await h.scheduler.admit(batch(), ctx)).blocked).toBe(1);
    active = false;
    expect((await h.scheduler.admit(batch(), ctx)).started).toBe(1);
    await h.scheduler.drain();
    expect(h.calls()).toBe(2);
    expect(h.markedRead).toEqual([1]);
  });

  it("'passed' 는 다음 폴에 바로 다시 띄운다 — 재시도 회계에 넣지 않는다", async () => {
    const h = run([new AccountGateRequeueError('passed', '/x/a'), new AccountGateRequeueError('passed', '/x/a'), new AccountGateRequeueError('passed', '/x/a')], () => true);
    for (let i = 0; i < 4; i += 1) { await h.scheduler.admit(batch(), ctx); await h.scheduler.drain(); }
    // MAX_ATTEMPTS(3) 를 넘겨 네 번째에 성공한다 — 회계에 들어갔다면 세 번째 뒤 버려졌다.
    expect(h.calls()).toBe(4);
    expect(h.failed).toEqual([]);
    expect(h.markedRead).toEqual([1]);
  });

  it('한 멘션을 관문 때문에 다시 띄우는 횟수에는 상한(GATE_REQUEUE_MAX)이 있다 — 넘으면 읽음 처리한다(#1047 F1)', async () => {
    const errs = Array.from({ length: GATE_REQUEUE_MAX + 3 }, () => new AccountGateRequeueError('passed', '/x/a'));
    const h = run(errs, () => false);
    // 실제 inbox 는 읽음 처리한 항목을 다시 주지 않는다 — 그때 멈춘다.
    for (let i = 0; i < GATE_REQUEUE_MAX + 3 && !h.markedRead.includes(1); i += 1) {
      await h.scheduler.admit(batch(), ctx); await h.scheduler.drain();
    }
    expect(h.calls()).toBe(GATE_REQUEUE_MAX + 1);
    expect(h.markedRead).toEqual([1]);
    expect(h.failed).toEqual([]);
  });

  it('표식이 상한(GATE_WAIT_MAX_MS) 넘게 안 지워지면 읽음 처리한다 — 관문 통지는 이미 스레드에 있다', async () => {
    let t = 1_000;
    const h = run([new AccountGateRequeueError('queued', '/x/a')], () => true, () => t);
    await h.scheduler.admit(batch(), ctx); await h.scheduler.drain();
    t += GATE_WAIT_MAX_MS + 1;
    const out = await h.scheduler.admit(batch(), ctx);
    expect(out.skipped).toBe(1);
    expect(h.markedRead).toEqual([1]);
    expect(h.calls()).toBe(1);
  });
});

/**
 * 끝난 턴의 읽음 처리 실패는 턴의 실패가 아니다(2026-10-02). task_manager 실측: 턴은 답했는데
 * 그 뒤 `inbox.read` 가 `MCP error -32001` 로 던져 재시도 경로로 떨어졌고, 30초 뒤 같은 프롬프트가
 * 한 번 더 돌았다(깨움 754건 중 62건이 그렇게 두 번 왔다). 끝난 entry 는 id 로 멱등해야 한다.
 *
 * 되돌려 RED: `finish` 를 지우고 `markRead` 를 다시 `try` 안에서 직접 부르면 첫 시험에서 재시도
 * 통지(`failed`)가 서고 두 번째 폴에 턴이 다시 돈다(`runs` 가 2).
 */
describe('끝난 턴의 읽음 처리 실패 — 다시 띄우지 않는다 (2026-10-02)', () => {
  it('markRead 가 던져도 재시도 통지 없이 끝나고, 같은 entry 가 다시 와도 읽음 처리만 다시 한다', async () => {
    let runs = 0;
    let linkDown = true;
    const h = harness({ runTurn: async () => { runs += 1; return { ok: true } as never; }, markReadFails: () => linkDown });

    expect(await h.scheduler.admit(batchOf([{ entryId: 7, messageId: 'm-7' }]), ctx)).toMatchObject({ started: 1 });
    await h.scheduler.drain();
    expect(runs).toBe(1);
    expect(h.failed).toEqual([]);          // "답하지 못하고 끝나 다시 시도합니다" 가 서지 않는다
    expect(h.markedRead).toEqual([]);      // 읽음 처리는 아직 못 했다
    expect(h.scheduler.holdingEntries()).toEqual([]); // 도는 턴은 없다
    expect(h.scheduler.doneEntries()).toEqual([7]);   // 끝났는데 읽음 처리만 남은 것은 따로 넘긴다(L2)

    // inbox 는 at-least-once 라 같은 entry 를 다시 준다 — 턴은 다시 돌지 않는다.
    expect(await h.scheduler.admit(batchOf([{ entryId: 7, messageId: 'm-7' }]), ctx)).toMatchObject({ started: 0, skipped: 1 });
    await h.scheduler.drain();
    expect(runs).toBe(1);

    // 링크가 돌아오면 그 폴에서 읽음 처리가 끝나고 표에서 빠진다.
    linkDown = false;
    expect(await h.scheduler.admit(batchOf([{ entryId: 7, messageId: 'm-7' }]), ctx)).toMatchObject({ started: 0, skipped: 1 });
    expect(h.markedRead).toEqual([7]);
    expect(h.scheduler.doneEntries()).toEqual([]);
    expect(runs).toBe(1);
  });

  /**
   * L1(2026-10-03). 되돌려 RED: `pruneDoneUnread` 를 지우면 첫 시험에서 7 이 표에 남고, 묶음 호출을
   * 다시 id 마다 부르면 둘째 시험의 호출 수가 2 가 된다.
   */
  it('다시 오지 않는 entry 도 24h 가 지나면 표에서 지운다 — 폴마다 나이로 정리한다', async () => {
    let linkDown = true;
    let clock = 1_000_000;
    const h = harness({ runTurn: async () => ({ ok: true }) as never, markReadFails: () => linkDown, now: () => clock });
    await h.scheduler.admit(batchOf([{ entryId: 7, messageId: 'm-7' }]), ctx);
    await h.scheduler.drain();
    expect(h.scheduler.doneEntries()).toEqual([7]);

    // 서버는 사실 읽음 처리를 했고 응답만 늦었다 — 7 은 다시 오지 않는다. 다른 멘션의 폴이 표를 정리한다.
    clock += DONE_UNREAD_MAX_MS + 1;
    linkDown = false;
    await h.scheduler.admit(batchOf([{ entryId: 8, messageId: 'm-8' }]), ctx);
    await h.scheduler.drain();
    expect(h.scheduler.doneEntries()).toEqual([]);
  });

  it('한 배치에 끝난 entry 가 여럿 다시 오면 markRead 를 한 번만 부른다', async () => {
    let linkDown = true;
    const h = harness({ runTurn: async () => ({ ok: true }) as never, markReadFails: () => linkDown });
    await h.scheduler.admit(batchOf([{ entryId: 7, messageId: 'm-7', threadRootId: 't-1' }, { entryId: 8, messageId: 'm-8', threadRootId: 't-2' }]), ctx);
    await h.scheduler.drain();
    expect(h.scheduler.doneEntries().sort()).toEqual([7, 8]);

    linkDown = false;
    const before = h.markReadCalls.length;
    expect(await h.scheduler.admit(batchOf([{ entryId: 7, messageId: 'm-7', threadRootId: 't-1' }, { entryId: 8, messageId: 'm-8', threadRootId: 't-2' }]), ctx)).toMatchObject({ started: 0, skipped: 2 });
    expect(h.markReadCalls.slice(before)).toEqual([[7, 8]]);
    expect(h.scheduler.doneEntries()).toEqual([]);
  });

  /**
   * L2(2026-10-03). 앞 러너가 끝냈는데 읽음 처리만 못 한 entry 를 넘겨받은 교체 러너는 **턴 없이** 읽음
   * 처리만 한다 — 보류(`heldEntryIds`)와 달리 시한이 지나도 띄우지 않는다.
   * 되돌려 RED: `handoverDone` 을 `doneUnread` 에 심지 않으면 턴이 돌아 `runs` 가 1 이 된다.
   */
  it('앞 세대가 끝낸 entry(handoverDone)는 턴 없이 읽음 처리만 한다', async () => {
    let runs = 0;
    const h = harness({ runTurn: async () => { runs += 1; return { ok: true } as never; }, handoverDone: new Set([5]) });
    expect(h.scheduler.doneEntries()).toEqual([5]);
    expect(await h.scheduler.admit(batchOf([{ entryId: 5, messageId: 'm-5' }]), ctx)).toMatchObject({ started: 0, skipped: 1 });
    await h.scheduler.drain();
    expect(runs).toBe(0);
    expect(h.markedRead).toEqual([5]);
    expect(h.scheduler.doneEntries()).toEqual([]);
  });

  it('물러나는 drain 이 읽음 처리를 한 번 더 시도한다', async () => {
    let linkDown = true;
    const h = harness({ runTurn: async () => ({ ok: true }) as never, markReadFails: () => linkDown });
    await h.scheduler.admit(batchOf([{ entryId: 8, messageId: 'm-8' }]), ctx);
    await h.scheduler.drain();
    expect(h.markedRead).toEqual([]);
    linkDown = false;
    await h.scheduler.drain();
    expect(h.markedRead).toEqual([8]);
  });

  it('재시도 없는 실패(MAX_ATTEMPTS 소진)의 읽음 처리가 던져도 턴 실패로 번지지 않는다', async () => {
    let linkDown = true;
    let runs = 0;
    let clock = 1_000_000;
    const h = harness({
      runTurn: async () => { runs += 1; throw new Error('harness 종료 1: boom'); },
      markReadFails: () => linkDown,
      now: () => clock,
    });
    for (let i = 0; i < 3; i += 1) {
      clock += 10 * 60_000; // 백오프를 건너뛴다
      await h.scheduler.admit(batchOf([{ entryId: 9, messageId: 'm-9' }]), ctx);
      await h.scheduler.drain();
    }
    expect(runs).toBe(3);
    // 소진 뒤에도 같은 entry 가 오면 띄우지 않는다 — 읽음 처리만 다시 한다.
    expect(await h.scheduler.admit(batchOf([{ entryId: 9, messageId: 'm-9' }]), ctx)).toMatchObject({ started: 0, skipped: 1 });
    expect(runs).toBe(3);
    linkDown = false;
    await h.scheduler.admit(batchOf([{ entryId: 9, messageId: 'm-9' }]), ctx);
    expect(h.markedRead).toEqual([9]);
  });
});
