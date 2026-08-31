import { vi } from 'vitest';
import type { AccountView, ChannelRow, MessageRow } from '@murmur/shared';
import type { ApiClient } from '../../src/lib/api';

export const acc = (id: string, handle: string, kind: 'human' | 'agent' = 'human'): AccountView =>
  ({ id, handle, displayName: handle, kind, isAdmin: false });

export const chan = (id: string, name: string, repo: string | null = null): ChannelRow =>
  ({ id, name, topic: '', kind: 'standard', repo });

export const msg = (id: string, channelId: string, seq: number, body: string, authorId = 'u1',
  extra: Partial<MessageRow> = {}): MessageRow =>
  ({ id, seq, channelId, threadRootId: null, authorId, body, kind: 'user', meta: {}, createdAt: new Date().toISOString(), ...extra });

export function fakeApi(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  const base = {
    baseUrl: 'http://x',
    setToken: vi.fn(),
    login: vi.fn(), bootstrap: vi.fn(),
    me: vi.fn(async () => acc('u1', 'admin')),
    accounts: vi.fn(async () => [acc('u1', 'admin'), acc('u2', 'bot', 'agent')]),
    channels: vi.fn(async () => [chan('c1', 'general')]),
    dms: vi.fn(async () => []),
    leases: vi.fn(async () => []),
    messages: vi.fn(async () => []),
    postMessage: vi.fn(async () => msg('m-post', 'c1', 99, 'sent')),
    inboxUnread: vi.fn(async () => []),
    markRead: vi.fn(async () => undefined),
    createDm: vi.fn(),
    ...overrides,
  };
  return base as unknown as ApiClient;
}

export function fakeWsFactory() {
  const callbacks: { current: import('../../src/lib/ws').WsCallbacks | null } = { current: null };
  const makeWs = ((_url: string, _token: string, cb: import('../../src/lib/ws').WsCallbacks) => {
    callbacks.current = cb;
    return { close: vi.fn() };
  }) as typeof import('../../src/lib/ws').connectWs;
  return { makeWs, callbacks };
}
