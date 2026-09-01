export interface AccountView {
  id: string;
  handle: string;
  displayName: string;
  kind: 'human' | 'agent';
  isAdmin: boolean;
}

/** murmur 가 실제로 실행할 수 있는 harness. 목록에만 있고 구현이 없는 것은 UI 에서 '지원 예정'이다. */
export const AGENT_HARNESSES = ['claude-code'] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];

/** UI 에서 등록·수정하는 에이전트의 정의. null 은 'harness 기본값 사용'이다. */
export interface AgentConfig {
  instructions: string;
  harness: AgentHarness;
  model: string | null;
  effort: string | null;
  workingDir: string | null;
}

export interface AgentView extends AccountView, AgentConfig {}

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
  /** 수정된 적이 없으면 null. */
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
  | { type: 'message.deleted'; channelId: string; messageId: string; audience: 'all' | string[] }
  | { type: 'inbox.updated'; accountId: string }
  | { type: 'lease.changed'; repo: string }
  | { type: 'presence.changed'; accountId: string; online: boolean }
  | { type: 'presence.snapshot'; online: string[] };
