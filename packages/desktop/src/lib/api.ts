import type { AccountView, ChannelRow, DmView, InboxEntry, LeaseRow, MessageRow } from '@murmur/shared';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  constructor(public baseUrl: string, private token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  setToken(token: string | null): void { this.token = token; }

  private async req<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
    const headers: Record<string, string> = { ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(res.status, err?.code ?? 'unknown', err?.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }

  login(handle: string, password: string): Promise<{ token: string }> {
    return this.req('POST', '/auth/login', { handle, password });
  }
  bootstrap(handle: string, displayName: string, password: string): Promise<{ id: string }> {
    return this.req('POST', '/bootstrap', { handle, displayName, password });
  }
  me(): Promise<AccountView> { return this.req('GET', '/auth/me'); }
  async accounts(): Promise<AccountView[]> {
    return (await this.req<{ accounts: AccountView[] }>('GET', '/accounts')).accounts;
  }
  async channels(): Promise<ChannelRow[]> {
    return (await this.req<{ channels: ChannelRow[] }>('GET', '/channels')).channels;
  }
  async dms(): Promise<DmView[]> {
    return (await this.req<{ dms: DmView[] }>('GET', '/dms')).dms;
  }
  async leases(): Promise<LeaseRow[]> {
    return (await this.req<{ leases: LeaseRow[] }>('GET', '/leases')).leases;
  }
  async messages(channelId: string, opts?: { since?: number; thread?: string }): Promise<MessageRow[]> {
    const q = new URLSearchParams();
    if (opts?.since !== undefined) q.set('since', String(opts.since));
    if (opts?.thread) q.set('thread', opts.thread);
    const qs = q.size ? `?${q.toString()}` : '';
    return (await this.req<{ messages: MessageRow[] }>('GET', `/channels/${channelId}/messages${qs}`)).messages;
  }
  postMessage(channelId: string, body: string, threadRootId?: string, idempotencyKey?: string): Promise<MessageRow> {
    return this.req('POST', `/channels/${channelId}/messages`,
      { body, ...(threadRootId ? { threadRootId } : {}) },
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined);
  }
  async inboxUnread(): Promise<InboxEntry[]> {
    return (await this.req<{ entries: InboxEntry[] }>('GET', '/inbox?unread=1')).entries;
  }
  /** WS 핸드셰이크용 단기 1회용 티켓. 연결 시도마다 새로 받는다. */
  async wsTicket(): Promise<string> {
    const res = await this.req<{ ticket: string }>('POST', '/ws-ticket');
    return res.ticket;
  }

  markRead(ids: number[]): Promise<void> { return this.req('POST', '/inbox/read', { ids }); }
  createDm(accountIds: string[]): Promise<ChannelRow> { return this.req('POST', '/dms', { accountIds }); }
}
