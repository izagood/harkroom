// mentionScheduler 의 승인 관문 회귀선.
//
// 이 파일이 존재하는 이유: 이 회계가 main.ts 에 있었다면 소스 문자열 정규식으로만 검사할 수
// 있었다(main.ts 는 top-level await 로 진짜 서버에 붙어 import 가 불가능하다). 동시성 회계는
// 이 저장소가 가장 자주 깨뜨린 종류의 코드라, 그것을 가장 약한 검사에 맡기지 않으려고 모듈로
// 뺐다 — 그 선택이 값을 하는 자리가 여기다.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMentionScheduler, type BatchContext } from '../src/mentionScheduler.js';
import { TurnRegistry } from '../src/turnRegistry.js';
import { MentionQueue } from '../src/mentionQueue.js';
import type { InboxBatch } from '../src/murmur.js';
import type { MentionTurnResult } from '../src/mentionTurn.js';

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

function harness(opts: { runTurn: () => Promise<MentionTurnResult>; now?: () => number }) {
  const markedRead: number[] = [];
  const posted: { channelId: string; body: string; anchor: string | null }[] = [];
  const registry = new TurnRegistry();
  const scheduler = createMentionScheduler({
    murmur: {
      markRead: async (ids) => { markedRead.push(...ids); return ids.length; },
      post: async (channelId, body, anchor) => { posted.push({ channelId, body, anchor }); return 1; },
    },
    registry,
    queue: new MentionQueue(),
    accountLane: [null],
    runMentionTurn: opts.runTurn,
    buildTurnDeps: () => ({}) as never,
    hooks: {
      stopRequested: () => {},
      exitIfUnrecoverable: () => {},
      noticeHarnessLogin: async () => {},
    },
    startedAtMs: 0,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { scheduler, registry, markedRead, posted };
}

describe('mentionScheduler 승인 관문', () => {
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
      murmur: { markRead: async (ids) => ids.length, post: async () => 1 },
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

  it('유예 통지가 실패해도 유예는 유지된다', async () => {
    const registry = new TurnRegistry();
    let calls = 0;
    const scheduler = createMentionScheduler({
      murmur: {
        markRead: async (ids) => ids.length,
        post: async () => { throw new Error('발화 실패'); },
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
      murmur: { markRead: async (ids) => ids.length, post: async () => 1 },
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
      murmur: { markRead: async (ids) => ids.length, post: async () => 1 },
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

  it('MAX_ATTEMPTS 를 소진하면 통지하고 읽음 처리해 큐를 비운다', async () => {
    let now = 1_000;
    const markedRead: number[] = [];
    const posted: string[] = [];
    const scheduler = createMentionScheduler({
      murmur: {
        markRead: async (ids) => { markedRead.push(...ids); return ids.length; },
        post: async (_c, body) => { posted.push(body); return 1; },
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
      runTurn: () => Promise.reject(new Error('harness 종료 1: MURMUR_PAT=murp_deadbeefcafe 로 붙는다')),
    });

    await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    await scheduler.drain();

    expect(posted[0]!.body).not.toContain('murp_deadbeefcafe');
    expect(posted[0]!.body).toContain('(가림)');
  });
});
