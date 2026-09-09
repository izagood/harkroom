import { EventEmitter } from 'node:events';
import type { AccountStatus, ChannelRow, MessageRow } from '@murmur/shared';
import type { WorkspaceSkill } from './services/skills.js';

export type WorkspaceEvent =
  | { type: 'message.created'; message: MessageRow; audience: 'all' | string[] }
  | { type: 'message.updated'; message: MessageRow; audience: 'all' | string[] }
  | { type: 'message.deleted'; channelId: string; messageId: string; audience: 'all' | string[] }
  | { type: 'inbox.updated'; accountId: string }
  | { type: 'lease.changed'; repo: string }
  | { type: 'presence.changed'; accountId: string; online: boolean }
  // 에이전트 세션이 사람 손을 기다린다(2026-09-08). 소유자에게만 간다 — 남의 에이전트가
  // 막힌 것은 이 사람이 할 수 있는 일이 아니다.
  | { type: 'agent.attention'; sessionId: string; channelId: string;
      threadRootId: string | null; agentAccountId: string; agentHandle: string;
      accountLabel: string; audience: string[] }
  // 사람이 직접 고른 상태(#186). presence 와 나란히 산다 — 이 이벤트는
  // presence.changed 를 만들지 않고, 소켓이 끊겨도 상태는 그대로 남는다.
  | { type: 'status.changed'; accountId: string; status: AccountStatus; statusText: string | null }
  | { type: 'avatar.changed'; accountId: string; avatarAttachmentId: string | null }
  // #271: 계정 handle 변경. 데스크탑은 디렉터리만 갱신하면 본문은 다음 렌더에 새 이름.
  | { type: 'account.handle_changed'; accountId: string; newHandle: string }
  | { type: 'reaction.added'; channelId: string; messageId: string; emoji: string; accountId: string; audience: 'all' | string[] }
  | { type: 'reaction.removed'; channelId: string; messageId: string; emoji: string; accountId: string; audience: 'all' | string[] }
  | { type: 'typing.changed'; channelId: string; accountIds: string[]; audience: 'all' | string[] }
  // 채널 목록 변경(#284). public 채널은 전원, private 은 멤버만 받는다.
  // public→private 전환시 비멤버는 channel.deleted 를 받는다 — 그 사람에게 채널이 사라진 것이기 때문이다.
  | { type: 'channel.created'; channel: ChannelRow; audience: 'all' | string[] }
  | { type: 'channel.updated'; channel: ChannelRow; audience: 'all' | string[] }
  | { type: 'channel.deleted'; channelId: string; audience: 'all' | string[] }
  // 채널 멤버십 변경(#300). 목록 수신자는 #284 의 channelListAudience 를 쓴다.
  // 추가된 사람은 channel.created 를, 제거된 사람은 channel.deleted 를 함께 받는다(#284 의 public→private 논리).
  | { type: 'channel.member_added'; channelId: string; accountId: string; audience: 'all' | string[] }
  | { type: 'channel.member_removed'; channelId: string; accountId: string; audience: 'all' | string[] }
  // 핸들 집합 변경(#300). 로그인한 전원에게 간다.
  | { type: 'handle_group.changed'; groupId: string; audience: 'all' | string[] }
  // 에이전트 팀 변경(#172). 집합과 같은 모양·같은 수신자다 — 팀 이름이 자동완성 후보이고
  // 팀원 수가 조용한 실패 판정의 유일한 출처이므로, 알리지 않으면 둘 다 낡는다.
  | { type: 'agent_team.changed'; teamId: string; audience: 'all' | string[] }
  // 담기/해제/상태 변경(#219). 본인의 소켓에만 간다.
  | { type: 'saved.changed'; messageId: string; state: 'open' | 'done' | null; accountId: string }
  // 워크스페이스 스킬(#140). 제안·승인·비활성을 알린다.
  | { type: 'skill.proposed'; skill: WorkspaceSkill; channelId: string }
  | { type: 'skill.approved'; skill: WorkspaceSkill }
  | { type: 'skill.disabled'; skill: WorkspaceSkill }
  // 링크 미리보기 준비 완료(#215). 가져오기는 비동기라, 메시지가 먼저 뜨고 카드가 뒤에 온다.
  | { type: 'link_preview.ready'; url: string; audience: 'all' | string[] };

const bus = new EventEmitter();
bus.setMaxListeners(1000);

export function emitEvent(e: WorkspaceEvent): void {
  bus.emit('event', e);
}

/**
 * 게시 하나가 내는 이벤트를 **한 자리에서** 낸다: 만들어진 말과, 그 말 때문에 목록에
 * 되돌아온 스레드 머리(`postMessage` 의 `rootBack`).
 *
 * 왜 함수로 묶었는가 — `postMessage` 를 부르는 자리가 여덟이고, 둘째 이벤트를 각자
 * 내게 두면 언젠가 한 자리가 빠진다. 그 자리에서는 **에이전트의 답이 채널에 안 보인다**:
 * 지워진 머리가 목록에 없는 채로 답만 도착하고, 머리가 없으니 그릴 자리가 없다.
 *
 * **순서가 규칙의 일부다.** 머리는 `message.created` **뒤에** 나간다. 먼저 내면 화면에
 * 그 행이 생기고, 뒤이어 오는 `message.created` 가 `bumpThreadCounts` 로 답글 수를 하나
 * 더 올린다 — 서버가 준 머리 행에는 이 답이 **이미 세어져 있다**. 뒤에 내면 bump 가
 * 머리를 못 찾아 조용히 no-op 하고(`appStore.bumpThreadCounts` 의 `if (!parent) return`),
 * 그다음 서버 행이 정확한 수로 자리를 세운다.
 *
 * **`message.updated` 인 것도 규칙의 일부다.** 이 머리는 이미 있던 행이 다시 보이게 된
 * 것이지 새로 생긴 말이 아니다. `created` 로 내면 안 읽음이 오르고 알림이 뜬다 — 몇
 * 시간 전에 지운 말이 방금 온 말처럼 보인다(`deleteMessage` 가 자리표시자에 `deleted`
 * 대신 `updated` 를 쓰는 것과 같은 판단이다).
 *
 * 실패한 게시(`failure`)는 여기 오기 전에 부른 쪽이 응답으로 끝낸다 — 그래도 만들어진
 * 말이 없으면 아무것도 내지 않는다. 이벤트를 내지 않는 것이 없는 메시지를 내는 것보다 낫다.
 */
export function emitPosted(
  posted: { message?: MessageRow; rootBack?: MessageRow | null },
  audience: 'all' | string[],
): void {
  if (!posted.message) return;
  emitEvent({ type: 'message.created', message: posted.message, audience });
  if (posted.rootBack) {
    emitEvent({ type: 'message.updated', message: posted.rootBack, audience });
  }
}

export function onEvent(fn: (e: WorkspaceEvent) => void): () => void {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}
