/**
 * 스레드 상태 리액션(D안) — 스레드 루트에 **하나만** 달리는, 서버가 정하는 상태 표시.
 *
 * 왜 서버가 정하는가: 에이전트가 직접 달게 하면 "러너가 죽었다"·"답 없이 끝났다"처럼 에이전트
 * 스스로 말할 수 없는 상태가 빠지고, 판정이 여러 자리에 있으면 갈라진다. 그래서 판정은 이
 * 순수 함수 하나이고, 서버가 사실(`ThreadStatusFacts`)을 모아 이것을 지난다.
 *
 * 왜 사람 리액션과 섞지 않는가: 리액션은 메시지 단위이고 누가 달았는지(accountId)만으로는
 * 상태 표시와 사람 ✅ 를 가를 수 없다(에이전트도 `message.react` 로 단다). 그래서 상태는
 * `message_reaction` 이 아니라 따로 저장하고(`thread_status`), 행에 `statusReaction` 으로
 * 싣는다 — 화면은 이것을 맨 앞에 숫자 없이 그리고, 누르면 토글되지 않는다. Inbox 의
 * "✅ = 치움" 집계는 `reactions` 만 보므로 상태 ✅ 는 처음부터 거기 섞이지 않는다.
 *
 * 화면의 `threadState()`(desktop `lib/threadState.ts`)와의 관계: 그쪽은 **보는 사람 기준**
 * (내 차례 / 남을 기다림)이고, 이것은 **스레드 기준**이다 — 사람에게 간 미답 물음이면 누가
 * 보든 🙋 다. 우선순위(내 차례 > 막힘 > 기다림 > 도는 중 > 끝남)와 실패 해소 규칙은 같다.
 */
export type ThreadStatus = 'received' | 'running' | 'waiting' | 'my-turn' | 'stuck' | 'done';

export const THREAD_STATUS_EMOJI: Record<ThreadStatus, string> = {
  received: '👀',
  running: '💬',
  waiting: '⏳',
  'my-turn': '🙋',
  stuck: '🚨',
  done: '✅',
};

/** 행에 실리는 상태 리액션. 없으면(에이전트가 한 번도 끼지 않은 스레드) `null`. */
export interface ThreadStatusReaction {
  status: ThreadStatus;
  emoji: string;
  /** 이 상태의 주인 에이전트(묻는 쪽·실패한 쪽·도는 쪽). 모르면 `null`. */
  accountId: string | null;
  /** 마우스를 올리면 보이는 이유 — ask 물음·fail 사유·기다리는 상대. 없으면 `null`. */
  reason: string | null;
  updatedAt: string;
}

/** 서버가 SQL 과 presence 로 모은 사실. 판정은 하지 않는다. */
export interface ThreadStatusFacts {
  /** 사람(아무나 또는 특정 사람)에게 간 가장 오래된 미답 물음. */
  humanAsk: { askerId: string; prompt: string | null } | null;
  /** 안 풀린 가장 최근 실패. */
  failure: { accountId: string; what: string | null } | null;
  /** 가장 최근 말에 실린 막힌 부름(`mentionDenied`·`mentionChainCapped`) — 그 뒤에 말이 없을 때만. */
  deniedMention: { authorId: string; targets: string[] } | null;
  /** 에이전트에게 간 미답 물음·열린 위임. */
  agentWait: { waiterId: string; blockedById: string | null } | null;
  /** 아직 울리지 않은 깨움 예약. */
  openWake: { accountId: string; wakeAt: string } | null;
  /** 배달됐지만 아직 읽지 않은 에이전트 앞 멘션. */
  pendingMention: { agentId: string } | null;
  /** 스레드의 마지막 말. */
  last: { kind: string; authorId: string; authorIsAgent: boolean } | null;
  /** 스레드에 에이전트가 한 번이라도 말했거나 불렸는가. 아니면 상태를 달지 않는다. */
  agentInvolved: boolean;
}

export interface ThreadStatusDecision {
  status: ThreadStatus;
  accountId: string | null;
  reason: string | null;
}

/**
 * 판정. **위에서부터 이긴다** — 하나의 스레드는 한 상태만 받는다.
 *
 * 1. 🙋 사람에게 간 미답 물음 — 답 한 번으로 풀리므로 가장 세다(`threadState` 와 같은 이유)
 * 2. 🚨 안 풀린 실패 · 막힌 부름 · 마지막 말이 진행인데 그 에이전트가 죽었다
 * 3. ⏳ 에이전트를 기다리는 물음·위임 · 열린 깨움
 * 4. 💬 마지막 말이 진행이고 그 에이전트가 살아 있다(모르면 살아 있다고 둔다)
 * 5. 👀 배달됐지만 아직 아무 말 없는 멘션
 * 6. ✅ 그 외 — 에이전트가 낀 스레드에서 열린 것이 없다
 *
 * `live` 가 `null` 이면 '모른다'다 — 모른다는 이유로 붉게 칠하지 않는다.
 */
export function decideThreadStatus(f: ThreadStatusFacts, live: ReadonlySet<string> | null): ThreadStatusDecision | null {
  if (!f.agentInvolved) return null;
  if (f.humanAsk) return { status: 'my-turn', accountId: f.humanAsk.askerId, reason: f.humanAsk.prompt };
  if (f.failure) return { status: 'stuck', accountId: f.failure.accountId, reason: f.failure.what };
  if (f.deniedMention) {
    return { status: 'stuck', accountId: f.deniedMention.authorId, reason: f.deniedMention.targets.join(', ') || null };
  }
  const lastProgress = f.last && f.last.authorIsAgent && (f.last.kind === 'progress') ? f.last.authorId : null;
  if (lastProgress && live !== null && !live.has(lastProgress) && !f.openWake && !f.agentWait) {
    return { status: 'stuck', accountId: lastProgress, reason: null };
  }
  if (f.agentWait) return { status: 'waiting', accountId: f.agentWait.waiterId, reason: f.agentWait.blockedById };
  if (f.openWake) return { status: 'waiting', accountId: f.openWake.accountId, reason: f.openWake.wakeAt };
  if (lastProgress) return { status: 'running', accountId: lastProgress, reason: null };
  if (f.pendingMention) return { status: 'received', accountId: f.pendingMention.agentId, reason: null };
  const lastAgent = f.last && f.last.authorIsAgent ? f.last.authorId : null;
  return { status: 'done', accountId: lastAgent, reason: null };
}
