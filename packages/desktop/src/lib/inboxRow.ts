import { readAskMeta, readFailureMeta, readReportMeta, type InboxEntry } from '@harkroom/shared';
import type { Translate } from '../i18n';

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
 *
 * **번역기가 필수 인자이고 맨 뒤에 온다.** 이 파일은 화면이 아니라 `lib/` 판정이라
 * 훅을 못 쓴다 — `lastTurnAgo`·`daemonFactRows` 가 이미 그 자리를 쓴다. 기본값을 주면
 * 안 넘긴 화면이 조용히 한 언어로 굳고, 앞에 끼우면 인자 자리가 어긋난 채 컴파일이
 * 통과할 수 있다.
 */
export function inboxRow(entry: InboxEntry, myAccountId: string | null, t: Translate): InboxRow {
  const ask = readAskMeta(entry.meta);
  if (ask && ask.answeredWith == null) {
    // **나에게 온 물음만 막는 말이다**(규칙 04). 남에게 간 물음은 읽을 것이다 —
    // 강조가 여러 줄에 뿌려지면 "내 차례"라는 신호가 죽는다.
    const forMe = ask.to.kind === 'human'
      ? myAccountId != null
      : ask.to.accountId === myAccountId;
    return {
      kind: 'ask',
      label: t(forMe ? 'inbox.label.ask' : 'inbox.label.askOther'),
      rank: forMe ? 0 : 1,
      // 셋 이상이면 줄에서 안 고른다 — 줄이 버튼 밭이 된다.
      options: forMe && ask.options.length === 2 ? ask.options : null,
    };
  }

  // 실패는 **항상 사람에게 온다**(`FailureMeta` 에 `to` 가 없는 이유). 나를 막는다.
  if (readFailureMeta(entry.meta)) {
    return { kind: 'failure', label: t('inbox.label.failure'), rank: 0, options: null };
  }

  // 보고는 읽을 것이다 — 끝난 일을 알리는 말이라 나를 막지 않는다.
  if (readReportMeta(entry.meta)) {
    return { kind: 'report', label: t('inbox.label.report'), rank: 1, options: null };
  }

  // 여기부터는 `meta` 가 말하지 않는다. **어떻게 왔는가**로 떨어진다.
  // `DM` 은 안 옮긴다 — **이 제품의 고유어**다(`waitChain.dm` 이 같은 판단을 이미 했다).
  if (entry.reason === 'dm') return { kind: 'dm', label: 'DM', rank: 1, options: null };
  if (entry.reason === 'mention') return { kind: 'mention', label: t('inbox.label.mention'), rank: 1, options: null };
  /**
   * 팀 부름(047) — **부름과 같은 등급이지만 글자가 다르다.** `mention` 으로 뭉치면 팀장이
   * 자기 인박스에서 "이건 팀으로 온 일" 과 "나를 직접 부른 일" 을 구별할 수 없다. 그 둘은
   * 다음에 할 일이 다르다(나눌지 직접 할지).
   *
   * `rank` 는 부름과 같은 1 이다 — 팀 부름도 사람이 나를 지목한 것이고, 순위를 낮추면
   * 팀으로 온 요청이 답글 뒤로 밀린다.
   */
  if (entry.reason === 'team_mention') {
    return { kind: 'mention', label: t('inbox.label.teamMention'), rank: 1, options: null };
  }
  /**
   * 위임 사유 둘(050). **글자를 가르는 이유는 팀 부름과 같다** — 넘겨받은 일과 결말이 온 것은
   * 다음에 할 일이 다르다(하나는 하는 것이고 하나는 취합하는 것이다).
   *
   * `rank` 도 1 이다: 넘겨받은 일은 나를 막는 일이고, 결말은 내가 이어서 해야 하는 일이다.
   * 순위를 낮추면 팀의 일이 남의 스레드 답글 뒤로 밀린다.
   */
  if (entry.reason === 'team_delegated') {
    return { kind: 'mention', label: t('inbox.label.delegated'), rank: 1, options: null };
  }
  if (entry.reason === 'delegation_done') {
    return { kind: 'mention', label: t('inbox.label.delegationDone'), rank: 1, options: null };
  }
  return { kind: 'reply', label: t('inbox.label.reply'), rank: 2, options: null };
}

/**
 * 문서의 필터 칩 — **정렬 순서를 그대로 쓴다.**
 *
 * 네이티브 `select` 둘과 체크박스가 사라진 자리다(B3). 칩이 정렬과 같은 축을 쓰므로
 * 고르는 것과 보이는 순서가 어긋나지 않는다.
 */
export const INBOX_FILTERS = ['blocking', 'unread', 'reading', 'all'] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/**
 * 저장본에서 읽은 값이 **오늘도 있는 칩인가.** 고른 칩을 기기에 남기기 시작한 뒤로
 * (`prefs.inboxStorage`) 이 판정이 필요해졌다 — 칩을 하나 빼거나 이름을 바꾸는 날,
 * 옛 값이 그대로 상태로 들어가면 아무 칩도 선택돼 보이지 않는 화면이 된다(무엇으로
 * 좁혀져 있는지 화면이 말하지 못한다). 모르는 값은 기본값으로 떨어뜨린다.
 */
export function isInboxFilter(value: unknown): value is InboxFilter {
  return typeof value === 'string' && (INBOX_FILTERS as readonly string[]).includes(value);
}

/**
 * `unread` 만 **줄의 종류가 아니라 내 읽음 상태**를 본다. 나머지 셋은 rank 축이다.
 *
 * 축이 둘 섞여 있는 것이 이상해 보이지만, 사람이 인박스에서 묻는 것도 두 가지다 —
 * "무엇이 나를 막나"(rank)와 "무엇이 새로 왔나"(readAt). 뒤엣것을 물을 길이 없어서
 * 238줄 중 무엇이 새 것인지 보이지 않았다. 축을 하나로 맞추자고 새 것을 못 묻게 두는
 * 것보다, 칩 하나가 다른 축이라고 적어 두는 편이 정직하다.
 *
 * `unread` 는 **호출부가 읽음 상태를 넘겨야** 참이 될 수 있다. 기본값을 `false` 로 두어,
 * 그것을 잊은 자리에서 조용히 전부 통과하는 일이 없게 한다(안 넘기면 아무것도 안 맞는다).
 */
export function matchesFilter(row: InboxRow, filter: InboxFilter, isUnread = false): boolean {
  if (filter === 'all') return true;
  if (filter === 'unread') return isUnread;
  if (filter === 'blocking') return row.rank === 0;
  return row.rank === 1;
}
