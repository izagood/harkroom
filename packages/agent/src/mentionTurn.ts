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
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentView, MessageRow } from '@murmur/shared';
import type { Me } from './murmur.js';
import { buildSystemPrompt, buildTurnPrompt, hasOwnPostSince, NO_REPLY_NOTICE } from './prompt.js';
import { SessionStore } from './sessions.js';
import { buildTurnCommand, preassignsSessionId, type TurnPlan } from './turn.js';
import type { TurnResult } from './pty.js';
import { findCodexSessionId } from './codexSessions.js';
import { ensureWorkspace, workspaceName, type Exec } from './workspace.js';

/** runMentionTurn 이 요구하는 murmur 표면. MurmurAgentClient 의 부분집합이라 실제 클래스를
 * 그대로 넘겨도 되고, 테스트는 인메모리 fake 를 넘긴다(프로세스 경계·네트워크 없이 검증). */
export interface MentionTurnMurmur {
  definition(): Promise<AgentView>;
  readThread(channelId: string, threadRootId: string | null): Promise<MessageRow[]>;
  post(channelId: string, body: string, threadRootId: string | null): Promise<void>;
}

/** 한 턴을 실제로 돌리는 함수. 프로덕션은 pty.ts::runPtyTurn 을 그대로 넘기고, 테스트는
 * 이 자리에 스텁을 꽂아 buildTurnCommand 가 만든 plan 을 가로채 검증한다(브리프: "buildTurnCommand
 * 호출 캡처는 runMentionTurn 에 spawn 함수를 주입해 확인"). */
export type RunTurn = (plan: TurnPlan, opts: { cwd: string; timeoutMs: number }) => Promise<TurnResult>;

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
  murmurUrl: string;
  pat: string;
  turnTimeoutMs: number;
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
 */
async function resolveWorkspaceDir(
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

export interface MentionTarget {
  channelId: string;
  /** 멘션이 있던 자리 — 스레드 안이면 그 루트, 채널 최상위면 null. main.ts 가 멘션
   * 메시지에서 이미 계산해 둔 값을 그대로 받는다(브리프: "여기서 새로 계산하지 마라 —
   * 계산하는 순간 네 번째 진실 원천이 된다"). */
  threadRootId: string | null;
}

/**
 * 멘션 하나에 답한다. 던지면(예: 하네스 비정상 종료) 호출자(main.ts)의 attempts/backoff
 * 경로가 받는다 — 이 함수 자체는 재시도하지 않는다(policy.ts 는 그대로 둔다).
 */
export async function runMentionTurn(deps: MentionTurnDeps, target: MentionTarget): Promise<void> {
  const { channelId, threadRootId: anchor } = target;

  // 정의는 매 턴 새로 읽는다 — UI 로 지시문을 바꾸면 다음 턴부터 바로 반영된다(spec §3).
  const def = await deps.murmur.definition();
  const thread = await deps.murmur.readThread(channelId, anchor);
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
    return;
  }

  // 발화 판정(hasOwnPostSince)의 기준선이다 — 턴 시작 전에 이미 있던 자기 발화까지 세면,
  // 아무것도 안 하고 끝낸 턴도 "발화했다"로 잘못 판정된다.
  const turnStartSeq = thread.reduce((max, m) => Math.max(max, m.seq), 0);

  const systemPrompt = buildSystemPrompt({
    handle: deps.me.handle,
    channelName: deps.channelName,
    instructions: def.instructions,
    guide: deps.guide,
  });

  const plan = buildTurnCommand({
    harness: def.harness,
    mode: 'mention',
    sessionId: rec.sessionId,
    isFirstTurn,
    systemPrompt,
    promptCtx: prompt,
    model: def.model,
    effort: def.effort,
    mentionPermission: def.mentionPermission,
    mcpConfigPath: deps.mcpConfigPath,
    pat: deps.pat,
    murmurUrl: deps.murmurUrl,
  });

  // codex 세션 발견(findCodexSessionId)의 sinceMs 는 PTY 를 띄우기 **직전** 시각이어야 한다.
  // 턴이 끝난 뒤에 재면 방금 만들어진 rollout 파일이 그보다 오래돼 보여 발견이 조용히
  // 실패하고, codex 스레드가 매 턴 새 세션으로 시작한다(에러 없이) — 브리프가 짚은 함정.
  const sinceMs = (deps.now ?? Date.now)();
  const result = await deps.runTurn(plan, { cwd: rec.workspaceDir, timeoutMs: deps.turnTimeoutMs });

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

  // #81 수정: 실패한 턴에서는 lastFedSeq 와 turnsRun 을 전진하지 않는다.
  // 전진하면 다음 턴이 델타가 비어있을 때 하네스를 안 돌리고 조용히 리턴한다 —
  // MAX_ATTEMPTS 에 도달하지 못한 채 멘션이 끝난다.
  // 대신 workspaceDir 과 발견된 sessionId(#81 권고) 는 저장한다 —前者는 이미
  // 만들어졌고 後者是 프로세스 종료 후 디스크에 쓰여있으므로, 저장해도 재시도에
  // 지장을 주지 않는다(같은 workspace 에서 새 세션을 시도하면 된다).
  const failure = result.exitCode !== 0 || result.timedOut;
  if (failure) {
    await deps.store.put(key, { ...rec });
    throw new Error(
      `harness 종료 ${result.exitCode}${result.timedOut ? ' (timeout)' : ''}: ${result.tail}`,
    );
  }

  // 성공한 턴만 lastFedSeq 와 turnsRun 을 전진한다.
  await deps.store.put(key, { ...rec, lastFedSeq: fedSeq, turnsRun: rec.turnsRun + 1 });

  // 관측·통보는 best-effort 다 — 방금 저장한 상태를 좌우하지 않으므로 여기서 던진 예외로
  // 턴 전체를 실패(재시도 대상)로 만들 이유가 없다. 조용히 삼키면 "왜 NO_REPLY_NOTICE 가
  // 안 남았지"의 원인이 사라지므로 러너 로그에는 남긴다.
  try {
    const after = await deps.murmur.readThread(channelId, anchor);
    if (!hasOwnPostSince(after, deps.me.id, turnStartSeq)) {
      // 하네스가 정상 종료했는데 스스로 발화하지 않았다 — 이유는 하나로 좁혀지지 않는다
      // (쓸 말이 없었거나, 안전 거부(exit 0)이거나). 옛 reply.ts::extractReply 가 안전
      // 거부를 사실로 남기던 자리를 이 경로가 대신한다: 침묵을 침묵으로 남기지 않는다.
      await deps.murmur.post(channelId, NO_REPLY_NOTICE, anchor);
    }
  } catch (err) {
    console.error(
      `[mentionTurn] ${key}: 발화 확인/통보 실패(세션 상태는 이미 저장됐다) — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
