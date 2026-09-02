import type { AgentConfig, AgentView, AccountView, AttachmentRow, ChannelRow, DmView, InboxEntry, LeaseRow, MessageRow } from '@murmur/shared';

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
  logout(): Promise<void> { return this.req('POST', '/auth/logout'); }
  /** 채널 전체의 읽음 상태를 한 번에. 채널마다 묻지 않기 위한 표면이다. */
  async reads(): Promise<{ channelId: string; lastReadSeq: number; unread: number }[]> {
    return (await this.req<{ reads: { channelId: string; lastReadSeq: number; unread: number }[] }>('GET', '/reads')).reads;
  }
  markChannelRead(channelId: string, seq: number): Promise<void> {
    return this.req('PUT', `/channels/${channelId}/read`, { seq });
  }
  async accounts(): Promise<AccountView[]> {
    return (await this.req<{ accounts: AccountView[] }>('GET', '/accounts')).accounts;
  }
  async channels(): Promise<ChannelRow[]> {
    return (await this.req<{ channels: ChannelRow[] }>('GET', '/channels')).channels;
  }
  createChannel(input: { name: string; topic?: string; repo?: string }): Promise<ChannelRow> {
    return this.req('POST', '/channels', input);
  }
  async dms(): Promise<DmView[]> {
    return (await this.req<{ dms: DmView[] }>('GET', '/dms')).dms;
  }
  async leases(): Promise<LeaseRow[]> {
    return (await this.req<{ leases: LeaseRow[] }>('GET', '/leases')).leases;
  }
  /** `hasMore` 는 '이 페이지보다 오래된 것이 남았는가'다 — 상단 추가 로드 표시에 쓴다. */
  messages(
    channelId: string,
    opts?: { since?: number; before?: number; limit?: number; thread?: string },
  ): Promise<{ messages: MessageRow[]; hasMore: boolean }> {
    const q = new URLSearchParams();
    if (opts?.since !== undefined) q.set('since', String(opts.since));
    if (opts?.before !== undefined) q.set('before', String(opts.before));
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts?.thread) q.set('thread', opts.thread);
    const qs = q.size ? `?${q.toString()}` : '';
    return this.req('GET', `/channels/${channelId}/messages${qs}`);
  }
  postMessage(
    channelId: string, body: string, threadRootId?: string, idempotencyKey?: string,
    attachmentIds: string[] = [],
  ): Promise<MessageRow> {
    return this.req('POST', `/channels/${channelId}/messages`,
      {
        body,
        ...(threadRootId ? { threadRootId } : {}),
        // 빈 배열은 보내지 않는다 — 첨부를 쓰지 않는 요청의 본문을 넓히지 않는다.
        ...(attachmentIds.length ? { attachmentIds } : {}),
      },
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined);
  }
  async inboxUnread(): Promise<InboxEntry[]> {
    return (await this.req<{ entries: InboxEntry[] }>('GET', '/inbox?unread=1')).entries;
  }
  editMessage(channelId: string, messageId: string, body: string): Promise<MessageRow> {
    return this.req('PATCH', `/channels/${channelId}/messages/${messageId}`, { body });
  }

  deleteMessage(channelId: string, messageId: string): Promise<void> {
    return this.req('DELETE', `/channels/${channelId}/messages/${messageId}`);
  }

  async listAgents(): Promise<AgentView[]> {
    return (await this.req<{ agents: AgentView[] }>('GET', '/accounts/agents')).agents;
  }

  createAgent(input: { handle: string; displayName: string } & Partial<AgentConfig>): Promise<AgentView> {
    return this.req('POST', '/accounts/agents', input);
  }

  /** PAT 는 서버가 해시만 보관하므로 생성 직후 한 번만 볼 수 있다. */
  async mintPat(accountId: string, label: string): Promise<string> {
    return (await this.req<{ token: string }>('POST', `/accounts/${accountId}/pats`, { label })).token;
  }

  updateAgent(id: string, patch: Partial<AgentConfig> & { displayName?: string }): Promise<AgentView> {
    return this.req('PATCH', `/accounts/agents/${id}`, patch);
  }

  /** WS 핸드셰이크용 단기 1회용 티켓. 연결 시도마다 새로 받는다. */
  async wsTicket(): Promise<string> {
    const res = await this.req<{ ticket: string }>('POST', '/ws-ticket');
    return res.ticket;
  }

  /** 이모지는 경로에 들어가므로 인코딩한다 — 그림문자는 URL 에 그대로 실을 수 없다. */
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    return this.req('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }

  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    return this.req('DELETE', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }

  /**
   * 파일 하나를 올린다. `FormData` 를 쓰므로 Content-Type 을 직접 정하지 않는다 —
   * boundary 는 브라우저가 만든다.
   */
  async upload(file: File): Promise<AttachmentRow> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${this.baseUrl}/uploads`, {
      method: 'POST',
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new ApiError(res.status, body?.error?.code ?? 'upload_failed', body?.error?.message ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<AttachmentRow>;
  }

  /**
   * 첨부 바이트를 받는다. **토큰을 URL 에 넣지 않는다** — 서버 로거가 URL 을 기록하므로
   * 쿼리 파라미터로 넘기면 자격증명이 평문으로 로그에 남는다. `<img src>` 와 `<a href>` 는
   * 헤더를 붙일 수 없으니, 호출부가 이 blob 으로 objectURL 을 만들어 쓴다.
   */
  async fetchAttachment(id: string): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/attachments/${id}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'attachment_failed', `HTTP ${res.status}`);
    return res.blob();
  }

  markRead(ids: number[]): Promise<void> { return this.req('POST', '/inbox/read', { ids }); }
  createDm(accountIds: string[]): Promise<ChannelRow> { return this.req('POST', '/dms', { accountIds }); }
  /** 초대 토큰을 발급한다 — admin 전용. 토큰은 생성 직후 한 번만 볼 수 있다. */
  createInvite(): Promise<string> {
    return (this.req<{ token: string }>('POST', '/invites')).then((r) => r.token);
  }
}
