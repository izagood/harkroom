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
  // 담기/해제/상태 변경(#219). 본인의 소켓에만 간다.
  | { type: 'saved.changed'; messageId: string; state: 'open' | 'done' | null; accountId: string }
  // 워크스페이스 스킬(#140). 제안·승인·비활성을 알린다.
  | { type: 'skill.proposed'; skill: WorkspaceSkill; channelId: string }
  | { type: 'skill.approved'; skill: WorkspaceSkill }
  | { type: 'skill.disabled'; skill: WorkspaceSkill };

const bus = new EventEmitter();
bus.setMaxListeners(1000);

export function emitEvent(e: WorkspaceEvent): void {
  bus.emit('event', e);
}

export function onEvent(fn: (e: WorkspaceEvent) => void): () => void {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}
