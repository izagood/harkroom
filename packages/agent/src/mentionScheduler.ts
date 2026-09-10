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
import {
  controlHeldNotice, controlledNotice, FAILURE_NOTICE, quotaNotice, retryNotice, retryReason,
  sessionConflictNotice, stallNotice,
} from './prompt.js';
import { exhausted, isHarnessStall, isQuotaExhausted, isSessionIdConflict, MAX_ATTEMPTS, nextBackoffMs } from './policy.js';

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

/**
 * 조종이 이만큼 이어지면 스레드에 `막힘`으로 한 번 세운다.
 *
 * 값의 근거: 사람이 터미널에서 하는 일 한 토막(명령 몇 줄 + 결과 읽기)은 실측 1~3분이고,
 * 그보다 넉넉히 잡아야 정상 작업 중에 경고가 뜨지 않는다. 반대로 너무 길게 잡으면 —
 * 실측된 사건은 **17분 넘게** 조용했다 — 그 사이 사람은 자기 요청이 어디로 갔는지 모른다.
 * 10분은 "한 토막보다 확실히 길고, 사람이 포기하기 전"이다.
 */
const DEFER_WARN_MS = 10 * 60_000;

/**
 * 또는 이만큼 쌓이면. 시간과 **함께** 재는 이유: 조종이 짧아도 대기가 셋이면 그 스레드에서
 * 사람 셋(혹은 한 사람이 세 번)이 답을 못 받고 있다는 뜻이고, 그것은 시간과 무관한 사실이다.
 * 실측 사건에서 3건째가 마지막으로 관측된 값이라 그 자리를 경계로 둔다.
 */
const DEFER_WARN_PENDING = 3;

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
  /**
   * 실패로 남긴다(`message.fail`). 평문(`post`)과 갈라 쓰는 자리가 있다 — 사람이 손을 대야
   * 풀리는 것은 스레드 상태에 `막힘`으로 남아야 하고, 그것을 정하는 것은 본문이 아니라
   * `meta.kind` 다(`murmur.ts::fail` 주석).
   */
  fail(
    channelId: string,
    body: string,
    threadRootId: string | null,
    opts: { retryable: boolean; what?: string; reason?: string },
  ): Promise<number>;
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

/**
 * "선택에 답이 왔다" 한 줄. 못 읽으면 **짧게라도 말한다** — 빈 문자열을 돌려주면 델타가
 * 비어 하네스가 돌지 않고, 그러면 사람이 누른 버튼이 아무 일도 안 한 것이 된다.
 */
/**
 * **답하지 않기로 했다**(2026-09-09). `askAnsweredNote` 와 가른 이유는 할 일이 다르기
 * 때문이다: 고른 길로 가는 것이 아니라 **접는 것**이다. 고른 것이 없으므로 옵션을 풀어
 * 싣지 않는다 — 대신 사람이 무엇을 물음에 답하지 않았는지가 본문에 있다.
 */
function askClosedNote(): string {
  return '내가 낸 선택지에 사람이 답하지 않기로 했다 — 그 선택을 기다리지 말고,'
    + ' 지금 아는 것으로 접거나 다른 길을 골라라(같은 물음을 다시 내지 마라)';
}

function askAnsweredNote(mention: { body: string; meta?: unknown }): string {
  const ask = (mention.meta as { ask?: {
    options?: { id: string; label: string }[]; answeredWith?: string;
  } } | undefined)?.ask;
  const picked = ask?.answeredWith;
  const label = ask?.options?.find((o) => o.id === picked)?.label;
  if (!picked) return '내가 낸 선택지에 답이 왔다(어느 것인지 스레드에서 확인해라)';
  return `내가 낸 선택지에 답이 왔다 — 고른 것: ${label ?? picked}`;
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
  /**
   * `noticed`: 이 entry 의 재시도 통지를 이미 올렸는가(2026-09-09). entry 당 1회다 —
   * 매 시도마다 올리면 빠르게 실패하는 오류에서 스레드가 몇 초 만에 도배된다.
   */
  const attempts = new Map<number, { tried: number; notBefore: number; noticed?: boolean }>();
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
    /** 팀 부름이면 서버가 실어 준 명단(047). 사유와 짝이라 함께 넘긴다. */
    team?: InboxBatch['entries'][number]['team'],
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
      /**
       * **선택에 답이 왔다**(2026-09-09). 깨움과 같은 자리를 쓰는 이유는 같은 문제이기
       * 때문이다: 사람은 카드의 버튼만 눌렀지 새 메시지를 쓰지 않았으므로 델타가 비고,
       * 비면 러너가 하네스를 돌리지 않는다 — 그러면 답이 흔적 없이 사라진다.
       *
       * **고른 것을 여기서 풀어 싣는다.** `inbox.poll` 이 그 메시지의 meta 를 함께 주므로
       * (`answeredWith` 와 옵션 목록), 에이전트가 스레드를 다시 읽지 않아도 무엇이
       * 정해졌는지 안다. 라벨을 쓰는 이유: id 는 에이전트가 지은 내부 값이라 사람이 무엇을
       * 골랐는지 그 자체로는 말하지 않는다.
       */
      ...(reason === 'ask_answered' ? { wake: { reason: askAnsweredNote(mention) } } : {}),
      /**
       * **답하지 않기로 했다**(마이그레이션 045). 같은 자리를 쓰는 이유는 같은 문제이기
       * 때문이다 — 사람은 버튼만 눌렀지 새 메시지를 쓰지 않았으므로 델타가 비고, 비면
       * 러너가 하네스를 돌리지 않아 그 결정이 흔적 없이 사라진다.
       */
      ...(reason === 'ask_closed' ? { wake: { reason: askClosedNote() } } : {}),
      /**
       * **팀장으로 불렸다**(047). `wake` 계열과 달리 델타를 대신하지 않는다 — 팀 부름에는
       * 사람의 새 발화가 있고(팀을 부른 그 말), 이것은 그 위에 덧붙는 맥락이다.
       *
       * 사유를 함께 보는 이유: 팀이 그 사이 지워지면 서버가 명단 없이 사유만 준다
       * (047 의 `on delete set null`). 그때는 팀 블록 없이 평범한 부름처럼 돈다 —
       * 명단이 빈 팀 블록을 그리면 팀장에게 "팀원 없음"을 알리는 셈이고, 그것은 사실이
       * 아니라 조회 결과의 부재다.
       */
      ...(reason === 'team_mention' && team ? { team } : {}),
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
        // **평문이 아니라 실패로 남긴다**(2026-09-09) — 아래 세 통지가 모두 같은 이유로
        // 바뀌었다: 러너가 답을 못 낸 사실을 평문으로 올리면 스레드 머리는 `끝남` 이 된다
        // (`murmur.ts::fail` 주석의 실측). 한도는 풀린 뒤 다시 부르면 되므로 retryable 이다.
        await deps.murmur.fail(mention.channelId, quotaNotice(quota.resetsAt), anchor, {
          retryable: true,
          what: '사용량 한도로 답하지 못했다',
          reason: quota.resetsAt === null ? '한도가 풀리는 시각을 읽지 못했다' : `${quota.resetsAt} 에 풀린다`,
        }).catch((e: unknown) => {
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
        await deps.murmur.fail(mention.channelId, sessionConflictNotice(), anchor, {
          retryable: false,
          what: '하네스 세션 상태가 어긋나 답하지 못했다',
          reason: '운영자가 러너 로그를 확인해야 한다 — 다시 불러도 같은 자리에서 실패한다',
        }).catch((e: unknown) => {
          console.error(`  ${mention.id} 세션 충돌 통지 발화 실패(읽음 처리 계속):`, e instanceof Error ? e.message : e);
        });
        await deps.murmur.markRead([entryId]);
        attempts.delete(entryId);
        return;
      }

      /**
       * **정지도 재시도로 낫지 않는다**(2026-09-09 실측). 위 두 분기와 같은 갈래다 — 러너는
       * 살고, 재시도는 안 하고, 스레드에 사실을 남긴다.
       *
       * 왜 여기 서는가: 정지의 대표 원인은 고장이 아니라 사람을 기다리는 확인 화면이고, 같은
       * 프롬프트를 다시 넣으면 모델이 같은 명령을 다시 시도해 **같은 자리에 다시 선다.**
       * 그 값이 10분 × 3회 = 30분이었고, 그 30분 동안 사람이 본 것은 "다시 시도합니다" 였다.
       *
       * **`markRead` 를 여기서 한다.** 안 하면 이 항목이 큐에 남아 다음 폴에서 다시 뜨고,
       * 재시도를 안 하겠다고 한 것이 무의미해진다(한도·충돌 분기와 같은 처리).
       */
      const stall = isHarnessStall(err);
      if (stall) {
        console.error(`  ${mention.id} 하네스 정지 — 재시도하지 않는다 (사람이 그 터미널을 봐야 한다): ${err instanceof Error ? err.message : String(err)}`);
        // **평문이 아니라 실패로 남긴다**(`murmur.ts::fail`). 이 스레드는 사람이 손을 대야
        // 풀리므로 화면에 `막힘` 으로 서 있어야 한다 — 평문으로 올리면 배지는 `끝남` 이다.
        await deps.murmur.fail(mention.channelId, stallNotice(stall.stallMs), anchor, {
          retryable: false,
          what: '하네스가 서 있어 답하지 못했다',
          reason: '그 터미널을 열어 화면을 확인해야 한다 — 확인을 기다리는 물음이 서 있을 수 있다',
        }).catch((e: unknown) => {
          console.error(`  ${mention.id} 정지 통지 발화 실패(읽음 처리 계속):`, e instanceof Error ? e.message : e);
        });
        await deps.murmur.markRead([entryId]);
        attempts.delete(entryId);
        return;
      }

      console.error(`  ${mention.id} 답변 실패 (${tried}/${MAX_ATTEMPTS}):`, err instanceof Error ? err.message : err);
      if (exhausted(tried)) {
        // 한도까지 실패하면 읽음 처리해 흘려보낸다 — 안 그러면 이 항목이 큐를 막는다.
        console.error(`  ${mention.id} 포기하고 읽음 처리한다`);
        await deps.murmur.fail(mention.channelId, FAILURE_NOTICE, anchor, {
          retryable: false,
          what: `${MAX_ATTEMPTS}회 시도 끝에 답하지 못했다`,
          reason: retryReason(err instanceof Error ? err.message : String(err)) ?? undefined,
        }).catch((e: unknown) => {
          console.error(`  ${mention.id} 실패 통지 발화 실패(읽음 처리 계속):`, e instanceof Error ? e.message : e);
        });
        await deps.murmur.markRead([entryId]);
        attempts.delete(entryId);
        return;
      }
      // 아직 시도가 남았다 — 다음 시도 시각을 찍는다. 이 entry 만 쉬고 나머지는 흐른다.
      //
      // **그 사실을 스레드에도 남긴다**(2026-09-09). 여기는 지금까지 `console.error` 뿐이었고,
      // 그 결과가 "30분 침묵 뒤에도 스레드에 아무것도 없다" 였다 — 사람은 👀 붙은 `끝남`
      // 배지만 보고 러너가 죽은 줄 안다. `FAILURE_NOTICE` 로는 못 메운다: 그것은 3회를 다
      // 태운 뒤에 나오므로, 재시도가 도는 동안은 여전히 침묵이다.
      //
      // 통지가 실패해도 재시도 회계는 그대로 간다 — 말하지 못한 것과 시도하지 못한 것은
      // 같은 실패가 아니다(위 대기 통지와 같은 판례).
      const already = attempts.get(entryId)?.noticed === true;
      if (!already) {
        /**
         * **평문이 아니라 실패로 낸다**(2026-09-09 실측). 이 통지는 `post` 로 나가고 있었고,
         * 그것이 스레드 머리를 거짓으로 만들었다:
         *
         * 서버의 `unresolved_failure_count` 와 화면의 `threadState()` 는 실패가 **풀렸는지**를
         * "그 뒤에 그 계정이 다시 말했는가"로 판정한다(마지막 답을 평범한 글로 내는 러너가
         * 있어서다). 그 규칙 아래에서 평문 재시도 통지는 **자기 앞의 실패를 지운다** — 그래서
         * 실측 화면이 스레드 머리 `끝남` · 터미널 머리 `Running` 으로 갈렸다.
         *
         * `failure` 로 내면 그 규칙이 그대로 옳아진다: 앞의 실패는 풀리고, **이 통지 자신이
         * 안 풀린 실패로 선다** — 지금 사실이 정확히 그것이다. 재시도가 답을 내면 그 답이
         * 이것을 푼다(같은 계정의 말이므로).
         *
         * `retryable: true` 인 이유: 러너가 실제로 다시 부를 것이고, 그것이 화면이 그리는
         * '다시 부르기' 경로와 어긋나지 않는다.
         */
        await deps.murmur.fail(
          mention.channelId,
          retryNotice(tried, MAX_ATTEMPTS, retryReason(err instanceof Error ? err.message : String(err))),
          anchor,
          {
            retryable: true,
            what: '멘션에 답하지 못하고 턴이 끝났다',
            reason: retryReason(err instanceof Error ? err.message : String(err)) ?? undefined,
          },
        ).catch((e: unknown) => {
          console.error(`  ${mention.id} 재시도 통지 발화 실패(재시도는 계속된다):`,
            e instanceof Error ? e.message : e);
        });
      }
      attempts.set(entryId, { tried, notBefore: now() + backoffFor(tried), noticed: true });
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
          const handle = controlling.openedByHandle ?? '소유자';
          const { shouldNotify, pending, heldMs, warned } =
            deps.queue.defer(threadKey, entry.id, mention.seq, now());
          if (shouldNotify) {
            // 통지는 entry 당 1회 — 재폴링마다 올리면 조종이 길수록 스레드가 도배된다.
            try {
              await deps.murmur.post(mention.channelId, controlledNotice(handle, pending), anchor);
            } catch (err) {
              // 통지는 관측이고 큐는 inbox 다 — 실패해도 유예는 유지된다.
              console.error(`  ${entry.messageId} 대기 통지 발화 실패(유예는 유지된다):`,
                err instanceof Error ? err.message : err);
            }
          }
          // **유예를 무한으로 두지 않는다.** 유예는 요청을 잃지 않지만(inbox 가 큐다) 그
          // 대가로 **조용하다** — 대기 통지가 entry 당 1회라, 조종이 풀리지 않으면 그
          // 스레드는 아무 신호 없이 영구 정지한다. 상한에서 한 번 `막힘`으로 세워 사람을
          // 부른다. 유예 자체는 유지한다(`controlHeldNotice` 주석 — PTY 가 세션을 쥐고
          // 있는 동안 턴을 억지로 띄우면 한 세션을 두 프로세스가 밟는다).
          if (!warned && (pending >= DEFER_WARN_PENDING || heldMs >= DEFER_WARN_MS)) {
            // **먼저 적는다.** 발화가 던지면 다음 폴에서 다시 시도하게 두고 싶지만, 그러면
            // 발화가 계속 실패하는 동안 폴마다 한 번씩 시도해 실패 카드가 쌓인다 — 경고는
            // 관측이고 관측의 실패는 유예를 바꾸지 않는다.
            deps.queue.markWarned(threadKey);
            try {
              await deps.murmur.fail(
                mention.channelId,
                controlHeldNotice(handle, pending, heldMs),
                anchor,
                {
                  // 재시도로 낫는 실패가 아니다 — 사람이 조종을 끝내야 풀린다.
                  retryable: false,
                  what: '사람이 조종 중이라 멘션을 처리하지 못하고 있다',
                  reason: `${handle} 의 조종이 ${Math.max(1, Math.round(heldMs / 60_000))}분째 이어진다`,
                },
              );
            } catch (err) {
              console.error(`  ${entry.messageId} 조종 상한 경고 발화 실패(유예는 유지된다):`,
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
        const prior = attempts.get(entry.id);
        const tried = (prior?.tried ?? 0) + 1;
        // `noticed` 를 **보존한다**: 여기서 떨어뜨리면 시도마다 "아직 안 알렸다"가 되어
        // entry 당 1회라는 약속이 깨진다.
        attempts.set(entry.id, { tried, notBefore: 0, noticed: prior?.noticed });

        const task: Promise<void> = runOne(entry.id, mention, anchor, threadKey, ctx, tried, entry.reason, entry.team)
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
