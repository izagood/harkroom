// 사람이 스스로 여는 인터랙티브 턴(#337, 스펙 §5-2 결정 4·5·7).
//
// 서버의 `interactive.open` 요청 하나를 받아 셋 중 하나로 답한다(3분기):
//   ① 그 스레드에 멘션 턴이 돌고 있다 → 그 턴의 릴레이 세션 id 를 `{created:false}` 로
//      돌려준다 — 새 PTY 를 띄우지 않고 진행 중인 화면에 사람을 붙인다(스펙 §1 표 3행).
//   ② 인터랙티브 턴이 이미 돌고 있다 → 같은 이유로 기존 세션을 돌려준다. 창을 두 개
//      열었다고 PTY 가 두 개 뜨면, 한 하네스 세션을 두 프로세스가 밟는다.
//   ③ 아무 턴도 없다 → 세션을 확보(없으면 생성)하고 인터랙티브 PTY 를 띄운다.
//
// **exit 을 기다리지 않는다.** 이 함수의 반환은 "떴다"이지 "끝났다"가 아니다 — 서버는
// 티켓을 발급해야 하고 사람은 그 티켓으로 attach 한다. 턴의 끝은 둘이다(스펙 §5-2 결정 5):
// 1차 exit(사람이 하네스 안에서 종료), 2차 고아 회수(viewer 0 → 유예 → SIGTERM→SIGKILL).
import { randomUUID } from 'node:crypto';
import type { AgentHarness, AgentView, MessageRow } from '@murmur/shared';
import type { Me } from './murmur.js';
import { SessionStore, type SessionRecord } from './sessions.js';
import { buildTurnCommand, preassignsSessionId, type TurnPlan } from './turn.js';
import type { PtyControls, TurnResult } from './pty.js';
import type { Exec } from './workspace.js';
import { resolveWorkspaceDir } from './mentionTurn.js';
import { findCodexSessionId } from './codexSessions.js';
import { claudeSessionFileExists } from './claudeSessions.js';
import { TurnRegistry } from './turnRegistry.js';
import { MentionQueue } from './mentionQueue.js';

/** SIGTERM 뒤 SIGKILL 승격까지의 유예. pty.ts 의 타임아웃 경로와 같은 값·같은 이유다. */
const KILL_GRACE_MS = 5_000;

/** 인터랙티브 턴을 실제로 돌리는 함수 — 프로덕션은 `runPtyTurn`, 테스트는 스텁. */
export type RunInteractiveTurn = (
  plan: TurnPlan,
  opts: {
    cwd: string;
    /** 인터랙티브는 항상 0(무기한)이다 — 사람이 앉아 있는 턴에는 시계가 없다. */
    timeoutMs: number;
    cols?: number;
    rows?: number;
    killGraceMs?: number;
    onData?: (chunk: Buffer) => void;
    onSpawn?: (controls: PtyControls) => void;
  },
) => Promise<TurnResult>;

/** 인터랙티브 턴이 요구하는 릴레이 표면 — mentionTurn 의 `TurnRelay` 에 mode·viewer 통지를 더한 것. */
export interface InteractiveRelay {
  openSession(input: {
    agentAccountId: string;
    channelId: string;
    threadRootId: string | null;
    harness: AgentHarness;
    mode?: 'mention' | 'interactive';
    onViewerCount?: (count: number) => void;
  }): {
    sessionId: string;
    push(chunk: Buffer): void;
    bindInput(writer: { write(chunk: Buffer): void }): void;
    close(): void;
  };
}

export interface InteractiveTurnDeps {
  murmur: {
    definition(): Promise<AgentView>;
    readThread(channelId: string, threadRootId: string | null, since?: number): Promise<MessageRow[]>;
  };
  store: SessionStore;
  exec: Exec;
  runTurn: RunInteractiveTurn;
  me: Me;
  workspaceBaseDir: string;
  mcpConfigPath: string;
  murmurUrl: string;
  pat: string;
  relay: InteractiveRelay;
  registry: TurnRegistry;
  queue: MentionQueue;
  /** viewer 0 → 회수까지의 유예(스펙 §5-2 결정 5). config.interactiveOrphanMs 가 온다. */
  orphanMs?: number;
  killGraceMs?: number;
  /**
   * 타이머 주입 — 반환값이 취소 함수다. 테스트가 유예·승격을 시간 없이 돌린다.
   * 생략하면 unref 된 setTimeout(러너 종료를 타이머가 붙잡지 않는다).
   */
  schedule?: (fn: () => void, ms: number) => () => void;
  /**
   * "하네스 세션이 실재하게 됐는가"의 관측(#337 스파이크 §2). 첫 인터랙티브 턴에서 사람이
   * 대화했으면 turnsRun 을 올려 다음 턴이 resume 으로 조립되게 하고, 열었다 그냥 닫았으면
   * 그대로 둬 다음 턴이 다시 `--session-id` 로 시작하게 한다 — 어느 쪽을 틀려도 다음 턴이
   * 파싱·조회 오류로 죽는다("already in use" / "No conversation found").
   */
  sessionMaterialized?: (harness: AgentHarness, sessionId: string) => Promise<boolean>;
}

export interface InteractiveOpenRequest {
  channelId: string;
  threadRootId: string;
  openedByHandle: string;
  cols?: number;
  rows?: number;
}

export interface InteractiveManager {
  /** 3분기를 지나 세션 id 를 돌려준다. 실패는 던진다 — 릴레이가 interactive.error 로 옮긴다. */
  open(req: InteractiveOpenRequest): Promise<{ sessionId: string; created: boolean }>;
  /**
   * 러너가 물러난다(SIGTERM) — 진행 중인 인터랙티브 PTY 전부를 고아 회수와 같은 경로
   * (SIGTERM → 유예 → SIGKILL)로 끝낸다. 멘션 턴과 달리 기다릴 답이 없으므로 즉시다.
   */
  shutdown(): void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

const defaultSessionMaterialized = (harness: AgentHarness, sessionId: string): Promise<boolean> => {
  if (harness === 'claude-code') return claudeSessionFileExists(sessionId);
  // codex 인터랙티브는 거절되므로(§5-2 결정 8) 여기 도달하지 않지만, sessionId 가 이미
  // 발견돼 있다는 것 자체가 디스크의 사실이므로 참이 맞다.
  return Promise.resolve(true);
};

export function createInteractiveManager(deps: InteractiveTurnDeps): InteractiveManager {
  const schedule = deps.schedule ?? defaultSchedule;
  const orphanMs = deps.orphanMs ?? 60_000;
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const sessionMaterialized = deps.sessionMaterialized ?? defaultSessionMaterialized;

  /** 진행 중인 인터랙티브 턴의 회수 손잡이(threadKey → 상태). shutdown 이 순회한다. */
  const liveTurns = new Map<string, {
    controls: PtyControls | null;
    exited: boolean;
    cancelOrphan: (() => void) | null;
    cancelKill: (() => void) | null;
  }>();

  const reclaim = (state: { controls: PtyControls | null; exited: boolean; cancelKill: (() => void) | null }): void => {
    if (state.exited || !state.controls) return;
    // SIGTERM 이 1차다 — 하네스가 모델 요청·파일 쓰기 중일 수 있어 정리할 기회를 준다.
    // 유예 안에 안 죽으면 SIGKILL — 세션은 디스크라 kill 로 잃는 것이 없다(스펙 §5-2 결정 5).
    state.controls.kill('SIGTERM');
    state.cancelKill = schedule(() => { if (!state.exited) state.controls?.kill('SIGKILL'); }, killGraceMs);
  };

  const open = async (req: InteractiveOpenRequest): Promise<{ sessionId: string; created: boolean }> => {
    const key = SessionStore.threadKey(req.channelId, req.threadRootId);

    // ── 분기 ①·② — 이미 도는 턴이 있으면 새 PTY 를 띄우지 않는다.
    const running = deps.registry.get(key);
    if (running) {
      if (running.sessionId === null) {
        // 멘션 턴이 릴레이 없이 돌고 있다 — attach 할 세션이 없다. 조용히 새 PTY 를
        // 띄우면 한 하네스 세션을 두 프로세스가 밟으므로, 사실을 말하고 거절한다.
        throw new Error('이 스레드에 멘션 턴이 진행 중이지만 관찰 릴레이가 없다 — 턴이 끝난 뒤 다시 열어라');
      }
      return { sessionId: running.sessionId, created: false };
    }

    // ── 분기 ③ — 세션을 확보하고 인터랙티브 PTY 를 띄운다.
    // 정의는 매번 새로 읽는다(멘션 턴과 같은 이유 — 하네스·모델이 UI 에서 바뀐다).
    const def = await deps.murmur.definition();

    let rec = deps.store.get(key);
    if (rec && rec.harness !== def.harness) {
      // 멘션 턴의 하네스 전환과 같은 판단(mentionTurn.ts): 세션 기억만 버리고
      // 워크스페이스는 재사용한다 — 산출물은 하네스와 무관하다.
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

    const isFirstTurn = rec.turnsRun === 0 || rec.sessionId === null;

    // 권한 플래그 없음(mode 가 mention 이 아니면 permission 표를 안 탄다 — 스펙 §6: 묻는
    // 것이 곧 "직접 개입"의 값이고 사람이 터미널에서 답한다), 프롬프트·stdin 파일 없음
    // (사람이 직접 친다). codex 는 여기서 명확한 거절을 던진다(§5-2 결정 8) — 그 메시지가
    // relay 의 interactive.error 로 사람 화면까지 그대로 간다.
    const plan = buildTurnCommand({
      harness: def.harness,
      mode: 'interactive',
      sessionId: rec.sessionId,
      isFirstTurn,
      systemPrompt: '',
      systemPromptFile: null,
      promptCtx: '',
      stdinFile: null,
      model: def.model,
      effort: def.effort,
      mentionPermission: def.mentionPermission,
      mcpConfigPath: deps.mcpConfigPath,
      pat: deps.pat,
      murmurUrl: deps.murmurUrl,
    });

    // definition() 을 기다리는 사이 멘션 턴이 시작됐을 수 있다 — 등록 직전에 다시 본다.
    // 그냥 register 하면 TurnRegistry 가 크게 던지는데, 이 경합은 결함이 아니라 합류
    // 대상이다(분기 ①과 같은 답).
    const raced = deps.registry.get(key);
    if (raced) {
      if (raced.sessionId === null) {
        throw new Error('이 스레드에 멘션 턴이 진행 중이지만 관찰 릴레이가 없다 — 턴이 끝난 뒤 다시 열어라');
      }
      return { sessionId: raced.sessionId, created: false };
    }

    const state: { controls: PtyControls | null; exited: boolean; cancelOrphan: (() => void) | null; cancelKill: (() => void) | null } = {
      controls: null, exited: false, cancelOrphan: null, cancelKill: null,
    };

    // 고아 회수(스펙 §5-2 결정 5). viewer 0 이 유예를 시작하고, 0 이 아닌 count 가 취소한다.
    // 패널 닫힘·소켓 단절·앱 강제종료가 서버 관점에서 전부 "viewer 소멸" 하나로 수렴한다.
    const onViewerCount = (count: number): void => {
      if (state.exited) return;
      if (count > 0) {
        state.cancelOrphan?.();
        state.cancelOrphan = null;
        return;
      }
      if (state.cancelOrphan) return; // 이미 유예 중 — 타이머를 다시 세우면 유예가 늘어난다.
      state.cancelOrphan = schedule(() => { state.cancelOrphan = null; reclaim(state); }, orphanMs);
    };

    const session = deps.relay.openSession({
      agentAccountId: deps.me.id,
      channelId: req.channelId,
      threadRootId: req.threadRootId,
      harness: def.harness,
      mode: 'interactive',
      onViewerCount,
    });

    deps.registry.register(key, { kind: 'interactive', sessionId: session.sessionId, openedByHandle: req.openedByHandle });
    liveTurns.set(key, state);

    // spawn 확인용 — onSpawn 이 불리면 PTY 가 실제로 떴다는 뜻이다. exit 은 기다리지 않는다.
    let resolveSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => { resolveSpawned = resolve; });

    const turn = deps.runTurn(plan, {
      cwd: rec.workspaceDir,
      timeoutMs: 0, // 무기한 — 사람이 앉아 있는 턴에는 시계가 없다(pty.ts 옵션 주석).
      cols: req.cols,
      rows: req.rows,
      killGraceMs,
      onData: (chunk) => session.push(chunk),
      onSpawn: (controls) => {
        session.bindInput(controls);
        state.controls = controls;
        // 사람이 아직 attach 전이다(count 0) — 지금부터 유예가 흐른다. 티켓을 받고도 안
        // 붙으면(창을 닫음, 네트워크) 이 타이머가 PTY 를 회수한다.
        onViewerCount(0);
        resolveSpawned();
      },
    });

    // ── 턴의 끝(1차 exit / 2차 회수 — 어느 쪽이든 여기로 온다).
    const finish = async (result: TurnResult | null): Promise<void> => {
      state.exited = true;
      state.cancelOrphan?.();
      state.cancelKill?.();
      liveTurns.delete(key);

      const current = rec as SessionRecord;
      let sessionId = current.sessionId;
      let turnsRun = current.turnsRun;
      let lastFedSeq = current.lastFedSeq;
      try {
        if (def.harness === 'codex' && sessionId === null) {
          // 사후 발견(스펙 §3) — 지금은 codex 인터랙티브가 거절되어 도달하지 않지만, 위
          // 거절 게이트(§5-2 결정 8)가 상류 codex 의 플래그 추가로 풀리는 날 이 경로가
          // 곧바로 정답이어야 한다. 못 찾으면 다음 턴이 새로 시작한다(멘션 턴과 같은 후퇴).
          sessionId = await findCodexSessionId(undefined, { cwd: current.workspaceDir, sinceMs: 0 });
        }

        // 스파이크 §2 실측이 요구하는 판정: 사람이 대화했으면(세션 파일 있음) turnsRun 을
        // 올려 다음 턴이 resume 으로 조립되게 하고, 그냥 닫았으면(파일 없음) 그대로 둬
        // 같은 uuid 로 첫 턴을 다시 시도하게 한다. 어느 쪽을 틀려도 다음 턴이 죽는다
        // ("Session ID already in use" / "No conversation found").
        if (turnsRun === 0 && sessionId !== null && (await sessionMaterialized(def.harness, sessionId))) {
          turnsRun = 1;
        }

        // lastFedSeq 전진 — 사람이 터미널에서 한 말은 스레드 밖이므로 세지 않고, 그 사이
        // 스레드에 쌓인 것만 당긴다(스펙 §4). 단 **대기 멘션의 min seq − 1 로 클램프한다**
        // (§5-2 결정 7): 클램프 없이 전진하면 유예됐다 풀려나는 멘션 턴의 델타 프롬프트가
        // 비어(그 멘션이 이미 "먹인 것"으로 계산된다) 그 부름이 조용히 소실된다.
        const thread = await deps.murmur.readThread(req.channelId, req.threadRootId, current.lastFedSeq);
        const maxSeq = thread.reduce((max, m) => Math.max(max, m.seq), current.lastFedSeq);
        const minPending = deps.queue.minSeq(key);
        const advanced = minPending !== null ? Math.min(maxSeq, minPending - 1) : maxSeq;
        lastFedSeq = Math.max(current.lastFedSeq, advanced);

        await deps.store.put(key, { ...current, sessionId, turnsRun, lastFedSeq });
      } catch (err) {
        // 저장 실패는 다음 멘션 턴이 같은 구간을 다시 먹는 쪽으로 기운다 — 소실보다 낫다.
        console.error(
          `[interactiveTurn] ${key}: 종료 처리 실패(세션 상태가 일부 저장되지 않았을 수 있다) — ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        // 대기 장부는 registry 해제 **전에** 비우면 안 된다(클램프가 min 을 이미 읽었으니
        // 이제 비워도 된다) — 다음 조종의 통지가 1회부터 다시 시작한다.
        deps.queue.clear(key);
        // 해제가 마지막이다: 해제되는 순간 main 루프가 유예를 풀고 대기 멘션을 처리하기
        // 시작하는데, 그 턴은 방금 저장한 lastFedSeq 를 읽어야 한다.
        deps.registry.release(key);
        session.close();
      }
      // "발화 없음" 검사는 하지 않는다 — 사람 턴에 발화 의무가 없다(멘션 턴과 다른 점).
      if (result) {
        console.log(`[interactiveTurn] ${key}: 인터랙티브 턴 종료 (exitCode=${result.exitCode})`);
      }
    };

    void turn.then(
      (result) => finish(result),
      // runPtyTurn 은 reject 하지 않는 계약이지만, spawn 자체가 실패하면(실행 파일 없음)
      // 여기로 온다 — 그때도 레지스트리·세션을 정리해야 스레드가 영구히 "조종 중"으로 안 남는다.
      (err) => {
        console.error(`[interactiveTurn] ${key}: 인터랙티브 턴 실패 — ${err instanceof Error ? err.message : String(err)}`);
        return finish(null);
      },
    );

    // spawn 이 확인되면 곧장 돌려준다 — 서버의 10초 타임아웃 안에 티켓이 발급돼야 한다.
    // spawn 자체가 실패하면 turn 이 그보다 먼저 끝나므로, 그 실패를 열기 실패로 돌려준다.
    await Promise.race([
      spawned,
      turn.then((result) => {
        throw new Error(`인터랙티브 턴이 뜨자마자 끝났다 (exitCode=${result.exitCode}) — 러너 로그를 확인해라`);
      }),
    ]);

    return { sessionId: session.sessionId, created: true };
  };

  return {
    open,

    shutdown() {
      // 러너 SIGTERM — 진행 중 인터랙티브 PTY 전부를 고아 회수와 같은 경로로 끝낸다.
      // 멘션 턴은 main 루프가 배치를 마치고 스스로 물러나지만, 인터랙티브 턴은 사람이
      // 닫아 줄 때까지 기다릴 대상이 없다(러너가 죽으면 릴레이도 함께 끊긴다).
      for (const state of liveTurns.values()) {
        state.cancelOrphan?.();
        state.cancelOrphan = null;
        reclaim(state);
      }
    },
  };
}
