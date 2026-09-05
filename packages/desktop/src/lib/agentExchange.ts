import { readAskMeta, readFailureMeta, type MessageRow } from '@murmur/shared';
import type { Slot } from './progressGroup';

/**
 * 에이전트 둘 사이의 주고받기를 접은 자리(규칙 04 · 계획 Task 5).
 *
 * `Slot` 을 확장하지 않고 별도 타입으로 두는 이유: 진행 접힘(`progressGroup`)과 이 접힘은
 * **묶는 근거가 다르다** — 하나는 "말의 종류"(progress)이고 하나는 "말의 수신자"(에이전트끼리)다.
 * 한 함수에 섞으면 어느 규칙이 어느 줄을 접었는지 나중에 알 수 없다.
 */
export type ExchangeSlot =
  | Slot
  | { kind: 'exchange'; messages: MessageRow[] };

/** 이 계정이 에이전트인가. 모르는 계정은 에이전트로 치지 않는다 — 접으면 안 되는 것을 접느니 안 접는다. */
type IsAgent = (accountId: string) => boolean;

/**
 * 사람이 끼지 않은 **에이전트끼리의 연속 구간**을 한 줄로 접는다.
 *
 * 규칙 04 가 화면에서 만드는 결과다: 에이전트끼리 주고받는 물음도 진행을 막지만 **나를
 * 막지는 않는다.** 접지 않으면 스레드는 정확히 우리가 피하려던 그 로그가 된다 —
 * forge ↔ codex 가 열 번 주고받으면 그 열 번이 그대로 흐른다.
 *
 * ## 접는 조건
 *
 * - 저자가 **전부 에이전트**이고
 * - 서로 **다른 에이전트가 둘 이상** 참여하고(혼잣말은 주고받기가 아니다)
 * - 구간 안에 **사람에게 온 말이 없다**
 *
 * ## 접지 않는 예외 — 사람에게 온 말
 *
 * 구간 안에 수신자가 사람인 선택 요청(`to.kind === 'human'`)이 있으면 **접지 않는다.**
 * 그것은 에이전트끼리의 대화가 아니라 사람을 부르는 말이고, 접으면 "내 차례"가 접힌 줄
 * 뒤로 사라진다 — 규칙 04 가 지키려는 것과 정반대다.
 *
 * **실패도 같은 예외에 든다**(`FailureMeta`). 실패는 언제나 사람에게 오는 말이므로 접으면
 * 사람이 그것을 못 본다 — 에이전트가 먼저 사람을 부르는 유일한 경우다. 두 판정을
 * `blocksHuman` 한 곳에 모아 두어 "사람을 막는가"라는 하나의 질문으로 답하게 한다.
 */
export function groupAgentExchanges(slots: Slot[], isAgent: IsAgent): ExchangeSlot[] {
  const out: ExchangeSlot[] = [];
  let run: MessageRow[] = [];

  /** 모인 구간을 확정한다. 접을 값이 없으면 원래 자리로 되돌린다. */
  const flush = (): void => {
    if (run.length === 0) return;
    const authors = new Set(run.map((m) => m.authorId));
    // 혼잣말은 주고받기가 아니다. 한 줄짜리도 접을 것이 없다 —
    // 접은 줄이 원래 줄보다 길어지면 접는 뜻이 없다.
    if (authors.size >= 2 && run.length >= 2) {
      out.push({ kind: 'exchange', messages: run });
    } else {
      for (const m of run) out.push({ kind: 'message', message: m });
    }
    run = [];
  };

  for (const slot of slots) {
    // 진행 묶음은 이미 접혀 있다 — 그 접힘을 이 접힘이 삼키면 두 규칙이 한 줄에 뭉친다.
    if (slot.kind !== 'message') { flush(); out.push(slot); continue; }
    const m = slot.message;
    if (isAgent(m.authorId) && !blocksHuman(m)) {
      run.push(m);
    } else {
      flush();
      out.push(slot);
    }
  }
  flush();
  return out;
}

/**
 * 이 말이 **사람을 막는가**. 막는다면 에이전트가 쓴 말이라도 접지 않는다 — 사슬의 끝은
 * 언제나 사람이고, 사람을 부르는 말이 접힌 줄 뒤로 사라지면 안 된다.
 *
 * 실패 어휘가 생기면 여기 한 줄이 는다(위 주석 참고).
 */
function blocksHuman(m: MessageRow): boolean {
  // 실패는 언제나 사람에게 오는 말이다 — 접으면 사람이 그것을 못 본다.
  if (readFailureMeta(m.meta) != null) return true;
  const ask = readAskMeta(m.meta);
  // 이미 답한 선택은 더 이상 아무도 막지 않는다 — 기록일 뿐이므로 접혀도 된다.
  return ask != null && ask.answeredWith == null && ask.to.kind === 'human';
}

/** 접힌 줄이 말할 참여자 — 등장 순서를 지킨다(먼저 말한 쪽이 먼저 읽힌다). */
export function exchangeParticipants(messages: MessageRow[]): string[] {
  const seen: string[] = [];
  for (const m of messages) if (!seen.includes(m.authorId)) seen.push(m.authorId);
  return seen;
}
