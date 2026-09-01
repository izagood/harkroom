export interface AccountView {
  id: string;
  handle: string;
  displayName: string;
  kind: 'human' | 'agent';
  isAdmin: boolean;
}

export interface MessageRow {
  id: string;
  seq: number;
  channelId: string;
  threadRootId: string | null;
  authorId: string;
  body: string;
  kind: 'user' | 'system';
  meta: Record<string, unknown>;
  createdAt: string;
  /** 수정된 적이 없으면 null. UI 는 이 값으로 "(edited)" 표시를 결정한다. */
  editedAt: string | null;
}

export interface ChannelRow {
  id: string;
  name: string | null;
  topic: string;
  kind: 'standard' | 'dm';
  repo: string | null;
}

export interface InboxEntry {
  id: number;
  messageId: string;
  reason: 'mention' | 'thread_reply' | 'dm';
  readAt: string | null;
  channelId: string;
}

export interface DmView {
  id: string;
  memberIds: string[];
}

export interface LeaseRow {
  repo: string;
  path: string;
  actorKeyId: string;
  expiresAt: string;
}

export type WsServerEvent =
  | { type: 'message.created'; message: MessageRow; audience: 'all' | string[] }
  | { type: 'message.updated'; message: MessageRow; audience: 'all' | string[] }
  // 삭제는 본문을 싣지 않는다 — 지운 내용을 푸시하면 삭제가 삭제가 아니다.
  | { type: 'message.deleted'; channelId: string; messageId: string; audience: 'all' | string[] }
  | { type: 'inbox.updated'; accountId: string }
  | { type: 'lease.changed'; repo: string }
  | { type: 'presence.changed'; accountId: string; online: boolean }
  | { type: 'presence.snapshot'; online: string[] };
