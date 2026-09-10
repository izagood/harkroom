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
import type { AgentSessionView, AgentWakeView, MessageRow } from '@murmur/shared';
import { getController } from '../state/controller';
import { bodyWithHandles } from './mention';

export type AgentTurnsSnapshot =
  /** 첫 답이 아직 안 왔다. 빈 목록과 **다르다.** */
  | { kind: 'checking' }
  | { kind: 'known'; turns: AgentSessionView[] }
  /** 물었지만 답을 못 받았다. `reason` 은 서버·전송이 쓴 문구를 그대로 옮긴다. */
  | { kind: 'unknown'; reason: string };

/** 물어보는 주기. 턴은 26초짜리도 흔해서 이보다 길면 목록이 계속 헛것을 보인다. */
export const AGENT_TURNS_POLL_MS = 5_000;

/**
 * 구독자들이 **한 폴러를 나눠 쓴다.** 이 훅을 부르는 곳이 둘이 된 순간(패널의 요약과
 * 본문 관제탑) 각자 5초 타이머를 갖는 구조는 같은 요청을 두 번 내고, 두 화면이 서로 다른
 * 순간의 목록을 보인다 — 한 화면에서 `2개`, 옆에서 `3개` 가 서면 사람은 어느 쪽을 믿을지
 * 고르게 된다. 폴러를 모듈에 두면 두 자리가 **같은 답**을 그린다.
 *
 * 마지막 구독자가 떠날 때 답을 **버린다**(`checking` 으로 되돌린다). 남겨 두면 칸을 다시
 * 열었을 때 몇 분 전 숫자가 먼저 서고, 그 숫자는 "지금 도는 턴"이라는 이 칸의 물음에
 * 거짓으로 답한다 — 이 파일이 `0` 과 `모름`을 가르는 이유와 같은 규율이다.
 */
const listeners = new Set<(snapshot: AgentTurnsSnapshot) => void>();
let shared: AgentTurnsSnapshot = { kind: 'checking' };
let timer: ReturnType<typeof setInterval> | null = null;

async function askOnce(): Promise<void> {
  try {
    // 컨트롤러에서 그때그때 꺼낸다 — 훅 바깥에 잡아 두면 로그아웃·커뮤니티 전환으로
    // 클라이언트가 갈릴 때 옛 토큰으로 계속 묻는다.
    shared = { kind: 'known', turns: await getController().api.agentSessions() };
  } catch (err) {
    // **여기서 사유를 지어내지 않는다.** 화면이 원인을 만들면 사람은 러너 로그를 볼
    // 이유를 잃는다(`RunnerStatus` 가 종료 코드를 그대로 보이는 것과 같은 규칙).
    shared = { kind: 'unknown', reason: err instanceof Error ? err.message : String(err) };
  }
  for (const listener of listeners) listener(shared);
}

export function useAgentTurns(enabled: boolean): AgentTurnsSnapshot {
  const [snapshot, setSnapshot] = useState<AgentTurnsSnapshot>(shared);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setSnapshot);
    setSnapshot(shared);
    if (!timer) {
      void askOnce();
      timer = setInterval(() => { void askOnce(); }, AGENT_TURNS_POLL_MS);
    }
    return () => {
      listeners.delete(setSnapshot);
      if (listeners.size || !timer) return;
      clearInterval(timer);
      timer = null;
      shared = { kind: 'checking' };
    };
  }, [enabled]);
  return enabled ? snapshot : { kind: 'checking' };
}

/**
 * **아직 오지 않은 깨움**(Agents 관제 4단계 — 대기). 위 폴러의 쌍둥이다.
 *
 * 왜 세션 목록과 **한 요청으로 묶지 않는가**: 두 사실의 신뢰도가 다르다. 세션은 러너
 * 메모리에서 오므로 릴레이가 끊기면 알 수 없지만, 깨움은 테이블에서 와 **언제나 알 수
 * 있다.** 한 스냅샷으로 묶으면 한쪽이 실패한 순간 다른 쪽까지 `unknown` 이 되어, 정작
 * 사람이 그때 알고 싶은 것("도는 턴은 모르지만 기다리는 것은 둘 있다")을 잃는다.
 *
 * 제네릭으로 합치지 않은 이유는 스냅샷이 **자기 짐의 이름을 갖기** 때문이다(`turns`·
 * `wakes`). 공통 `value` 로 바꾸면 부르는 곳마다 그 이름이 사라져, 25줄을 아끼고 화면
 * 코드 전부를 읽기 어렵게 만든다.
 */
export type AgentWakesSnapshot =
  | { kind: 'checking' }
  | { kind: 'known'; wakes: AgentWakeView[] }
  | { kind: 'unknown'; reason: string };

const wakeListeners = new Set<(snapshot: AgentWakesSnapshot) => void>();
let sharedWakes: AgentWakesSnapshot = { kind: 'checking' };
let wakeTimer: ReturnType<typeof setInterval> | null = null;

async function askWakes(): Promise<void> {
  try {
    sharedWakes = { kind: 'known', wakes: await getController().api.agentWakes() };
  } catch (err) {
    sharedWakes = { kind: 'unknown', reason: err instanceof Error ? err.message : String(err) };
  }
  for (const listener of wakeListeners) listener(sharedWakes);
}

export function useAgentWakes(enabled: boolean): AgentWakesSnapshot {
  const [snapshot, setSnapshot] = useState<AgentWakesSnapshot>(sharedWakes);
  useEffect(() => {
    if (!enabled) return;
    wakeListeners.add(setSnapshot);
    setSnapshot(sharedWakes);
    if (!wakeTimer) {
      void askWakes();
      wakeTimer = setInterval(() => { void askWakes(); }, AGENT_TURNS_POLL_MS);
    }
    return () => {
      wakeListeners.delete(setSnapshot);
      if (wakeListeners.size || !wakeTimer) return;
      clearInterval(wakeTimer);
      wakeTimer = null;
      sharedWakes = { kind: 'checking' };
    };
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

/**
 * 묶음 머리에 **스레드 이름**을 세우기 위해 루트 메시지를 받아 둔다.
 *
 * 처음 판에서 묶음 머리는 채널 이름(`#murmur`)뿐이었다. 그런데 이 목록이 스레드로 묶는
 * 이유는 *"중단의 단위가 스레드"* 라는 것이었고, 그렇게 말해 놓고 화면은 채널만 말했다 —
 * 한 채널에서 두 스레드가 돌면 두 묶음이 **똑같은 이름**으로 서서, 무엇을 멈추는지 보고
 * 누르라는 규칙(확인 겹창을 스레드 단위에 두지 않은 근거)이 성립하지 않았다.
 *
 * 캐시는 **모듈 단위**다: 목록은 5초마다 새로 오지만 스레드 루트의 첫 줄은 바뀌지 않는다
 * (수정되면 다음에 칸을 다시 열 때 따라온다). 못 받은 id 도 기억한다 — 권한이 없거나
 * 지워진 메시지를 5초마다 다시 묻지 않기 위해서다.
 */
const roots = new Map<string, MessageRow | null>();

export function useThreadRoots(rootIds: readonly (string | null)[]): Map<string, MessageRow> {
  // 의존성은 **id 목록의 값**이어야 한다 — 배열 자체는 렌더마다 새로 만들어지므로
  // 그것을 의존성에 두면 5초마다 같은 루트를 다시 묻는다.
  const key = [...new Set(rootIds.filter((id): id is string => !!id))].sort().join(',');
  const [, bump] = useState(0);
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    const missing = ids.filter((id) => !roots.has(id));
    if (!missing.length) return;
    let disposed = false;
    void (async () => {
      const api = getController().api;
      await Promise.all(missing.map(async (id) => {
        try { roots.set(id, await api.message(id)); } catch { roots.set(id, null); }
      }));
      if (!disposed) bump((n) => n + 1);
    })();
    return () => { disposed = true; };
  }, [key]);

  const known = new Map<string, MessageRow>();
  for (const id of key ? key.split(',') : []) {
    const row = roots.get(id);
    if (row) known.set(id, row);
  }
  return known;
}

/**
 * 스레드 루트의 **첫 줄**을 이름으로 쓴다.
 *
 * `AgentSessionView` 에는 *"이 턴이 무슨 일을 하는가"* 가 없다(러너가 싣지 않는다). 그래서
 * 화면은 자기가 아는 것만 말한다 — **스레드의 첫 줄**이다. 그것을 턴의 일이라고 적지
 * 않는 이유가 여기 있다: 그 스레드에서 도는 턴이 첫 줄과 다른 일을 하고 있을 수 있고,
 * 화면이 확인한 적 없는 것을 단언하면 사람은 목록을 더 이상 믿지 않는다.
 *
 * `<@id>` 는 반드시 `bodyWithHandles` 를 지난다 — 안 지나면 제목 자리에 uuid 가 뜬다(#271).
 */
export function threadTitle(row: MessageRow, accounts: Record<string, { handle: string }>): string | null {
  const lines = bodyWithHandles(row.body, accounts).split('\n');
  for (const line of lines) {
    // 인용 줄(`>`)·머리표(`#`)·목록표(`-`)를 걷어낸 첫 줄. 붙여넣은 인용으로 시작하는
    // 스레드가 흔하고, 그때 `> @murmur …` 를 제목으로 세우면 죄다 같은 모양이 된다.
    const bare = line.replace(/^[>#\-*\s]+/, '').trim();
    // **부른 이름은 제목이 아니다.** 스레드 첫 줄은 거의 언제나 `@handle` 로 시작하고,
    // 그 이름은 같은 줄의 턴 쪽에 이미 서 있다 — 남겨 두면 묶음 이름 열이 전부 `@…` 로
    // 시작해 정작 일이 무엇인지가 오른쪽으로 밀린다. handle 글자만 걷어낸다:
    // 모르는 계정은 `@알 수 없음`(공백이 있다)이 되므로 `@\S+` 로 자르면 말이 잘린다.
    const text = bare.replace(/^(?:@[A-Za-z0-9_-]+[\s,]*)+/, '').trim() || bare;
    if (text) return text.length > 120 ? `${text.slice(0, 119)}\u2026` : text;
  }
  return null;
}
