# 멘션 턴의 스레드별 병렬 실행 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 러너가 서로 다른 스레드의 멘션 턴을 동시에 돌리게 해, 턴 하나가 나머지 전부를 막는 head-of-line 차단을 없앤다.

**Architecture:** `main.ts` 의 `for…await` 직렬 루프에서 "지금 시작할 수 있는 멘션은 무엇인가"와 "끝난 턴을 어떻게 회수하는가"를 새 모듈 `mentionScheduler.ts` 로 뽑는다. `main.ts` 는 `poll → admit → sleep 판정` 만 한다. 스케줄러는 인플라이트 장부(entry·thread)를 동기적으로 들어 중복 실행과 같은 스레드 겹침을 막고, `markRead` 를 배치 단위에서 턴 단위로 내린다.

**Tech Stack:** TypeScript (ESM, `type: module`), Node ≥22, vitest 3.

**Spec:** `docs/specs/2026-09-08-mention-turn-parallelism-design.md`

## Global Constraints

- 대상은 `packages/agent` 뿐이다. 서버·DB·데스크탑 UI 는 바뀌지 않는다.
- `markRead` 는 **턴 완료 후**에 머문다. 시작 시로 옮기면 at-least-once 가 깨지고, 그것이 유예 설계 전체의 토대다(spec §5).
- 승인 관문에서 `attempts` 증가는 **맨 마지막**이다. `blocked`·`deferred`·`skipped` 는 시도 횟수를 건드리지 않는다(spec §4-2).
- 인플라이트 장부(`inFlightEntries`·`inFlightThreads`)의 삭제는 `finally` 안에서 **어떤 `await` 보다도 앞**이다(spec §4-6).
- 동시 상한은 두지 않는다. 계정 배분도 현행 그대로다 — 모든 턴이 lane 첫 계정부터 시작한다.
- 주석은 한국어로, 이 저장소의 기존 톤을 따른다: **무엇을 하는지가 아니라 왜 그래야 하는지, 그리고 그러지 않으면 무엇이 깨지는지**를 적는다.
- 테스트 실행: `pnpm --filter @murmur/agent exec vitest run <파일>`. 전체는 `pnpm --filter @murmur/agent test`.

## File Structure

| 파일 | 책임 |
|---|---|
| `packages/agent/src/mentionScheduler.ts` (신규) | 승인 관문·인플라이트 장부·턴 실행·완료 회수·실패 회계 |
| `packages/agent/test/mentionScheduler.test.ts` (신규) | 위의 단위 테스트 |
| `packages/agent/src/main.ts` (수정) | 배치 루프를 `admit` 호출로 교체, 종료 시 `drain` |
| `packages/agent/test/wakeWiring.test.ts` (수정) | 소스 정규식 → 실제 동작 검사로 승격 |
| `packages/agent/test/mainCredentialSites.test.ts` (수정) | 멘션 자리 검사 대상을 스케줄러로 이동 |
| `docs/specs/2026-09-01-runner-sessions-pty-design.md` (수정) | §동시성 개정 |

---

### Task 1: 스케줄러 골격 — 승인 관문과 동시 실행

**Files:**
- Create: `packages/agent/src/mentionScheduler.ts`
- Test: `packages/agent/test/mentionScheduler.test.ts`

**Interfaces:**
- Consumes: `TurnRegistry` (`turnRegistry.ts`), `MentionQueue` (`mentionQueue.ts`), `SessionStore.threadKey` (`sessions.ts`), `mentionAnchor`·`runMentionTurn`·`MentionTurnDeps`·`MentionTarget`·`MentionTurnResult` (`mentionTurn.ts`), `InboxBatch` (`murmur.ts`), `ClaudeAccount`·`withAccountFailover` (`claudeAccounts.ts`).
- Produces:
  - `createMentionScheduler(deps: MentionSchedulerDeps): MentionScheduler`
  - `interface MentionScheduler { admit(batch, ctx): Promise<AdmitOutcome>; inFlight(): number; drain(): Promise<void> }`
  - `interface AdmitOutcome { started: number; deferred: number; blocked: number; skipped: number }`
  - `interface BatchContext { channelName(channelId: string): string; handles: Record<string, string> }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

Create `packages/agent/test/mentionScheduler.test.ts`:

```ts
// mentionScheduler 의 승인 관문 회귀선.
//
// 이 파일이 존재하는 이유: 이 회계가 main.ts 에 있었다면 소스 문자열 정규식으로만 검사할 수
// 있었다(main.ts 는 top-level await 로 진짜 서버에 붙어 import 가 불가능하다). 동시성 회계는
// 이 저장소가 가장 자주 깨뜨린 종류의 코드라, 그것을 가장 약한 검사에 맡기지 않으려고 모듈로
// 뺐다 — 그 선택이 값을 하는 자리가 여기다.
import { describe, expect, it } from 'vitest';
import { createMentionScheduler, type BatchContext } from '../src/mentionScheduler.js';
import { TurnRegistry } from '../src/turnRegistry.js';
import { MentionQueue } from '../src/mentionQueue.js';
import type { InboxBatch } from '../src/murmur.js';
import type { MentionTurnResult } from '../src/mentionTurn.js';

const CH = 'ch-1';

/** 한 건짜리 배치. `threadRootId: null` 이면 채널 최상위 멘션이라 앵커가 그 메시지 자신이다. */
function batchOf(items: { entryId: number; messageId: string; threadRootId?: string | null; body?: string }[]): InboxBatch {
  return {
    entries: items.map((i) => ({
      id: i.entryId, messageId: i.messageId, reason: 'mention' as const,
      readAt: null, channelId: CH,
    })) as InboxBatch['entries'],
    messages: items.map((i, n) => ({
      id: i.messageId, seq: n + 1, channelId: CH,
      threadRootId: i.threadRootId ?? null, authorId: 'human-1',
      body: i.body ?? 'hi', kind: 'message', meta: null,
      createdAt: '2026-09-08T00:00:00Z', alsoInChannel: false,
    })) as InboxBatch['messages'],
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

function harness(opts: { runTurn: () => Promise<MentionTurnResult> }) {
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
      resumeHandoff: async () => {},
      stopRequested: () => {},
      exitIfUnrecoverable: () => {},
      noticeHarnessLogin: async () => {},
    },
    startedAtMs: 0,
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
        // 장부 삭제가 이 await 뒤에 있으면 그 스레드는 영원히 blocked 가 된다.
        resumeHandoff: async () => { throw new Error('이어받기 실패'); },
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
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionScheduler.test.ts`
Expected: FAIL — `Failed to resolve import "../src/mentionScheduler.js"`

- [ ] **Step 3: 최소 구현을 쓴다**

Create `packages/agent/src/mentionScheduler.ts`:

```ts
// "지금 시작할 수 있는 멘션은 무엇인가"의 유일한 자리.
//
// **왜 main.ts 가 아닌가.** main.ts 는 top-level await 로 서버 접속·설정 파일 쓰기를 곧바로
// 일으켜 테스트가 import 할 수 없다(그 파일 머리 주석). 그래서 거기 사는 로직은 소스 문자열
// 정규식으로만 검사되고, 그 테스트들이 스스로 "약한 검사"라고 적어 뒀다. 동시성 회계 —
// 중복 실행, 같은 스레드 두 턴, 시도 횟수 갉아먹기 — 는 이 저장소가 가장 자주 깨뜨린 종류라
// 가장 약한 검사에 맡기지 않는다. `runMentionTurn` 을 main.ts 밖으로 뺀 것과 같은 판단이다.
//
// **admit 의 계약 한 줄: 턴 길이의 일을 절대 await 하지 않는다.** 유예 통지와 고아 entry 의
// markRead 만 await 한다. 이 계약이 깨지면 폴 루프가 다시 턴에 묶여, 이 모듈이 존재하는
// 이유 자체가 사라진다.
import type { InboxBatch } from './murmur.js';
import { mentionAnchor, type MentionTarget, type MentionTurnDeps, type MentionTurnResult } from './mentionTurn.js';
import { SessionStore } from './sessions.js';
import type { TurnRegistry } from './turnRegistry.js';
import type { MentionQueue } from './mentionQueue.js';
import { withAccountFailover, type ClaudeAccount } from './claudeAccounts.js';

/** 배치 단위로 한 번만 받는 것들. 턴마다 바뀌지 않는다. */
export interface BatchContext {
  channelName(channelId: string): string;
  handles: Record<string, string>;
}

export interface AdmitOutcome {
  /** 이번에 띄운 턴. */
  started: number;
  /** 사람이 조종 중이라 유예했다(현행 §5-2 결정 6). */
  deferred: number;
  /** 이미 인플라이트다 — 같은 entry 이거나 같은 스레드에 턴이 돈다. */
  blocked: number;
  /** 메시지가 사라진 고아 entry — 턴 없이 읽음 처리했다. */
  skipped: number;
}

/**
 * 이 모듈이 murmur 에서 실제로 쓰는 것만. `MurmurAgentClient` 를 통째로 받지 않는 이유는
 * `mentionTurn.ts` 의 `TurnRelay` 와 같다 — 좁게 받아야 테스트가 소켓·MCP 를 세우지 않는다.
 */
export interface SchedulerMurmur {
  markRead(ids: number[]): Promise<number>;
  post(channelId: string, body: string, threadRootId: string | null): Promise<number>;
}

export interface MentionSchedulerDeps {
  murmur: SchedulerMurmur;
  registry: TurnRegistry;
  queue: MentionQueue;
  /** 계정 축. 비어 있으면 안 된다 — 호출자가 최소 `[null]` 을 넘긴다(claudeAccounts.ts). */
  accountLane: readonly (ClaudeAccount | null)[];
  runMentionTurn(deps: MentionTurnDeps, target: MentionTarget): Promise<MentionTurnResult>;
  /** 계정 두 필드까지 채운 완성 deps 를 만든다. 조립은 main 이 갖는다. */
  buildTurnDeps(args: {
    ctx: BatchContext;
    mention: InboxBatch['messages'][number];
    account: ClaudeAccount | null;
  }): MentionTurnDeps;
  hooks: {
    /** #384 이어받기 — 턴이 완전히 끝난 뒤 main 루프가 정한 자리에서 부른다. */
    resumeHandoff(threadKey: string): Promise<void>;
    stopRequested(at: string): void;
    exitIfUnrecoverable(err: unknown): void;
    noticeHarnessLogin(err: unknown, channelId: string, anchor: string, messageId: string): Promise<void>;
  };
  /** 종료 요청이 나를 향한 것인지 가르는 기준(stop.ts). */
  startedAtMs: number;
}

export interface MentionScheduler {
  admit(batch: InboxBatch, ctx: BatchContext): Promise<AdmitOutcome>;
  inFlight(): number;
  drain(): Promise<void>;
}

export function createMentionScheduler(deps: MentionSchedulerDeps): MentionScheduler {
  /** 지금 도는 턴의 entry id. markRead 가 완료 후라 같은 entry 가 다음 폴에 또 온다. */
  const inFlightEntries = new Set<number>();
  /**
   * 지금 턴을 띄우기로 **결정한** 스레드.
   *
   * `registry` 로만 재면 틀린다: `registry.register` 는 `runMentionTurn` **안에서** 불리므로
   * 띄운 시점과 등록 사이에 비동기 간극이 있고, 그 사이의 admit 이 같은 스레드를 한 번 더
   * 통과시키면 `register` 가 크게 던진다. registry 는 "턴이 도는 동안"의 진실이고, 여기 필요한
   * 것은 "띄우기로 결정한 순간"부터의 진실이다 — 두 사실은 다르다.
   */
  const inFlightThreads = new Set<string>();
  /** 완료를 기다릴 수 있게 잡아 두는 프로미스. `drain` 이 이것을 본다. */
  const running = new Set<Promise<void>>();

  async function runOne(
    entryId: number, mention: InboxBatch['messages'][number], anchor: string, threadKey: string, ctx: BatchContext,
  ): Promise<void> {
    const target: MentionTarget = {
      channelId: mention.channelId, threadRootId: anchor, mentionId: mention.id,
    };
    try {
      const turn = await withAccountFailover(
        deps.accountLane,
        (account) => deps.runMentionTurn(deps.buildTurnDeps({ ctx, mention, account }), target),
      );
      await deps.murmur.markRead([entryId]);
      if (turn.stopRequestedAt) deps.hooks.stopRequested(turn.stopRequestedAt);
    } finally {
      // **이 두 줄이 어떤 await 보다도 앞이어야 한다.** 아래 resumeHandoff 가 던지면 그 뒤가
      // 실행되지 않아 스레드 키가 장부에 영구히 남고, 그 스레드는 영원히 blocked 가 된다 —
      // 프로세스는 회수됐는데 장부만 남아 스레드가 죽는다(turnRegistry.ts 머리 주석의 인메모리판).
      inFlightEntries.delete(entryId);
      inFlightThreads.delete(threadKey);
      await deps.hooks.resumeHandoff(threadKey);
    }
  }

  return {
    async admit(batch, ctx) {
      const out: AdmitOutcome = { started: 0, deferred: 0, blocked: 0, skipped: 0 };
      const orphans: number[] = [];

      for (const entry of batch.entries) {
        const mention = batch.messages.find((m) => m.id === entry.messageId);
        if (!mention) { orphans.push(entry.id); out.skipped += 1; continue; }

        if (inFlightEntries.has(entry.id)) { out.blocked += 1; continue; }

        const anchor = mentionAnchor(mention);
        const threadKey = SessionStore.threadKey(mention.channelId, anchor);
        if (inFlightThreads.has(threadKey) || deps.registry.get(threadKey)) { out.blocked += 1; continue; }

        // 장부 등록은 **동기적으로, 띄우기 전에**. 위 inFlightThreads 주석이 이유다.
        inFlightEntries.add(entry.id);
        inFlightThreads.add(threadKey);
        out.started += 1;

        const task = runOne(entry.id, mention, anchor, threadKey, ctx)
          .catch((err: unknown) => {
            console.error(`  ${entry.messageId} 턴 실패:`, err instanceof Error ? err.message : err);
          })
          .finally(() => { running.delete(task); });
        running.add(task);
      }

      if (orphans.length) await deps.murmur.markRead(orphans);
      return out;
    },

    inFlight: () => running.size,

    async drain() {
      // 도는 동안 새 프로미스가 들어오지 않는다(admit 을 멈춘 뒤에 부른다). 그래도 스냅샷을
      // 떠서 도는 이유는, 완료 콜백이 집합을 수정하는 중에 순회하지 않기 위해서다.
      while (running.size) await Promise.all([...running]);
    },
  };
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionScheduler.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: 타입 검사**

Run: `pnpm --filter @murmur/agent typecheck`
Expected: 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add packages/agent/src/mentionScheduler.ts packages/agent/test/mentionScheduler.test.ts
git commit -m "feat(agent): 멘션 턴 스케줄러 — 스레드별 동시 실행

서로 다른 스레드의 멘션 턴을 동시에 띄운다. 같은 스레드와 같은 entry 는
인플라이트 장부로 막는다 — registry.register 는 턴 안에서 불려 띄운 시점과
등록 사이에 간극이 있고, 그 간극에서 같은 스레드가 두 번 통과하면 register 가
던진다."
```

---

### Task 2: 유예(deferred) 경로 이식

**Files:**
- Modify: `packages/agent/src/mentionScheduler.ts`
- Test: `packages/agent/test/mentionScheduler.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `createMentionScheduler`, `AdmitOutcome`; `controlledNotice` (`prompt.ts`), `TurnRegistry.controlOf`, `MentionQueue.defer`.
- Produces: 관문 순서에 유예가 들어간 `admit` — 인플라이트 판정 **뒤**, 스레드 판정 **앞**.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/mentionScheduler.test.ts` 의 `describe` 블록 안에 추가:

```ts
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
        resumeHandoff: async () => {}, stopRequested: () => {},
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
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionScheduler.test.ts`
Expected: FAIL — 유예 테스트 2건. 첫 번째는 `deferred` 가 0 이고 `blocked` 로 세어진다(관문 4 가 인터랙티브 턴도 registry 에서 보므로).

- [ ] **Step 3: 최소 구현을 쓴다**

`mentionScheduler.ts` 의 import 에 추가:

```ts
import { controlledNotice } from './prompt.js';
```

`admit` 의 for 루프에서 `if (inFlightEntries.has(entry.id))` 다음, `if (inFlightThreads.has(...))` **앞**에 삽입:

```ts
        // #337/#384: 사람이 이 스레드를 조종 중이면 **유예한다** — markRead 도 attempts 증가도
        // 없이 건너뛴다(스펙 §5-2 결정 6: inbox 의 at-least-once 가 그대로 큐다). 판정은
        // `controlOf` 하나다: 도는 인터랙티브 턴과 아직 기다리는 이어받기 예약을 함께 본다.
        // 예약 구간(사람이 [이어받기] 를 누르고 기다리는 26초)에서 유예가 빠지면 그 사이에
        // 시작된 멘션 턴이 사람이 기다린 자리를 가져간다.
        //
        // **아래 스레드 판정보다 앞이어야 한다.** 뒤에 두면 인터랙티브 턴이 registry 에 있다는
        // 이유로 `blocked` 로 세어져, 사람은 아무 통지도 못 받는다.
        const controlling = deps.registry.controlOf(threadKey);
        if (controlling) {
          out.deferred += 1;
          const { shouldNotify, pending } = deps.queue.defer(threadKey, entry.id, mention.seq);
          if (shouldNotify) {
            // 통지는 entry 당 1회 — 재폴링마다 올리면 조종이 길수록 스레드가 도배된다.
            try {
              await deps.murmur.post(
                mention.channelId,
                controlledNotice(controlling.openedByHandle ?? '소유자', pending),
                anchor,
              );
            } catch (err) {
              // 통지는 관측이고 큐는 inbox 다 — 실패해도 유예는 유지된다.
              console.error(`  ${entry.messageId} 대기 통지 발화 실패(유예는 유지된다):`,
                err instanceof Error ? err.message : err);
            }
          }
          continue;
        }
```

`anchor`·`threadKey` 계산을 이 블록 **위**로 올려야 한다(이미 그 순서다 — 인플라이트 entry 판정 다음에 계산한다).

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionScheduler.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/mentionScheduler.ts packages/agent/test/mentionScheduler.test.ts
git commit -m "feat(agent): 스케줄러에 유예 경로 이식

controlOf 판정은 스레드 인플라이트 판정보다 앞이다 — 뒤에 두면 인터랙티브
턴이 registry 에 있다는 이유로 blocked 로 세어져 사람이 통지를 못 받는다."
```

---

### Task 3: 실패 회계 — entry 별 백오프와 실패 5분기

**Files:**
- Modify: `packages/agent/src/mentionScheduler.ts`
- Test: `packages/agent/test/mentionScheduler.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `admit`; `exhausted`·`MAX_ATTEMPTS`·`nextBackoffMs`·`isQuotaExhausted`·`isSessionIdConflict` (`policy.ts`), `FAILURE_NOTICE`·`quotaNotice`·`sessionConflictNotice` (`prompt.ts`).
- Produces: `attempts: Map<number, { tried: number; notBefore: number }>` 를 내부에 든 `admit`/`runOne`. 관문 0(백오프)이 추가된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`describe` 블록 안에 추가:

```ts
  it('실패한 entry 는 백오프 전에는 다시 띄우지 않는다', async () => {
    let calls = 0;
    let now = 1_000;
    const registry = new TurnRegistry();
    const scheduler = createMentionScheduler({
      murmur: { markRead: async (ids) => ids.length, post: async () => 1 },
      registry,
      queue: new MentionQueue(),
      accountLane: [null],
      runMentionTurn: async () => { calls += 1; throw new Error('턴 실패'); },
      buildTurnDeps: () => ({}) as never,
      hooks: {
        resumeHandoff: async () => {}, stopRequested: () => {},
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
    let now = 1_000;
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
        resumeHandoff: async () => {}, stopRequested: () => {},
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
        resumeHandoff: async () => {}, stopRequested: () => {},
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
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionScheduler.test.ts`
Expected: FAIL — 백오프 테스트 3건 (`now` 옵션이 타입에 없고, 실패한 entry 가 곧바로 다시 시작된다)

- [ ] **Step 3: 최소 구현을 쓴다**

import 에 추가:

```ts
import { exhausted, isQuotaExhausted, isSessionIdConflict, MAX_ATTEMPTS, nextBackoffMs } from './policy.js';
import { controlledNotice, FAILURE_NOTICE, quotaNotice, sessionConflictNotice } from './prompt.js';
```

`MentionSchedulerDeps` 에 추가:

```ts
  /** 테스트가 백오프 경계를 결정론적으로 재현하기 위한 시계 주입. 생략하면 Date.now. */
  now?: () => number;
```

`createMentionScheduler` 본문 상단에 추가:

```ts
  const now = deps.now ?? Date.now;
  /**
   * 항목별 시도 횟수와 **다음 시도 가능 시각**.
   *
   * 백오프가 전역이 아니라 entry 별인 이유: 현행 main 루프는 실패 시 `sleep(backoffMs)` 로
   * 루프 전체를 재웠다. 병렬에서는 그것이 틀리다 — 스레드 A 의 실패가 스레드 B~F 의 새
   * 멘션까지 멈춘다. 러너 전역 백오프는 폴 루프의 transport 실패에만 남는다(main.ts).
   */
  const attempts = new Map<number, { tried: number; notBefore: number }>();
```

`admit` 의 for 루프 맨 앞(메시지 조회 **뒤**, 인플라이트 판정 **앞**)에 관문 0 을 넣는다:

```ts
        // 관문 0: 실패 백오프. `attempts` 를 **읽기만** 한다 — 증가는 관문 5 뒤다.
        const record = attempts.get(entry.id);
        if (record && record.notBefore > now()) { out.blocked += 1; continue; }
```

`out.started += 1;` 바로 앞에 시도 횟수 증가를 넣는다. **관문을 전부 통과한 지금이 유일한
증가 지점이다** — `blocked`·`deferred`·`skipped` 는 이 줄에 닿지 않는다:

```ts
        const tried = (attempts.get(entry.id)?.tried ?? 0) + 1;
        attempts.set(entry.id, { tried, notBefore: 0 });
```

`runOne` 호출에 `tried` 를 넘긴다 — 그 값이 실패 로그의 `(n/MAX_ATTEMPTS)` 와 소진 판정에 쓰인다:

```ts
        const task = runOne(entry.id, mention, anchor, threadKey, ctx, tried)
```

`runOne` 의 시그니처 끝에 `tried: number` 를 더하고 `try` 를 다음으로 바꾼다:

```ts
    try {
      const turn = await withAccountFailover(
        deps.accountLane,
        (account) => deps.runMentionTurn(deps.buildTurnDeps({ ctx, mention, account }), target),
        (from, to) => console.error(
          `  ${mention.id} 계정 전환: ${from?.name ?? '(기본)'} → ${to?.name ?? '(기본)'}`,
        ),
      );
      await deps.murmur.markRead([entryId]);
      attempts.delete(entryId);
      if (turn.stopRequestedAt) deps.hooks.stopRequested(turn.stopRequestedAt);
    } catch (err) {
      // **여기 도달했다는 것은 계정 축이 이미 소진됐다는 뜻이다** — withAccountFailover 가
      // 위를 감싸고 있으므로, 아직 안 써 본 계정이 있으면 그 오류는 여기 오지 않는다.
      //
      // 물러나기 **전에** 사람이 보는 자리에 말한다(2026-09-07) — 아래 판정은 process.exit 을
      // 부르므로 순서가 계약이다.
      await deps.hooks.noticeHarnessLogin(err, mention.channelId, anchor, mention.id);
      deps.hooks.exitIfUnrecoverable(err);

      // 사용량 한도는 **재시도 회계에 넣지 않는다.** 3회가 5초 안에 끝나므로 한도가 풀릴 리
      // 없고, 태운 끝에 남는 "운영자 확인이 필요합니다"는 사람이 할 일을 잘못 가리킨다 —
      // 여기서 할 일은 기다리는 것뿐이다.
      const quota = isQuotaExhausted(err);
      if (quota) {
        console.error(`  ${mention.id} 사용량 한도 — 재시도하지 않는다 (풀림: ${quota.resetsAt ?? '알 수 없음'}) tail: ${err instanceof Error ? err.message : String(err)}`);
        await deps.murmur.post(mention.channelId, quotaNotice(quota.resetsAt), anchor).catch((e: unknown) => {
          console.error(`  ${mention.id} 한도 통지 발화 실패(읽음 처리 계속):`, e instanceof Error ? e.message : e);
        });
        await deps.murmur.markRead([entryId]);
        attempts.delete(entryId);
        return;
      }

      // 세션 id 충돌도 재시도로 낫지 않는다(2026-09-07 실측: 176·185·278ms 만에 같은 자리).
      // **자격증명처럼 죽이지 않는다** — 그 스레드 하나의 세션 상태 문제이고 다른 스레드는
      // 멀쩡하다. 죽으면 다른 스레드의 대기 멘션까지 함께 잃는다.
      if (isSessionIdConflict(err)) {
        console.error(`  ${mention.id} 하네스 세션 충돌 — 재시도하지 않는다 (러너의 세션 상태와 하네스 디스크가 어긋났다): ${err instanceof Error ? err.message : String(err)}`);
        await deps.murmur.post(mention.channelId, sessionConflictNotice(), anchor).catch((e: unknown) => {
          console.error(`  ${mention.id} 세션 충돌 통지 발화 실패(읽음 처리 계속):`, e instanceof Error ? e.message : e);
        });
        await deps.murmur.markRead([entryId]);
        attempts.delete(entryId);
        return;
      }

      console.error(`  ${mention.id} 답변 실패 (${tried}/${MAX_ATTEMPTS}):`, err instanceof Error ? err.message : err);
      if (exhausted(tried)) {
        // 한도까지 실패하면 읽음 처리해 흘려보낸다 — 안 그러면 이 항목이 큐를 막는다.
        console.error(`  ${mention.id} 포기하고 읽음 처리한다`);
        await deps.murmur.post(mention.channelId, FAILURE_NOTICE, anchor).catch((e: unknown) => {
          console.error(`  ${mention.id} 실패 통지 발화 실패(읽음 처리 계속):`, e instanceof Error ? e.message : e);
        });
        await deps.murmur.markRead([entryId]);
        attempts.delete(entryId);
        return;
      }
      // 아직 시도가 남았다 — 다음 시도 시각을 찍는다. 이 entry 만 쉬고 나머지는 흐른다.
      attempts.set(entryId, { tried, notBefore: now() + backoffFor(tried) });
    } finally {
      inFlightEntries.delete(entryId);
      inFlightThreads.delete(threadKey);
      await deps.hooks.resumeHandoff(threadKey);
    }
```

`createMentionScheduler` 바깥에 백오프 정책을 둔다:

```ts
/**
 * `tried` 번 실패한 entry 가 다음 시도까지 쉬는 시간.
 *
 * 폴 루프의 전역 백오프(`policy.ts::nextBackoffMs`)와 **같은 사다리를 쓴다** — 두 곳이 각자
 * 상수를 들면 하나를 고칠 때 다른 하나가 남는다. 1회 실패 뒤 1초에서 시작한다.
 */
function backoffFor(tried: number): number {
  let ms = 1_000;
  for (let i = 1; i < tried; i += 1) ms = nextBackoffMs(ms);
  return ms;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionScheduler.test.ts`
Expected: PASS — 11 tests

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/mentionScheduler.ts packages/agent/test/mentionScheduler.test.ts
git commit -m "feat(agent): 실패 백오프를 entry 별로 내린다

현행 전역 sleep 은 병렬에서 틀리다 — 스레드 A 의 실패가 스레드 B~F 의 새
멘션까지 멈춘다. 러너 전역 백오프는 폴 루프의 transport 실패에만 남는다."
```

---

### Task 4: `main.ts` 배선 교체와 종료 드레인

**Files:**
- Modify: `packages/agent/src/main.ts` (배치 루프 전체 — 현재 `while (running)` 안의 `for (const entry of batch.entries)` 블록)
- Test: 기존 전체 스위트로 회귀 확인

**Interfaces:**
- Consumes: Task 3 의 `createMentionScheduler`, `MentionScheduler`, `BatchContext`.
- Produces: 없음(최종 배선).

- [ ] **Step 1: 스케줄러를 배선한다**

`main.ts` 의 import 에 추가:

```ts
import { createMentionScheduler, type BatchContext } from './mentionScheduler.js';
```

`interactive = createInteractiveManager({...})` 블록 **뒤**, `const sleep = ...` **앞**에 삽입:

```ts
// #337/#384 의 유예·이어받기와 같은 registry·queue 를 본다 — 갈라지면 같은 세션에 PTY 가 둘 뜬다.
const scheduler = createMentionScheduler({
  murmur, registry, queue: mentionQueue, accountLane,
  runMentionTurn,
  // 계정별로 갈리는 두 필드만 계정 축이 채운다 — 나머지는 계정과 무관하다.
  buildTurnDeps: ({ ctx, mention, account }) => ({
    murmur, store, exec, runTurn: runPtyTurn, me, guide,
    channelName: ctx.channelName(mention.channelId),
    handles: ctx.handles, workspaceBaseDir, mcpConfigPath,
    // 지시문 파일이 여기 쓰인다(#92) — 에이전트 워크스페이스가 아니라 러너의 상태
    // 디렉터리다. 워크스페이스 안에 두면 bypassPermissions 에이전트가 자기 지시문을 고칠 수 있다.
    stateDir: agentStateDir, codexHome,
    claudeAccount: account?.name ?? null,
    claudeConfigDir: account?.configDir ?? null,
    murmurUrl: config.murmurUrl, pat: config.murmurPat,
    turnTimeoutMs: config.turnTimeoutMs,
    relay, registry,
  } satisfies MentionTurnDeps),
  hooks: {
    resumeHandoff: async (threadKey) => { await interactive?.resumeHandoff(threadKey); },
    stopRequested: (at) => {
      // #129: 종료 요청은 턴이 끝난 지금 본다. 진행 중인 다른 턴은 drain 이 기다린다.
      if (stopRequestedForRunner(at, startedAtMs)) acceptStopRequest(at);
    },
    exitIfUnrecoverable,
    noticeHarnessLogin: noticeIfHarnessLogin,
  },
  startedAtMs,
});
```

- [ ] **Step 2: 배치 루프를 교체한다**

`while (running)` 안의 `const done: number[] = [];` 부터 `await murmur.markRead(done);` 까지를 전부 지우고 다음으로 바꾼다(`const channels`·`byId`·`accounts`·`handles` 조립은 그대로 둔다):

```ts
    const ctx: BatchContext = {
      channelName: (channelId) => byId.get(channelId) ?? 'dm',
      handles,
    };
    const outcome = await scheduler.admit(batch, ctx);
```

그리고 그 아래 sleep 판정을 다음으로 바꾼다:

```ts
    // 인플라이트 entry 는 미읽음으로 남으므로(markRead 는 턴 완료 후다) 다음 폴이 **즉시**
    // 같은 배치를 돌려준다 — 아무것도 새로 못 띄운 폴이면 잠깐 쉰다. 유예 backoff 와 같은
    // 5초다: 유예도 blocked 도 실패가 아니고(늘어나는 backoff 는 자리가 난 뒤 반응만 늦춘다),
    // 5초는 턴 하나가 끝난 뒤 대기 멘션이 시작되기까지의 최대 지연이다.
    if (outcome.started === 0 && outcome.deferred + outcome.blocked > 0) {
      await sleep(5_000);
    }
    backoffMs = 1_000;
```

`while` 루프 **뒤**, `relay.stop()` **앞**에 드레인을 넣는다:

```ts
// #129 의 계약 "진행 중인 턴을 마쳤으므로 물러난다" 를 병렬에서도 지킨다 — 루프를 벗어난
// 지금 admit 은 멈췄고, 남은 것은 이미 도는 턴들뿐이다.
await scheduler.drain();
```

- [ ] **Step 3: 죽은 코드를 지운다**

`const attempts = new Map<number, number>();` 를 지운다(스케줄러가 자기 것을 든다). `backoffMs` 는 폴 루프 catch 가 쓰므로 **남긴다**.

import 도 정리한다. `mentionAnchor` 는 이제 스케줄러가 부르므로 `main.ts` 에서 지운다:

```ts
// 전: import { mentionAnchor, runMentionTurn, type MentionTurnDeps } from './mentionTurn.js';
import { runMentionTurn, type MentionTurnDeps } from './mentionTurn.js';
```

`prompt.ts` 에서 가져오던 것 중 `controlledNotice`·`FAILURE_NOTICE`·`quotaNotice`·
`sessionConflictNotice` 는 스케줄러로 옮겨갔다. `harnessLoginNotice` 는 `noticeIfHarnessLogin`
이 여전히 `main.ts` 에 있으므로 **남긴다**. `policy.ts` 에서 가져오던 `exhausted`·
`MAX_ATTEMPTS`·`isQuotaExhausted`·`isSessionIdConflict` 도 지우고, `nextBackoffMs` 와
`isCredentialFailure` 는 남긴다(각각 폴 루프 백오프와 `noticeIfHarnessLogin` 이 쓴다).

`typecheck` 가 남은 미사용 import 를 잡아 준다 — 목록을 손으로 맞추려 들지 말고 그 출력을 따른다.

- [ ] **Step 4: 타입 검사와 전체 테스트**

Run: `pnpm --filter @murmur/agent typecheck && pnpm --filter @murmur/agent test`
Expected: typecheck 통과. `wakeWiring.test.ts` 와 `mainCredentialSites.test.ts` 는 **실패한다** — 검사 대상이 스케줄러로 옮겨갔기 때문이고, Task 5 가 고친다. 나머지는 전부 통과해야 한다.

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/main.ts
git commit -m "feat(agent): 러너 배치 루프를 스케줄러로 교체

for…await 직렬 루프가 사라진다. 폴 루프는 이제 턴에 묶이지 않으므로 턴이
도는 동안에도 다른 스레드의 멘션을 집는다. 종료는 admit 중단 + drain 으로
'진행 중인 턴을 마쳤으므로 물러난다' 계약을 유지한다."
```

---

### Task 5: 기존 소스 정규식 테스트를 실제 동작 검사로 승격

**Files:**
- Modify: `packages/agent/test/wakeWiring.test.ts`
- Modify: `packages/agent/test/mainCredentialSites.test.ts`

**Interfaces:**
- Consumes: Task 4 이후의 `mentionScheduler.ts`·`main.ts`.
- Produces: 없음.

- [ ] **Step 1: `wakeWiring.test.ts` 를 고친다**

`main.ts` 를 읽던 첫 케이스를 지우고 다음으로 바꾼다. `entry.reason === 'wake'` 판정이 스케줄러로 옮겨갔으므로 **실제로 호출해** 확인한다:

```ts
  it("스케줄러가 reason === 'wake' 를 보고 턴에 사유를 싣는다", async () => {
    const targets: { wake?: { reason: string } }[] = [];
    const scheduler = createMentionScheduler({
      murmur: { markRead: async (ids) => ids.length, post: async () => 1 },
      registry: new TurnRegistry(),
      queue: new MentionQueue(),
      accountLane: [null],
      runMentionTurn: async (_d, target) => { targets.push(target); return { stopRequestedAt: null }; },
      buildTurnDeps: () => ({}) as never,
      hooks: {
        resumeHandoff: async () => {}, stopRequested: () => {},
        exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {},
      },
      startedAtMs: 0,
    });

    await scheduler.admit({
      entries: [{ id: 1, messageId: 'w1', reason: 'wake', readAt: null, channelId: 'ch-1' }],
      messages: [{
        id: 'w1', seq: 1, channelId: 'ch-1', threadRootId: null, authorId: 'agent-1',
        body: '30분 뒤 CI 확인', kind: 'message', meta: null,
        createdAt: '2026-09-08T00:00:00Z', alsoInChannel: false,
      }],
    } as never, { channelName: () => 'general', handles: {} });
    await scheduler.drain();

    // 깨움에는 부른 사람의 새 발화가 없다 — 사유를 안 실으면 프롬프트가 비어 턴이 건너뛰어지고,
    // 기다림이 흔적 없이 사라진다.
    expect(targets[0]?.wake).toEqual({ reason: '30분 뒤 CI 확인' });
  });
```

파일 상단 import 를 그에 맞게 더한다(`createMentionScheduler`, `TurnRegistry`, `MentionQueue`). `mentionTurn.ts` 를 소스로 읽는 두 번째 케이스(`wake: target.wake`)는 **그대로 둔다** — 그 파일은 여전히 그 자리에서만 확인 가능하다.

- [ ] **Step 2: 스케줄러에 wake 를 싣는다**

Task 1~3 의 `runOne` 이 만드는 `target` 에 wake 가 빠져 있다. `runOne` 시그니처 끝에
`reason: InboxBatch['entries'][number]['reason']` 을 더하고, `admit` 의 호출도 함께 바꾼다:

```ts
        const task = runOne(entry.id, mention, anchor, threadKey, ctx, tried, entry.reason)
```

그리고 `target` 을 다음으로 바꾼다:

```ts
    const target: MentionTarget = {
      channelId: mention.channelId, threadRootId: anchor, mentionId: mention.id,
      // 깨움(마이그레이션 040): 자기가 걸어 둔 예약이 시각이 되어 자기를 부른 것이다. 사유는
      // 그 대기 줄의 본문이다 — 서버가 거기 넣었고(agentWakes.ts), 여기서 다시 지어내면
      // 사람이 스레드에서 읽는 사유와 프롬프트의 사유가 갈라진다.
      ...(reason === 'wake' ? { wake: { reason: mention.body } } : {}),
    };
```

- [ ] **Step 3: `mainCredentialSites.test.ts` 를 고친다**

이 파일은 `exitIfUnrecoverable` 이 **세 자리**(기동·멘션 턴·폴 루프)에 걸려 있는지를 본다. 멘션 턴 자리가 스케줄러로 옮겨갔으므로, 그 케이스만 대상을 바꾼다. `const source = readFileSync(.../main.ts)` 아래에 추가:

```ts
const schedulerSource = readFileSync(path.resolve(__dirname, '../src/mentionScheduler.ts'), 'utf8');
```

멘션 턴 자리를 보던 케이스를 다음으로 바꾼다:

```ts
  it('멘션 턴의 실패 경로가 판정을 부른다 (스케줄러로 이동)', () => {
    // 자리가 main.ts 에서 mentionScheduler.ts 로 옮겨갔다(2026-09-08 병렬화). 판정 자체는
    // exit.test.ts 가 실물로 확인하고, 여기서는 그 자리에 걸려 있는지만 본다 — 이 기능이
    // 실제로 깨졌던 방식이 "판정은 있는데 그 자리에 없다" 였다.
    expect(schedulerSource).toContain('deps.hooks.exitIfUnrecoverable(err)');
    // 물러나기 **전에** 사람이 보는 자리에 말한다 — 순서가 계약이다.
    const noticeAt = schedulerSource.indexOf('noticeHarnessLogin(err');
    const exitAt = schedulerSource.indexOf('exitIfUnrecoverable(err)');
    expect(noticeAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(exitAt);
  });
```

기동·폴 루프 자리를 보던 케이스는 `main.ts` 를 계속 보므로 **그대로 둔다**.

- [ ] **Step 4: 전체 테스트**

Run: `pnpm --filter @murmur/agent test`
Expected: PASS — 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/test/wakeWiring.test.ts packages/agent/test/mainCredentialSites.test.ts packages/agent/src/mentionScheduler.ts
git commit -m "test(agent): 소스 정규식 검사를 실제 동작 검사로 승격

wake 사유 주입은 이제 import 가능한 모듈에 있으므로 스케줄러를 실제로 돌려
확인한다. 자격증명 판정 자리 검사는 대상을 스케줄러로 옮긴다."
```

---

### Task 6: 스펙 §동시성 개정

**Files:**
- Modify: `docs/specs/2026-09-01-runner-sessions-pty-design.md` (§동시성, 현재 133~142행)

**Interfaces:**
- Consumes: 없음.
- Produces: 없음.

- [ ] **Step 1: §동시성을 개정한다**

현재 문단을 지우지 않고 아래 형태로 바꾼다. **v1 원문을 인용으로 남긴다** — 그 문단이 경고한 폭주 위험은 개정 뒤에도 사실이고, 근거를 지우면 나중에 상한을 다시 논의할 때 재료가 없다:

```markdown
### 동시성

**2026-09-08 개정.** 멘션 턴은 **스레드마다 하나**이고, **스레드 간에는 무제한 병렬**로 돈다.
같은 스레드는 여전히 직렬이다(`TurnRegistry` + `mentionScheduler` 의 인플라이트 장부).
설계: `docs/specs/2026-09-08-mention-turn-parallelism-design.md`.

v1 은 이랬다:

> 멘션 턴은 러너당 **한 번에 하나**(현행 poll 배치의 순차 처리 유지). 스레드가 달라도
> 줄 세운다 — 로컬 로그인 하나가 rate limit 을 공유하므로 병렬의 실제 상한은 계정
> 한도이고, v1 에서 병렬화는 이득보다 폭주 위험이 크다.

바꾼 이유는 그 결정의 대가가 실측으로 드러났기 때문이다(2026-09-08): 19분짜리 턴 하나가
도는 동안 **서로 다른 스레드의 멘션 5건이 무음으로 쌓였다.** 폴 자체가 나가지 않으므로
러너는 그 멘션들의 존재조차 몰랐고, 부른 사람에게 아무 통지도 가지 않았다.

**v1 의 관찰은 그대로 유효하다.** 계정 배분은 바뀌지 않았다 — 모든 턴이 lane 첫 계정부터
시작하고 한도·자격증명 실패에서만 다음 계정으로 넘어간다. 따라서 *"병렬의 실제 상한은 계정
한도"* 는 지금도 참이다. 동시 상한을 두지 않기로 한 근거와 실측 메모리 비용은 위 설계 문서
§4-6 에 있다.

사람 인터랙티브 턴은 예외로 동시에 존재할 수 있다(사람이 자기 눈으로 본다).

사람이 조종 중인 스레드에 멘션이 오면: 큐에 두고 스레드에 메시지 —
*"@fizz 는 지금 jaebin 이 직접 조종 중 — 대기 1건"*. 사람이 닫으면 러너가 처리한다.
```

그 아래 "에이전트가 여럿이면…" 문단은 **그대로 둔다** — 여전히 참이다(러너가 서로 다른
프로세스라는 사실은 바뀌지 않았다). 다만 마지막 괄호 *"(직렬화는 러너 안에서만)"* 을
*"(러너 안에서도 이제 스레드가 다르면 병렬이다 — 위 개정)"* 로 바꾼다.

- [ ] **Step 2: 커밋**

```bash
git add docs/specs/2026-09-01-runner-sessions-pty-design.md
git commit -m "docs(agent): 스펙 §동시성 개정 — 스레드 간 병렬

v1 원문은 인용으로 남긴다. 그 문단이 경고한 폭주 위험은 개정 뒤에도 사실이고,
근거를 지우면 나중에 상한을 다시 논의할 때 재료가 없다."
```

---

## 최종 확인

- [ ] `pnpm --filter @murmur/agent test` — 전부 통과
- [ ] `pnpm --filter @murmur/agent typecheck` — 오류 없음
- [ ] `pnpm -r test` — 다른 패키지 회귀 없음
- [ ] 실물 확인: 러너를 띄우고 **서로 다른 스레드에 멘션 2건을 20초 간격으로** 보낸다.
      러너 로그에 `턴 시작` 이 두 번 연달아 찍히고 그 사이에 `턴 종료` 가 없어야 한다
      (로그: `~/Library/Application Support/app.murmur.desktop/daemon/runner-<agentId>.log`).
