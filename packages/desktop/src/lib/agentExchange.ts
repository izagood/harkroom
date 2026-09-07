import { readAskMeta, readFailureMeta, readReportMeta, type MessageRow } from '@murmur/shared';
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

/**
 * 결론 글자 수의 상한. 넘으면 `…` 로 자른다.
 *
 * **40 자를 고른 근거**(실측): 접힌 줄은 참여자(`forge ↔ codex` — handle 두 개 + 화살표,
 * 대략 15~25 자)와 `· 12번 주고받음 · 마지막 오후 12:57`(대략 25 자)을 이미 싣는다. 스레드
 * 패널의 폭은 채널 패널보다 좁고, 11px 로 그 폭에 들어가는 글자는 90 자 안쪽이다. 40 자면
 * 참여자·횟수를 밀어내지 않고 남는 자리를 다 쓴다.
 *
 * **왜 CSS `truncate` 만으로 두지 않는가:** 이 저장소의 관례는 *"자르는 폭은 화면이
 * 정한다"*(`Inbox.tsx`)이고 실제로 대부분 `truncate` 다. 여기는 다르다 — 결론은 **줄 하나를
 * 혼자 쓰지 않고** 횟수·시각과 같은 줄을 나눠 쓴다. flex 안에서 `truncate` 에만 맡기면
 * 결론이 긴 구간에서 뒤의 횟수·시각이 0 폭까지 밀려 사라지고, 문서가 *"횟수는 그 뒤에 붙는
 * 부수적인 숫자다"* 라고 한 그 숫자가 없어진다. 그래서 **글자 수로 먼저 재고**(여기)
 * 그래도 넘치는 경우를 `truncate` 가 받는다(화면). 두 겹인 것이 의도다.
 */
export const EXCHANGE_CONCLUSION_MAX = 40;

/**
 * 접힌 구간의 **결론** — 둘이 주고받아 무엇이 정해졌는가.
 *
 * `source` 를 함께 내는 이유: 화면이 결론 앞에 붙일 말(`정했다`·`끝냈다`)을 고르는 데
 * 쓴다. 판정은 여기 한 곳에서 하고 화면은 그린다 — `inboxRow` 가 인박스 줄에 대해
 * 같은 모양을 갖고 있고, `threadState` 를 순수 함수로 뽑은 것과 같은 이유다.
 */
export interface ExchangeConclusion {
  source: 'ask' | 'report';
  text: string;
}

/**
 * 접힌 구간이 **무엇을 정했는지** 낸다(#488 C1).
 *
 * 문서의 진단: *"컨셉의 '접힘'이 구현돼 있는 셈인데, 말하는 것은 횟수뿐이다. 답글 스택에서
 * 이름 나열을 버린 이유와 같은 문제다 — '열어야 하나'에 답하지 않는다."* 처방: *"접힌 줄은
 * 결론을 담는다. 둘이 주고받아 무엇이 정해졌는지가 접힘의 값이다."*
 *
 * ## 새 어휘를 만들지 않는다
 *
 * 문서의 실행 순서는 C1 앞에 *"`meta` 에 말의 종류"* 를 문턱으로 뒀고 **그 문턱은 이미
 * 넘었다** — `AskMeta`·`FailureMeta`·`ReportMeta` 가 shared 에 있고 `inboxRow` 가 그것으로
 * 인박스 네 줄을 갈랐다(C2). 그래서 결론도 그 둘에서 나온다:
 *
 * - **답한 선택**(`AskMeta.answeredWith`) → 고른 옵션의 `label`. 에이전트끼리 갈림길에서
 *   하나를 고른 것이 정확히 "무엇이 정해졌는지"다. `AskCard` 가 답한 카드의 머리글을
 *   `정해졌다` 로 그리는 그 사실을 접힌 줄에서도 쓴다
 * - **완료 보고**(`ReportMeta.checks[0]`) → 확인한 것의 첫 줄. `checks` 는 보고의 **유일한
 *   필수 항목**이고(*"무엇을 확인했는지 없는 보고는 보고가 아니다"*), 그중 첫 줄이 그
 *   구간의 성과다
 *
 * `files`·`remaining` 을 쓰지 않는 이유: 경로는 결론이 아니라 증거이고(`ReportCard` 도
 * 그것만 고정폭으로 따로 그린다), `remaining` 은 **닫지 못한 것**이라 결론과 반대말이다.
 *
 * ## 실패는 여기 오지 않는다
 *
 * `FailureMeta` 를 보지 않는 것은 누락이 아니다 — 실패가 있는 구간은 `blocksHuman` 이
 * **애초에 접지 않는다**. 여기서 실패를 읽으면 그 판정이 두 벌이 되고, 접히지도 않는 말의
 * 결론을 계산하는 죽은 가지가 남는다.
 *
 * ## 마지막에 정해진 것이 이긴다
 *
 * 뒤에서부터 훑는다. 한 구간 안에 답한 선택과 보고가 둘 다 있으면 **나중 것**이 결론이다 —
 * 앞의 결정 위에 뒤의 결정이 쌓이므로, 앞을 말하면 이미 지난 사실을 말하는 것이 된다.
 *
 * ## 없으면 `null` 이다
 *
 * 주고받기만 있고 아무것도 정해지지 않은 구간이 실제로 있다(서로 자리를 나누기만 한 경우).
 * 그때 본문 첫 줄을 결론처럼 싣지 **않는다** — 그것은 결론이 아니라 마지막 발언이고,
 * "정해졌다"는 거짓 신호를 준다. 빈 상자를 그리지 않는 이 저장소의 규약과 같은 태도다.
 * 화면은 `null` 을 받아 "아직 정해진 것 없음"으로 그린다.
 */
export function exchangeConclusion(messages: MessageRow[]): ExchangeConclusion | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;

    const ask = readAskMeta(m.meta);
    if (ask?.answeredWith != null) {
      const chosen = ask.options.find((o) => o.id === ask.answeredWith);
      // 고른 `id` 가 옵션에 없으면 무엇으로 정해졌는지 말할 수 없다 — 옛 서버나 손으로 쓴
      // meta 가 그럴 수 있고, 그때는 결론이 없는 것으로 친다(모르는 것을 지어내지 않는다).
      if (chosen) return { source: 'ask', text: clamp(chosen.label) };
    }

    const report = readReportMeta(m.meta);
    // `readReportMeta` 가 `checks` 가 비면 null 을 주므로 `[0]` 은 항상 있다.
    if (report) return { source: 'report', text: clamp(report.checks[0]!) };
  }
  return null;
}

/**
 * 한 줄로 만들고 상한에서 자른다.
 *
 * 줄바꿈을 먼저 없애는 이유: `checks` 한 항목이 여러 줄일 수 있고(에이전트가 발행하는
 * 문자열이므로 형식을 믿을 수 없다), 그대로 넣으면 접힌 "한 줄"이 두 줄이 된다.
 */
function clamp(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCHANGE_CONCLUSION_MAX
    ? `${flat.slice(0, EXCHANGE_CONCLUSION_MAX)}…`
    : flat;
}
