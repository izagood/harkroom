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
import { controlledNotice, FAILURE_NOTICE, quotaNotice, sessionConflictNotice } from './prompt.js';
import { exhausted, isQuotaExhausted, isSessionIdConflict, MAX_ATTEMPTS, nextBackoffMs } from './policy.js';

/**
 * `tried` 번 실패한 entry 가 다음 시도까지 쉬는 시간(ms).
 *
 * 여기 걸린 트레이드오프: 짧으면 일시적 실패(서버 재시작, 순간적 네트워크 단절)에서 빨리
 * 회복하지만 MAX_ATTEMPTS(3) 를 몇 초 만에 태워 버린다 — `policy.ts::isQuotaExhausted` 의
 * 주석이 지적한 그 문제다("3회가 5초 안에 끝나므로 한도가 풀릴 리 없고, 태운 끝에 남는
 * 안내는 사람이 할 일을 잘못 가리킨다"). 길면 회복이 그만큼 늦다.
 *
 * `policy.ts::nextBackoffMs` 가 폴 루프에서 쓰는 사다리(2배씩, 상한 있음)를 재사용할 수
 * 있다 — 두 곳이 각자 상수를 들면 하나를 고칠 때 다른 하나가 남는다.
 */
function backoffFor(tried: number): number {
  // 30초 → 60초. 재시도 창 총 90초는 정상 턴(실측 5~8분)의 20% 라 사용자 눈에는 "조금
  // 오래 걸리네" 안에 묻힌다. 반대로 짧게 잡으면 3초 만에 "운영자 확인이 필요합니다" 가
  // 뜨고 그 멘션은 markRead 로 **영구히 사라진다** — 이 경로의 실패는 PTY 고갈·서버 재시작
  // 같은 일시적 자원 실패라, 조건이 달라질 시간을 주는 것이 곧 답을 얻는 것이다.
  //
  // 비대칭이 값을 정한다: 길어서 생기는 피해는 "좀 더 기다린다"(회복 가능)이고, 짧아서
  // 생기는 피해는 "요청이 사라진다"(회복 불가)다.
  //
  // 사다리는 `policy.ts::nextBackoffMs`(2배, 상한 있음)를 시작값만 바꿔 재사용한다 —
  // 모양이 한 곳에 있어야 나중에 한쪽만 고치는 사고가 없다.
  let ms = 30_000;
  for (let i = 1; i < tried; i += 1) ms = nextBackoffMs(ms);
  return ms;
}

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
    /**
     * 이 계정이 축의 **마지막인가**(2026-09-08). 사람 부르기는 여기서만 열린다 —
     * 앞 계정에서 부르면, 준비된 계정이 뒤에 있는데도 사람을 깨운다.
     */
    isLastAccount: boolean;
  }): MentionTurnDeps;
  hooks: {
    stopRequested(at: string): void;
    exitIfUnrecoverable(err: unknown): void;
    noticeHarnessLogin(err: unknown, channelId: string, anchor: string, messageId: string): Promise<void>;
  };
  /** 종료 요청이 나를 향한 것인지 가르는 기준(stop.ts). */
  startedAtMs: number;
  /** 테스트가 백오프 경계를 결정론적으로 재현하기 위한 시계 주입. 생략하면 Date.now. */
  now?: () => number;
}

export interface MentionScheduler {
  admit(batch: InboxBatch, ctx: BatchContext): Promise<AdmitOutcome>;
  inFlight(): number;
  drain(): Promise<void>;
}

export function createMentionScheduler(deps: MentionSchedulerDeps): MentionScheduler {
  const now = deps.now ?? Date.now;
  /**
   * 항목별 시도 횟수와 **다음 시도 가능 시각**.
   *
   * 백오프가 전역이 아니라 entry 별인 이유: 현행 main 루프는 실패 시 `sleep(backoffMs)` 로
   * 루프 전체를 재웠다. 병렬에서는 그것이 틀리다 — 스레드 A 의 실패가 스레드 B~F 의 새
   * 멘션까지 멈춘다. 러너 전역 백오프는 폴 루프의 transport 실패에만 남는다(main.ts).
   */
  const attempts = new Map<number, { tried: number; notBefore: number }>();
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
    entryId: number, mention: InboxBatch['messages'][number], anchor: string, threadKey: string,
    ctx: BatchContext, tried: number, reason: InboxBatch['entries'][number]['reason'],
  ): Promise<void> {
    const target: MentionTarget = {
      channelId: mention.channelId, threadRootId: anchor, mentionId: mention.id,
      // 깨움(마이그레이션 040): 자기가 걸어 둔 예약이 시각이 되어 자기를 부른 것이다. 사유는
      // 그 대기 줄의 본문이다 — 서버가 거기 넣었고(agentWakes.ts::scheduleWake), 여기서 다시
      // 지어내면 사람이 스레드에서 읽는 사유와 프롬프트의 사유가 갈라진다.
      //
      // 평범한 멘션으로 처리하면 안 되는 이유: 깨움에는 부른 사람의 새 발화가 없다. 델타는
      // 자기가 쓴 대기 줄뿐이고 자기 발화는 걸러지므로 프롬프트가 비어, 러너가 하네스를
      // 돌리지 않고 커서만 전진시킨다 — 기다림이 흔적 없이 사라진다.
      ...(reason === 'wake' ? { wake: { reason: mention.body } } : {}),
    };
    try {
      const turn = await withAccountFailover(
        deps.accountLane,
        (account, isLastAccount) => deps.runMentionTurn(
          deps.buildTurnDeps({ ctx, mention, account, isLastAccount }), target,
        ),
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
      // 재시도로 낫지 않는 실패는 여기서 걸러 **재시도 회계에 들어가기 전에** 죽는다 —
      // 시도 회계와 실패 통지는 아래 한참 뒤부터 시작한다. 조용히 반복하면 "왜 답이
      // 없지"의 원인이 묻힌다: 자격증명 실패는 폐기된 PAT 로 무한 재시도하고(#250), 하네스
      // 실행 파일 부재는 멘션 MAX_ATTEMPTS 건을 태운 뒤에야 흔적을 남긴다(#340).
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
      // **이 두 줄이 어떤 await 보다도 앞이어야 한다.** 뒤에 두면 그 사이 예외에 스레드
      // 키가 장부에 영구히 남고, 그 스레드는 영원히 blocked 가 된다 — 프로세스는 회수됐는데
      // 장부만 남아 스레드가 죽는다(turnRegistry.ts 머리 주석의 인메모리판).
      inFlightEntries.delete(entryId);
      inFlightThreads.delete(threadKey);
    }
  }

  return {
    async admit(batch, ctx) {
      const out: AdmitOutcome = { started: 0, deferred: 0, blocked: 0, skipped: 0 };
      const orphans: number[] = [];

      for (const entry of batch.entries) {
        const mention = batch.messages.find((m) => m.id === entry.messageId);
        if (!mention) { orphans.push(entry.id); out.skipped += 1; continue; }

        // 관문 0: 실패 백오프. `attempts` 를 **읽기만** 한다 — 증가는 모든 관문 뒤다.
        const record = attempts.get(entry.id);
        if (record && record.notBefore > now()) { out.blocked += 1; continue; }

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

        // **관문을 전부 통과한 지금이 유일한 증가 지점이다.** blocked·deferred·skipped 는 이
        // 줄에 닿지 않는다 — 닿으면 붐비는 스레드의 멘션이 답도 못 듣고 MAX_ATTEMPTS 로 버려진다.
        const tried = (attempts.get(entry.id)?.tried ?? 0) + 1;
        attempts.set(entry.id, { tried, notBefore: 0 });

        const task: Promise<void> = runOne(entry.id, mention, anchor, threadKey, ctx, tried, entry.reason)
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
