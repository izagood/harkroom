import type { AccountView, ChannelRow, DmView, MessageRow } from '@murmur/shared';

/**
 * 훑기 한 항목(#227).
 *
 * **훑기 동작(하나 보여 주고 다음)은 이 모양만 안다.** 무엇을 훑을지는 모드가 정한다 —
 * 이번에 만드는 것은 `reads` 맵 기반의 "전체 미읽음" 모드 하나뿐이다. #185("나를 부른 것")는
 * `InboxEntry[]` 라는 **다른 데이터 모델**에서 출발하므로 안쪽 리스트 구현은 갈리지만,
 * 그쪽도 결과를 이 모양으로 접어 넣으면 화면과 손동작을 다시 만들지 않아도 된다.
 * 두 모드를 여기서 미리 합치지 않는 이유가 그것이다: 합쳐야 하는 것은 데이터가 아니라 동작이다.
 */
export interface SweepItem {
  channelId: string;
  /** 화면에 보일 이름. 채널이면 `#general`, DM 이면 `@handle`. */
  label: string;
  /** 이 항목의 미읽음 메시지들. 오래된 것부터다(서버가 seq 오름차순으로 준다). */
  messages: MessageRow[];
  /** 정렬 기준 — 가장 오래된 미읽음 메시지의 시각(ISO). */
  oldestAt: string;
  /**
   * '읽음 처리하고 다음'이 전진시킬 위치. 내가 쓴 메시지까지 포함한 이 페이지의 최대 seq 다 —
   * 미읽음 메시지의 최대치만 쓰면 그 뒤의 내 발화가 남아 채널이 읽음으로 정리되지 않는다.
   */
  newestSeq: number;
}

/**
 * 채널·DM 을 사람이 읽을 이름으로. 훑기는 사이드바 밖에 있는 화면이라 "이게 어느 대화인지"를
 * 스스로 말할 수 있어야 한다 — id 를 그대로 보여 주면 훑을지 말지를 판단할 근거가 없다.
 */
export function sweepLabel(
  state: { channels: ChannelRow[]; dms: DmView[]; accounts: Record<string, AccountView>; me: AccountView | null },
  channelId: string,
): string {
  const channel = state.channels.find((c) => c.id === channelId);
  if (channel) return `#${channel.name ?? channelId}`;
  const dm = state.dms.find((d) => d.id === channelId);
  if (dm) {
    const peers = dm.memberIds.filter((id) => id !== state.me?.id);
    const handles = peers.map((id) => state.accounts[id]?.handle).filter((h): h is string => !!h);
    if (handles.length) return handles.map((h) => `@${h}`).join(', ');
    return 'DM';
  }
  return channelId;
}

/**
 * 훑기 목록의 순서 — **오래된 것부터**다.
 *
 * 즐겨찾기(#152)나 멘션 여부로 가중치를 주지 않는다. 숨은 우선순위는 사람이 "왜 이게 먼저
 * 뜨지?"를 물었을 때 답할 수 없게 만든다. 오래된 것부터는 설명 가능하고 결정적이다 —
 * 같은 시각이면 channelId 로 갈라 순서가 조회마다 흔들리지 않게 한다.
 */
export function sortSweepItems(items: SweepItem[]): SweepItem[] {
  return [...items].sort((a, b) =>
    a.oldestAt === b.oldestAt ? a.channelId.localeCompare(b.channelId) : a.oldestAt.localeCompare(b.oldestAt));
}
