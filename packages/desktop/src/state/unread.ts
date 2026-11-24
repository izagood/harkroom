import { notifyLevelOf, type NotifyLevel } from '@harkroom/shared';

/**
 * 미읽음을 **두 가지 신호**로 읽는 규칙. 사이드바가 이미 이 둘을 나눠 그리고 있고
 * (`Sidebar.tsx` 의 `UnreadBadge` · `ChannelUnreadDot`), 그 주석이 이유를 적었다:
 * 멘션은 *"당신을 불렀다"*(빨간 숫자), 미읽음은 *"새 대화가 있다"*(작은 점) —
 * 한 자리에 섞으면 빨간 배지가 뜻을 잃는다.
 *
 * 규칙을 순수 함수로 꺼내 두는 이유는 **읽는 곳이 셋**이 되었기 때문이다: 레일 홈 배지,
 * 사이드바, 그리고 독(Dock) 배지(`lib/useDockBadge.ts`). 한 곳이라도 자기 식으로 세면
 * 화면의 숫자와 독의 숫자가 갈라지고, 그때 사람이 믿는 것은 둘 중 아무것도 아니게 된다.
 */

/**
 * 숫자로 셀 것은 없지만 **새 대화가 있는가**. 사이드바의 회색 점과 같은 근거
 * (`reads[channelId].unread`)를 쓴다 — 그 점이 켜져 있는데 독이 아무 말도 하지 않으면,
 * 앱을 열어 보기 전까지는 새 대화가 있다는 사실을 알 길이 없다(이 이슈의 신고 내용이다).
 *
 * 음소거(`notifyLevel: 'none'`) 채널을 빼지 않는 것도 그 점과 같게 하기 위한 것이다.
 * 음소거는 "알리지 마라"이고 이것은 알림이 아니라 표시다 — 게다가 한쪽만 빼면 사이드바에
 * 점이 있는데 독에는 없는 상태가 생긴다.
 */
export function hasUnreadMessages(reads: Record<string, { unread: number }>): boolean {
  return Object.values(reads).some((r) => r.unread > 0);
}

/** 배지가 세는 데 드는 것 — 스토어의 안 읽은 줄과 채널 선호. */
export interface UnreadSource {
  unread: ReadonlyArray<{ reason: string; channelId: string }>;
  channelPrefs: Record<string, { notifyLevel?: NotifyLevel } | undefined>;
}

/**
 * **안 읽은 멘션·DM 수** — 레일·독·커뮤니티 타일의 숫자 배지가 모두 이것 하나를 읽는다.
 * 재료는 스토어의 `unread`(`GET /inbox?unread=1`, 안 읽은 것만 담긴다)다 — 따로 조회하지 않는다.
 * 그 밖의 사유(답글·위임 소식 등)는 "새 대화가 있다"에 가깝고 숫자로 세지 않는다.
 *
 * **음소거(`notifyLevel: 'none'`) 채널의 것은 빼고 센다.** 사이드바의 채널 숫자도 음소거면 숨으므로
 * (`Sidebar.tsx` 의 `UnreadBadge`), 세면 어디서 왔는지 찾을 길이 없는 숫자가 된다.
 *
 * 스토어 상태를 통째로 받는 까닭: 선호를 따로 넘기는 인자면 한 곳이 빠뜨렸을 때 그 배지만 갈린다.
 */
export function unreadMentionCount({ unread, channelPrefs }: UnreadSource): number {
  let n = 0;
  for (const e of unread) if (isMentionOrDm(e) && notifyLevelOf(channelPrefs[e.channelId]) !== 'none') n += 1;
  return n;
}

/** 배지가 세는 사유인가 — 멘션·DM·팀장으로서 불림(`team_mention`). */
export function isMentionOrDm(e: { reason: string }): boolean {
  return e.reason === 'mention' || e.reason === 'dm' || e.reason === 'team_mention';
}
