import { vi } from 'vitest';
import type { AccountView, ChannelRow, MessageRow } from '@murmur/shared';
import type { ApiClient } from '../../src/lib/api';

// #186: 상태는 옵셔널이 아니라 **필수 필드**다 — fixture 도 그것을 적어야 한다.
// 기본값은 서버의 기본값과 같은 'available' 이고, 상태를 보는 테스트가 덮어쓴다.
export const acc = (id: string, handle: string, kind: 'human' | 'agent' = 'human', isAdmin = false): AccountView =>
  ({ id, handle, displayName: handle, kind, isAdmin, disabled: false, status: 'available', statusText: null });

export const chan = (id: string, name: string, repo: string | null = null): ChannelRow =>
  ({ id, name, topic: '', kind: 'standard', repo });

export const msg = (id: string, channelId: string, seq: number, body: string, authorId = 'u1',
  extra: Partial<MessageRow> = {}): MessageRow =>
  // #161: 스레드 메타데이터는 **루트에만** 붙고 옵셔널이 아니라 명시적 null 이다 —
  // fixture 도 그것을 적어야 한다. 루트 메시지를 만드는 테스트는 extra 로 덮어쓴다.
  ({ id, seq, channelId, threadRootId: null, authorId, body, kind: 'user', meta: {}, createdAt: new Date().toISOString(), editedAt: null, reactions: [], attachments: [], replyCount: null, lastReplyAt: null, participantIds: null, ...extra });

// override 를 ApiClient 의 실제 시그니처로 받는다. 이전에는 값 타입이 `unknown` 이어서
// 반환 형태가 어긋난 fake 를 tsc 가 통과시켰다 — 실제로 api.messages() 가 배열에서
// {messages, hasMore} 로 바뀐 뒤 stale fake 가 그대로 컴파일돼 main 이 빨강이 됐다(#42).
// 안전망은 CI 가 아니라 여기서 서야 한다: base 쪽 캐스트는 남지만, 각 테스트가 갈아끼우는
// override 는 이제 타입이 검사된다.
export function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const base = {
    baseUrl: 'http://x',
    setToken: vi.fn(),
    login: vi.fn(), bootstrap: vi.fn(),
    me: vi.fn(async () => acc('u1', 'admin')),
    // 베이스가 클라이언트 표면을 다 덮어야 한다 — 빠져 있으면 "호출되지 않았다" 를 단언할 수 없다.
    logout: vi.fn(async () => undefined),
    reads: vi.fn(async () => []),
    markChannelRead: vi.fn(async () => undefined),
    accounts: vi.fn(async () => [acc('u1', 'admin'), acc('u2', 'bot', 'agent')]),
    channels: vi.fn(async () => [chan('c1', 'general')]),
    dms: vi.fn(async () => []),
    leases: vi.fn(async () => []),
    channelPrefs: vi.fn(async () => []),
    agentMemory: vi.fn(async () => []),
    deleteAgentMemory: vi.fn(async () => undefined),
    messages: vi.fn(async () => ({ messages: [], hasMore: false })),
    postMessage: vi.fn(async () => msg('m-post', 'c1', 99, 'sent')),
    inboxUnread: vi.fn(async () => []),
    markRead: vi.fn(async () => undefined),
    wsTicket: vi.fn(async () => 'murt_fake'),
    editMessage: vi.fn(async () => msg('m-edit', 'c1', 1, 'edited')),
    deleteMessage: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    createDm: vi.fn(),
    updateChannel: vi.fn(async (id: string, input: { topic?: string; repo?: string | null }) =>
      chan(id, id, input.repo ?? null)),
    search: vi.fn(async () => []),
    ...overrides,
  };
  return base as unknown as ApiClient;
}

export function fakeWsFactory() {
  const callbacks: { current: import('../../src/lib/ws').WsCallbacks | null } = { current: null };
  const makeWs = ((_url: string, _getTicket: import('../../src/lib/ws').TicketProvider, cb: import('../../src/lib/ws').WsCallbacks) => {
    callbacks.current = cb;
    return { close: vi.fn(), send: vi.fn() };
  }) as typeof import('../../src/lib/ws').connectWs;
  return { makeWs, callbacks };
}
