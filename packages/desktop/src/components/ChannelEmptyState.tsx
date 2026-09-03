import type { ChannelRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';

/**
 * 메시지가 하나도 없는 채널에 다음 걸음을 보여 준다(#234).
 *
 * 안내는 **지금 실제로 되는 것만** 낸다(docs/design.md §4). 그래서 줄마다 조건이 붙는다 —
 * 조건이 없으면 "에이전트를 멘션하라"가 에이전트가 하나도 없는 워크스페이스에서도 뜨고,
 * 그것이 정확히 §4 가 막으려는 거짓 신호다. **"사람을 초대하라"는 넣지 않는다**: 표준
 * 채널에는 멤버십이 없어서(#156) "이 채널로 사람을 부른다"는 동작 자체가 존재하지 않는다.
 *
 * 새로 만든 채널인지도 보지 않는다. 비었다는 사실이 같으면 화면도 같아야 하고, 생성 시각으로
 * 나눠 봐야 보는 사람에게 달라지는 것이 없다.
 */
export function ChannelEmptyState(
  { channel, isArchived }: { channel: ChannelRow | undefined; isArchived: boolean },
) {
  const { accounts, me } = useAppStore();

  // 멘션 자동완성과 **같은 기준**으로 고른다(Composer.tsx 의 후보 필터 — 나 자신 제외,
  // disabled 제외). 기준이 갈리면 여기서 이름을 보여 준 에이전트가 정작 자동완성에는 뜨지
  // 않는, 없는 동작을 안내한 상태가 된다.
  const agent = Object.values(accounts).find((a) => a.kind === 'agent' && !a.disabled && a.id !== me?.id);

  /**
   * 멘션 안내를 낼 조건.
   * - 채널일 때만: DM 은 상대가 이미 정해져 있어 멘션으로 부를 대상이 없다.
   * - 보관된 채널이 아닐 때만: 보관되면 Composer 가 사라지므로(아래 ChannelPane) 멘션할
   *   방법 자체가 없다.
   * - 에이전트가 실제로 있을 때만.
   * 문구는 "답한다"가 아니라 "inbox 로 들어간다"이다 — inbox 행을 만드는 것은 서버가 하는
   * 일이지만(services/messages.ts 의 insertInbox), 답이 오는지는 러너가 떠 있는가에 달려
   * 있고 이 화면은 그것을 모른다(#125).
   */
  const mentionAgent = channel && !isArchived ? agent : undefined;

  // topic 은 `PATCH /channels/:id` 가 requireAdmin 이고 사이드바의 '채널 편집' 항목도
  // admin 에게만 열린다(Sidebar.tsx). admin 이 아닌 사람에게 권하면 갈 곳이 없다.
  const showTopic = !!channel && !!me?.isAdmin && !channel.topic;

  return (
    <div className="px-4 py-10 text-center" data-testid="channel-empty-state">
      <p className="text-sm font-medium text-fg-muted">
        {channel ? `#${channel.name} 에 아직 메시지가 없다` : '아직 메시지가 없다'}
      </p>
      {channel?.topic && <p className="mt-1 text-xs text-fg-subtle">{channel.topic}</p>}
      {(mentionAgent || showTopic) && (
        <ul className="mx-auto mt-4 max-w-sm list-disc space-y-1 pl-5 text-left text-xs text-fg-subtle">
          {mentionAgent && (
            <li>@{mentionAgent.handle} 처럼 에이전트를 멘션하면 그 에이전트의 inbox 로 들어간다.</li>
          )}
          {showTopic && (
            <li>사이드바에서 이 채널의 ⋯ 메뉴를 열고 '채널 편집'으로 topic 을 정할 수 있다.</li>
          )}
        </ul>
      )}
    </div>
  );
}
