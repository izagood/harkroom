import {
  mentionedIds, readAskMeta, readFailureMeta, mentionScope, readReportMeta, type MessageRow,
} from '@murmur/shared';
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
 * ## 접지 않는 예외 ① — 사람에게 온 말
 *
 * 구간 안에 수신자가 사람인 선택 요청(`to.kind === 'human'`)이 있으면 **접지 않는다.**
 * 그것은 에이전트끼리의 대화가 아니라 사람을 부르는 말이고, 접으면 "내 차례"가 접힌 줄
 * 뒤로 사라진다 — 규칙 04 가 지키려는 것과 정반대다.
 *
 * **실패도 같은 예외에 든다**(`FailureMeta`). 실패는 언제나 사람에게 오는 말이므로 접으면
 * 사람이 그것을 못 본다 — 에이전트가 먼저 사람을 부르는 유일한 경우다. **본문이 사람
 * 계정을 멘션한 말**도 같다 — 에이전트가 요청자를 이름으로 부른 말은 그 사람에게 온
 * 말이다. 세 판정을 `addressesHuman` 한 곳에 모아 두어 "이 말이 사람에게 오는가"라는
 * 하나의 질문으로 답하게 한다.
 *
 * ## 접지 않는 예외 ② — 사람이 부른 뒤 각 에이전트의 첫 답
 *
 * 이 예외가 없어서 실제로 답이 사라졌다(2026-09-08 실측). 사람이 한 스레드에서 에이전트
 * 넷을 부르면 넷이 각자 **사람에게** 답하는데, 그 넷이 연속이고 저자가 전부 에이전트라
 * 위 조건에 그대로 걸려 `avcs ↔ avcs-server ↔ avcshub ↔ murmur · 12번 주고받음 · 펼치기`
 * 한 줄로 접혔다. 화면에 남은 글자가 문자 그대로 "에이전트끼리 대화했다" 였고, 정밀 검토
 * 다섯 건이 전부 그 줄 뒤에 있었다.
 *
 * 원인은 판정에 **수신자가 없었다**는 것이다. 저자만 보면 "나에게 온 답"과 "자기들끼리 한
 * 말"이 같은 값이 된다. 그래서 사람의 발화를 기준선으로 둔다:
 *
 * > **사람이 말한 뒤, 각 에이전트의 첫 발화는 접지 않는다.** 같은 에이전트의 두 번째
 * > 발화부터, 그리고 그 뒤 에이전트끼리 주고받는 말은 접는다.
 *
 * 이 규칙이 규칙 04 의 원래 의도를 그대로 적은 것이다 — **나에게 온 답은 내 것이고, 그
 * 뒤 자기들끼리 하는 말은 그들 것이다.**
 *
 * 왜 "사람이 부른 에이전트"(사람 발화의 멘션)로 좁히지 않는가: 화면은 `@channel` 과 집합
 * (`@team`)을 펼칠 수 없다 — 그 명단은 서버에만 있다. 멘션으로 재면 그 두 경로의 답이
 * 다시 조용히 접히고, 그것은 지금 고치는 결함과 같은 종류다. 대신 사람이 말한 적이
 * **없으면** 이 예외는 아예 켜지지 않는다(`turnOpen`) — 그래야 사람 없이 흐르는
 * 에이전트끼리의 로그가 예전대로 접힌다.
 *
 * 이 예외가 틀리는 방향은 **너무 많이 보여 주는 쪽**이다(사람이 "고맙다"만 써도 그 뒤 첫
 * 발화들이 펼쳐진다). 이 파일이 이미 택한 방향이 그쪽이다 — *접으면 안 되는 것을 접느니
 * 안 접는다*.
 */
export function groupAgentExchanges(slots: Slot[], isAgent: IsAgent): ExchangeSlot[] {
  const out: ExchangeSlot[] = [];
  let run: MessageRow[] = [];

  /**
   * 사람이 이 목록에서 말한 적이 있는가. 예외 ②는 이것이 참일 때만 켜진다 — 기준선이
   * 없으면 "답"이라고 부를 대상이 없다.
   */
  let turnOpen = false;
  /** 사람이 마지막으로 말한 뒤 이미 답한 에이전트. 첫 답만 예외로 빼기 위한 장부다. */
  const answered = new Set<string>();

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
    //
    // 진행은 **사람의 차례를 닫지 않는다**: 에이전트가 일하는 중이라는 말이고, 그 뒤에 오는
    // 결과 발화가 여전히 사람에게 온 첫 답이다. 그래서 `answered` 를 비우지 않는다.
    if (slot.kind !== 'message') { flush(); out.push(slot); continue; }
    const m = slot.message;

    // 사람의 발화 — 새 기준선이다. 앞의 구간을 닫고 장부를 비운다.
    if (!isAgent(m.authorId)) {
      flush();
      turnOpen = true;
      answered.clear();
      out.push(slot);
      continue;
    }

    // 예외 ① 사람에게 오는 말, 예외 ② 사람이 부른 뒤 이 에이전트의 첫 발화.
    const firstAnswer = turnOpen && !answered.has(m.authorId);
    if (addressesHuman(m, isAgent) || firstAnswer) {
      flush();
      answered.add(m.authorId);
      out.push(slot);
      continue;
    }

    run.push(m);
  }
  flush();
  return out;
}

/**
 * 이 말이 **사람에게 오는가**. 온다면 에이전트가 쓴 말이라도 접지 않는다 — 사슬의 끝은
 * 언제나 사람이고, 사람에게 온 말이 접힌 줄 뒤로 사라지면 안 된다.
 *
 * 판정이 셋이다:
 * - **실패**는 언제나 사람에게 오는 말이다 — 접으면 사람이 그것을 못 본다.
 * - **사람에게 온 미답 선택**은 사람의 차례다. 이미 답한 선택은 기록일 뿐이라 접혀도 된다.
 * - **본문이 사람 계정을 멘션한 말**은 그 사람을 이름으로 부른 것이다. 에이전트가 요청자를
 *   `@handle` 로 부르며 쓴 답이 여기 걸린다(`packages/agent/src/prompt.ts` 가 그렇게 쓰라고
 *   지시한다 — 이 판정과 그 지시가 한 쌍이다).
 *
 * 멘션 판정을 서버와 같은 규칙으로 한다: `mentionScope` 를 먼저 거쳐 **코드·인용 안의 토큰은
 * 부름이 아니다**(#298). 그래야 코드를 인용한 말이 "사람을 불렀다"로 오인되지 않는다.
 *
 * `isAgent` 가 모르는 계정은 에이전트로 치지 않으므로 사람 쪽으로 센다 — 이 파일이 택한
 * 방향(접으면 안 되는 것을 접느니 안 접는다)과 같다.
 */
function addressesHuman(m: MessageRow, isAgent: IsAgent): boolean {
  // 실패는 언제나 사람에게 오는 말이다 — 접으면 사람이 그것을 못 본다.
  if (readFailureMeta(m.meta) != null) return true;
  const ask = readAskMeta(m.meta);
  // 이미 답한 선택은 더 이상 아무도 막지 않는다 — 기록일 뿐이므로 접혀도 된다.
  if (ask != null && ask.answeredWith == null && ask.to.kind === 'human') return true;
  // 자기 자신을 부른 것은 사람을 부른 것이 아니다(에이전트가 제 handle 을 인용할 수 있다).
  return mentionedIds(mentionScope(m.body)).some((id) => id !== m.authorId && !isAgent(id));
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
 * `FailureMeta` 를 보지 않는 것은 누락이 아니다 — 실패가 있는 구간은 `addressesHuman` 이
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
