/**
 * "지금 도는 턴"을 서버에 물어 오는 자리(Agents 관제 1단계).
 *
 * ## 왜 새 데이터가 아니라 새 화면인가
 *
 * 서버는 이미 이 사실을 쥐고 있다 — 멘션 턴은 시작할 때 릴레이 세션을 열고
 * (`agent/src/mentionTurn.ts`), `GET /agent-sessions` 가 그 목록을 권한대로 돌려준다
 * (admin 은 전체, 그 외는 자기가 소유한 에이전트만). 그런데 그것을 부르는 곳이 지금까지
 * **터미널 패널 하나뿐**이었고(창 열 때 1회), 그래서 사람은 한 스레드에서 에이전트가
 * 몇 개나 돌고 있는지 알 방법이 없었다. 빠진 것은 데이터가 아니라 묻는 화면이다.
 *
 * ## 폴링인 이유 — 그리고 이것이 임시라는 사실
 *
 * 세션이 열리고 닫히는 사실은 서버가 릴레이에서 **이미 알고 있지만**, 그것을 데스크탑으로
 * 밀어 주는 이벤트가 아직 없다. 그 이벤트를 내는 것이 이 개편의 다음 단계이고, 여기서는
 * 그 전에 사람이 볼 수 있게 하는 것이 목적이라 주기적으로 묻는다. 주기를 짧게 잡지 않는
 * 이유: 이 요청은 러너 수와 무관한 고정 비용이지만, 사람이 이 칸을 보고 있지 않을 때는
 * 그 비용조차 낼 이유가 없다 — 그래서 `enabled` 가 거짓이면 **한 번도 묻지 않는다.**
 *
 * ## 모르는 것을 0 으로 말하지 않는다
 *
 * 이 훅의 상태가 셋인 이유가 그것이다. `known` 은 물어서 받은 답이고, `unknown` 은
 * **물었지만 답을 못 받은** 상태다 — 그 둘을 같은 모양으로 그리면 "도는 턴 0개"가
 * 화면에 서고, 사람은 폭주가 멈춘 줄 안다. `checking` 은 첫 답이 오기 전이다.
 *
 * 답을 받았어도 그 목록은 **러너가 릴레이로 알려 준 것**까지다: 릴레이가 끊긴 러너의 턴은
 * 목록에 없다. 화면은 그 범위를 한 줄로 적어야 한다(`AgentTurns` 의 주석 참고) —
 * 서버가 러너별 릴레이 연결 여부를 내주면 그때 "끊겼다"를 단언할 수 있고, 그것은 이
 * 단계의 범위가 아니다.
 */
import { useEffect, useState } from 'react';
import type { AgentSessionView } from '@murmur/shared';
import { getController } from '../state/controller';

export type AgentTurnsSnapshot =
  /** 첫 답이 아직 안 왔다. 빈 목록과 **다르다.** */
  | { kind: 'checking' }
  | { kind: 'known'; turns: AgentSessionView[] }
  /** 물었지만 답을 못 받았다. `reason` 은 서버·전송이 쓴 문구를 그대로 옮긴다. */
  | { kind: 'unknown'; reason: string };

/** 물어보는 주기. 턴은 26초짜리도 흔해서 이보다 길면 목록이 계속 헛것을 보인다. */
export const AGENT_TURNS_POLL_MS = 5_000;

export function useAgentTurns(enabled: boolean): AgentTurnsSnapshot {
  const [snapshot, setSnapshot] = useState<AgentTurnsSnapshot>({ kind: 'checking' });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const ask = async (): Promise<void> => {
      try {
        // 컨트롤러에서 그때그때 꺼낸다 — 훅 바깥에 잡아 두면 로그아웃·커뮤니티 전환으로
        // 클라이언트가 갈릴 때 옛 토큰으로 계속 묻는다.
        const turns = await getController().api.agentSessions();
        if (!disposed) setSnapshot({ kind: 'known', turns });
      } catch (err) {
        if (disposed) return;
        // **여기서 사유를 지어내지 않는다.** 화면이 원인을 만들면 사람은 러너 로그를 볼
        // 이유를 잃는다(`RunnerStatus` 가 종료 코드를 그대로 보이는 것과 같은 규칙).
        setSnapshot({ kind: 'unknown', reason: err instanceof Error ? err.message : String(err) });
      }
    };
    void ask();
    const timer = setInterval(() => { void ask(); }, AGENT_TURNS_POLL_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [enabled]);
  return enabled ? snapshot : { kind: 'checking' };
}

/** 한 스레드에서 도는 턴들. 목록의 묶음 단위가 스레드인 이유는 `AgentTurns` 주석에 있다. */
export interface AgentTurnGroup {
  channelId: string;
  /** 러너가 말하지 않으면 `null` 이다 — 그 묶음은 눌러도 갈 곳이 없다. */
  threadRootId: string | null;
  turns: AgentSessionView[];
}

/**
 * 스레드로 묶는다. 순서는 **오래된 턴이 있는 묶음이 먼저** — 폭주는 오래 도는 쪽에서
 * 시작되고, 사람이 먼저 봐야 하는 것이 그것이다. 묶음 안은 시작 순서다.
 */
export function groupTurnsByThread(turns: readonly AgentSessionView[]): AgentTurnGroup[] {
  const groups = new Map<string, AgentTurnGroup>();
  for (const turn of turns) {
    const key = `${turn.channelId}/${turn.threadRootId ?? '_root'}`;
    const group = groups.get(key)
      ?? { channelId: turn.channelId, threadRootId: turn.threadRootId, turns: [] };
    group.turns.push(turn);
    groups.set(key, group);
  }
  const startedAt = (g: AgentTurnGroup): number =>
    Math.min(...g.turns.map((t) => Date.parse(t.startedAt) || Number.MAX_SAFE_INTEGER));
  for (const group of groups.values()) {
    group.turns.sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
  }
  return [...groups.values()].sort((a, b) => startedAt(a) - startedAt(b));
}
