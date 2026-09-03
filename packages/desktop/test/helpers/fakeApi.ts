import { vi } from 'vitest';
import type { AccountView, ChannelRow, HandleGroupRow, MessageRow, PinRow } from '@murmur/shared';
import type { ApiClient } from '../../src/lib/api';

// #186: 상태는 옵셔널이 아니라 **필수 필드**다 — fixture 도 그것을 적어야 한다.
// 기본값은 서버의 기본값과 같은 'available' 이고, 상태를 보는 테스트가 덮어쓴다.
// #181: ownerAccountId 도 필수다 — 에이전트는 null 이 정상이고, 사람 계정에도 null 이다.
// #159: 아바타도 필수 필드다. 기본은 null(사진 없음)이고, 아바타를 보는 테스트가 extra 로 덮어쓴다.
export const acc = (id: string, handle: string, kind: 'human' | 'agent' = 'human', isAdmin = false,
  extra: Partial<AccountView> = {}): AccountView =>
  ({ id, handle, displayName: handle, kind, isAdmin, disabled: false, status: 'available', statusText: null,
    ownerAccountId: null, avatarAttachmentId: null, ...extra });

// #285: 구성원 수도 **필수 필드**다 — fixture 가 그것을 적어야 한다. 기본은 0(빈 집합)이고,
// 후보의 수 표시를 보는 테스트가 마지막 인자로 덮어쓴다.
export const grp = (id: string, handle: string, displayName: string, memberCount = 0): HandleGroupRow =>
  ({ id, handle, displayName, createdAt: new Date().toISOString(), memberCount });

/**
 * `GET /accounts` 의 응답 모양(#230). 계정 목록과 집합 목록을 함께 준다.
 *
 * 헬퍼로 두는 이유: 이 모양을 fake 마다 손으로 적으면 서버가 필드를 하나 더 줄 때
 * 고칠 자리가 테스트 파일 수만큼 생긴다 — 아래 `fakeApi` 주석이 경계하는 그 결함이다.
 */
export function accountsResult(
  accounts: AccountView[], groups: HandleGroupRow[] = [],
): { accounts: AccountView[]; groups: HandleGroupRow[] } {
  return { accounts, groups };
}

// #182: 공개 범위도 **필수 필드**다 — fixture 가 그것을 적어야 한다. 기본값은 서버의
// 기본값과 같은 'public' 이고, private 을 보는 테스트가 마지막 인자로 덮어쓴다.
// #180: 생성 시각도 **필수 필드**다 — 채널 디렉터리의 "생성순" 정렬이 이 값으로 비교한다.
// 기본값은 모든 채널이 같은 고정 시각이고, 순서를 보는 테스트가 extra 로 서로 다르게 덮어쓴다.
// 고정값을 쓰는 이유: 호출 시각을 쓰면 fixture 를 나열한 순서가 곧 생성순이 되어, 비교 함수를
// 지워도 테스트가 우연히 초록으로 남는다.
export const chan = (
  id: string, name: string, repo: string | null = null,
  visibility: 'public' | 'private' = 'public',
  extra: Partial<ChannelRow> = {},
): ChannelRow =>
  ({ id, name, topic: '', kind: 'standard', repo, archivedAt: null, visibility,
    createdAt: '2024-01-01T00:00:00.000Z', ...extra });

export const msg = (id: string, channelId: string, seq: number, body: string, authorId = 'u1',
  extra: Partial<MessageRow> = {}): MessageRow =>
  // #161: 스레드 메타데이터는 **루트에만** 붙고 옵셔널이 아니라 명시적 null 이다 —
  // fixture 도 그것을 적어야 한다. 루트 메시지를 만드는 테스트는 extra 로 덮어쓴다.
  ({ id, seq, channelId, threadRootId: null, authorId, body, kind: 'user', meta: {}, createdAt: new Date().toISOString(), editedAt: null, reactions: [], attachments: [], replyCount: null, lastReplyAt: null, participantIds: null, alsoInChannel: false, ...extra });

// #218: 핀은 메시지를 통째로 싣는다 — 목록이 본문 한 줄을 미리 보여 줘야 쓸모가 있어서다.
// 그래서 fixture 도 메시지를 함께 만든다(기본은 그 자리에서 만든 한 줄짜리 메시지다).
export const pin = (messageId: string, channelId: string, pinnedBy = 'u1', message?: MessageRow): PinRow =>
  ({
    messageId, channelId, pinnedBy, pinnedAt: new Date().toISOString(),
    message: message ?? msg(messageId, channelId, 1, 'pinned body', pinnedBy),
  });

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
    markChannelUnread: vi.fn(async () => undefined),
    accounts: vi.fn(async () => accountsResult([acc('u1', 'admin'), acc('u2', 'bot', 'agent')])),
    channels: vi.fn(async () => [chan('c1', 'general')]),
    dms: vi.fn(async () => []),
    leases: vi.fn(async () => []),
    // #267: 베이스가 덮지 않으면 컨트롤러의 상태 조회가 TypeError 로 떨어져, 모든
    // 테스트가 "투영 상태를 못 읽었다" 화면 위에서 돌게 된다.
    projectionStatus: vi.fn(async () => ({
      state: 'ok' as const, configured: true, repo: null, lastLogIndex: 0,
      lastPolledAt: Date.now(), lastAdvancedAt: null, lastError: null,
    })),
    channelPrefs: vi.fn(async () => []),
    agentDefaults: vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null })),
    updateAgentDefaults: vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null })),
    agentMemory: vi.fn(async () => []),
    deleteAgentMemory: vi.fn(async () => undefined),
    messages: vi.fn(async () => ({ messages: [], hasMore: false })),
    // #178: 링크가 가리키는 메시지 하나. 베이스가 이것을 덮어야 "부르지 않았다" 를 단언할 수 있다.
    message: vi.fn(async () => msg('m-link', 'c1', 1, 'linked')),
    postMessage: vi.fn(async () => msg('m-post', 'c1', 99, 'sent')),
    // #222: 예약 발송. 베이스가 덮어야 컴포저를 띄우는 화면 테스트가 실제 배선을
    // 그대로 재현한다 — 이것이 없으면 컴포저가 실제로 부르는 표면이 목에 없어,
    // 프로덕션 코드에 "없으면 건너뛴다" 를 넣어 초록을 사는 유혹이 생긴다.
    scheduledMessages: vi.fn(async () => []),
    scheduleMessage: vi.fn(),
    cancelScheduledMessage: vi.fn(async () => undefined),
    inboxUnread: vi.fn(async () => []),
    // #185: 읽은 것까지 포함한 inbox 전체. 베이스가 덮어야 목록 화면 테스트가 fake 를 갈아끼울 수 있다.
    inbox: vi.fn(async () => []),
    markRead: vi.fn(async () => undefined),
    wsTicket: vi.fn(async () => 'murt_fake'),
    editMessage: vi.fn(async () => msg('m-edit', 'c1', 1, 'edited')),
    deleteMessage: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    createDm: vi.fn(),
    channelMembers: vi.fn(async () => []),
    inviteChannelMember: vi.fn(async () => []),
    removeChannelMember: vi.fn(async () => undefined),
    updateChannel: vi.fn(async (id: string, input: { topic?: string; repo?: string | null; archived?: boolean }) =>
      chan(id, id, input.repo ?? null)),
    archiveChannel: vi.fn(async (id: string, _archived: boolean) =>
      chan(id, id, null)),
    search: vi.fn(async () => []),
    // #232: 채널 파일 색인. 베이스가 덮어야 "부르지 않았다" 를 단언할 수 있다.
    channelFiles: vi.fn(async () => ({ files: [], hasMore: false })),
    // 파일 패널의 항목 클릭은 **이동이지 내려받기가 아니다.** 그것을 단언하려면
    // 내려받기 경로도 베이스에 있어야 한다.
    fetchAttachment: vi.fn(async () => new Blob(['x'])),
    // #218: 베이스가 핀 표면을 덮어야 openChannel 이 조용히 던지지 않고, "부르지 않았다" 도 단언할 수 있다.
    pins: vi.fn(async () => []),
    // #188: 채널 문서. 베이스가 덮어야 "부르지 않았다" 를 단언할 수 있고, 아직 아무도
    // 쓰지 않은 문서의 모양(본문 '', 누가·언제 null)이 fixture 에도 적혀 있어야 한다.
    channelDoc: vi.fn(async (channelId: string) =>
      ({ channelId, body: '', updatedBy: null, updatedAt: null })),
    updateChannelDoc: vi.fn(async (channelId: string, body: string) =>
      ({ channelId, body, updatedBy: 'u1', updatedAt: new Date().toISOString() })),
    pinMessage: vi.fn(async (channelId: string, messageId: string) => pin(messageId, channelId)),
    unpinMessage: vi.fn(async () => undefined),
    // #219: 담아 둔 메시지 표면. 베이스가 덮어야 Controller.start 가 조용히 던지지 않고,
    // "부르지 않았다" 도 단언할 수 있다.
    savedMessages: vi.fn(async (_state: 'open' | 'done') => []),
    savedSummary: vi.fn(async () => ({ openCount: 0, messageIds: [] as string[] })),
    saveMessage: vi.fn(),
    updateSavedMessage: vi.fn(),
    unsaveMessage: vi.fn(async () => undefined),
    // #285: 핸들 집합
    createHandleGroup: vi.fn(async (input: { handle: string; displayName: string }) =>
      grp('g-new', input.handle, input.displayName)),
    getHandleGroup: vi.fn(async () => ({ group: grp('g1', 'test', 'Test'), members: [] })),
    updateHandleGroup: vi.fn(async () => grp('g1', 'test', 'Updated')),
    deleteHandleGroup: vi.fn(async () => undefined),
    addHandleGroupMembers: vi.fn(async () => ({ members: ['u1'] })),
    removeHandleGroupMembers: vi.fn(async () => ({ members: [] })),
    // #250: 러너 실행기가 부르는 표면. 베이스가 덮어야 `Controller.start` 뒤의 자동 기동이
    // 조용히 던지지 않고, "발급을 부르지 않았다" 도 단언할 수 있다.
    listAgents: vi.fn(async () => []),
    listPats: vi.fn(async () => []),
    mintPat: vi.fn(async (_id: string, label: string) => `murp_${label}`),
    revokePat: vi.fn(async () => ({ revoked: 1 })),
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

/**
 * 컴포저가 마운트되는 화면 테스트를 위한 **최소 api**(#222). 컨트롤러를 통째로 세우지
 * 않고 손으로 만든 컨트롤러 목에 `api` 로 끼워 넣는다 — 컴포저는 채널이 붙으면 예약
 * 목록을 읽으므로, 이 표면이 없으면 화면 자체가 뜨지 않는다.
 */
export const scheduledApiStub = (): {
  scheduledMessages: ReturnType<typeof vi.fn>;
  scheduleMessage: ReturnType<typeof vi.fn>;
  cancelScheduledMessage: ReturnType<typeof vi.fn>;
} => ({
  scheduledMessages: vi.fn(async () => []),
  scheduleMessage: vi.fn(),
  cancelScheduledMessage: vi.fn(async () => undefined),
});
