import type { InboxEntry } from '@murmur/shared';

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
 * **나를 막는 것**의 개수 — 안 읽은 `mention`·`dm` 만 센다.
 *
 * 문서의 규칙("배지는 나를 막는 것만 센다")이 그대로 여기 있다. `thread_reply` 를 넣지
 * 않는 이유는 레일 주석이 적은 그대로다: 이 앱에서 내 답을 기다린다고 **서버가 판정한**
 * 것이 멘션과 DM 이고, 나머지 사유는 "새 대화가 있다"에 가깝다.
 */
export function blockingUnreadCount(unread: InboxEntry[]): number {
  return unread.filter((e) => !e.readAt && (e.reason === 'mention' || e.reason === 'dm')).length;
}

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
