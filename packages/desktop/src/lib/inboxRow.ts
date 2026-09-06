import { readAskMeta, readFailureMeta, readReportMeta, type InboxEntry } from '@murmur/shared';

/**
 * 인박스 줄 하나가 **무슨 말인가**(#488 C2).
 *
 * ## `reason` 으로는 못 가른다
 *
 * 문서의 진단: *"지금 네 줄이 글자 하나까지 똑같다 — `스레드 답글 #general` 넷."*
 * 원인은 `InboxEntry.reason` 의 값이 셋뿐이라는 것이다(`mention`·`thread_reply`·`dm`).
 * 그 셋은 **어떻게 나에게 왔는가**를 말하지 **무슨 말인가**를 말하지 않는다.
 *
 * 말의 종류는 `meta` 에 있다(`AskMeta`·`FailureMeta`·`ReportMeta`). 그것을 읽어야
 * 되물음·선택·보고·실패가 갈린다 — 문서가 "말의 종류가 `meta` 에 들어간 다음 제
 * 모습이 된다"고 적은 그것이다.
 *
 * ## 정렬은 막는 순이다
 *
 * 문서: *"시간순이 아니라 **나를 막는 것 → 읽을 것 → 배경**."* 그래서 종류마다
 * `rank` 를 함께 낸다 — 화면이 그 값으로만 정렬하면 순서 규칙이 한 자리에 모인다.
 */
export type InboxKind = 'ask' | 'failure' | 'report' | 'mention' | 'dm' | 'reply';

export interface InboxRow {
  kind: InboxKind;
  /** 줄 앞의 말표. 종류마다 다른 글자여야 네 줄이 갈린다. */
  label: string;
  /**
   * **낮을수록 먼저**. 나를 막는 것(0) → 읽을 것(1) → 배경(2).
   * 시간은 이 값이 같을 때만 본다 — 문서가 정한 순서다.
   */
  rank: 0 | 1 | 2;
  /**
   * 줄에서 바로 고를 수 있는 선택지. **둘일 때만** 낸다(문서: *"선택지가 둘뿐이면
   * 인박스에서 바로 누른다"*). 셋 이상은 줄이 버튼 밭이 되므로 스레드에서 고른다.
   */
  options: { id: string; label: string }[] | null;
}

/**
 * `meta` 를 읽어 줄의 성격을 정한다. **모르는 `meta` 는 평문으로 흐른다** — 이
 * 저장소의 불변 규약이고, 여기서도 `reason` 이 정한 기본값으로 떨어진다.
 */
export function inboxRow(entry: InboxEntry, myAccountId: string | null): InboxRow {
  const ask = readAskMeta(entry.meta);
  if (ask && ask.answeredWith == null) {
    // **나에게 온 물음만 막는 말이다**(규칙 04). 남에게 간 물음은 읽을 것이다 —
    // 강조가 여러 줄에 뿌려지면 "내 차례"라는 신호가 죽는다.
    const forMe = ask.to.kind === 'human'
      ? myAccountId != null
      : ask.to.accountId === myAccountId;
    return {
      kind: 'ask',
      label: forMe ? '골라 줘' : '고르는 중',
      rank: forMe ? 0 : 1,
      // 셋 이상이면 줄에서 안 고른다 — 줄이 버튼 밭이 된다.
      options: forMe && ask.options.length === 2 ? ask.options : null,
    };
  }

  // 실패는 **항상 사람에게 온다**(`FailureMeta` 에 `to` 가 없는 이유). 나를 막는다.
  if (readFailureMeta(entry.meta)) {
    return { kind: 'failure', label: '막혔다', rank: 0, options: null };
  }

  // 보고는 읽을 것이다 — 끝난 일을 알리는 말이라 나를 막지 않는다.
  if (readReportMeta(entry.meta)) {
    return { kind: 'report', label: '끝냈다', rank: 1, options: null };
  }

  // 여기부터는 `meta` 가 말하지 않는다. **어떻게 왔는가**로 떨어진다.
  if (entry.reason === 'dm') return { kind: 'dm', label: 'DM', rank: 1, options: null };
  if (entry.reason === 'mention') return { kind: 'mention', label: '불렀다', rank: 1, options: null };
  return { kind: 'reply', label: '답글', rank: 2, options: null };
}

/**
 * 문서의 필터 칩 — **정렬 순서를 그대로 쓴다.**
 *
 * 네이티브 `select` 둘과 체크박스가 사라진 자리다(B3). 칩이 정렬과 같은 축을 쓰므로
 * 고르는 것과 보이는 순서가 어긋나지 않는다.
 */
export type InboxFilter = 'blocking' | 'reading' | 'all';

export function matchesFilter(row: InboxRow, filter: InboxFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'blocking') return row.rank === 0;
  return row.rank === 1;
}
