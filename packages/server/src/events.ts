import { EventEmitter } from 'node:events';
import type { AccountStatus, MessageRow } from '@murmur/shared';

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
  | { type: 'reaction.added'; channelId: string; messageId: string; emoji: string; accountId: string; audience: 'all' | string[] }
  | { type: 'reaction.removed'; channelId: string; messageId: string; emoji: string; accountId: string; audience: 'all' | string[] }
  | { type: 'typing.changed'; channelId: string; accountIds: string[]; audience: 'all' | string[] };

const bus = new EventEmitter();
bus.setMaxListeners(1000);

export function emitEvent(e: WorkspaceEvent): void {
  bus.emit('event', e);
}

export function onEvent(fn: (e: WorkspaceEvent) => void): () => void {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}
