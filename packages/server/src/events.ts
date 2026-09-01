import { EventEmitter } from 'node:events';
import type { MessageRow } from '@murmur/shared';

export type WorkspaceEvent =
  | { type: 'message.created'; message: MessageRow; audience: 'all' | string[] }
  | { type: 'message.updated'; message: MessageRow; audience: 'all' | string[] }
  | { type: 'message.deleted'; channelId: string; messageId: string; audience: 'all' | string[] }
  | { type: 'inbox.updated'; accountId: string }
  | { type: 'lease.changed'; repo: string }
  | { type: 'presence.changed'; accountId: string; online: boolean }
  | { type: 'reaction.added'; channelId: string; messageId: string; emoji: string; accountId: string; audience: 'all' | string[] }
  | { type: 'reaction.removed'; channelId: string; messageId: string; emoji: string; accountId: string; audience: 'all' | string[] };

const bus = new EventEmitter();
bus.setMaxListeners(1000);

export function emitEvent(e: WorkspaceEvent): void {
  bus.emit('event', e);
}

export function onEvent(fn: (e: WorkspaceEvent) => void): () => void {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}
