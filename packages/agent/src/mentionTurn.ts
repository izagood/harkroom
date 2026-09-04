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
import type { AgentHarness, AgentView, MessageRow } from '@murmur/shared';
import type { Me } from './murmur.js';
import { buildSystemPrompt, buildTurnPrompt, type MemoryContext, countOwnPostsSince, hasOwnPostSince, NO_REPLY_NOTICE } from './prompt.js';
import { SessionStore } from './sessions.js';
import { buildTurnCommand, preassignsSessionId, writePromptFile, writeSystemPromptFile, type TurnPlan } from './turn.js';
import type { PtyWriter, TurnResult } from './pty.js';
import { findCodexSessionId } from './codexSessions.js';
import { ensureWorkspace, workspaceName, type Exec } from './workspace.js';
import type { TurnRegistry } from './turnRegistry.js';

/** runMentionTurn 이 요구하는 murmur 표면. MurmurAgentClient 의 부분집합이라 실제 클래스를
 * 그대로 넘겨도 되고, 테스트는 인메모리 fake 를 넘긴다(프로세스 경계·네트워크 없이 검증). */
export interface MentionTurnMurmur {
  definition(): Promise<AgentView>;
  readThread(channelId: string, threadRootId: string | null, since?: number): Promise<MessageRow[]>;
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
     * PTY stdin 통로(#315). `onData` 의 반대 방향 — attach 한 소유자가 친 바이트가 이리로
     * 들어간다. `RunPtyTurnOptions` 의 같은 이름 필드를 이 계약에도 연 것이고, 이유도
     * `onData` 와 같다: 좁혀 놓은 이 타입이 넘길 방법을 막으면 배선이 구조적으로 불가능하다.
     */
    onSpawn?: (writer: PtyWriter) => void;
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
  }): {
    sessionId: string;
    push(chunk: Buffer): void;
    /** 사람이 친 바이트가 갈 곳(#315). spawn 시점에 이어 붙인다. */
    bindInput(writer: PtyWriter): void;
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
   * (bypassPermissions)인 에이전트가 자기 지시문을 읽고 고칠 수 있게 된다.
   */
  stateDir: string;
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
  /** 테스트가 sinceMs 캡처 시점을 결정론적으로 만들기 위한 시계 주입. 생략하면 Date.now. */
  now?: () => number;
}

/**
 * 새 워크스페이스를 확보한다. `def.workingDir` 이 null 인 것과 "명시적으로 지정됐다"는
 * 서로 다른 사실이라 나눠서 다룬다(리뷰 지적) — 하나로 뭉개
 * (`def.workingDir ?? process.cwd()`) `ensureWorkspace` 에 넘기면, 아무도 지정한 적 없는
 * `process.cwd()`(러너 자신의 체크아웃)에서 avcs 워크스페이스를 시도하게 된다. 그건
 * 누구도 요청하지 않은 동작이고 `mentionPermission: 'auto'`(bypassPermissions)와 겹치면
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
    join(workspaceDir, '.codex', 'skills'),
  ];

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

  if (rec && rec.harness !== def.harness) {
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
  });

  if (!prompt) {
    // 새 메시지가 있었지만 전부 자기 발화라 넘길 게 없었다 — 하네스를 돌리지 않는다.
    // 그래도 fedSeq 는 이미 전진한 값을 반드시 저장해야, 다음 턴이 이 구간을 다시 "새
    // 것"으로 들이밀어 세션이 자기 말을 또 보는 일이 없다. turnsRun 은 건드리지 않는다 —
    // 하네스가 안 돌았으니 "돌았다"고 기록할 것도 없다.
    await deps.store.put(key, { ...rec, lastFedSeq: fedSeq });
    return { stopRequestedAt: def.stopRequestedAt };
  }

  // 발화 판정(hasOwnPostSince)의 기준선이다 — 턴 시작 전에 이미 있던 자기 발화까지 세면,
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

  // #117: 대화 본문도 stdin 파일로 이동한다. argv 에 있으면 같은 머신의 다른 로컬 사용자가
  // `ps -ef` 로 스레드 내용을 그대로 읽는다. codex 는 지시문까지 합쳐서 stdin 으로 가고,
  // claude 는 지시문이 이미 systemPromptFile 로 별도로 가므로 여기선 promptCtx 만 stdin 으로 간다.
  let stdinFile: string | null = null;
  if (def.harness === 'codex') {
    // codex: 지시문 + 본문 합쳐서 stdin 으로
    const combined = [systemPrompt, prompt].filter((s) => s.length > 0).join('\n\n');
    stdinFile = await writePromptFile(deps.stateDir, combined);
  } else {
    // claude: 본문만 stdin 으로 (지시문은 --append-system-prompt-file 로 별도 파일)
    stdinFile = await writePromptFile(deps.stateDir, prompt);
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
  const session = deps.relay?.openSession({
    agentAccountId: deps.me.id,
    channelId,
    threadRootId: anchor,
    harness: def.harness,
  });

  // #337: 이 스레드에 멘션 턴이 돈다는 사실을 등록한다 — 인터랙티브 open 의 3분기 ①
  // ("멘션 턴 진행 중 → 그 PTY 에 attach")과 main 루프의 유예 판정이 이 등록을 본다.
  // 세션을 연 **뒤**여야 한다: 등록의 sessionId 가 곧 attach 대상이다(릴레이가 없으면 null).
  deps.registry?.register(key, { kind: 'mention', sessionId: session?.sessionId ?? null });

  let result: TurnResult;
  try {
    result = await deps.runTurn(plan, {
      cwd: rec.workspaceDir,
      timeoutMs: deps.turnTimeoutMs,
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
      onSpawn: session ? (writer: PtyWriter) => session.bindInput(writer) : undefined,
    });
  } finally {
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
    const discovered = await findCodexSessionId(undefined, { cwd: rec.workspaceDir, sinceMs });
    if (discovered === null) {
      console.warn(
        `[mentionTurn] ${key}: codex 세션 발견 실패 (cwd=${rec.workspaceDir}, sinceMs=${sinceMs}) — 다음 턴은 새 세션으로 다시 시작한다`,
      );
    }
    rec = { ...rec, sessionId: discovered };
  }

  if (result.exitCode !== 0 || result.timedOut) {
    // #81: 실패한 턴은 turnsRun 을 올리지 않는다. claude 의 세션 uuid 는 러너가 발급만 했을
    // 뿐 하네스에 등록됐다는 증거가 아니다 — 올리면 다음 턴이 isFirstTurn=false 로 판단해
    // `-r`(resume)로 조립하고, 존재한 적 없는 세션을 이어받으려다 또 실패한다. 0 으로 둬야
    // 같은 uuid 로 첫 턴(`--session-id`)을 다시 시도한다. workspaceDir 과 (codex 라면) 방금
    // 발견한 sessionId 는 저장한다 — 둘 다 이 시점에 디스크에 이미 실재하는 사실이다.
    //
    // lastFedSeq 는 "이 턴에 발화가 있었나"로 정한다. 실패해도 발화는 이미 있었을 수 있고,
    // 대표적인 경우가 타임아웃이다(답을 올린 뒤 계속 일하다 시간이 다 되어 SIGTERM 을
    // 맞는다). 그때 커서를 되돌려 두면 재시도가 같은 메시지를 다시 먹여 **같은 질문에 두 번
    // 답한다**(#90 과 같은 결의 중복 발화). `timedOut` 을 대리 신호로 쓰지 않는 이유는,
    // 발화 여부가 진짜 신호이고 우리는 이미 그걸 관측할 수단(hasOwnPostSince)을 갖고 있어서다.
    //
    // 관측 자체가 실패하면(murmur 로 가는 네트워크가 잠깐 끊김) 전진시키지 않는다 —
    // "한 번 더 시도한다"가 "중복 발화"보다 회복 가능한 쪽이다.
    let answered = false;
    try {
      // #80: 턴 시작 이후의 메시지만 읽으면 turnStartSeq 이후 발화가 있는지 정확히 판정한다.
      const after = await deps.murmur.readThread(channelId, anchor, turnStartSeq);
      // #144: progress 메시지는 결과 발화로 세지 않는다 — 에이전트가 message.progress 로 올린
      // 진행 설명은.kind='progress'로 저장되어 countOwnPostsSince 에서 자동으로 제외된다.
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
    await deps.store.put(key, answered ? { ...rec, lastFedSeq: fedSeq } : { ...rec });
    // tail 을 반드시 포함한다 — PTY 안에서는 stdout/stderr 가 한 스트림으로 섞여 나오므로
    // policy.ts::isCredentialFailure 가 자격증명 실패를 판단할 근거가 이것뿐이다.
    throw new Error(
      `harness 종료 ${result.exitCode}${result.timedOut ? ' (timeout)' : ''}: ${result.tail}`,
    );
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
    // 진행 설명은.kind='progress'로 저장되어 countOwnPostsSince 에서 자동으로 제외된다.
    // 따라서 "progress 메시지만 있고 결과가 없는 턴"은 NO_REPLY_NOTICE 로 처리된다.
    const postCount = countOwnPostsSince(after, deps.me.id, turnStartSeq);
    warnOnDuplicatePosts(key, postCount);
    if (postCount === 0) {
      // 여기는 정상 종료 경로뿐이다(실패는 위에서 던졌다). 정상 종료했는데 스스로 발화하지 않았다 — 이유는 하나로 좁혀지지 않는다
      // (쓸 말이 없었거나, 안전 거부(exit 0)이거나). 옛 reply.ts::extractReply 가 안전
      // 거부를 사실로 남기던 자리를 이 경로가 대신한다: 침묵을 침묵으로 남기지 않는다.
      await deps.murmur.post(channelId, NO_REPLY_NOTICE, anchor);
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
