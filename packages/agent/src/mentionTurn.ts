// 멘션 하나를 하네스 턴으로 조립·실행하는 흐름 — main.ts 의 폴 루프에서 분리한 함수다
// (task-9 브리프: "테스트 가능하도록 main 루프에서 분리된 함수"). main.ts 는 top-level
// await 로 접속·설정 파일 쓰기 같은 부작용을 곧바로 일으키므로, 그 파일에 이 함수를 두면
// import 하는 순간 진짜 서버 접속을 시도하게 된다 — 그래서 별도 모듈로 뺐다(브리프의 파일
// 목록에는 없지만, "main 루프에서 분리"라는 요구를 지키려면 이 분리가 필요하다).
//
// 여기 있는 것은 조립뿐이다: Task 3~8 이 만든 부품(sessions, workspace, prompt, turn, pty,
// codexSessions) 을 순서대로 부르고, 그 결과로 무엇을 저장·발화·실패 처리할지 판단한다.
// 하네스 출력은 파싱하지 않는다 — 에이전트가 스스로 murmur MCP 로 답을 올린다(spec §4).
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, symlink, writeFile, lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentHarness, AgentView, InboxDelegationOutcome, InboxTeamCall, MessageRow } from '@murmur/shared';
import type { Me } from './murmur.js';
import { BODY_LIMIT, buildSystemPrompt, buildTurnPrompt, gateNotice, type MemoryContext, countOwnPostsSince, harnessTailNotice, hasOwnWakeSince, NO_REPLY_NOTICE, offAnchorNotice, offAnchorPosts } from './prompt.js';
import { SessionStore } from './sessions.js';
import { buildTurnCommand, preassignsSessionId, writePromptFile, writeSystemPromptFile, type TurnPlan } from './turn.js';
import { acceptsPtyInput } from './pty.js';
import type { AttentionKind, PtyControls, PtyWriter, TurnResult } from './pty.js';
import { findCodexSessionId } from './codexSessions.js';
import { claudeSessionMaterialized } from './claudeSessions.js';
import { readLastApiError } from './harnessErrors.js';
import type { AttentionLedger } from './attentionLedger.js';
import { sessionTranscriptGrewSince, sessionTranscriptMtimeMs } from './harnessErrors.js';
import { ensureDangerousModeAccepted, ensureWorkspaceTrusted } from './workspaceTrust.js';
import { codexSessionsDir } from './codexHome.js';
import { ensureWorkspace, workspaceName, type Exec } from './workspace.js';
import type { TurnRegistry } from './turnRegistry.js';

/** runMentionTurn 이 요구하는 murmur 표면. MurmurAgentClient 의 부분집합이라 실제 클래스를
 * 그대로 넘겨도 되고, 테스트는 인메모리 fake 를 넘긴다(프로세스 경계·네트워크 없이 검증). */
export interface MentionTurnMurmur {
  definition(): Promise<AgentView>;
  /**
   * 관문에 걸린 사실을 스레드에 남긴다(`gateNotice`). **평문이 아니라 실패여야 한다** —
   * 이유는 `murmur.ts::fail` 주석에 있다.
   */
  fail(
    channelId: string,
    body: string,
    threadRootId: string | null,
    opts: { retryable: boolean; what?: string; reason?: string },
  ): Promise<number>;
  readThread(channelId: string, threadRootId: string | null, since?: number): Promise<MessageRow[]>;
  /**
   * 채널 **전체**(스레드 답 포함)에서 seq 커서 이후를 읽는다 — `offAnchorEvidence` 가 쓴다.
   *
   * `readThread(ch, null, since)` 와 서버 호출은 같지만 이름을 따로 둔다: 저 호출은 부르는
   * 자리마다 "최상위 스레드를 읽는다"로도 읽히고, 두 의도가 한 이름에 겹치면 한쪽을 고칠 때
   * 다른 쪽이 조용히 바뀐다. 여기서 필요한 것은 **스레드 경계를 넘어 보는 것**이다.
   */
  readChannelSince(channelId: string, sinceSeq: number, limit?: number): Promise<MessageRow[]>;
  /** #139: core 본문과 mem/* slug 목록. 실패는 **던진다** — 호출자가 구분해야 한다. */
  readMemory(): Promise<{ core: string | null; slugs: string[] }>;
  /**
   * #140: 승인된 스킬 목록. **실패는 던진다** — 러너가 stderr 에 한 줄 남길 수 있어야 한다.
   * 여기서 빈 배열로 삼키면 "스킬이 없다"와 "서버를 못 읽었다"가 같은 값이 되고, 그러면
   * 동기화 로직이 있는 스킬을 사라진 것으로 보고 지워 버린다.
   */
  listApprovedSkills(): Promise<{ slug: string; body: string }[]>;
  /** 발화 후 메시지의 seq 를 반환한다. */
  post(channelId: string, body: string, threadRootId: string | null): Promise<number>;
  /** #144: 긴 작업 시작 시 진행 설명 — 결과 발화로 세지 않는다. kind='progress'로 저장되어 message.read 응답에서 구분한다. */
  progress(channelId: string, body: string, threadRootId: string | null): Promise<number>;
  /** 멘션이 왔음을 알리는 리액션(👀). 대상은 멘션 메시지 자체다. */
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** 턴이 진행 중임을 알리는 리액션(💬). 턴 종료 후 반드시 제거한다. */
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /**
   * #176: 턴을 마쳤다고 보고한다. 인자가 없다 — 시각은 서버가 찍는다.
   * 실패는 **던진다**: 턴을 실패로 만들지 않는 판단은 호출자가 하고, 여기서 삼키면
   * "보고했다"와 "보고가 실패했다"가 구분되지 않아 로그에도 남지 않는다.
   */
  reportActivity(): Promise<void>;
}

/** 한 턴을 실제로 돌리는 함수. 프로덕션은 pty.ts::runPtyTurn 을 그대로 넘기고, 테스트는
 * 이 자리에 스텁을 꽂아 buildTurnCommand 가 만든 plan 을 가로채 검증한다(브리프: "buildTurnCommand
 * 호출 캡처는 runMentionTurn 에 spawn 함수를 주입해 확인"). */
export type RunTurn = (
  plan: TurnPlan,
  opts: {
    cwd: string;
    timeoutMs: number;
    /**
     * PTY raw 바이트 탭(#141). `runPtyTurn` 의 옵션에 이미 있던 것을 이 계약에도
     * 열었다 — 그전에는 `RunPtyTurnOptions` 에 있는 필드를 조립 경로에서 넘길 방법이
     * 없어서(이 타입이 좁혀 놨다) Phase 2 의 라이브 중계가 구조적으로 불가능했다.
     */
    onData?: (chunk: Buffer) => void;
    /**
     * PTY 조작 손잡이(#315). `onData` 의 반대 방향 — attach 한 소유자가 친 바이트가 이리로
     * 들어간다. `RunPtyTurnOptions` 의 같은 이름 필드를 이 계약에도 연 것이고, 이유도
     * `onData` 와 같다: 좁혀 놓은 이 타입이 넘길 방법을 막으면 배선이 구조적으로 불가능하다.
     *
     * **`PtyWriter` 가 아니라 `PtyControls` 다(2026-09-08).** 종료가 필요해졌다: TUI 는
     * 답하고도 죽지 않으므로 러너가 턴의 끝에 이 PTY 를 회수한다. 릴레이에 넘어가는 것은
     * 여전히 `PtyWriter` 뿐이다 — 관찰하는 쪽에 종료 손잡이를 주면 뷰어가 턴을 죽인다.
     */
    onSpawn?: (controls: PtyControls) => void;
  },
) => Promise<TurnResult>;

/**
 * 진행 중인 턴을 attach 가능한 세션으로 감싸는 릴레이(#141 Phase 2, 스펙 §5).
 *
 * `relay.ts` 의 `RelayClient` 를 그대로 받지 않고 이 좁은 모양으로 받는 이유: 이 파일이
 * 릴레이 모듈을 알면 소켓·재접속·`ws` 의존까지 끌고 오게 되고, 턴 조립 테스트가 그것을
 * 전부 세워야 한다. 릴레이는 관찰이고 턴은 답이다 — 관찰이 답의 의존이 되면 안 된다.
 */
export interface TurnRelay {
  openSession(input: {
    agentAccountId: string;
    channelId: string;
    threadRootId: string | null;
    harness: AgentHarness;
    /**
     * 이 세션의 PTY 에 사람이 입력할 수 있는가.
     *
     * **2026-09-08 실행 모델 교체로 claude 멘션 턴은 참이다** — TUI 로 뜨므로 fd 0 이 PTY 다.
     * codex 는 아직 `exec` + stdin 파일이라 거짓이다(P5). 판정은 하네스 이름이 아니라
     * `acceptsPtyInput(plan)` 하나로 한다(스펙 §5-3).
     */
    acceptsInput: boolean;
    /**
     * 이 턴이 쓰는 claude 계정과 그 풀(다중 계정 3단계). 관찰용이다 — 턴은 이 값을
     * 읽지 않는다(`AgentSessionView.claudeAccount`).
     */
    claudeAccount?: string | null;
    claudePool?: string | null;
    /**
     * 지금 이 세션을 보고 있는 사람 수. **턴의 끝이 이 값에 걸려 있다**(2026-09-08):
     * TUI 는 답하고도 죽지 않으므로 러너가 끝을 정해야 하고, 그 조건이 "발화했고 아무도
     * 안 본다" 다. 릴레이가 이 훅을 안 주면 아무도 안 보는 것으로 다룬다.
     */
    onViewerCount?: (count: number) => void;
    /**
     * 사람이 화면에서 이 턴을 **그만두게 했다**(3단계). 릴레이는 알리기만 하고 죽이는 것은
     * 이 턴이다 — SIGTERM 을 보내는 손잡이(`PtyControls`)와 그 뒤의 흔적(실패 카드·💬
     * 제거·재시도 회계)을 가진 쪽이 여기이기 때문이다.
     */
    onCancel?: (byHandle: string) => void;
  }): {
    sessionId: string;
    push(chunk: Buffer): void;
    /** 사람이 친 바이트가 갈 곳(#315). spawn 시점에 이어 붙인다. */
    bindInput(writer: PtyWriter): void;
    /**
     * 이 세션이 사람 손을 기다린다(2026-09-08). 앱이 이 세션의 터미널을 연다 —
     * 관문에 걸린 턴은 화면에 아무 신호도 남기지 않아서, 사람은 열어 볼 이유조차 모른다.
     */
    needsAttention(screen: string, accountLabel: string): void;
    close(): void;
  };
}

export interface MentionTurnDeps {
  murmur: MentionTurnMurmur;
  store: SessionStore;
  exec: Exec;
  runTurn: RunTurn;
  me: Me;
  /** 기동 시 한 번 받아 두는 워크스페이스 규칙 원문(murmur.guide()). */
  guide: string;
  channelName: string;
  /** accountId → handle. 배치 단위로 한 번 채운다(main.ts, GET /accounts) — 매 턴 새로
   * 받을 필요는 없다(핸들이 턴 사이에 바뀌는 일은 없다). */
  handles: Record<string, string>;
  /** avcs 워크스페이스들이 사는 상위 디렉터리. */
  workspaceBaseDir: string;
  /** writeMcpConfigOnce 가 기동 시 한 번 쓴 경로. 매 턴 그대로 재사용한다. */
  mcpConfigPath: string;
  /**
   * 러너의 상태 디렉터리(config.ts::stateDir). 지시문 파일을 여기 쓴다 —
   * **에이전트의 워크스페이스 안에 두면 안 된다**: `mentionPermission: 'auto'`
   * 인 에이전트가 자기 지시문을 읽고 고칠 수 있게 된다.
   */
  stateDir: string;
  /** 이 러너 전용 CODEX_HOME. 세션 발견과 자식 env 가 같은 루트를 봐야 한다. */
  codexHome: string;
  /**
   * 이 턴을 돌릴 claude 계정 이름(`claudeAccounts.ts`). `null` 은 계정 지정 없음(시스템
   * 기본)이다. **세션 무효화 판정이 이 값을 쓴다** — 계정이 바뀌면 그 스레드의 claude
   * 세션은 재개할 수 없다(세션 파일이 계정 디렉터리 안에 있다).
   */
  claudeAccount: string | null;
  /**
   * 그 계정의 `CLAUDE_CONFIG_DIR`. 자식 env 와 세션 실재 판정이 **같은 값**을 봐야 한다
   * (`codexHome` 주석과 같은 이유).
   */
  claudeConfigDir: string | null;
  /**
   * 그 계정이 속한 풀 이름(`pools.json`). `null`·생략은 뿌리(암묵 풀)다. 턴의 동작에는
   * 쓰이지 않는다 — **릴레이 세션에 실어 화면이 "어느 풀의 어느 계정"을 말할 수 있게
   * 하는 것**이 전부다(`AgentSessionView.claudePool`). 그래서 옵셔널이다: 이 값을 모르는
   * 호출부의 턴은 그대로 돌고 화면만 풀을 말하지 못한다.
   */
  claudePool?: string | null;
  murmurUrl: string;
  pat: string;
  turnTimeoutMs: number;
  /**
   * PTY 릴레이(#141). **옵셔널이다** — 릴레이가 없어도 턴은 그대로 돌아야 한다.
   * 관찰을 못 하는 것과 답을 못 하는 것은 같은 실패가 아니다.
   */
  relay?: TurnRelay;
  /**
   * 진행 중 턴의 레지스트리(#337). 멘션 턴이 자기 존재를 등록해야 인터랙티브 open 의
   * 3분기 ①("그 스레드 멘션 턴 진행 중 → 그 PTY 에 attach")이 성립한다. 옵셔널인 이유는
   * relay 와 같다 — 기존 테스트·호출부가 관찰 없이 턴만 돌릴 수 있어야 한다.
   */
  registry?: TurnRegistry;
  /**
   * 하네스 세션이 디스크에 실재하는가(기본 `claudeSessionMaterialized`). 실패한 턴이
   * 세션을 남겼는지 가리는 데만 쓴다 — 아래 실패 분기의 주석이 이유를 적었다.
   *
   * 주입 가능한 이유는 `interactiveTurn.ts` 의 같은 이름 옵션과 같다: 실제 판정은
   * `~/.claude/projects` 를 훑으므로, 테스트가 그것을 세우지 않고 두 세계(실재/부재)를
   * 다 재현할 수 있어야 한다.
   */
  sessionMaterialized?: (harness: AgentHarness, sessionId: string, claudeConfigDir: string | null) => Promise<boolean>;
  /** 테스트가 sinceMs 캡처 시점을 결정론적으로 만들기 위한 시계 주입. 생략하면 Date.now. */
  now?: () => number;
  /**
   * 하네스 기록이 마지막으로 자란 시각(기본 `sessionTranscriptMtimeMs`). 주입 가능한
   * 이유는 `readApiError` 와 같다 — 실제 판정이 `~/.claude/projects` 를 훑으므로, 테스트가
   * 그것을 세우지 않고 "자라는 중"과 "멈췄다"를 다 재현할 수 있어야 한다.
   */
  readTranscriptMtime?: typeof sessionTranscriptMtimeMs;
  /**
   * 발화를 확인하는 주기(기본 3초, 2026-09-08). TUI 는 답하고도 안 죽으므로 러너가
   * "답했는가"를 직접 봐야 하고, 그 사실은 스레드에만 있다 — 에이전트는 자기 PAT 로
   * 서버에 직접 발화하므로 PTY 출력에는 나타나지 않는다.
   */
  utteranceProbeMs?: number;
  /** 발화 뒤 관찰자가 0 일 때 회수까지의 유예(기본 60초). 인터랙티브 턴과 같은 값이다. */
  orphanMs?: number;
  /**
   * **하네스가 멈춘 것으로 보는 무활동 시간**(기본 10분, 2026-09-09). 기록 파일이 이 시간
   * 동안 자라지 않으면 답을 기다리지 않고 접는다.
   *
   * `turnTimeoutMs`(무발화 30분)와 **다른 사실을 잰다.** 무발화 시계는 "답이 없다"를 재는데,
   * 일하는 턴도 30분 내내 답이 없다 — PR 하나 만드는 턴이 그렇다. 그래서 그 시계는 짧게
   * 못 하고, 짧게 못 하니 멈춘 턴이 30분을 통째로 가져간다. 이 시계는 "일하고 있다"를
   * 직접 재므로 짧아도 일하는 턴을 죽이지 않는다.
   *
   * 값의 근거: 멀쩡히 도는 세션 8개의 기록 간격을 재 보니 최대가 390초(6.5분)였다
   * (긴 빌드·CI 대기가 그 자리다). 10분은 그 위의 첫 자리이고, 실측된 정지(30분 내내
   * 한 줄도 안 자랐다)와는 멀리 떨어져 있다.
   */
  harnessStallMs?: number;
  /** 테스트가 타이머를 잡기 위한 주입. 생략하면 unref 된 setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /**
   * 이 턴이 쓰는 계정 이름(2026-09-08). 사람을 부를 때 "어느 계정이 막혔는지"를 화면에
   * 싣고, 같은 계정으로 두 번 부르지 않게 하는 키다. 계정 풀을 안 만든 러너는 없다.
   */
  accountLabel?: string;
  /**
   * 계정별 부름 원장(`attentionLedger.ts`). 관문은 계정 단위라 한 번 지나면 그 계정의
   * 나머지 턴이 풀린다 — 스레드마다 부르면 사람이 같은 승인을 반복한다.
   */
  attentionLedger?: AttentionLedger;
  /**
   * 이 턴이 **사람을 부를 수 있는가**(2026-09-08). 계정 축의 마지막에서만 참이다.
   *
   * **왜 축의 마지막에서만인가.** 사람을 부르는 경로는 PTY 를 살려 두려고 **던지지
   * 않는다** — 그러면 `withAccountFailover` 가 실패를 못 보고 계정 전환이 일어나지
   * 않는다. 즉 "부른다"와 "전환한다"는 동시에 못 한다. 앞 계정에서 부르면 준비된
   * 계정이 뒤에 있는데도 사람을 깨우고, 그 계정은 시도조차 되지 않는다.
   *
   * 거짓이면 `onAttention` 을 아예 넘기지 않는다 — `pty.ts` 는 그 콜백의 **유무로**
   * 두 정책(죽이고 던진다 / 살리고 부른다)을 가르기 때문이다.
   */
  callsForHuman?: boolean;
  /**
   * 하네스가 자기 세션 파일에 남긴 API 에러를 읽는다(기본 `readLastApiError`).
   * 주입 가능한 이유는 `sessionMaterialized` 와 같다 — 테스트가 디스크를 세우지 않고
   * 두 세계(에러 있음/없음)를 태울 수 있어야 한다.
   */
  readApiError?: (
    harness: AgentHarness, sessionId: string | null,
    opts: { configDir?: string | null; sinceMs?: number },
  ) => Promise<{ text: string } | null>;
}

/**
 * 새 워크스페이스를 확보한다. `def.workingDir` 이 null 인 것과 "명시적으로 지정됐다"는
 * 서로 다른 사실이라 나눠서 다룬다(리뷰 지적) — 하나로 뭉개
 * (`def.workingDir ?? process.cwd()`) `ensureWorkspace` 에 넘기면, 아무도 지정한 적 없는
 * `process.cwd()`(러너 자신의 체크아웃)에서 avcs 워크스페이스를 시도하게 된다. 그건
 * 누구도 요청하지 않은 동작이고 `mentionPermission: 'auto'` 와 겹치면
 * 러너 자신의 코드가 대상이 되는 사고다.
 *
 * - `workingDir === null`(아무도 지정하지 않음) → avcs 를 아예 시도하지 않는다. 스레드
 *   전용 디렉터리만 만들어 최소한의 격리를 유지한다(avcs 버전관리는 없다 — 격리 없음을
 *   UI 에 드러내는 것은 별도 이슈).
 * - `workingDir` 이 지정됨 → 지금처럼 `ensureWorkspace` 로 간다. 그 값이 avcs repo 가
 *   아니면 `ensureWorkspace` 자신의 폴백이 지정된 그 디렉터리를 그대로 돌려준다 — 사용자가
 *   그 파일들에서 일하라고 지정한 것이라 빈 디렉터리로 갈아치우면 설정이 장식이 된다.
 *
 * export 하는 이유(#337): 인터랙티브 턴(`interactiveTurn.ts`)이 세션 없는 스레드에서
 * 워크스페이스를 만들 때 **같은 규칙**을 써야 한다 — 규칙이 두 벌이면 같은 스레드의
 * 멘션 턴과 인터랙티브 턴이 서로 다른 디렉터리에서 돌아, 사람이 고친 것을 다음 멘션이
 * 못 본다(스펙 §14 성공 기준 4 가 정확히 그것을 요구한다).
 */
export async function resolveWorkspaceDir(
  deps: Pick<MentionTurnDeps, 'exec' | 'me' | 'workspaceBaseDir'>,
  def: Pick<AgentView, 'workingDir'>,
  threadKey: string,
): Promise<string> {
  if (def.workingDir === null) {
    const dir = join(deps.workspaceBaseDir, workspaceName(deps.me.handle, threadKey));
    await mkdir(dir, { recursive: true });
    return dir;
  }
  return ensureWorkspace(deps.exec, {
    handle: deps.me.handle,
    threadKey,
    baseDir: deps.workspaceBaseDir,
    repoDir: def.workingDir,
  });
}

/**
 * 이 멘션에 답할 자리(앵커). 스레드 안의 멘션은 그 스레드의 루트를, **채널 최상위 멘션은
 * 그 멘션 메시지 자신**을 쓴다(#98).
 *
 * 왜 최상위를 멘션 자신으로 바꾸는가: `threadRootId` 가 null 이면 세션 키가
 * `${channelId}/_root` 로 뭉쳐(sessions.ts::threadKey) 한 채널의 **모든** 최상위 멘션이
 * 하네스 세션 하나를 공유했다 — 서로 무관한 요청의 맥락이 섞인다. 멘션 자신을 루트로
 * 삼으면 멘션마다 키가 갈리고, 덤으로 긴 답이 채널 본문이 아니라 스레드로 들어간다.
 *
 * **왜 `main.ts` 안의 식이 아니라 함수인가**: `main.ts` 는 top-level 스크립트라(import 하면
 * 러너가 돈다) 테스트가 그 안의 식을 겨눌 수 없다. 실제로 초판은 이 계산을 main.ts 에
 * 인라인으로 뒀고, 그 상태에서 규칙을 되돌려도 테스트 146개가 전부 초록이었다 — 이 태스크의
 * 본론이 무보호였다. 규칙을 여기 두면 단위 테스트가 규칙 자체를 붙잡는다.
 *
 * 호출자는 턴과 실패 통지(main.ts 의 `FAILURE_NOTICE`)에 **같은 값**을 써야 한다 — 답은
 * 스레드로 가는데 통지만 채널 최상위에 남으면 부른 사람이 실패를 놓친다.
 */
export function mentionAnchor(mention: { id: string; threadRootId: string | null }): string {
  return mention.threadRootId ?? mention.id;
}

export interface MentionTarget {
  channelId: string;
  /** 앵커 — 스레드 안이면 그 루트, 채널 최상위면 그 멘션 메시지 id 다(#98).
   * main.ts 가 이미 계산해 둔 값을 그대로 받는다(브리프: "여기서 새로 계산하지 마라 —
   * 계산하는 순간 네 번째 진실 원천이 된다"). */
  threadRootId: string | null;
  /**
   * 멘션 메시지 자체의 id. **리액션 대상은 앵커가 아니라 이것이다** — 스레드 안의
   * 멘션에서 앵커는 스레드 루트이고, 그것에 리액션하면 "듣기는 했나"에 답하는 대상이
   * 방금 온 멘션이 아니라 남의 옛 메시지가 된다.
   *
   * 옵셔널이 아니다. 호출자는 항상 이 값을 알고 있고, 없을 때 앵커로 대체하면 위 오류가
   * 조용히 들어온다.
   */
  mentionId: string;
  /**
   * 이 턴이 **깨어난 턴**이면 그 사유(마이그레이션 040). `main.ts` 가 inbox 항목의
   * `reason === 'wake'` 일 때 그 대기 줄의 본문을 그대로 싣는다.
   *
   * 옵셔널인 이유: 평범한 멘션 턴에는 깨움이 없다. 그리고 값이 있으면 프롬프트 조립이
   * 달라진다 — 깨움에는 부른 사람이 없어서 델타가 비고, 비면 하네스가 돌지 않는다.
   */
  wake?: { reason: string };
  /**
   * 이 턴이 **팀장으로서 불린 턴**이면 그 팀과 명단(마이그레이션 047). 서버가 inbox 항목에
   * 실어 주고(`InboxEntry.team`) 스케줄러가 그대로 옮긴다 — 러너가 팀을 다시 조회하지
   * 않는 이유는 그 필드의 주석에 있다(같은 판정을 두 번 하면 갈라진다).
   *
   * 옵셔널인 이유: 팀 부름이 아닌 턴에는 팀이 없다. 그리고 값이 있으면 프롬프트가 달라진다 —
   * 명단과 "너는 이 팀의 창구다"가 붙는다. 팀장이 없거나 비활성인 팀은 애초에 이 사유로
   * 오지 않으므로(서버 폴백), 이 값이 있다는 것은 곧 창구가 하나라는 뜻이다.
   */
  team?: InboxTeamCall;
  /**
   * 이 턴이 **넘긴 일의 결말로 깨어난 턴**이면 그 결말(050). 서버가 inbox 항목에 실어 주고
   * (`InboxEntry.delegation`) 스케줄러가 그대로 옮긴다.
   *
   * `wake` 와 같은 성격이라 프롬프트에서 **델타를 대신할 수 있다** — 기한이 지나 깨어난
   * 경우엔 팀원이 아무 말도 하지 않았으므로 새 메시지가 없다.
   */
  delegation?: InboxDelegationOutcome;
}

/**
 * 멘션 하나에 답한다. 던지면(예: 하네스 비정상 종료) 호출자(main.ts)의 attempts/backoff
 * 경로가 받는다 — 이 함수 자체는 재시도하지 않는다(policy.ts 는 그대로 둔다).
 */
/**
 * 한 턴에서 두 번 이상 발화한 것을 러너 로그에 남긴다.
 *
 * **채널에는 통보하지 않는다** — 이미 답이 두 개인데 세 번째 메시지를 더하면 소음이다.
 * 러너가 호출 횟수를 세어 **막지는** 못한다: 그러려면 PTY 출력에서 tool-call 흔적을
 * 파싱해야 하고, 그건 "러너는 하네스 출력을 해석하지 않는다"(pty.ts)와 정면으로 부딪친다.
 * 그래서 예방은 시스템 프롬프트(prompt.ts)가 하고, 이 함수는 그것이 지켜졌는지를
 * murmur 데이터로만 관측한다 — 설계 경계를 넘지 않는 유일한 관측 지점이다.
 */
/**
 * 이 턴이 자기 앵커 밖에 남긴 발화를 관측해 통지에 실을 문단으로 만든다(없으면 `null`).
 *
 * 채널 전체를 읽는다 — `threadRootId` 를 주지 않은 `message.read` 는 스레드 답까지 포함해
 * seq 커서 이후 전부를 돌려준다(서버 `listMessages`). 앵커 스레드만 읽는 기존 관측으로는
 * **정의상** 이것을 볼 수 없다: 문제는 발화가 다른 스레드에 있다는 것이다.
 *
 * 러너 로그에도 남긴다. 통지는 사람이 보는 자리고 로그는 운영이 보는 자리인데, 이 사고는
 * 로그에서 여러 턴을 나란히 놓고 봐야 모양이 보인다(그날도 그렇게 찾았다).
 *
 * **던지지 않는다.** 이것은 통지를 더 좋게 만드는 정황이지 통지의 조건이 아니다.
 */
async function offAnchorEvidence(
  deps: MentionTurnDeps, key: string, channelId: string, anchor: string | null, turnStartSeq: number,
): Promise<string | null> {
  try {
    // limit 를 넉넉히 준다 — 기본 30 은 바쁜 채널에서 내 발화를 창 밖으로 밀어낸다.
    const channelWide = await deps.murmur.readChannelSince(channelId, turnStartSeq, 200);
    const strays = offAnchorPosts(channelWide, deps.me.id, anchor, turnStartSeq);
    if (strays.length === 0) return null;
    console.warn(
      `[mentionTurn] ${key}: 앵커에는 발화가 없는데 같은 채널의 다른 스레드에 내 발화가 ` +
        `${strays.length}건 있다 — 이 턴이 남의 앵커의 요청을 대신했을 수 있다(2026-09-08 사고와 같은 모양). ` +
        `대상 스레드: ${[...new Set(strays.map((m) => m.threadRootId ?? m.id))].join(', ')}`,
    );
    return offAnchorNotice(strays);
  } catch (err) {
    console.error(
      `[mentionTurn] ${key}: 앵커 밖 발화 관측 실패(통지는 그대로 나간다) — ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function warnOnDuplicatePosts(key: string, postCount: number): void {
  if (postCount <= 1) return;
  console.warn(
    `[mentionTurn] ${key}: 한 턴에 발화가 ${postCount}건이다 — 한 번만 발화해야 한다(#90). ` +
      '시스템 프롬프트의 지시가 지켜지지 않았다.',
  );
}

/**
 * 턴 하나가 끝난 뒤 호출자(main.ts 의 폴 루프)에게 돌려주는 사실.
 *
 * 종료 요청을 여기 실어 보내는 이유(#129): 러너는 이미 매 턴 `deps.murmur.definition()`
 * 으로 자기 정의를 다시 읽는다 — 요청은 그 응답에 얹혀 온다. 별도 채널을 두면 러너가
 * 서버를 보는 경로가 둘이 되고, 두 경로가 서로 다른 시점의 사실을 말할 수 있다.
 *
 * **이 함수는 스스로 종료하지 않는다.** 턴 중간에 죽으면 사람이 기다리는 답이 사라진다.
 * 요청을 본 시점(턴 시작 직후)과 그것에 따라 물러나는 시점(턴 종료 후)이 달라야 하고,
 * 반환값이 정확히 그 간격을 만든다.
 */
/**
 * #140: 승인된 스킬을 러너 상태 디렉터리에 실체화하고 하네스 스킬 디렉터리로 링크한다.
 *
 * **왜 워크스페이스 밖에 쓰고 링크만 넣는가**(스펙 §12 결정 3): 스킬 파일을 워크스페이스
 * 안에 직접 쓰면 avcs 가 그것을 저장소로 쓸어 간다. 실측(0단계): `avcs workspace land` 는
 * 미추적 파일을 건드리지 않지만, 같은 디렉터리에서 부르는 `avcs commit` 은
 * `A .claude/skills/foo/SKILL.md` 로 전부 쓸어 담는다 — 반면 `.claude/skills/<slug>` 가
 * **심볼릭 링크**면 avcs 는 따라 들어가지 않아 아무것도 담기지 않는다. 링크가 결정의 핵심이다.
 *
 * **복사가 아니라 링크**인 이유: 복사하면 갈라진 사본이 생겨, 승인이 취소된 스킬이
 * 워크스페이스마다 다른 시점의 본문으로 남는다.
 *
 * **링크 대상은 SKILL.md 가 아니라 스킬 디렉터리다.** 하네스는 `<스킬디렉터리>/SKILL.md` 를
 * 읽으므로 파일을 직접 링크하면 `.../SKILL.md/SKILL.md` 를 찾아 아무것도 읽지 못한다.
 *
 * 실패해도 **턴은 진행한다** — 스킬은 있으면 좋은 것이지 필수 자격이 아니다. 대신 실패를
 * stderr 한 줄로 남긴다(조용히 빈 목록으로 삼키면 서버가 죽은 것과 스킬이 없는 것을
 * 구분할 수 없다).
 *
 * @param stateDir 워크스페이스 **밖**의 러너 상태 디렉터리
 * @param workspaceDir 에이전트 워크스페이스 — 여기에는 링크만 들어간다
 */
export async function syncSkills(
  stateDir: string,
  workspaceDir: string,
  listSkills: () => Promise<{ slug: string; body: string }[]>,
): Promise<void> {
  const skillsDir = join(stateDir, 'skills');
  // 하네스별 스킬 디렉터리. claude 는 `.claude/skills/<slug>/SKILL.md` 를 읽는다.
  const harnessDirs = [
    join(workspaceDir, '.claude', 'skills'),
    // Codex 공식 repo-scope 경로. `.codex/skills` 는 스캔 대상이 아니다.
    join(workspaceDir, '.agents', 'skills'),
  ];
  const legacyCodexDir = join(workspaceDir, '.codex', 'skills');

  try {
    const skills = await listSkills();
    const wanted = new Set(skills.map((s) => s.slug));

    // 사라진 스킬(비활성·삭제): 상태 디렉터리의 파일과 하네스의 링크를 **함께** 지운다.
    // 링크만 남기면 하네스가 깨진 링크를 읽고, 파일만 남기면 지워진 스킬이 계속 붙는다.
    let existing: string[] = [];
    try {
      existing = await readdir(skillsDir);
    } catch { /* 상태 디렉터리가 아직 없으면 지울 것도 없다 */ }
    for (const slug of existing) {
      if (wanted.has(slug)) continue;
      await rm(join(skillsDir, slug), { recursive: true, force: true });
    }
    for (const dir of harnessDirs) {
      await removeStaleLinks(dir, skillsDir, wanted);
    }
    // 예전 구현이 만든 잘못된 경로의 **우리 링크만** 걷는다. 활성 스킬 링크도 공식
    // `.agents/skills`로 옮겨졌으므로 이 경로에는 하나도 남기지 않는다.
    await removeStaleLinks(legacyCodexDir, skillsDir, new Set());

    for (const skill of skills) {
      const skillPath = join(skillsDir, skill.slug);
      await mkdir(skillPath, { recursive: true });
      await writeFile(join(skillPath, 'SKILL.md'), skill.body, 'utf8');
      for (const dir of harnessDirs) {
        await mkdir(dir, { recursive: true });
        await linkSkill(skillPath, join(dir, skill.slug));
      }
    }
  } catch (err) {
    console.error(
      `[mentionTurn] 스킬 동기화 실패(턴은 계속한다): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 하네스 디렉터리에서 **우리가 만든** 링크 중 승인 목록에 없는 것만 지운다.
 *
 * 대상이 `skillsDir` 아래인지 확인하는 이유: 사람이 직접 넣은 스킬 디렉터리와 다른
 * 도구가 만든 링크를 워크스페이스에서 함부로 지우지 않기 위해서다.
 */
async function removeStaleLinks(harnessDir: string, skillsDir: string, wanted: Set<string>): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(harnessDir);
  } catch { return; /* 하네스 디렉터리가 없으면 지울 것도 없다 */ }
  for (const name of entries) {
    if (wanted.has(name)) continue;
    const linkPath = join(harnessDir, name);
    const st = await lstat(linkPath).catch(() => null);
    if (!st?.isSymbolicLink()) continue;
    const target = await readlink(linkPath).catch(() => null);
    if (target && target.startsWith(skillsDir)) await rm(linkPath, { force: true });
  }
}

/** 링크가 이미 올바르면 그대로 두고, 아니면(없거나·파일이거나·다른 곳을 가리키면) 다시 건다. */
async function linkSkill(target: string, linkPath: string): Promise<void> {
  const st = await lstat(linkPath).catch(() => null);
  if (st?.isSymbolicLink() && (await readlink(linkPath).catch(() => null)) === target) return;
  if (st) await rm(linkPath, { recursive: true, force: true });
  await symlink(target, linkPath);
}

export interface MentionTurnResult {
  /** 이 턴에 읽은 정의에 실려 온 종료 요청 시각. null 은 '요청 없음'. */
  stopRequestedAt: string | null;
}

export async function runMentionTurn(
  deps: MentionTurnDeps, target: MentionTarget,
): Promise<MentionTurnResult> {
  const { channelId, threadRootId: anchor, mentionId } = target;

  // 👀 신호: 멘션을 집은 **즉시**. 함수 진입 직후에 있어야 하는 이유가 있다 — 아래의
  // 워크스페이스 해석은 avcs workspace project 를 돌릴 수 있어 초 단위로 걸린다.
  // 그 뒤에 붙이면 "듣기는 했나"에 답하지 못한다. 그것이 이 신호의 존재 이유다.
  //
  // best-effort 다. 리액션 실패로 턴을 멈추지 않되 조용히 삼키지도 않는다 — 삼키면
  // "왜 신호가 없었지"의 원인이 사라진다.
  void deps.murmur.addReaction(channelId, mentionId, '👀').catch((err: unknown) => {
    console.error(
      `[mentionTurn] ${channelId}/${mentionId}: 리액션(받았음) 실패(턴은 계속한다) — ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  // 정의는 매 턴 새로 읽는다 — UI 로 지시문을 바꾸면 다음 턴부터 바로 반영된다(spec §3).
  const def = await deps.murmur.definition();
  const key = SessionStore.threadKey(channelId, anchor);

  let rec = deps.store.get(key);

  // claude 계정도 같은 부류다(다중 계정): 세션 파일은 `<CLAUDE_CONFIG_DIR>/projects` 아래
  // 있어 계정을 넘어가지 않는다. 남겨 두면 `-r <id>` 가 없는 세션을 재개하려 든다. 잃는 것이
  // 적은 이유: `prompt.ts` 의 `isFirstTurn`(lastFedSeq 0)이 자기 발화를 포함한 스레드 전체를
  // 다시 먹인다 — 하네스 내부 컨텍스트는 잃지만 스레드의 사실은 남는다.
  //
  // `?? null` 로 정규화해 비교하는 이유: 옛 레코드에는 이 필드가 `undefined` 다. 그것과
  // "계정 지정 없음"(`null`)은 같은 상태이므로, 정규화 없이 비교하면 풀을 안 쓰는 러너가
  // 스레드마다 세션을 헛되이 버린다.
  if (rec && (rec.harness !== def.harness || (rec.claudeAccount ?? null) !== deps.claudeAccount)) {
    // harness 는 지시문·모델과 달리 플래그가 아니라 실행 바이너리다 — claude 가 발급한
    // session-id 를 codex 에 넘기면(또는 반대) resume 자체가 성립하지 않는다. 대화 기억
    // (세션 id·진행 상태)만 버리고 워크스페이스는 재사용한다: 그 안의 작업 산출물은
    // harness 와 무관하고, 재사용하면 ensureWorkspace 를 다시 부를 이유도 없다(avcs
    // workspace project 재실행 없이 그대로 이어 쓴다).
    rec = {
      workspaceDir: rec.workspaceDir,
      sessionId: preassignsSessionId(def.harness) ? randomUUID() : null,
      harness: def.harness,
      lastFedSeq: 0,
      turnsRun: 0,
      claudeAccount: deps.claudeAccount,
    };
  }

  if (!rec) {
    const workspaceDir = await resolveWorkspaceDir(deps, def, key);
    rec = {
      workspaceDir,
      sessionId: preassignsSessionId(def.harness) ? randomUUID() : null,
      harness: def.harness,
      lastFedSeq: 0,
      turnsRun: 0,
      claudeAccount: deps.claudeAccount,
    };
  }

  // #80: 이 턴에 새로 먹일 것만 정확히 읽기 위해 lastFedSeq 로 커서를 찍는다.
  // 첫 턴(lastFedSeq=0)에서는 since=0 이라 서버가 최신 N 개를 반환하므로,
  // buildTurnPrompt 가 전체 맥락을 보여주는 동작이 유지된다.
  const thread = await deps.murmur.readThread(channelId, anchor, rec.lastFedSeq);

  // isFirstTurn 은 원칙적으로 turnsRun 에서 유도한다 — lastFedSeq 는 "무엇을 봤는지"의
  // 경계일 뿐 "하네스를 실제로 돌렸는지"의 증거가 아니다(sessions.ts::SessionRecord.turnsRun
  // 참고). 다만 `sessionId === null` 도 같이 본다: codex 는 턴이 최소 한 번 돌았어도
  // (turnsRun>=1) 그 턴이 끝난 뒤 세션 발견(findCodexSessionId)이 실패하면 sessionId 가
  // 여전히 null 로 남는다(spec §8, "기능 후퇴이지 정지가 아니다"). 그때 turnsRun 만 보고
  // isFirstTurn:false 로 조립하면 `assertValidSession` 이 "resume 인데 id 가 없다"로 던지고,
  // turnsRun 은 그 실패로 줄지 않으니 이 스레드가 재시도 한도까지 영원히 실패한다(리뷰가
  // 실물로 재현) — sessionId 가 없으면 이어받을 게 없으므로 무조건 첫 턴(exec, resume
  // 아님)으로 다시 시작해야 그 후퇴가 실제로 "다음 턴에 새 세션"으로 이어진다.
  const isFirstTurn = rec.turnsRun === 0 || rec.sessionId === null;

  const { prompt, fedSeq } = buildTurnPrompt({
    messages: thread,
    lastFedSeq: rec.lastFedSeq,
    meId: deps.me.id,
    handles: deps.handles,
    channelId,
    threadRootId: anchor,
    // 첨부 안내에 실을 실값(#첨부 열기). 러너는 자기가 붙은 URL 을 이미 안다.
    murmurUrl: deps.murmurUrl,
    ...(target.wake ? { wake: target.wake } : {}),
    ...(target.team ? { team: target.team } : {}),
    ...(target.delegation ? { delegation: target.delegation } : {}),
  });

  if (!prompt) {
    // 새 메시지가 있었지만 전부 자기 발화라 넘길 게 없었다 — 하네스를 돌리지 않는다.
    // 그래도 fedSeq 는 이미 전진한 값을 반드시 저장해야, 다음 턴이 이 구간을 다시 "새
    // 것"으로 들이밀어 세션이 자기 말을 또 보는 일이 없다. turnsRun 은 건드리지 않는다 —
    // 하네스가 안 돌았으니 "돌았다"고 기록할 것도 없다.
    await deps.store.put(key, { ...rec, lastFedSeq: fedSeq });
    return { stopRequestedAt: def.stopRequestedAt };
  }

  // 발화 판정(countOwnPostsSince)의 기준선이다 — 턴 시작 전에 이미 있던 자기 발화까지 세면,
  // 아무것도 안 하고 끝낸 턴도 "발화했다"로 잘못 판정된다.
  const turnStartSeq = thread.reduce((max, m) => Math.max(max, m.seq), 0);

  // #139: 메모리는 **매 턴 다시 읽는다.** 지시문이 그렇듯(바로 아래 주석) 시스템
  // 프롬프트가 매 턴 새로 쓰이므로, 캐시 없이도 메모리 수정이 다음 턴부터 반영된다 —
  // 캐시를 넣으면 그 이점을 없애고 무효화 문제를 새로 만든다.
  //
  // **조회 실패와 빈 저장소를 구분한다.** 실패를 빈 값으로 삼키면 에이전트가 "나는
  // 기억이 없다" 고 믿고 진짜 기억을 새 프로필로 덮어쓴다.
  let memory: MemoryContext;
  try {
    memory = await deps.murmur.readMemory();
  } catch (err: unknown) {
    memory = 'unavailable';
    console.error(
      `[mentionTurn] ${key}: 메모리 조회 실패 — 이번 턴은 기억 없이 돈다(빈 저장소로 취급하지 않는다): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const systemPrompt = buildSystemPrompt({
    handle: deps.me.handle,
    channelName: deps.channelName,
    instructions: def.instructions,
    guide: deps.guide,
    memory,
    // 턴 예산은 러너만 아는 사실이다. 알려주지 않으면 에이전트가 "지금 기다려도 되는지"를
    // 판단할 근거 없이 물러난다 — 2026-09-07 15:08 의 턴은 30분 중 4분만 쓰고 끝냈다.
    turnBudgetMs: deps.turnTimeoutMs,
  });

  // 지시문은 argv 가 아니라 파일로 넘긴다(#92) — `ps` 로 다른 로컬 사용자에게 보이는 자리에
  // 대화·지시문을 올리지 않는다. **매 턴 다시 쓴다**: UI 로 지시문을 바꾸면 다음 턴부터
  // 반영돼야 하고(spec §3), channelName 이 프롬프트에 들어가므로 내용이 턴마다 다르다.
  // 턴은 순차적으로 돈다(main.ts 의 for 루프가 await 한다) — 그래서 파일 하나로 충분하다.
  const systemPromptFile = await writeSystemPromptFile(deps.stateDir, systemPrompt);

  // #140: 승인된 스킬 동기화 — 하네스가 뜨기 **전에** 끝나야 한다. await 을 빼면 이 턴의
  // 하네스는 아직 없는 스킬 디렉터리를 읽고, 스킬은 항상 한 턴 늦게 붙는다.
  // 실패는 syncSkills 안에서 삼키고 stderr 로 남긴다 — 그래서 턴은 그대로 진행한다.
  await syncSkills(deps.stateDir, rec.workspaceDir, () => deps.murmur.listApprovedSkills());

  // **프롬프트가 하네스에 닿는 길은 하네스마다 다르다(2026-09-08 실행 모델 교체).**
  //
  // `#117` 이 대화 본문을 argv 에서 뺀 이유(같은 머신의 다른 로컬 사용자가 `ps -ef` 로
  // 스레드 내용을 그대로 읽는다)는 **양쪽에서 그대로 지켜진다** — 주입도 argv 를 지나지
  // 않는다. 바뀐 것은 "파일이냐 PTY 냐" 하나이고, 그 선택이 **사람이 이 턴에 칠 수 있는지**를
  // 결정한다(스펙 §5-3: 판정은 fd 0 의 정체 하나로 한다).
  //
  // - claude: TUI 로 뜨고 프롬프트는 PTY 에 주입한다 → `stdinFile: null` → 입력이 열린다.
  // - codex: 아직 `exec` 이라 지시문 + 본문을 합쳐 stdin 파일로 준다(P5 전까지 두 세계가 함께 산다).
  const usesTui = def.harness === 'claude-code';
  let stdinFile: string | null = null;
  if (!usesTui) {
    const combined = [systemPrompt, prompt].filter((s) => s.length > 0).join('\n\n');
    stdinFile = await writePromptFile(deps.stateDir, combined);
  }

  const plan = buildTurnCommand({
    harness: def.harness,
    mode: 'mention',
    sessionId: rec.sessionId,
    isFirstTurn,
    systemPrompt,
    systemPromptFile,
    promptCtx: prompt,
    stdinFile,
    model: def.model,
    effort: def.effort,
    mentionPermission: def.mentionPermission,
    mcpConfigPath: deps.mcpConfigPath,
    pat: deps.pat,
    murmurUrl: deps.murmurUrl,
    codexHome: deps.codexHome,
    claudeConfigDir: deps.claudeConfigDir,
  });

  // #126: 턴 시작 로그 (어느 채널·스레드·하네스·워크스페이스에서 PTY 를 띄우는가)
  const turnStartMs = (deps.now ?? Date.now)();
  console.log(
    `[mentionTurn] ${key}: 턴 시작 (채널=${channelId}, 앵커=${anchor ?? 'null'}, 하네스=${def.harness}, 워크스페이스=${rec.workspaceDir})`,
  );

  // 💬 신호: 턴이 도는 중. 임계를 물려받지 않는다 — 위 지연 ack 의 임계는 "짧은 턴에
  // 매번 메시지를 더하면 소음"이라는 근거였고 소음의 단위가 스레드 한 칸이었다.
  // 리액션은 칸을 쓰지 않으므로 그 근거가 사라진다.
  //
  // **추가 프라미스를 붙잡아 둔다.** 턴이 아주 짧으면 아래 제거가 이 추가를 앞질러
  // 서버에 닿아 💬 가 영구히 남는다 — 같은 파일의 ackInFlight 가 이미 이 함정을 기록한다.
  const workingInFlight = deps.murmur.addReaction(channelId, mentionId, '💬').catch((err: unknown) => {
    console.error(
      `[mentionTurn] ${key}: 리액션(진행 중) 실패(턴은 계속한다) — ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  // #141: 이 턴을 attach 가능한 세션으로 연다. `plan` 이 조립된 **뒤**, PTY 가 뜨기
  // **직전**이어야 한다 — 더 앞이면 avcs workspace project 가 도는 수 초 동안 빈 세션이
  // 목록에 뜨고, 더 뒤면 첫 바이트를 놓친다.
  //
  // **attach 는 이 턴의 권한을 건드리지 않는다.** `plan` 은 위에서 `mode: 'mention'` 과
  // `def.mentionPermission` 으로 이미 조립됐고, 세션을 여는 것은 그 뒤다 — 스펙 §6 의
  // "멘션 턴에 attach 해도 그 턴의 모드는 바꿀 수 없다"가 이 순서로 성립한다.
  // ── 턴의 끝(2026-09-08 실행 모델 교체). TUI 는 답하고도 죽지 않으므로 러너가 끝을 정한다.
  //
  // 끝의 정의는 **"발화했고 아무도 안 본다"** 다. 발화만으로 즉시 죽이면 사람이 답을 보고
  // 이어서 칠 수 없고(터미널을 보여 주는 이유가 그것이다), 관찰자만 보면 아무도 안 보는
  // 스레드의 프로세스가 영원히 산다 — 실측 RSS 182~285MB 라 그 값이 작지 않다.
  //
  // 회수 장치를 새로 만들지 않는다: `interactiveTurn.ts` 의 viewer 기반 고아 회수가 이미
  // 그것이고, 그 주석이 근거를 적어 뒀다 — 패널 닫힘·소켓 단절·앱 강제종료가 서버 관점에서
  // 전부 "뷰어 소멸" 하나로 수렴한다.
  const schedule = deps.schedule
    ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
  const end: {
    controls: PtyControls | null; exited: boolean; spoke: boolean; viewers: number; silenced: boolean;
    /**
     * **러너가 이 턴을 죽였는가**(2026-09-08). 종료 코드로는 못 가른다: 회수도 무발화도
     * SIGTERM 이라 둘 다 143 이고, 하네스가 스스로 죽은 143 과도 같다.
     */
    reclaimed: boolean;
    /** 턴이 도는 동안 관측한 하네스 API 에러(한도·자격증명). 있으면 이 턴은 실패다. */
    apiError: string | null;
    /**
     * 사람이 이 턴을 그만두게 했으면 그 사람의 handle(3단계). **`reclaimed` 로 대신할 수
     * 없다**: 그 값은 "러너가 죽였다"이고 고아 회수·무발화 회수도 참으로 만든다 — 사람이
     * 눌러서 끝난 것과 아무도 안 봐서 회수된 것은 스레드에 남길 말이 다르다.
     */
    canceledBy: string | null;
    /**
     * **하네스가 멈춰서 우리가 접었는가**(2026-09-09). `silenced` 와 갈라야 하는 이유는
     * 사람이 읽을 문장이 다르기 때문이다 — 무발화는 "시간 안에 답을 못 했다"이고 이것은
     * "일하다 만 게 아니라 서 있었다"다. 재시도 통지의 사유가 그대로 이 문장이 된다.
     */
    stalled: boolean;
    /**
     * 사람 손을 부른 턴인가(`onAttention`). 부른 뒤에는 정지 시계를 재지 않는다 — 그
     * 턴의 기록이 안 자라는 것은 고장이 아니라 **사람을 기다리는 중**이라는 뜻이고,
     * 여기서 접으면 관문 앞에 세워 둔 턴이 사람이 오기 전에 사라진다.
     */
    awaitingHuman: boolean;
    /**
     * 관문 통지를 이 턴에 **이미 스레드에 남겼나**(2026-09-09).
     *
     * `awaitingHuman` 으로 대신할 수 없다: 그 값은 "정지 시계를 재지 마라"는 뜻이고 한 턴에
     * 관문이 여러 번 뜨는 동안 계속 참으로 남는다. 통지는 그 사이 **한 번만** 나가야 한다 —
     * 명령마다 묻는 하네스에서는 카드가 줄줄이 쌓이고, 그 소음이 정작 무엇이 막혔는지를
     * 가린다(`retryNotice` 가 entry 당 1회인 것과 같은 판례).
     */
    gateNoticed: boolean;
    /** 하네스 기록이 마지막으로 자란 것을 본 시각(ms). 정지 판정의 기준점이다. */
    lastLifeMs: number;
    /**
     * 정지로 접을 때 **실제로 잰** 유휴시간(ms). 0 은 "정지가 아니다"다.
     *
     * 한도(`harnessStallMs`)와 갈라 두는 이유: 스레드에 남는 문장이 한도를 찍으면 사람은
     * "정말 그만큼이었나"를 알 수 없다. 2026-09-09 진단이 통지 시각에서 한도를 빼서
     * 턴 시작 시점을 되짚어야 했던 자리가 그것이다 — 잰 값을 그대로 쓰면 그 산수가 없다.
     */
    stalledIdleMs: number;
    cancelReclaim: (() => void) | null; cancelProbe: (() => void) | null; cancelSilence: (() => void) | null;
  } = {
    controls: null, exited: false, spoke: false, viewers: 0, silenced: false, reclaimed: false,
    apiError: null, canceledBy: null, stalled: false, awaitingHuman: false, gateNoticed: false,
    lastLifeMs: 0, stalledIdleMs: 0,
    cancelReclaim: null, cancelProbe: null, cancelSilence: null,
  };

  const reclaim = (): void => {
    if (end.exited || !end.controls) return;
    end.reclaimed = true;
    // SIGTERM 이 1차다 — 하네스가 모델 요청·파일 쓰기 중일 수 있어 정리할 기회를 준다.
    // 유예 뒤 SIGKILL 승격은 `PtyControls.kill` 이 갖는다(pty.ts::terminate). 세션은
    // 디스크라 잃는 것이 없다.
    //
    // **PTY 가 아직 없으면 여기서 할 수 있는 일이 없다** — 그 창에 들어온 중단은 아래
    // `runTurn` 앞의 가드가 받는다(스폰을 아예 안 한다). 이 자리에서 `canceledBy` 만
    // 적힌 채 아무 일도 안 일어나던 것이 사람이 멈춘 턴이 끝까지 돌던 두 번째 경로였다.
    end.controls.kill('SIGTERM');
  };

  /** 끝 조건을 다시 잰다. 발화·뷰어 어느 쪽이 바뀌어도 여기로 모인다. */
  const reconsiderEnd = (): void => {
    if (end.exited) return;
    if (!end.spoke || end.viewers > 0) {
      end.cancelReclaim?.();
      end.cancelReclaim = null;
      return;
    }
    if (end.cancelReclaim) return; // 이미 유예 중 — 다시 세우면 유예가 늘어난다.
    end.cancelReclaim = schedule(() => { end.cancelReclaim = null; reclaim(); }, deps.orphanMs ?? 60_000);
  };

  const onViewerCount = (count: number): void => {
    end.viewers = count;
    reconsiderEnd();
  };

  const session = deps.relay?.openSession({
    agentAccountId: deps.me.id,
    channelId,
    threadRootId: anchor,
    harness: def.harness,
    // 판정은 하네스 이름이 아니라 **fd 0 의 정체** 하나로 한다(스펙 §5-3). 그래서 claude 가
    // TUI 로 바뀐 것만으로 이 값이 참이 되고, 서버·데스크탑은 손대지 않아도 입력이 열린다.
    // codex 는 아직 `exec` + stdin 파일이라 거짓이다 — 쳐도 아무 데도 안 가는 입력창이
    // 최악이므로 그 사실을 서버까지 실어 보내 차례 자체를 안 주게 한다.
    acceptsInput: acceptsPtyInput(plan),
    // **claude 턴에만 싣는다.** 계정 축은 claude 계정 풀이므로, codex·gemini 턴에 이
    // 이름을 실으면 화면이 그 턴과 아무 상관 없는 계정을 가리키게 된다 — 생략은 "모른다"
    // 이고, 모르는 것으로 남기는 편이 틀린 것을 단언하는 것보다 낫다.
    claudeAccount: def.harness === 'claude-code' ? deps.claudeAccount : undefined,
    claudePool: def.harness === 'claude-code' ? (deps.claudePool ?? null) : undefined,
    onViewerCount,
    /*
      **사람이 [중단] 을 눌렀다**(3단계). 죽이는 것은 릴레이가 아니라 여기다 —
      `reclaim()` 이 이미 그 일을 하고 있고(SIGTERM, 유예 뒤 SIGKILL 승격은 pty.ts::terminate),
      그 뒤의 흔적 처리(실패 카드·💬 제거·재시도 회계)도 이 턴의 `finally` 가 갖는다.
      릴레이가 직접 kill 하면 종료 경로가 둘로 갈라져 한쪽은 아무 흔적도 남기지 않는다.

      `canceledBy` 를 **먼저** 적는다: kill 이 먼저면 그 사이에 exit 가 관측되어 실패 문구가
      "harness 종료 143" 으로 굳는다 — 사람이 누른 결과를 하네스 고장으로 적는 것이다.
    */
    onCancel: (byHandle: string) => {
      end.canceledBy = byHandle;
      reclaim();
    },
  });

  // #337: 이 스레드에 멘션 턴이 돈다는 사실을 등록한다 — 인터랙티브 open 의 3분기 ①
  // ("멘션 턴 진행 중 → 그 PTY 에 attach")과 main 루프의 유예 판정이 이 등록을 본다.
  // 세션을 연 **뒤**여야 한다: 등록의 sessionId 가 곧 attach 대상이다(릴레이가 없으면 null).
  deps.registry?.register(key, { kind: 'mention', sessionId: session?.sessionId ?? null });

  // 발화 폴링. 서버에만 있는 사실이라 물어보는 수밖에 없다 — 에이전트는 자기 PAT 로
  // 서버에 직접 발화하므로 러너의 PTY 출력에는 그 사실이 안 나타난다.
  //
  // codex 는 `exec` 이라 답하면 스스로 죽는다 — 폴링할 이유가 없다(P5 전까지).
  const probeMs = deps.utteranceProbeMs ?? 3_000;
  /**
   * **하네스가 한도·자격증명 에러를 냈는가**(2026-09-09). TUI 는 그 에러를 받고도 죽지
   * 않으므로 — 실측: 431ms 만에 화면에 찍고 8분 넘게 살아 있었다 — 프로세스 종료를
   * 기다리면 무발화 30분까지 간다. 그동안 멀쩡한 계정들이 논다.
   *
   * `sinceMs` 로 **이 턴의 것만** 본다: 세션 파일은 스레드의 전체 이력이라 앞 턴의 한도가
   * 그대로 남아 있고, 그것을 지금 것으로 읽으면 멀쩡한 계정을 버리고 축을 헛돈다.
   *
   * 발화한 뒤에는 보지 않는다(위 `end.spoke` 가드) — 답을 올린 뒤 후속 작업에서 한도를
   * 만나는 경우가 있고, 그 턴을 실패로 읽으면 재시도가 같은 질문에 두 번 답한다.
   */
  const probeApiError = async (): Promise<boolean> => {
    const read = deps.readApiError ?? readLastApiError;
    const err = await read(def.harness, sessionIdForProbe, {
      configDir: deps.claudeConfigDir, sinceMs: turnStartedAtMs,
    }).catch(() => null);
    if (!err || end.exited || end.spoke) return false;
    end.apiError = err.text;
    console.error(`[mentionTurn] ${key}: 하네스가 API 에러를 냈다 — ${err.text}`);
    reclaim();
    return true;
  };

  /**
   * **하네스가 멈췄는가**(2026-09-09 실측). 기록 파일이 `harnessStallMs` 동안 자라지
   * 않았으면 접는다. 판정 기준점은 마지막으로 자란 것을 본 시각이고, 아직 한 번도 못
   * 봤으면 턴 시작 시각이다 — 그래야 "기록이 아예 안 생긴다"도 같은 시계로 잡힌다.
   *
   * **못 읽으면 판정하지 않는다.** `null` 은 "파일이 없다"와 "읽기가 실패했다"를 함께
   * 뜻하므로, 그것을 정지로 읽으면 첫 몇 초의 정상 턴이 죽는다. 기준점만 그대로 두고
   * 다음 주기에 다시 본다 — 진짜로 안 생기면 시계가 그대로 흘러 잡힌다.
   */
  const probeStall = async (): Promise<boolean> => {
    const limit = deps.harnessStallMs ?? 10 * 60_000;
    // 기준점이 아직 안 잡혔으면(턴 시작 직전) 재지 않는다 — 0 을 기준으로 빼면
    // 첫 주기가 곧바로 한도를 넘는다.
    if (limit <= 0 || end.awaitingHuman || end.lastLifeMs === 0) return false;
    const read = deps.readTranscriptMtime ?? sessionTranscriptMtimeMs;
    const mtime = await read(def.harness, sessionIdForProbe, {
      configDir: deps.claudeConfigDir,
    }).catch(() => null);
    if (end.exited || end.spoke || end.awaitingHuman) return false;
    if (mtime !== null && mtime > end.lastLifeMs) { end.lastLifeMs = mtime; return false; }
    // 관찰자가 있으면 재지 않는다 — 무발화 시계와 같은 규칙이다(사람이 보고 있으면
    // 러너는 끼어들지 않는다). 사람이 그 터미널에서 직접 치고 있을 수 있다.
    if (end.viewers > 0) return false;
    const idleMs = (deps.now?.() ?? Date.now()) - end.lastLifeMs;
    if (idleMs < limit) return false;
    end.stalled = true;
    end.stalledIdleMs = idleMs;
    console.error(`[mentionTurn] ${key}: 하네스가 멈췄다 — 기록이 ${idleMs}ms 째 자라지 않는다`);
    reclaim();
    return true;
  };

  const probeUtterance = (): void => {
    if (end.exited || end.spoke) return;
    void deps.murmur.readThread(channelId, anchor, turnStartSeq)
      .then(async (after) => {
        if (end.exited || end.spoke) return;
        if (countOwnPostsSince(after, deps.me.id, turnStartSeq) > 0) {
          end.spoke = true;
          reconsiderEnd();
          return;
        }
        // 발화가 없다 — 하네스가 말을 못 하는 이유가 디스크에 있을 수 있다.
        if (await probeApiError()) return;
        // 에러도 없다 — 그러면 일하는 중인가, 서 있는가. 그것도 디스크가 말해 준다.
        if (await probeStall()) return;
        end.cancelProbe = schedule(probeUtterance, probeMs);
      })
      // 관측 실패로 턴을 죽이지 않는다 — 다음 주기에 다시 묻는다.
      .catch(() => { end.cancelProbe = schedule(probeUtterance, probeMs); });
  };
  if (usesTui) end.cancelProbe = schedule(probeUtterance, probeMs);

  // **PTY 를 띄우기 전에** 이 워크스페이스를 하네스가 신뢰하게 한다(2026-09-08).
  // 뜬 뒤에 적으면 그 턴은 이미 신뢰 대화상자를 만난 뒤다 — 러너는 답할 수 없고, 그
  // 대화상자가 준비 표시와 같은 글자를 담고 있어 프롬프트가 모달에 타이핑된다.
  await ensureWorkspaceTrusted({
    harness: def.harness,
    workspaceDir: rec.workspaceDir,
    claudeConfigDir: deps.claudeConfigDir,
    codexHome: deps.codexHome,
  });
  // 계정 단위 관문(2026-09-08). 위와 갈라 부르는 이유는 저장 위치와 범위가 다르기
  // 때문이다 — 이쪽은 `settings.json` 이고, 한 번 적으면 그 계정의 모든 워크스페이스가
  // 풀린다. **기본 경로는 이제 이 관문을 만나지 않는다**(2026-09-09: auto → claude 의
  // `auto`). 남겨 두는 이유는 사람이 터미널에서 bypass 로 올려 쓸 수 있기 때문이다 —
  // 그때 이 기록이 없으면 그 세션이 경고 화면에서 멈춘다. 이미 있으면 아무것도 안 쓴다.
  await ensureDangerousModeAccepted({
    harness: def.harness,
    claudeConfigDir: deps.claudeConfigDir,
  });

  // 아래 콜백들이 쓰는 값을 여기서 잡아 둔다 — 콜백 안에서는 `rec` 의 좁힌 타입이
  // 유지되지 않고(비동기 경계), 세션 id 는 첫 턴에도 이미 발급돼 있다.
  const sessionIdForProbe: string | null = rec.sessionId;
  /**
   * 이 턴이 시작된 벽시계 시각. 세션 파일의 `timestamp` 와 비교해 **이 턴의 에러만**
   * 가른다(`probeApiError`). PTY 를 띄우기 **직전**이어야 한다 — 뒤에 찍으면 그 사이에
   * 하네스가 쓴 에러를 놓친다.
   */
  const turnStartedAtMs = deps.now?.() ?? Date.now();
  // 정지 시계의 첫 기준점. 기록이 아직 없는 구간도 이 시각부터 흐른다.
  end.lastLifeMs = turnStartedAtMs;

  /**
   * **스폰 전에 들어온 중단을 받는다**(2026-09-09 회귀). 릴레이 세션은 위에서 이미 열렸다 —
   * 즉 화면의 「지금 도는 턴」에는 **[중단] 이 달린 줄로 이미 서 있는데** PTY 는 아직 없다.
   * 그 창(정의 읽기·워크스페이스 준비·계정 관문)에 사람이 누르면 `reclaim()` 은
   * `end.controls` 가 없어 조용히 돌아갔고, `canceledBy` 만 적힌 채 턴은 그대로 떠서
   * 끝까지 돌았다 — 답까지 올린 뒤 실패 카드가 "누가 중단했다"고 적히는, 기록과 사실이
   * 어긋나는 최악의 모양이었다.
   *
   * 띄웠다가 죽이지 않고 **아예 안 띄운다**: 이 창의 하네스는 아직 존재하지 않아 정리할
   * 것이 없고, 띄우면 프롬프트가 주입돼 모델 호출 한 번이 그냥 버려진다.
   *
   * `reclaimed` 는 적지 않는다 — 그 값은 "러너가 죽였다"이고 여기서는 죽인 것이 없다.
   * 종료 코드는 SIGTERM 의 관례값(143)이라 아래 실패 경로가 그대로 잡지만, 사람이 읽는
   * 문장은 `canceledBy` 가 정한다(실패 카드의 첫 분기).
   */
  const canceledBeforeSpawn = (): TurnResult | null =>
    (end.canceledBy ? { exitCode: 143, timedOut: false, tail: '' } : null);

  let result: TurnResult;
  try {
    result = canceledBeforeSpawn() ?? await deps.runTurn(plan, {
      cwd: rec.workspaceDir,
      // **0 = 무기한**(pty.ts 옵션 주석). TUI 턴의 시간 한도는 러너가 무발화로 잰다 —
      // PTY 쪽 시계는 프로세스 수명을 재는데, TUI 에서는 그 둘이 다른 사실이다.
      // codex 는 `exec` 이라 두 사실이 같으므로 그대로 PTY 시계를 쓴다.
      timeoutMs: usesTui ? 0 : deps.turnTimeoutMs,
      // TUI 로 뜬 턴에만 주입한다 — codex 의 `exec` 은 stdin 파일이 곧 프롬프트다.
      // 주입은 `runPtyTurn` 이 준비 신호를 본 뒤에 한다(pty.ts::injectPrompt).
      ...(usesTui ? {
        injectPrompt: {
          text: prompt,
          // 아래 두 필드는 **함께 켜지고 함께 꺼진다**: `confirmDelivery` 는 `onAttention`
          // 이 있어야 할 일이 있고(부를 곳이 없으면 확인해도 소용없다), `onAttention` 은
          // 축의 마지막에서만 열린다. 앞 계정에서는 준비 실패가 그대로 던져져
          // 계정 전환을 태운다 — 그것이 이 턴이 아직 쓸 수 있는 더 싼 수단이다.
          ...(deps.callsForHuman === false ? {} : {
            /**
             * 주입이 **먹혔는지**도 잰다(2026-09-08). 증거는 세션 기록 파일이고, 화면
             * 문자열로 재지 않는 이유는 그것이 하네스 버전에 묶이기 때문이다.
             *
             * **재는 것은 존재가 아니라 성장이다**(2026-09-09). 파일의 존재로 재면 이 창은
             * **첫 턴에서만** 산다 — 되살린 턴(`claude -r`)의 기록 파일은 앞 턴에 이미
             * 생겨 있어 무조건 통과한다. 그 구멍으로 프로덕션에서 턴 둘이 연달아 프롬프트를
             * 못 받고 각각 10분씩 정지 시계에 접혔다(`sessionTranscriptGrewSince` 머리).
             *
             * 기준점은 **턴 시작 시각**이다. 주입 시각이 아닌 이유: 주입은 이 콜백 바깥
             * (`pty.ts`)에서 일어나 그 시각을 여기서 모르고, 턴 시작 이후에 자란 기록은
             * 어차피 이 턴의 것이다 — 앞 턴은 이미 끝나 있다.
             */
            confirmDelivery: {
              probe: () => sessionTranscriptGrewSince(def.harness, sessionIdForProbe, turnStartedAtMs, {
                configDir: deps.claudeConfigDir,
              }),
            },
            /**
             * **사람 부르기는 마지막 수단이다.** 여기까지 왔다는 것은 `withAccountFailover`
             * 가 풀을 다 태웠다는 뜻이다 — 준비 실패는 계정 전환 방아쇠이므로
             * (`claudeAccounts.ts::switchesAccount`), 마지막 계정이 아니면 이 콜백이 아니라
             * 그 전환이 먼저 일어난다.
             *
             * 이 턴은 여기서 끝나지 않는다: PTY 가 살아 있고, 사람이 관문을 지나면 그
             * 자리에서 프롬프트가 주입된다. 끝은 exit 이거나 무발화 시계다 — 그 시계는
             * 사람이 붙어 있으면(`end.viewers > 0`) 지나가므로, 사람이 오면 살아남는다.
             */
            onAttention: (screen: string, kind: AttentionKind) => {
              // 이 턴은 이제 **사람을 기다린다** — 기록이 안 자라는 것이 정상이다.
              // 정지 시계를 계속 재면 사람이 오기 전에 접힌다(위 `awaitingHuman` 주석).
              end.awaitingHuman = true;
              const label = deps.accountLabel ?? '(기본)';

              /**
               * **스레드에 남기는 것은 원장보다 앞이다**(2026-09-09).
               *
               * 지금까지 이 부름의 표면은 `agent.attention` **WS 이벤트 하나**였다. 그것은
               * 그때 거기 있던 사람에게만 닿는다 — 앱이 닫혀 있었거나 다른 스레드의 터미널을
               * 보고 있었으면(`controller.ts` 의 `if (지금) break`) 부름은 **흔적 없이
               * 사라진다.** 그 자리가 이번 사건에서 사람이 "앱이 알려주지 않아 알 수가
               * 없었다"고 말한 자리다.
               *
               * 원장 뒤에 두면 안 되는 이유가 여기서 갈린다: 원장은 **화면을 빼앗는 것**을
               * 묶는 장부다(같은 계정 승인 하나에 창 7개를 띄우지 않는다). 그런데 막힌
               * 스레드는 그 7개가 다 막힌 것이 사실이므로, 기록은 스레드마다 남아야 한다.
               * 묶는 것과 남기는 것은 다른 일이다.
               */
              if (!end.gateNoticed) {
                end.gateNoticed = true;
                // 이 콜백은 `void` 다(pty.ts) — 던지면 PTY 쪽으로 새어 나가므로 삼킨다.
                // 말하지 못한 것으로 턴을 죽이지 않는다: 사람은 여전히 터미널로 닿을 수 있다.
                void deps.murmur.fail(channelId, gateNotice(label), anchor, {
                  retryable: false,
                  what: '하네스가 사람의 확인을 기다린다',
                  reason: '그 터미널에서 화면의 물음에 답하면 이 턴이 그 자리에서 이어진다',
                }).catch((e: unknown) => {
                  console.error(`[mentionTurn] ${key}: 관문 통지 발화 실패(턴은 그대로 기다린다):`,
                    e instanceof Error ? e.message : e);
                });
              }

              /**
               * **원장은 `'startup'` 만 묶는다**(2026-09-09).
               *
               * 그 관문의 승인은 계정 설정에 기록되므로 한 번 지나면 그 계정의 모든 스레드가
               * 함께 풀린다 — 스레드마다 부르면 사람이 같은 승인을 반복한다.
               *
               * `'gate'` 는 그렇지 않다: `--permission-mode auto` 의 확인은 **명령 하나에
               * 대한 물음**이라, 지나도 다음 명령은 다시 묻고 다른 스레드는 전혀 풀리지
               * 않는다. 그것을 계정으로 묶으면 먼저 걸린 스레드가 장부를 쥐고, 나머지 턴은
               * 화면도 통지도 없이 서 있다가 정지 시계에 접힌다 — 이 커밋이 고치려는 실패를
               * 원장으로 다시 만드는 셈이다.
               */
              if (kind === 'startup'
                && deps.attentionLedger
                && !deps.attentionLedger.claim(label, sessionIdForProbe ?? key)) return;
              session?.needsAttention(screen, label);
              console.error(
                `[mentionTurn] ${key}: 사람 손이 필요하다(${kind}, 계정=${label}) — 앱이 이 세션의 터미널을 연다`,
              );
            },
          }),
        },
      } : {}),
      // 릴레이가 없으면 탭도 없다 — `undefined` 를 넘겨 pty 쪽 호출을 아예 안 만든다.
      onData: session ? (chunk) => session.push(chunk) : undefined,
      // 반대 방향(#315): 사람이 attach 해서 친 바이트가 이 PTY 로 들어온다. 릴레이가
      // 없으면 그 바이트를 나를 길 자체가 없으므로 통로도 만들지 않는다.
      //
      // **이 배선이 이 턴의 권한을 바꾸지 않는다.** `plan` 은 위에서 `mode: 'mention'` 과
      // `def.mentionPermission` 으로 이미 조립됐고 여기서 손대지 않는다 — 스펙 §6 의
      // "멘션 턴에 attach 해도 그 턴의 모드는 바꿀 수 없다"는 **여전히 참이다.** 바뀐
      // 것은 그 PTY 에 바이트를 넣을 수 있는 주체뿐이고, 그 주체는 하네스가 아니라
      // 사람이다: `mention_permission` 은 에이전트가 스스로 넘지 못하는 선이지 사람이
      // 넘지 못하는 선이 아니다(#315 운영자 결정).
      onSpawn: (controls: PtyControls) => {
        // 릴레이에는 입력·크기만 넘긴다(`PtyWriter`) — 종료는 러너의 몫이고, 관찰하는
        // 쪽에 그 손잡이를 주면 뷰어가 턴을 죽일 수 있게 된다.
        session?.bindInput(controls);
        // 회수 손잡이. 릴레이가 없어도 잡아야 한다 — 관찰이 없다고 턴이 안 끝나면 안 된다.
        end.controls = controls;
        // 위 가드와 이 콜백 사이에도 창이 있다(실행 파일 해석·forkpty). 그 창에 들어온
        // 중단은 손잡이를 잡은 **바로 이 순간** 써야 한다 — 안 쓰면 그 턴은 아무도 다시
        // 죽여 주지 않는다(중단은 한 번 오고, 다시 오지 않는다).
        if (end.canceledBy) {
          reclaim();
          return;
        }
        // **무발화 시계(2026-09-08).** `turnTimeoutMs` 는 이제 프로세스 수명이 아니라
        // "답 없이 흐른 시간"을 잰다 — TUI 는 답하고도 안 죽으므로 프로세스 수명으로 재면
        // 정상 턴까지 시간 한도에 걸린다.
        //
        // 관찰자가 있으면 재지 않는다: 인터랙티브 턴이 `timeoutMs: 0`(무기한)인 것과 같은
        // 규칙이고, 회수·유예와 한 문장으로 모인다 — 사람이 보고 있으면 러너는 끼어들지 않는다.
        if (usesTui) {
          end.cancelSilence = schedule(() => {
            if (end.exited || end.spoke || end.viewers > 0) return;
            end.silenced = true;
            reclaim();
          }, deps.turnTimeoutMs);
        }
      },
    });
  } finally {
    // 끝 상태의 타이머를 먼저 끈다 — 남기면 끝난 턴의 타이머가 다음 턴의 PTY 를 죽인다.
    end.exited = true;
    end.cancelProbe?.();
    end.cancelReclaim?.();
    end.cancelSilence?.();
    // 등록도 세션과 같은 수명이다 — 남겨 두면 끝난 턴이 "진행 중"으로 남아 인터랙티브
    // open 이 죽은 PTY 에 사람을 붙인다.
    deps.registry?.release(key);
    // 턴이 어떻게 끝나든(정상·타임아웃·예외) 세션은 닫는다. 안 닫으면 서버의 세션
    // 목록에 끝난 턴이 영구히 남아, 사람이 attach 해도 아무 바이트도 오지 않는다.
    session?.close();
    // 💬 는 반드시 제거한다 — 타임아웃·예외로 끝나도 남으면 "영원히 작업 중"이라는
    // 거짓 신호가 되고, 그것이 docs/design.md 4절 "없는 것을 있다고 표시하지 않는다" 다.
    // 추가가 끝난 뒤에 제거한다(순서가 뒤집히면 💬 가 남는다).
    await workingInFlight;
    await deps.murmur.removeReaction(channelId, mentionId, '💬').catch((err: unknown) => {
      console.error(
        `[mentionTurn] ${key}: 리액션(진행 중) 제거 실패 — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // #144: 에이전트가 직접 message.progress 로 진행 설명을 올리므로, 더 이상 ack seq 를 추적할 필요가 없다.
  // progress 메시지는 kind='progress' 로 저장되어 countOwnPostsSince 에서 자동으로 제외된다.

  // #126: 턴 종료 로그 (경과 시간, exitCode, 발화 여부)
  const elapsedMs = (deps.now ?? Date.now)() - turnStartMs;
  const exitInfo = result.timedOut ? `timeout (${result.exitCode})` : String(result.exitCode);
  console.log(`[mentionTurn] ${key}: 턴 종료 (경과=${elapsedMs}ms, exitCode=${exitInfo})`);

  // #176: 마지막 활동 시각을 서버에 남긴다. **여기가 자리다** — 실패 분기(아래)보다 위여서
  // 실패한 턴도 보고된다. 실패한 턴도 움직인 턴이고, "마지막으로 언제 움직였나"에 성공
  // 여부는 들어 있지 않다. 발화 여부와도 무관하다(도구만 쓰고 끝나는 턴이 있다).
  //
  // **실패해도 턴을 실패로 만들지 않는다.** 활동 보고가 안 됐다고 사람이 기다리는 답을
  // 못 준 것은 아니다 — 이 호출로 던지면 아래의 세션 상태 저장·발화 확인까지 건너뛰게 되고,
  // 그러면 다음 턴이 같은 메시지를 다시 먹인다. 조용히 삼키지는 않는다: 화면의 "마지막
  // 활동"이 왜 멈춰 있는지 답할 수 있는 자리가 이 로그뿐이다.
  await deps.murmur.reportActivity().catch((err: unknown) => {
    console.error(
      `[mentionTurn] ${key}: 활동 보고 실패(턴은 계속한다) — ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  // codex 세션 발견(findCodexSessionId)의 sinceMs 는 PTY 를 띄우기 **직전** 시각이어야 한다.
  // 턴이 끝난 뒤에 재면 방금 만들어진 rollout 파일이 그보다 오래돼 보여 발견이 조용히
  // 실패하고, codex 스레드가 매 턴 새 세션으로 시작한다(에러 없이) — 브리프가 짚은 함정.
  const sinceMs = turnStartMs;

  if (def.harness === 'codex' && rec.sessionId === null) {
    // codex 는 세션 id 를 사전 할당할 수 없다 — 방금 끝난 턴이 만든 rollout 파일에서
    // 사후 발견한다. 못 찾아도(null) 예외로 죽이지는 않는다 — 다음 턴이 새 세션으로 다시
    // 시작한다(spec §8, isFirstTurn 계산이 sessionId===null 도 보므로 실제로 그렇게 된다).
    // 그래도 원인 없이 반복되면 "왜 이 스레드는 매번 새로 시작하지"를 아무도 알 수 없으니
    // 러너 로그에는 남긴다(spec §8 "+ 러너 로그 경고").
    const discovered = await findCodexSessionId(codexSessionsDir(deps.codexHome), { cwd: rec.workspaceDir, sinceMs });
    if (discovered === null) {
      console.warn(
        `[mentionTurn] ${key}: codex 세션 발견 실패 (cwd=${rec.workspaceDir}, sinceMs=${sinceMs}) — 다음 턴은 새 세션으로 다시 시작한다`,
      );
    }
    rec = { ...rec, sessionId: discovered };
  }

  // `end.silenced` 를 함께 본다(2026-09-08): 무발화로 회수한 턴은 SIGTERM 으로 죽으므로
  // exitCode 만 봐도 대개 실패로 잡히지만, 그 사실을 조건에 명시해야 아래 문구가 원인을
  // 정확히 말한다 — "무발화"와 "하네스가 스스로 죽었다"는 사람이 할 일이 다르다.
  // **발화한 뒤 우리가 회수한 턴은 성공이다**(2026-09-08 프로덕션 관측). TUI 는 답하고도
  // 죽지 않으므로 러너가 SIGTERM 으로 끝내는데, 그 143 을 실패로 읽으면 답을 낸 턴이
  // "답변 실패"로 기록되고 재시도 3회를 태운다 — 이미 답한 스레드에.
  //
  // **종료 코드로는 못 가른다**: 회수·무발화·하네스 자멸이 전부 143 이다. 그래서 러너가
  // 아는 두 사실을 함께 본다 — 우리가 죽였는가(`reclaimed`), 그리고 답했는가(`spoke`).
  // 무발화 회수는 `spoke` 가 거짓이므로 아래 실패 경로에 그대로 남는다.
  const 회수로끝났다 = end.reclaimed && end.spoke && !end.silenced && !end.stalled;

  if (!회수로끝났다 && (result.exitCode !== 0 || result.timedOut || end.silenced || end.stalled || end.apiError)) {
    // #81: 실패한 턴은 turnsRun 을 올리지 않는다. claude 의 세션 uuid 는 러너가 발급만 했을
    // 뿐 하네스에 등록됐다는 증거가 아니다 — 올리면 다음 턴이 isFirstTurn=false 로 판단해
    // `-r`(resume)로 조립하고, 존재한 적 없는 세션을 이어받으려다 또 실패한다. 0 으로 둬야
    // 같은 uuid 로 첫 턴(`--session-id`)을 다시 시도한다. workspaceDir 과 (codex 라면) 방금
    // 발견한 sessionId 는 저장한다 — 둘 다 이 시점에 디스크에 이미 실재하는 사실이다.
    //
    // **다만 "발급만 했다"를 추측하지 않는다(2026-09-07 18:59 실측).** #81 의 판단은
    // "실패한 턴은 세션을 만들지 않았다"를 암묵 전제로 깔았고, 사용량 한도가 그 전제를
    // 정면으로 깬다: claude 는 프롬프트를 다 받아 세션을 만든 **뒤** 답을 쓰려는 순간
    // 한도에 걸려 죽는다(디스크에 19줄이 적힌 `<uuid>.jsonl` 이 남았다). 그때 turnsRun 을
    // 0 으로 두면 다음 턴이 `--session-id` 로 조립하고 claude 가 이미 있는 id 를 거부한다
    // (`Error: Session ID <uuid> is already in use.`) — **그 실패도 turnsRun 을 올리지
    // 않으므로 상태가 자기를 재생산해** 그 스레드가 영구히 죽는다(실측: 두 멘션이 각각
    // 3회씩 176ms 만에 같은 자리에서 실패).
    //
    // 그래서 추측 대신 **디스크를 관측한다**. 이것은 인터랙티브 턴이 이미 하던 일이고
    // (`interactiveTurn.ts` 의 같은 판정), 두 경로가 같은 하네스의 같은 세션 파일을
    // 공유하므로 한쪽만 그 사실을 보는 비대칭이 결함이었다.
    //
    // lastFedSeq 는 "이 턴에 발화가 있었나"로 정한다. 실패해도 발화는 이미 있었을 수 있고,
    // 대표적인 경우가 타임아웃이다(답을 올린 뒤 계속 일하다 시간이 다 되어 SIGTERM 을
    // 맞는다). 그때 커서를 되돌려 두면 재시도가 같은 메시지를 다시 먹여 **같은 질문에 두 번
    // 답한다**(#90 과 같은 결의 중복 발화). `timedOut` 을 대리 신호로 쓰지 않는 이유는,
    // 발화 여부가 진짜 신호이고 우리는 이미 그걸 관측할 수단(countOwnPostsSince)을 갖고 있어서다.
    //
    // 관측 자체가 실패하면(murmur 로 가는 네트워크가 잠깐 끊김) 전진시키지 않는다 —
    // "한 번 더 시도한다"가 "중복 발화"보다 회복 가능한 쪽이다.
    let answered = false;
    try {
      // #80: 턴 시작 이후의 메시지만 읽으면 turnStartSeq 이후 발화가 있는지 정확히 판정한다.
      const after = await deps.murmur.readThread(channelId, anchor, turnStartSeq);
      // #144: progress 메시지는 결과 발화로 세지 않는다 — 에이전트가 message.progress 로 올린
      // 진행 설명은 .kind='progress'로 저장되어 countOwnPostsSince 에서 자동으로 제외된다.
      // 따라서 "progress 메시지만 있고 결과가 없는 턴"은 NO_REPLY_NOTICE 로 처리된다.
      const postCount = countOwnPostsSince(after, deps.me.id, turnStartSeq);
      // 실패한 턴에서도 중복 발화는 일어난다(답을 두 번 올리고 나서 죽는다) — 성공 경로와
      // 같은 관측을 여기서도 한다. 안 하면 "실패했으니 안 보였다"가 되어 #90 의 관측이
      // 반쪽이 된다.
      warnOnDuplicatePosts(key, postCount);
      answered = postCount > 0;
    } catch (err) {
      console.error(
        `[mentionTurn] ${key}: 실패 턴의 발화 확인 실패(커서를 전진시키지 않고 재시도로 넘긴다) — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // 관측이 던지면 올리지 않는다 — "다시 첫 턴을 시도한다"가 "없는 세션을 이어받는다"보다
    // 회복 가능한 쪽이다(#81 이 고른 것과 같은 방향의 보수적 실패).
    let materializedTurnsRun = rec.turnsRun;
    if (rec.turnsRun === 0 && rec.sessionId !== null) {
      const materialized = deps.sessionMaterialized ?? claudeSessionMaterialized;
      try {
        // 계정 디렉터리를 함께 넘긴다 — 자식 env 와 이 관측이 같은 곳을 봐야 한다.
        if (await materialized(def.harness, rec.sessionId, deps.claudeConfigDir)) materializedTurnsRun = 1;
      } catch (err) {
        console.error(
          `[mentionTurn] ${key}: 세션 실재 관측 실패(turnsRun 을 올리지 않는다) — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // lastFedSeq 와 turnsRun 은 서로 다른 사실이다: 세션은 실재하게 됐지만(turnsRun) 답은
    // 못 했으므로(lastFedSeq) 다음 턴이 같은 델타를 다시 먹여야 한다.
    await deps.store.put(key, {
      ...rec,
      ...(answered ? { lastFedSeq: fedSeq } : {}),
      turnsRun: materializedTurnsRun,
    });
    // tail 을 반드시 포함한다 — PTY 안에서는 stdout/stderr 가 한 스트림으로 섞여 나오므로
    // policy.ts::isCredentialFailure 가 자격증명 실패를 판단할 근거가 이것뿐이다.
    // tail 을 반드시 포함한다 — PTY 안에서는 stdout 과 stderr 가 한 스트림으로 섞여 나오므로
    // policy.ts 의 **tail 폴백**이 볼 근거가 이것뿐이다.
    //
    // **그 위에 구조화된 사실을 얹는다(2026-09-08).** 세션 JSONL 의 `isApiErrorMessage`
    // 레코드는 앞이 안 잘리고 사람의 프롬프트가 섞이지 않는다(`harnessErrors.ts` 머리).
    // 2026-09-07 19:03 사건에서 tail 판정이 "풀림: 알 수 없음"만 남긴 자리가 여기다 —
    // 그날도 세션 파일에는 시각이 온전히 있었다.
    //
    // **읽기가 실패해도 던지지 않는다.** 이 값은 판정을 더 좋게 만드는 재료이지 턴의 성패가
    // 아니다. 여기서 예외를 올리면 원래 하려던 실패 처리(통지·재시도 회계)까지 함께 무너진다.
    const apiError = await readLastApiError(def.harness, rec.sessionId, {
      configDir: deps.claudeConfigDir,
    }).catch(() => null);
    // **무발화는 tail 을 담지 않는다.** TUI 에서는 주입한 프롬프트가 에코돼 tail 에 섞이고,
    // 그것이 판정 재료가 되면 사람이 본문 한 줄로 러너를 죽일 수 있다(설계 §3-4). 무발화는
    // 하네스가 아무 말도 안 했다는 사실이므로 tail 에서 얻을 것도 없다.
    const failure = new Error(
      // **사람이 중단한 턴은 그 사실을 먼저 말한다**(3단계). 원인이 하네스가 아니라 사람이고,
      // 그때 사람이 할 일은 아무것도 없다 — 종료 코드와 tail 을 앞세우면 스레드를 보던
      // 사람은 에이전트가 고장난 줄 알고 러너 로그를 뒤진다. 누가 눌렀는지도 함께 남긴다:
      // 여럿이 같은 스레드를 보는 자리에서 "누가 멈췄나"는 다음 판단의 재료다.
      end.canceledBy
        ? `@${end.canceledBy} 가 이 턴을 중단했다`
        : end.apiError
          // 턴 도중에 관측한 에러가 있으면 그것이 원인이다(2026-09-09). tail 을 담지 않는
          // 이유는 무발화와 같다 — TUI 에서는 주입한 프롬프트가 에코돼 tail 에 섞인다.
          ? `harness API 에러: ${end.apiError}`
          // 정지를 무발화보다 **먼저** 본다: 접는 수단이 같은 SIGTERM 이라 무발화 시계가
          // 뒤따라 설 수 있는데, 사람이 알아야 할 사실은 "서 있었다" 쪽이다.
          : end.stalled
            // **한도가 아니라 잰 값을 쓴다**(2026-09-09). 한도만 남기면 사람이 "정말 그만큼
            // 서 있었나"를 알 수 없어, 통지 시각에서 한도를 빼 턴 시작을 되짚는 산수를 해야
            // 한다. 한도를 함께 남기는 것은 그 값이 손잡이(`AGENT_HARNESS_STALL_MS`)여서다.
            ? `harness 정지 ${end.stalledIdleMs}ms(한도 ${deps.harnessStallMs ?? 10 * 60_000}ms) — 기록이 자라지 않았다(답 없음)`
            : end.silenced
              ? `harness 무발화 ${deps.turnTimeoutMs}ms — 답 없이 시간 한도를 넘겼다`
              : `harness 종료 ${result.exitCode}${result.timedOut ? ' (timeout)' : ''}: ${result.tail}`,
    ) as Error & { harnessApiError?: string; harnessStalledMs?: number };
    /*
      **정지의 마지막 화면은 러너 로그에 남긴다**(2026-09-09).

      2026-09-09 진단이 여기서 막혔다: 되살린 턴 둘이 프롬프트를 못 받고 각각 10분에
      접혔는데, "왜 안 먹혔나"의 재료인 그때 화면이 아무 데도 없었다 — 정지 실패는 tail 을
      담지 않고(아래 이유) 러너 로그에도 안 찍혔다. 그래서 원인이 가설 둘로 남았다.

      **실패 문구에는 여전히 담지 않는다.** 그 문장은 `policy.ts::isCredentialFailure` 의
      tail 폴백이 읽는 자리이고, TUI 에서는 주입한 프롬프트가 에코돼 tail 에 섞인다 —
      담으면 사람이 본문 한 줄로 러너를 78 로 물러나게 할 수 있다(설계 §3-4). 통지로도
      내지 않는다: 스레드에 영구히 남는 자리에 프롬프트 에코를 흘리지 않는다.

      로그는 그 둘 중 어느 것도 아니다. PAT 는 `harnessTailNotice` 가 가린다 — 이 함수를
      쓰는 이유가 자르기보다 그 가리기다.
    */
    if (end.stalled) {
      const 화면 = harnessTailNotice(result.tail, deps.pat);
      console.error(
        `[mentionTurn] ${key}: 정지 당시 마지막 화면 —\n${화면 ?? '(출력이 없었다)'}`,
      );
    }
    /**
     * **정지를 문구가 아니라 표시로 넘긴다**(#711). 스케줄러가 이 실패를 재시도 회계에 넣지
     * 않기 위해 알아봐야 하는데(`policy.ts::isHarnessStall`), 위 문장으로 판정하면 그 문장을
     * 다듬는 순간 조용히 안 맞는다 — 30분을 태우는 옛 동작으로 되돌아가고, 되돌아간 것을
     * 아무도 모른다.
     *
     * **싣는 값은 한도가 아니라 잰 값이다**(2026-09-09). 이 값으로 스레드 문장이 서므로
     * (`stallNotice`), 한도를 실으면 화면이 "실제로 잰 것"과 갈라진다 — `isHarnessStall` 의
     * 주석이 경계하는 그 어긋남이다. 잰 값이 없을 때만(있을 수 없지만, 0 이면 스케줄러가
     * 정지로 못 읽어 재시도가 되살아난다) 한도를 바닥값으로 쓴다.
     */
    if (end.stalled) failure.harnessStalledMs = end.stalledIdleMs || (deps.harnessStallMs ?? 10 * 60_000);
    // **턴 도중 관측이 우선이다.** 종료 뒤 읽기(`apiError`)는 sinceMs 가 없어 앞 턴의
    // 에러를 집을 수 있다 — 지금 턴의 사실을 이미 손에 쥐었으면 그것을 쓴다.
    if (end.apiError) failure.harnessApiError = end.apiError;
    else if (apiError) failure.harnessApiError = apiError.text;
    throw failure;
  }

  // 여기 도달했다면 정상 종료다(위에서 실패를 이미 걸렀다). 성공한 턴만 turnsRun 을 올린다.
  // 이 저장이 아래 관측·통보보다 **먼저**여야 한다: 관측(readThread)이나 통보(post)가 던지면
  // — 저장이 그 뒤에 있었다면 실제로 돌아간 턴이 디스크에 기록되지 않고, 다음 재시도가
  // turnsRun===0 을 보고 새 uuid 를 발급하거나(claude 세션이 고아가 된다) 이미 먹인 메시지를
  // 다시 먹인다(리뷰 지적).
  await deps.store.put(key, { ...rec, lastFedSeq: fedSeq, turnsRun: rec.turnsRun + 1 });

  // 관측·통보는 best-effort 다 — 방금 저장한 상태를 좌우하지 않으므로 여기서 던진 예외로
  // 턴 전체를 실패(재시도 대상)로 만들 이유가 없다. 조용히 삼키면 "왜 NO_REPLY_NOTICE 가
  // 안 남았지"의 원인이 사라지므로 러너 로그에는 남긴다.
  try {
    // #80: 턴 시작 이후의 메시지만 읽으면 turnStartSeq 이후 발화가 있는지 정확히 판정한다.
    const after = await deps.murmur.readThread(channelId, anchor, turnStartSeq);
    // #144: progress 메시지는 결과 발화로 세지 않는다 — 에이전트가 message.progress 로 올린
    // 진행 설명은 .kind='progress'로 저장되어 countOwnPostsSince 에서 자동으로 제외된다.
    // 따라서 "progress 메시지만 있고 결과가 없는 턴"은 NO_REPLY_NOTICE 로 처리된다.
    const postCount = countOwnPostsSince(after, deps.me.id, turnStartSeq);
    warnOnDuplicatePosts(key, postCount);
    // 이번 턴에 깨움을 걸었다면 침묵이 아니다 — 스레드에 대기 줄이 보이므로 사람은 무슨
    // 일인지 안다. 여기에 NO_REPLY_NOTICE 까지 더하면 CI 를 10분 기다리는 사이 "발화 없음"
    // 이 줄줄이 쌓이고, 그 소음이 정작 진짜 침묵을 가린다.
    //
    // 커서(lastFedSeq)는 **위에서 이미 전진**했다(발화가 있었든 없었든 성공한 턴은 전진한다) —
    // 여기서 되돌리지 않는다. 되돌리면 깨어난 턴이 옛 멘션을 다시 먹는다.
    if (postCount === 0 && !hasOwnWakeSince(after, deps.me.id, turnStartSeq)) {
      // 여기는 정상 종료 경로뿐이다(실패는 위에서 던졌다). 정상 종료했는데 스스로 발화하지 않았다 — 이유는 하나로 좁혀지지 않는다
      // (쓸 말이 없었거나, 안전 거부(exit 0)이거나). 옛 reply.ts::extractReply 가 안전
      // 거부를 사실로 남기던 자리를 이 경로가 대신한다: 침묵을 침묵으로 남기지 않는다.
      // **버려지던 마지막 출력을 함께 싣는다**(2026-09-07 후속). 그날 사람이 본 것은
      // 이 통지 한 줄이었고, `PR #533 을 올렸고 CI 가 도는 중입니다` 는 stdout 에만
      // 남아 사라졌다 — 그 말은 이미 `result.tail` 안에 있었다.
      //
      // 해석이 아니라 **증거 첨부**다(`harnessTailNotice` 주석). 통지가 먼저 서는 순서도
      // 뜻이 있다: 사실("발화가 없었다")이 먼저고, 출력은 그 사실의 정황이다.
      const evidence = harnessTailNotice(result.tail, deps.pat);
      // **침묵의 이유가 옆 스레드에 있을 수 있다**(2026-09-08 실측, `offAnchorPosts` 주석).
      // 여기서만 채널 전체를 훑는 이유는 값이 싸지 않아서다: 이 경로는 드물게 도는 침묵
      // 경로이고, 그때는 사람에게 어차피 통지가 나가므로 한 왕복을 더 쓸 값어치가 있다.
      // 실패해도 통지 자체는 그대로 나간다 — 정황이 없다고 사실을 못 남기면 본말이 뒤집힌다.
      const offAnchor = await offAnchorEvidence(deps, key, channelId, anchor, turnStartSeq);
      const body = [
        NO_REPLY_NOTICE,
        ...(offAnchor === null ? [] : ['', offAnchor]),
        ...(evidence === null ? [] : ['', `하네스가 마지막에 남긴 출력:\n${evidence}`]),
      ].join('\n');
      // 상한을 넘기면 서버가 거절해 **통지 자체가 사라진다** — 이 기능이 막으려던 것과
      // 같은 결과다. `harnessTailNotice` 가 이미 1000자로 줄이지만, 상한 판정을 그 함수의
      // 상수에 맡기지 않는다: 여기가 서버 계약을 아는 자리다.
      await deps.murmur.post(channelId, body.slice(0, BODY_LIMIT), anchor);
    }
  } catch (err) {
    console.error(
      `[mentionTurn] ${key}: 발화 확인/통보 실패(세션 상태는 이미 저장됐다) — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 종료 요청은 **여기서** 돌려준다 — 정의를 읽은 직후가 아니다. 그 자리에서 돌아서면
  // 이 멘션은 답 없이 사라지고, 부른 사람은 왜 답이 없는지 알 방법이 없다.
  return { stopRequestedAt: def.stopRequestedAt };
}
