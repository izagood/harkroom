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
import { controlledNotice } from './prompt.js';

/** 배치 단위로 한 번만 받는 것들. 턴마다 바뀌지 않는다. */
export interface BatchContext {
  channelName(channelId: string): string;
  handles: Record<string, string>;
}

export interface AdmitOutcome {
  /** 이번에 띄운 턴. */
  started: number;
  /** 사람이 조종 중이라 유예했다(스펙 §5-2 결정 6). */
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

        if (inFlightThreads.has(threadKey) || deps.registry.get(threadKey)) { out.blocked += 1; continue; }

        // 장부 등록은 **동기적으로, 띄우기 전에**. 위 inFlightThreads 주석이 이유다.
        inFlightEntries.add(entry.id);
        inFlightThreads.add(threadKey);
        out.started += 1;

        const task: Promise<void> = runOne(entry.id, mention, anchor, threadKey, ctx)
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
      // 스냅샷을 떠서 도는 이유: 완료 콜백이 이 집합을 수정하므로 순회 중에 직접 읽지 않는다.
      while (running.size) await Promise.all([...running]);
    },
  };
}
