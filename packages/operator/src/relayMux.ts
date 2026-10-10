/**
 * 릴레이 다중화기 — 스펙 2026-09-20 §5 PTY 행. 러너 프레임에 `runnerId` 를 붙여 서버 채널에
 * 싣고, 서버 프레임의 `runnerId` 로 러너를 골라 링크에 내려보낸다.
 *
 * **해석하지 않는다.** 붙이고 떼는 것은 `@harkroom/shared/runnerLink` 의 함수 한 벌이고, 이
 * 모듈이 프레임에서 읽는 것은 딱 하나 — 세션 목록이다. 서버가 재접속했을 때 러너에게 다시
 * 물을 왕복이 없으므로, 러너의 `announce` 이후 `session.started/ended` 를 따라간 목록을 들고
 * 있다가 `resync` 에 `runner.announce` 로 다시 낸다. 옛 릴레이에서 러너가 재접속마다 announce
 * 하던 것(서버는 소켓이 끊기면 그 러너의 세션을 버린다)을 오퍼레이터가 대신하는 것이다 —
 * 러너는 서버가 끊긴 것을 모르므로(§5) 이 자리 말고는 할 곳이 없다.
 */
import type { AgentSessionView, RelayRunnerFrame, RelayServerFrame, RunnerCap } from '@harkroom/shared';
import type { OperatorToServerFrame, ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';
import { unwrapServerFrame, wrapRunnerFrame } from '@harkroom/shared/runnerLink';

export interface RelayMuxDeps {
  link: { send(runnerId: string, frame: RelayServerFrame): boolean; isLinked(runnerId: string): boolean };
  /** 서버 채널로. 안 붙어 있으면 false — 그때의 손실은 `resync` 가 메운다(세션 목록에 한해). */
  send(frame: OperatorToServerFrame): boolean;
  log(line: string): void;
  /**
   * 러너가 아니라 **이 오퍼레이터**가 가진 능력(R1 PR-3b) — 러너의 announce 에 덧붙인다. 지금은 로컬 터미널
   * 허브가 서버의 `local.view`·`local.writer` 를 알아듣는다는 `'local-terminal'` 하나다. 없으면 그대로 올린다.
   */
  extraCaps?: readonly RunnerCap[];
}

export interface RelayMux {
  onRunnerFrame(runnerId: string, frame: RelayRunnerFrame): void;
  /** 러너에게 갔으면 true. 배정 같은 오퍼레이터의 말이거나 러너가 없으면 false. */
  onServerFrame(frame: ServerToOperatorFrame): boolean;
  /** 서버 (재)접속 뒤 — 붙어 있는 러너들의 세션 목록을 다시 낸다. */
  resync(): void;
  /** 러너가 죽었다 — 그 목록을 잊는다. */
  forget(runnerId: string): void;
  /** hello 에 실을 세션 전부(붙어 있는 러너 것만). */
  sessions(): AgentSessionView[];
}

/** 러너가 아니라 오퍼레이터만 가질 수 있는 능력 — 러너 announce 에 있으면 지운다(security n2). */
const OPERATOR_CAPS: ReadonlySet<RunnerCap> = new Set<RunnerCap>(['local-terminal']);

export function createRelayMux(deps: RelayMuxDeps): RelayMux {
  const known = new Map<string, { sessions: Map<string, AgentSessionView>; caps: RunnerCap[] | undefined }>();

  const track = (runnerId: string, frame: RelayRunnerFrame): void => {
    if (frame.type === 'announce') {
      known.set(runnerId, { sessions: new Map(frame.sessions.map((s) => [s.sessionId, s])), caps: frame.caps ? [...frame.caps] : undefined });
      return;
    }
    const entry = known.get(runnerId);
    if (!entry) return;
    if (frame.type === 'session.started') entry.sessions.set(frame.session.sessionId, frame.session);
    else if (frame.type === 'session.ended') entry.sessions.delete(frame.sessionId);
  };

  const ownCaps = (announce: Extract<RelayRunnerFrame, { type: 'announce' }>): RelayRunnerFrame => {
    const claimed = announce.caps?.filter((c) => !OPERATOR_CAPS.has(c));
    const extra = deps.extraCaps ?? [];
    if (!announce.caps && extra.length === 0) return announce;
    const caps = [...new Set([...(claimed ?? []), ...extra])];
    if (!announce.caps && caps.length === 0) return announce;
    return { ...announce, caps };
  };

  return {
    onRunnerFrame(runnerId, incoming) {
      // **러너는 오퍼레이터의 능력을 주장하지 못한다**(security n2) — 러너가 스스로 올린 'local-terminal' 은 지우고,
      // 허브가 있을 때만 오퍼레이터가 붙인다. 옛 러너(caps 없음)에도 덧붙인다 — 그때 caps 는 이 능력 하나뿐이고,
      // 'input' 이 없으니 서버는 입력을 열지 않는다.
      const frame: RelayRunnerFrame = incoming.type === 'announce'
        ? ownCaps(incoming)
        : incoming;
      track(runnerId, frame);
      const wrapped = wrapRunnerFrame(runnerId, frame);
      if (!wrapped) return;
      deps.send(wrapped);
    },
    onServerFrame(frame) {
      const inner = unwrapServerFrame(frame);
      if (!inner) return false;
      const runnerId = (frame as { runnerId: string }).runnerId;
      if (!deps.link.isLinked(runnerId)) {
        // 큐에 담지 않는다 — 입력은 안 보이는 화면에 친 것이고, 재생 요청은 뷰어가 다시 붙으며 다시 온다.
        deps.log(`러너가 없어 버린 서버 프레임: ${frame.type} runnerId=${runnerId}`);
        return false;
      }
      return deps.link.send(runnerId, inner);
    },
    resync() {
      for (const [runnerId, entry] of known) {
        if (!deps.link.isLinked(runnerId)) continue;
        deps.send({
          type: 'runner.announce', runnerId, sessions: [...entry.sessions.values()],
          ...(entry.caps ? { caps: entry.caps } : {}),
        });
      }
    },
    forget(runnerId) { known.delete(runnerId); },
    sessions() {
      const out: AgentSessionView[] = [];
      for (const [runnerId, entry] of known) if (deps.link.isLinked(runnerId)) out.push(...entry.sessions.values());
      return out;
    },
  };
}
