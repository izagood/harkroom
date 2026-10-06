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
import type { FailOpts, InboxBatch } from './harkroom.js';
import type { WakeReportTo } from '@harkroom/shared';
import { AccountGateRequeueError, mentionAnchor, type MentionTarget, type MentionTurnDeps, type MentionTurnResult } from './mentionTurn.js';
import { SessionStore } from './sessions.js';
import type { TurnRegistry } from './turnRegistry.js';
import type { MentionQueue } from './mentionQueue.js';
import { accountFailureOf, accountTrailOf, withAccountFailover, type ClaudeAccount } from './claudeAccounts.js';
import {
  accountTrailReason, controlHeldNotice, controlledNotice, FAILURE_NOTICE, quotaNotice, retryNotice, retryReason,
  withAccountTrail,
  sessionConflictNotice, stallNotice, threadModelRejectedNotice, wakeReportTo,
} from './prompt.js';
import { exhausted, isHarnessStall, isQuotaExhausted, isSessionIdConflict, isThreadModelRejected, MAX_ATTEMPTS, nextBackoffMs } from './policy.js';
import type { SecretLeases } from './secretLeases.js';
import type { ThreadClaim, ThreadClaims } from './threadClaims.js';
import { looksLikeGate, PromptNotDeliveredError } from './pty.js';

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
  /** 에이전트 계정 id 들 — 침묵 통지가 부른 쪽을 가른다(`MentionTurnDeps.agentIds`). */
  agentIds?: ReadonlySet<string>;
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
 * 이 모듈이 harkroom 에서 실제로 쓰는 것만. `HarkroomAgentClient` 를 통째로 받지 않는 이유는
 * `mentionTurn.ts` 의 `TurnRelay` 와 같다 — 좁게 받아야 테스트가 소켓·MCP 를 세우지 않는다.
 */
export interface SchedulerHarkroom {
  markRead(ids: number[]): Promise<number>;
  post(channelId: string, body: string, threadRootId: string | null): Promise<number>;
  /**
   * 실패로 남긴다(`message.fail`). 평문(`post`)과 갈라 쓰는 자리가 있다 — 사람이 손을 대야
   * 풀리는 것은 스레드 상태에 `막힘`으로 남아야 하고, 그것을 정하는 것은 본문이 아니라
   * `meta.kind` 다(`harkroom.ts::fail` 주석).
   */
  fail(
    channelId: string,
    body: string,
    threadRootId: string | null,
    opts: FailOpts,
  ): Promise<number>;
}

export interface MentionSchedulerDeps {
  harkroom: SchedulerHarkroom;
  registry: TurnRegistry;
  queue: MentionQueue;
  /**
   * 계정 축. 비어 있으면 안 된다 — 호출자가 최소 `[null]` 을 넘긴다(claudeAccounts.ts).
   * 함수면 **턴마다** 불러 그 턴의 축을 얻는다 — 지운 계정을 건너뛰는 자리다(`presentAccounts`).
   */
  accountLane: readonly (ClaudeAccount | null)[] | (() => Promise<readonly (ClaudeAccount | null)[]>);
  /**
   * 이 스레드의 계정 순서(2026-09-29 C ②, `accountAssign.ts`). 생략하면 `accountLane` 그대로다.
   * 스레드마다 묻는 이유: 계정은 스레드 단위로 고정된다 — 세션 파일이 계정 디렉터리 안에 있다.
   * 지운 계정 걸러 내기(`presentAccounts`)는 이 함수가 맡는다.
   */
  /**
   * `anchorMessageId` 는 이 턴의 앵커(채널 최상위면 그 멘션) — 스레드 지정 모델(079)을 찾는 열쇠다.
   * 모델별 주간 창(Opus 등)을 **이 턴이 실제로 쓸 모델**로 봐야 지정한 스레드가 찬 계정을 피한다.
   */
  laneFor?(threadKey: string, anchorMessageId?: string): Promise<readonly (ClaudeAccount | null)[]>;
  /**
   * **사람이 지나야 하는 관문**의 표식(2026-10-01, `@harkroom/shared/claudeGates`). 이 계정의 턴이
   * 프롬프트를 넣기 전 관문에 막혀 넘어가면 `mark`, 이 계정으로 턴이 끝까지 돌면 `clear` 를 부른다.
   * 설정 화면이 그 표식으로 "승인 필요"와 [터미널 열기]를 보이고, 배정기는 그 계정을 새 배정에서 뺀다.
   * 둘 다 **던지지 않아야 한다** — 표식은 관찰이지 턴의 조건이 아니다. 생략하면 아무것도 안 남긴다.
   */
  accountAttention?: {
    mark(account: ClaudeAccount): Promise<void>;
    clear(account: ClaudeAccount): Promise<void>;
    /**
     * 그 config 디렉터리에 관문 표식이 서 있는가(2026-10-02). 관문 때문에 접은 멘션
     * (`AccountGateRequeueError('queued')`)은 이것이 거짓이 될 때까지 다시 띄우지 않는다.
     */
    active?(configDir: string): Promise<boolean>;
  };
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
    /** 이 시도의 프롬프트가 입력창에 들어갔다(`MentionTurnDeps.onPromptDelivered`). 관문 표식 지우기의 근거다. */
    onPromptDelivered?: () => void;
  }): MentionTurnDeps;
  hooks: {
    stopRequested(at: string): void;
    exitIfUnrecoverable(err: unknown): void;
    noticeHarnessLogin(err: unknown, channelId: string, anchor: string, messageId: string): Promise<void>;
  };
  /**
   * 앞 세대 러너가 아직 들고 있는 entry — 이관 중에만 있다(`main.ts` 의 `HARKROOM_HANDOVER_HOLD`).
   *
   * 여기 있는 항목은 **띄우지 않는다.** 앞 러너가 그 턴을 이미 돌리고 있는데 여기서 또 띄우면
   * 같은 멘션에 두 번 답한다 — 이관을 빠르게 하려다 `#430`·`#174` 의 중복을 되살리는 자리다.
   */
  heldEntryIds?: () => ReadonlySet<number>;
  /**
   * 앞 세대가 **끝냈는데 읽음 처리만 못 한** entry(`HARKROOM_HANDOVER_DONE`, L2). 기동 때 `doneUnread` 에
   * 심어 턴 없이 읽음 처리만 한다. `heldEntryIds` 와 달리 풀 일이 없다 — 기다릴 턴이 없다.
   */
  handoverDone?: ReadonlySet<number>;
  /**
   * 턴 임대(비밀 보관소 PR 3, `secretLeases.ts`). 멘션의 첫 시도 전에 받고, 그 멘션이 **끝날 때**(읽음
   * 처리) 놓는다 — 재시도로 미룬 동안은 쥐고 있다(R1: 같은 멘션의 재시도는 받은 임대를 다시 쓴다).
   */
  secretLeases?: SecretLeases;
  /**
   * (에이전트, 스레드) 턴 임대(서버 095, `threadClaims.ts`). 아래 스레드 잠금이 **이 프로세스 안**의 진실이라면
   * 이것은 같은 에이전트의 **러너들 사이**의 진실이다 — 앱 업데이트로 옛 러너와 새 러너가 겹쳐 도는 동안
   * 같은 스레드에 턴이 둘 뜨지 않게 한다. 못 잡으면 `blocked` 로 세고 다음 폴에서 다시 묻는다.
   */
  threadClaims?: ThreadClaims;
  /**
   * 동시 턴 자리(오퍼레이터 전체 상한 `HARKROOM_MAX_TURNS`, `operator/src/turnSlots.ts`). 스레드 임대 다음에 묻는다.
   * 'full' 이면 `blocked` — 읽음 처리하지 않고 attempts 도 올리지 않아, 자리가 난 뒤의 폴에서 다시 온다.
   * 'unsupported'(옛 오퍼레이터·링크 오류)는 상한이 없는 것으로 보고 띄운다.
   */
  turnSlots?: {
    acquire(key: string): Promise<'granted' | 'full' | 'unsupported'>;
    release(key: string): Promise<void>;
  };
  /**
   * 턴 앞뒤 통지(작업 폴더 정리, `cleanupReport.ts`). 기다리지 않는다 — 정리 보고가 늦거나 실패해도 턴은 그대로 돈다.
   */
  turnWatch?: {
    started(threadKey: string, mentionId: string): Promise<void>;
    ended(threadKey: string, mentionId: string): Promise<void>;
  };
  /** 종료 요청이 나를 향한 것인지 가르는 기준(stop.ts). */
  startedAtMs: number;
  /** 테스트가 백오프 경계를 결정론적으로 재현하기 위한 시계 주입. 생략하면 Date.now. */
  now?: () => number;
}

export interface MentionScheduler {
  admit(batch: InboxBatch, ctx: BatchContext): Promise<AdmitOutcome>;
  inFlight(): number;
  /**
   * 지금 도는 턴들의 inbox entry id. `markRead` 가 턴 완료 후라 **아직 미읽음**인 것들이다.
   *
   * 물러나는 러너가 교체 러너에게 "이건 내가 들고 있다"고 넘기는 목록이다
   * (`main.ts` 의 종료 경로 → `relay.notifyPollStopped`).
   */
  holdingEntries(): number[];
  /** 턴은 끝났는데 읽음 처리만 못 한 entry id(`doneUnread`). 교체 러너에게 따로 넘긴다 — 읽음 처리만 하라고. */
  doneEntries(): number[];
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
/** 스레드 임대를 잃어 접힌 턴의 표지. 누가 이어 가는지는 같은 에이전트의 다른 러너다(이관·재접속). */
export function fencedNotice(): string {
  return '(다른 러너가 이 스레드를 넘겨받아 이 턴을 접었다 — 이 러너가 서버와 끊긴 사이 스레드 임대가 만료됐다.'
    + ' 남은 일은 넘겨받은 쪽이 잇는다)';
}

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

/** 깨움 턴의 대상: 사유는 깨움 메시지 본문, 보고처는 그 meta(`meta.wake.reportTo`). */
function wakeTarget(mention: InboxBatch['messages'][number]): { reason: string; reportTo?: WakeReportTo } {
  const reportTo = wakeReportTo(mention.meta);
  return { reason: mention.body, ...(reportTo ? { reportTo } : {}) };
}

/** 끝났는데 읽음 처리가 안 된 entry 를 "다시 띄우지 않는다" 로 기억하는 상한(2026-10-02). */
export const DONE_UNREAD_MAX_MS = 24 * 60 * 60 * 1000;
/**
 * 읽음 처리까지 **끝낸** entry 를 "다시 띄우지 않는다" 로 기억하는 시간(2026-10-06). 폴 묶음은 받은
 * 뒤 `channels()`·`accounts()`·임대·자리를 기다리느라 수 초~수십 초 묵는다 — 그 사이 끝난 턴의 entry 가
 * 묵은 묶음에 미읽음으로 남아 있으므로, 그보다 넉넉히 길면 된다. 그 뒤엔 inbox 가 다시 주지 않는다.
 */
export const RECENTLY_DONE_MS = 10 * 60 * 1000;
/** 관문 때문에 접어 둔 멘션을 기다리는 상한. 그 뒤에는 읽음 처리한다(관문 통지는 이미 남았다). */
export const GATE_WAIT_MAX_MS = 2 * 60 * 60 * 1000;
/** 한 멘션을 관문 때문에 접어 다시 띄우는 횟수 상한(#1047 security F1 안전판). */
export const GATE_REQUEUE_MAX = 5;

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
  /**
   * 계정 관문 때문에 접어 둔 멘션(2026-10-02) — 그 계정의 표식이 지워질 때까지 다시 띄우지 않는다.
   * **읽음 처리하지 않는다**: inbox 의 at-least-once 가 그대로 큐다(조종 유예와 같은 판례). 한없이
   * 기다리지 않는다(`GATE_WAIT_MAX_MS`) — 그 뒤에는 읽음 처리한다(관문 통지는 이미 스레드에 있다).
   */
  const gateWaits = new Map<number, { configDir: string; since: number }>();
  /**
   * 한 멘션을 관문 때문에 접은 횟수와 처음 접은 시각(#1047 security F1). `queued`·`passed` 모두 센다.
   * 상한(`GATE_REQUEUE_MAX`·`GATE_WAIT_MAX_MS`)을 넘으면 읽음 처리한다 — 다음 결함이나 같은 uid 가 표식을
   * 건드려도 재기동·알림이 끝없이 번지지 않게 하는 안전판이다. 재시도 회계(`tried`)와 따로 센다.
   */
  const gateRequeues = new Map<number, { count: number; since: number }>();
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
  /**
   * **턴은 끝났는데 읽음 처리가 실패한 entry**(2026-10-02) → 실패 시각. 다시 띄우지 않고 폴마다
   * 읽음 처리만 다시 시도한다.
   *
   * 왜 필요한가: `markRead` 는 턴이 끝난 **뒤**의 서버 호출이라, 그 실패는 턴의 실패가 아니다.
   * 그런데 전에는 `try` 안에 있어 재시도 경로로 떨어졌다 — 턴은 이미 답했는데 "답하지 못하고
   * 끝나 다시 시도합니다" 가 서고, 30초 뒤 **같은 프롬프트로 한 번 더** 돌았다. task_manager
   * 10-01~02 실측: 깨움 754건 중 62건이 같은 사유로 80~180초 뒤 다시 왔고, 그 자리마다 러너
   * 로그는 `MCP error -32001: Request timed out`·`-32000: Connection closed`·`no healthy upstream`
   * 뒤 `답변 실패 (1/3)` 였다. 멘션이면 같은 질문에 두 번 답한다.
   *
   * 끝난 entry 는 **entry id 로 멱등**하다: 이 표에 있으면 inbox 가 다시 줘도 턴을 띄우지 않는다.
   * 상한(`DONE_UNREAD_MAX_MS`)을 넘기면 표에서 지운다 — 그 뒤엔 inbox 의 at-least-once 가 이긴다
   * (표가 영원히 자라지 않게 하는 안전판이고, 그만큼 오래 서버에 못 닿았으면 러너가 이미 교체됐다).
   */
  const doneUnread = new Map<number, number>();
  // 앞 세대가 끝냈는데 읽음 처리만 못 한 entry(L2) — 처음부터 "끝났다" 로 둔다. 시각은 지금: 앞 러너가
  // 언제 끝냈는지 모르고, 24h 상한은 이 러너 기준으로 다시 세는 것이 안전하다(짧게 세면 다시 띄운다).
  for (const id of deps.handoverDone ?? []) doneUnread.set(id, now());
  /**
   * **턴도 끝나고 읽음 처리도 된 entry** → 끝낸 시각(2026-10-06, wake 두 번 뜸).
   *
   * 왜 필요한가: 폴 루프는 `pollInbox` → `channels()` → `accounts()` → `admit` 순서라, 묶음을 받은 뒤
   * admit 에 닿기까지 await 가 여럿이다. 도는 턴의 entry 는 아직 미읽음이라 그 묶음에 들어 있다. 그 사이
   * 턴이 끝나면 `finish` 가 읽음 처리하고 `finally` 가 `inFlightEntries` 를 지운다 — 성공했으니
   * `doneUnread` 에도 없다. 그래서 **묵은 묶음의 같은 entry 가 모든 관문을 지나 턴을 한 번 더 띄웠다.**
   * 멘션은 델타가 비어 하네스를 안 돌려 안 보였고, 사유를 직접 싣는 wake·ask_answered 는 실제로 두 번
   * 돌았다(task_manager 10-06: wake 턴 70건 중 9건, 간격 27~84초).
   *
   * 이 표에 있으면 이미 읽은 것이므로 읽음 처리도 다시 하지 않고 건너뛴다. `RECENTLY_DONE_MS` 뒤에 지운다.
   */
  const recentlyDone = new Map<number, number>();
  /**
   * 끝난 entry 들을 **한 번의 호출로** 읽음 처리한다 — **던지지 않는다.** 실패하면 전부 `doneUnread` 에
   * 적고(이미 있던 것은 처음 적힌 시각을 지킨다) 다음 폴이 다시 시도한다. 호출자는 이 뒤에 회계
   * 정리(attempts·gateRequeues·임대 반납)를 그대로 이어 간다: 턴의 결말은 이미 났고, 읽음 처리는
   * 그 결말을 서버에 알리는 일일 뿐이다.
   *
   * 묶는 이유(L1): 링크가 느릴 때 id 마다 따로 부르면 폴 루프가 id 수 × 요청 시한만큼 선다.
   */
  const finishMany = async (ids: readonly number[]): Promise<void> => {
    if (ids.length === 0) return;
    try {
      await deps.harkroom.markRead([...ids]);
      const at = now();
      for (const id of ids) { doneUnread.delete(id); recentlyDone.set(id, at); }
    } catch (err) {
      const at = now();
      for (const id of ids) if (!doneUnread.has(id)) doneUnread.set(id, at);
      console.error(`  entry ${ids.join(',')} 읽음 처리 실패(턴은 끝났다 — 다시 띄우지 않고 다음 폴에 읽음 처리만 다시 한다): ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const finish = (entryId: number): Promise<void> => finishMany([entryId]);
  /**
   * 상한을 넘긴 항목을 표에서 지운다(L1). 전에는 같은 entry 가 **다시 올 때만** 지웠다 — 서버가 읽음
   * 처리는 했는데 응답만 늦어 시한에 걸린 경우(`-32001`)가 그 모양이라, 다시 오지 않는 id 가 러너가
   * 사는 동안 표에 남아 이관 목록과 drain 재시도에 계속 실렸다. 폴마다 한 번 훑는다.
   */
  const pruneDoneUnread = (): void => {
    const at = now();
    for (const [id, since] of doneUnread) if (at - since > DONE_UNREAD_MAX_MS) doneUnread.delete(id);
    for (const [id, since] of recentlyDone) if (at - since > RECENTLY_DONE_MS) recentlyDone.delete(id);
  };
  /** 완료를 기다릴 수 있게 잡아 두는 프로미스. `drain` 이 이것을 본다. */
  const running = new Set<Promise<void>>();

  async function runOne(
    entryId: number, mention: InboxBatch['messages'][number], anchor: string, threadKey: string,
    ctx: BatchContext, tried: number, reason: InboxBatch['entries'][number]['reason'],
    /** 팀 부름이면 서버가 실어 준 명단(047). 사유와 짝이라 함께 넘긴다. */
    team?: InboxBatch['entries'][number]['team'],
    /** 넘긴 일의 결말(050). 같은 이유로 사유와 함께 넘긴다. */
    delegation?: InboxBatch['entries'][number]['delegation'],
    /** 넘겨받은 일의 팀장·기한(3-2). */
    delegatedBy?: InboxBatch['entries'][number]['delegatedBy'],
    /** 수정으로 생긴 부름(076). */
    viaEdit?: boolean,
    /** 이 턴이 쥔 스레드 임대를 잃었다는 신호(`threadClaims.ts` 펜싱). */
    fence?: AbortSignal,
    /** 이 부름이 접은 내 예약(서버 107). */
    canceledWakes?: InboxBatch['entries'][number]['canceledWakes'],
  ): Promise<void> {
    /**
     * 임대를 잃어 접힌 턴의 표지(security L1). 사람이 스레드에서 "왜 말하다 멈췄나"를 알 수 있게 한 줄 남긴다.
     * 실패 카드가 아니다 — 고장이 아니라 다른 러너가 이어 가는 것이고, 사람이 할 일이 없다.
     */
    const noticeFenced = async (): Promise<void> => {
      await deps.harkroom.post(mention.channelId, fencedNotice(), anchor).catch((e: unknown) => {
        console.error(`  ${mention.id} 임대 잃음 표지 발화 실패:`, e instanceof Error ? e.message : e);
      });
    };
    const target: MentionTarget = {
      channelId: mention.channelId, threadRootId: anchor, mentionId: mention.id,
      ...(fence ? { fence } : {}),
      // 깨움(마이그레이션 040): 자기가 걸어 둔 예약이 시각이 되어 자기를 부른 것이다. 사유는
      // 그 대기 줄의 본문이다 — 서버가 거기 넣었고(agentWakes.ts::scheduleWake), 여기서 다시
      // 지어내면 사람이 스레드에서 읽는 사유와 프롬프트의 사유가 갈라진다.
      //
      // 평범한 멘션으로 처리하면 안 되는 이유: 깨움에는 부른 사람의 새 발화가 없다. 델타는
      // 자기가 쓴 대기 줄뿐이고 자기 발화는 걸러지므로 프롬프트가 비어, 러너가 하네스를
      // 돌리지 않고 커서만 전진시킨다 — 기다림이 흔적 없이 사라진다.
      //
      // 보고처(2026-10-06)도 그 메시지의 meta 에서 꺼낸다 — 서버가 사유와 함께 거기 실었다.
      ...(reason === 'wake' ? { wake: wakeTarget(mention) } : {}),
      ...(canceledWakes?.length ? { canceledWakes } : {}),
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
      /**
       * **넘긴 일의 결말이 나왔다**(050). `wake` 계열과 같은 자리를 쓰는 이유는 같은 문제이기
       * 때문이다: 기한이 지나 깨어난 경우엔 팀원이 아무 말도 하지 않았으므로 델타가 비고,
       * 비면 러너가 하네스를 돌리지 않는다 — 그러면 팀장이 다시 깨어난 것이 흔적 없이 사라진다.
       *
       * 사유를 함께 보는 이유는 팀 명단과 같다: 결말이 없는 항목(옛 서버·경합)에 빈 블록을
       * 그리면 팀장에게 "결말 없음"을 알리는 셈이고, 그것은 사실이 아니라 조회 결과의 부재다.
       */
      ...(reason === 'delegation_done' && delegation ? { delegation } : {}),
      /**
       * **넘겨받은 일**(3-2). 사유와 함께 보는 이유는 팀 명단과 같다 — 위임이 그 사이
       * 지워지면 서버가 맥락 없이 사유만 준다. 그때는 블록 없이 평범한 부름처럼 돈다.
       */
      ...(reason === 'team_delegated' && delegatedBy ? { delegatedBy } : {}),
      /**
       * **수정으로 불렸다**(076). 고친 글은 seq 가 옛날 그대로라 이미 본 구간일 수 있다 — 그러면
       * 델타(`readThread(since)`)에 들지 않아 프롬프트가 비고 턴이 돌지 않는다. 배치에 실려 온
       * 그 글(고친 뒤의 본문)을 그대로 넘겨 델타와 무관하게 싣게 한다.
       */
      ...(viaEdit ? { editedMention: mention } : {}),
    };
    try {
      const lane = deps.laneFor
        ? await deps.laneFor(threadKey, anchor)
        : typeof deps.accountLane === 'function' ? await deps.accountLane() : deps.accountLane;
      // 비밀이 없어도 턴은 돈다 — 임대 실패는 여기서 삼킨다(acquire 가 던지지 않는다).
      await deps.secretLeases?.acquire(mention.id);
      const turn = await withAccountFailover(
        lane,
        (account, isLastAccount) => {
          /*
            **표식은 입력창까지 간 것이 확실할 때만 지운다**(#1047 security F1). 근거는 이 시도에서 프롬프트가
            실제로 들어갔다는 신호(`onPromptDelivered`) 하나다. 관문 앞에서 접은 턴(`AccountGateRequeueError`)·
            사람을 기다리다 시간이 다 된 턴은 이 신호가 없으므로 표식을 남긴다 — 그 둘이 지우면 같은 계정에
            막힌 턴들이 서로의 표식을 지우며 끝없이 다시 뜨고, 그때마다 관문 글·🙋·Inbox 가 쌓인다.
          */
          let delivered = false;
          return deps.runMentionTurn(
            deps.buildTurnDeps({ ctx, mention, account, isLastAccount, onPromptDelivered: () => { delivered = true; } }), target,
          ).then(
            (result) => {
              if (account && delivered) void deps.accountAttention?.clear(account).catch(() => undefined);
              return result;
            },
            (err: unknown) => {
              // 화면이 **사람의 선택을 기다린다**(`kind: 'waiting'` — 입력창이 아닌 화면을 그리고 멈췄다,
              // 문구가 아니라 상태로 판정한다: `pty.ts::waitingQuietMs`). 상한에 닿은 것(`timeout`)은
              // 표시하지 않는다 — 그 계정을 맨 뒤로 보낼 근거가 없다. 화면 원문은 넘기지 않는다 —
              // 조직 설정 값이 들어 있을 수 있다(`claudeGates.ts`).
              if (account && err instanceof PromptNotDeliveredError && err.kind === 'waiting') {
                void deps.accountAttention?.mark(account).catch(() => undefined);
              } else if (account && delivered) {
                // 입력창까지 간 뒤의 실패(한도·하네스 오류 등) — 그 계정의 관문은 지나 있다.
                void deps.accountAttention?.clear(account).catch(() => undefined);
              }
              throw err;
            },
          );
        },
        // 이유는 종류만 적는다 — 화면 원문은 조직 설정 값을 담을 수 있다(`AccountFailureKind`).
        (from, to, why) => console.error(
          `  ${mention.id} 계정 전환: ${from?.name ?? '(기본)'} → ${to?.name ?? '(기본)'} (이유: ${why ?? '알 수 없음'})`,
        ),
      );
      await finish(entryId);
      attempts.delete(entryId);
      gateRequeues.delete(entryId);
      void deps.secretLeases?.release(mention.id);
      // 답을 낸 뒤 잃었으면 답은 이미 나갔다 — 읽음은 그대로 두고 접혔다는 사실만 남긴다.
      if (fence?.aborted) await noticeFenced();
      if (turn.stopRequestedAt) deps.hooks.stopRequested(turn.stopRequestedAt);
    } catch (err) {
      // **임대를 잃어 접혔다**(security L1) — 실패가 아니다. 이 스레드는 이제 넘겨받은 러너의 것이다:
      // 읽음 처리하지 않고(그쪽이 같은 inbox 를 본다), 재시도 회계도 통지도 하지 않는다. 오류 종류가 아니라
      // 신호로 가른다 — 접히는 길(SIGTERM·스폰 전 가드)이 여럿이라 어느 오류로 끝날지 정해져 있지 않다.
      if (fence?.aborted) {
        const prior = attempts.get(entryId);
        attempts.set(entryId, { tried: Math.max(0, tried - 1), notBefore: 0, noticed: prior?.noticed });
        void deps.secretLeases?.release(mention.id);
        console.error(`  ${mention.id} 스레드 임대를 잃어 턴을 접었다 — 넘겨받은 러너가 잇는다`);
        await noticeFenced();
        return;
      }
      // 계정 관문 때문에 접었다(2026-10-02) — **실패가 아니다.** 재시도 회계·실패 통지·읽음 처리를 하지
      // 않고 같은 멘션을 다시 띄운다: `passed` 는 다음 폴에 바로, `queued` 는 그 계정의 표식이 지워진 뒤.
      if (err instanceof AccountGateRequeueError) {
        void deps.secretLeases?.release(mention.id);
        const rq = gateRequeues.get(entryId) ?? { count: 0, since: now() };
        rq.count += 1;
        gateRequeues.set(entryId, rq);
        if (rq.count > GATE_REQUEUE_MAX || now() - rq.since > GATE_WAIT_MAX_MS) {
          // 안전판: 관문 통지는 이미 스레드에 있다 — 더 띄우지 않고 흘려보낸다.
          console.error(`  ${mention.id} 계정 관문 — 다시 띄우기 상한(${rq.count}회) — 읽음 처리한다`);
          gateRequeues.delete(entryId);
          gateWaits.delete(entryId);
          attempts.delete(entryId);
          await finish(entryId);
          return;
        }
        const prior = attempts.get(entryId);
        attempts.set(entryId, { tried: Math.max(0, tried - 1), notBefore: 0, noticed: prior?.noticed });
        if (err.why === 'queued' && err.configDir) gateWaits.set(entryId, { configDir: err.configDir, since: rq.since });
        console.error(`  ${mention.id} 계정 관문 — 턴을 접고 다시 띄운다(${err.why}, ${rq.count}/${GATE_REQUEUE_MAX})`);
        return;
      }
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

      // 계정 축을 넘겼으면 계정마다의 이유(종류만)를 한 줄로 남긴다 — 마지막 오류만 보면
      // 앞 계정이 사람 손으로 풀리는 관문이었다는 사실이 사라진다(2026-10-01, `AccountFailureKind`).
      const trail = accountTrailOf(err);
      if (trail.length) {
        console.error(`  ${mention.id} 계정 축 소진: ${trail.map((f) => `${f.account ?? '(기본)'}=${f.kind}${f.resetsAt ? `(${f.resetsAt})` : ''}`).join(', ')}`);
      }
      // 사람이 보는 자리(스레드·로그)에 싣는 오류 문장. **준비 실패는 화면 원문을 담으므로**
      // (`PromptNotDeliveredError.tail` — 조직 설정 값이 있을 수 있다) 종류만 남긴다.
      const errText = err instanceof PromptNotDeliveredError
        ? `TUI 준비 신호를 못 봤다(${accountFailureOf(err)?.kind ?? err.kind}, ${err.waitedMs}ms)`
        : err instanceof Error ? err.message : String(err);

      // 사용량 한도는 **재시도 회계에 넣지 않는다.** 3회가 5초 안에 끝나므로 한도가 풀릴 리
      // 없고, 태운 끝에 남는 "운영자 확인이 필요합니다"는 사람이 할 일을 잘못 가리킨다 —
      // 여기서 할 일은 기다리는 것뿐이다.
      const quota = isQuotaExhausted(err);
      if (quota) {
        // `err.message` 는 싣지 않는다 — 화면·메시지 원문을 담을 수 있다(security, #1036). 시각을 못 읽었을
        // 때만 **하네스가 자기 기록에 적은 오류 한 줄**(`harnessApiError` — 화면이 아니다)을 붙인다: 판정이
        // 어디서 어긋났는지 보려면 그 원문이 있어야 한다(2026-09-07 19:03 사건).
        const apiLine = quota.resetsAt === null ? (err as { harnessApiError?: unknown }).harnessApiError : null;
        console.error(`  ${mention.id} 사용량 한도 — 재시도하지 않는다 (풀림: ${quota.resetsAt ?? '알 수 없음'})${typeof apiLine === 'string' ? ` 하네스 오류: ${apiLine.slice(0, 200)}` : ''}`);
        // **평문이 아니라 실패로 남긴다**(2026-09-09) — 아래 세 통지가 모두 같은 이유로
        // 바뀌었다: 러너가 답을 못 낸 사실을 평문으로 올리면 스레드 머리는 `끝남` 이 된다
        // (`harkroom.ts::fail` 주석의 실측). 한도는 풀린 뒤 다시 부르면 되므로 retryable 이다.
        await deps.harkroom.fail(mention.channelId, withAccountTrail(quotaNotice(quota.resetsAt), trail), anchor, {
          retryable: true,
          what: '사용량 한도로 답하지 못했다',
          reason: accountTrailReason(trail)
            ?? (quota.resetsAt === null ? '한도가 풀리는 시각을 읽지 못했다' : `${quota.resetsAt} 에 풀린다`),
        }).catch((e: unknown) => {
          console.error(`  ${mention.id} 한도 통지 발화 실패(읽음 처리 계속):`, e instanceof Error ? e.message : e);
        });
        await finish(entryId);
        attempts.delete(entryId);
        void deps.secretLeases?.release(mention.id);
        return;
      }

      // 세션 id 충돌도 재시도로 낫지 않는다(2026-09-07 실측: 176·185·278ms 만에 같은 자리).
      // **자격증명처럼 죽이지 않는다** — 그 스레드 하나의 세션 상태 문제이고 다른 스레드는
      // 멀쩡하다. 죽으면 다른 스레드의 대기 멘션까지 함께 잃는다.
      if (isSessionIdConflict(err)) {
        console.error(`  ${mention.id} 하네스 세션 충돌 — 재시도하지 않는다 (러너의 세션 상태와 하네스 디스크가 어긋났다): ${err instanceof Error ? err.message : String(err)}`);
        await deps.harkroom.fail(mention.channelId, sessionConflictNotice(), anchor, {
          retryable: false,
          what: '하네스 세션 상태가 어긋나 답하지 못했다',
          reason: '운영자가 러너 로그를 확인해야 한다 — 다시 불러도 같은 자리에서 실패한다',
        }).catch((e: unknown) => {
          console.error(`  ${mention.id} 세션 충돌 통지 발화 실패(읽음 처리 계속):`, e instanceof Error ? e.message : e);
        });
        await finish(entryId);
        attempts.delete(entryId);
        void deps.secretLeases?.release(mention.id);
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
      // 스레드 지정 모델 거절(결정 6) — 정지와 같은 갈래: 재시도하지 않고 사람이 할 일을 남긴다.
      const rejected = isThreadModelRejected(err);
      if (rejected) {
        console.error(`  ${mention.id} 스레드 지정 모델 거절 — 재시도하지 않는다 (${rejected.model ?? '-'}·${rejected.effort ?? '-'}): ${rejected.apiError}`);
        await deps.harkroom.fail(mention.channelId, threadModelRejectedNotice(rejected.model, rejected.effort, rejected.apiError), anchor, {
          retryable: false,
          what: '이 스레드에 지정한 모델을 하네스가 받지 않았다',
          // 화면이 이 표지로 [기본으로 되돌리고 다시 부르기]·[모델 고르기]를 단다 — 문구로 가르지 않는다.
          code: 'thread_model_rejected',
          reason: '스레드 머리의 모델 칩에서 기본으로 되돌리거나 다른 모델을 골라야 한다 — 같은 지정으로는 다시 실패한다',
        }).catch((e: unknown) => {
          console.error(`  ${mention.id} 모델 거절 통지 발화 실패(읽음 처리 계속):`, e instanceof Error ? e.message : e);
        });
        await finish(entryId);
        attempts.delete(entryId);
        void deps.secretLeases?.release(mention.id);
        return;
      }

      const stall = isHarnessStall(err);
      if (stall) {
        console.error(`  ${mention.id} 하네스 정지 — 재시도하지 않는다 (사람이 그 터미널을 봐야 한다): ${err instanceof Error ? err.message : String(err)}`);
        // **평문이 아니라 실패로 남긴다**(`harkroom.ts::fail`). 이 스레드는 사람이 손을 대야
        // 풀리므로 화면에 `막힘` 으로 서 있어야 한다 — 평문으로 올리면 배지는 `끝남` 이다.
        await deps.harkroom.fail(mention.channelId, stallNotice(stall.stallMs), anchor, {
          retryable: false,
          what: '하네스가 서 있어 답하지 못했다',
          reason: '그 터미널을 열어 화면을 확인해야 한다 — 확인을 기다리는 물음이 서 있을 수 있다',
        }).catch((e: unknown) => {
          console.error(`  ${mention.id} 정지 통지 발화 실패(읽음 처리 계속):`, e instanceof Error ? e.message : e);
        });
        await finish(entryId);
        attempts.delete(entryId);
        void deps.secretLeases?.release(mention.id);
        return;
      }

      console.error(`  ${mention.id} 답변 실패 (${tried}/${MAX_ATTEMPTS}):`, errText);
      if (exhausted(tried)) {
        // 한도까지 실패하면 읽음 처리해 흘려보낸다 — 안 그러면 이 항목이 큐를 막는다.
        console.error(`  ${mention.id} 포기하고 읽음 처리한다`);
        await deps.harkroom.fail(mention.channelId, withAccountTrail(FAILURE_NOTICE, trail), anchor, {
          retryable: false,
          what: `${MAX_ATTEMPTS}회 시도 끝에 답하지 못했다`,
          reason: retryReason(errText) ?? undefined,
        }).catch((e: unknown) => {
          console.error(`  ${mention.id} 실패 통지 발화 실패(읽음 처리 계속):`, e instanceof Error ? e.message : e);
        });
        await finish(entryId);
        attempts.delete(entryId);
        void deps.secretLeases?.release(mention.id);
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
        await deps.harkroom.fail(
          mention.channelId,
          withAccountTrail(retryNotice(tried, MAX_ATTEMPTS, retryReason(errText)), trail),
          anchor,
          {
            retryable: true,
            what: '멘션에 답하지 못하고 턴이 끝났다',
            reason: retryReason(errText) ?? undefined,
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
      /** 이 배치에서 다시 온, 끝났는데 읽음 처리만 남은 entry — 루프 뒤 **한 번에** 읽음 처리한다(L1). */
      const doneAgain: number[] = [];
      pruneDoneUnread();

      for (const entry of batch.entries) {
        const mention = batch.messages.find((m) => m.id === entry.messageId);
        if (!mention) { orphans.push(entry.id); out.skipped += 1; continue; }

        // 관문 0: 실패 백오프. `attempts` 를 **읽기만** 한다 — 증가는 모든 관문 뒤다.
        const record = attempts.get(entry.id);
        if (record && record.notBefore > now()) { out.blocked += 1; continue; }

        // 관문 대기(2026-10-02): 그 계정의 표식이 지워질 때까지 이 멘션은 다시 띄우지 않는다.
        const gw = gateWaits.get(entry.id);
        if (gw) {
          if (now() - gw.since > GATE_WAIT_MAX_MS) {
            gateWaits.delete(entry.id);
            gateRequeues.delete(entry.id);
            attempts.delete(entry.id);
            orphans.push(entry.id);
            out.skipped += 1;
            continue;
          }
          const still = await (deps.accountAttention?.active?.(gw.configDir) ?? Promise.resolve(false)).catch(() => false);
          if (still) { out.blocked += 1; continue; }
          gateWaits.delete(entry.id);
        }

        // 끝났는데 읽음 처리만 남은 entry(2026-10-02) — 턴을 띄우지 않고 읽음 처리만 다시 한다.
        // 상한 넘긴 것은 위 `pruneDoneUnread` 가 이미 지웠다.
        if (doneUnread.has(entry.id)) { out.skipped += 1; doneAgain.push(entry.id); continue; }
        // 끝내고 읽음 처리까지 한 entry 가 묵은 묶음에 실려 다시 왔다(2026-10-06) — 아무것도 하지 않는다.
        if (recentlyDone.has(entry.id)) { out.skipped += 1; continue; }

        if (inFlightEntries.has(entry.id)) { out.blocked += 1; continue; }
        // 앞 세대가 들고 있는 것은 **내 것이 아니다**(이관 중). 유예가 끝나면 이 집합이
        // 비므로, 앞 러너가 끝내지 못한 항목도 결국 여기로 돌아온다 — 잃지 않는다.
        if (deps.heldEntryIds?.().has(entry.id)) { out.blocked += 1; continue; }

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
              await deps.harkroom.post(mention.channelId, controlledNotice(handle, pending), anchor);
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
              await deps.harkroom.fail(
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

        // 러너들 사이의 잠금 — 다른 러너(이관 중인 옛 세대)가 이 스레드에서 턴을 돌리고 있으면 띄우지 않는다.
        // 멘션은 미읽음으로 남아 그 턴이 끝나 임대가 풀린 뒤의 폴에서 다시 온다. attempts 를 올리지 않는다.
        let claim: ThreadClaim | null = null;
        if (deps.threadClaims) {
          claim = await deps.threadClaims.hold(mention.channelId, anchor);
          if (!claim) { out.blocked += 1; continue; }
          // 기다리는 사이 이 프로세스 안에서 같은 스레드가 시작됐을 수 있다 — 다시 본다. `hold` 는 스레드당
          // 하나만 주므로 이 임대는 이 자리 것뿐이고, 놓아도 다른 턴의 임대를 지우지 않는다.
          if (inFlightThreads.has(threadKey) || deps.registry.get(threadKey)) {
            void claim.release();
            out.blocked += 1;
            continue;
          }
        }

        // 머신 전체의 동시 턴 상한 — 자리가 없으면 잡은 스레드 임대를 놓고 다음 폴로 미룬다.
        let slotHeld = false;
        if (deps.turnSlots) {
          const slot = await deps.turnSlots.acquire(threadKey);
          if (slot === 'full') {
            void claim?.release();
            out.blocked += 1;
            continue;
          }
          slotHeld = slot === 'granted';
          // 기다리는 사이 이 프로세스 안에서 같은 스레드가 시작됐을 수 있다 — 위와 같은 재확인.
          if (inFlightThreads.has(threadKey) || deps.registry.get(threadKey)) {
            if (slotHeld) void deps.turnSlots.release(threadKey);
            void claim?.release();
            out.blocked += 1;
            continue;
          }
        }

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

        void deps.turnWatch?.started(threadKey, mention.id).catch(() => {});
        const task: Promise<void> = runOne(entry.id, mention, anchor, threadKey, ctx, tried, entry.reason, entry.team, entry.delegation, entry.delegatedBy, entry.viaEdit === true, claim?.lost, entry.canceledWakes)
          .catch((err: unknown) => {
            console.error(`  ${entry.messageId} 턴 실패:`, err instanceof Error ? err.message : err);
          })
          // 임대는 턴이 **완전히 끝난 뒤** 놓는다(재시도로 미룬 멘션도 이 턴은 끝났다 — 다음 시도는 다시 잡는다).
          .finally(() => {
            running.delete(task);
            void claim?.release();
            if (slotHeld) void deps.turnSlots?.release(threadKey);
            void deps.turnWatch?.ended(threadKey, mention.id).catch(() => {});
          });
        running.add(task);
      }

      if (orphans.length) await deps.harkroom.markRead(orphans);
      await finishMany(doneAgain);
      return out;
    },

    inFlight: () => running.size,
    holdingEntries: () => [...inFlightEntries],
    // 읽음 처리가 남은 끝난 entry 는 **따로** 넘긴다(L2) — `holding` 에 섞으면 교체 러너는 보류 시한 동안만
    // 건너뛰고, 시한 뒤 inbox 가 다시 주면 끝난 일에 두 번째 턴을 띄운다. 따로 받으면 읽음 처리만 한다.
    doneEntries: () => [...doneUnread.keys()],

    async drain() {
      // 스냅샷을 떠서 도는 이유: 완료 콜백이 이 집합을 수정하므로 순회 중에 직접 읽지 않는다.
      while (running.size) await Promise.all([...running]);
      // 물러나기 전에 한 번 더, 한 호출로 — 링크가 돌아왔으면 여기서 끝난다.
      await finishMany([...doneUnread.keys()]);
    },
  };
}
