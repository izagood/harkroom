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

/**
 * handle 문법. 계정 생성과 멘션 인식이 같은 것을 봐야 한다.
 */
export const HANDLE_PATTERN = '[a-zA-Z0-9_-]{2,32}';

/**
 * 본문 안의 멘션. 서버(알림 발송)와 데스크탑(강조)이 **반드시 같은 규칙**을 써야 한다 —
 * 갈라지면 두 방향으로 거짓말을 한다: 강조되지 않은 것이 몰래 알림을 보내거나(`me@x.com`),
 * 강조된 것이 알림을 보내지 않는다(`@Fizz`).
 *
 * 선행 문자 조건이 핵심이다. `@` 앞이 문자·숫자면 멘션이 아니다 — 이메일 주소와 단어
 * 중간의 `@` 를 걸러 낸다. handle 은 소문자로만 만들어지지만 사람은 `@Fizz` 라고 쓰므로
 * 대소문자를 무시하고 찾고, 조회할 때 소문자로 맞춘다.
 */
export const MENTION_PATTERN = `(^|[^a-zA-Z0-9_-])@(${HANDLE_PATTERN})`;

/**
 * 본문에서 불린 handle 들. 소문자로 정규화해 중복을 없앤다(`@fizz` 와 `@Fizz` 는 한 사람).
 * 패턴이 대문자를 이미 포함하므로 `i` 플래그는 필요하지 않다.
 */
export function mentionedHandles(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(new RegExp(MENTION_PATTERN, 'g'))) {
    if (m[2]) found.add(m[2].toLowerCase());
  }
  return [...found];
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
