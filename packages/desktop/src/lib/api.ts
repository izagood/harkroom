import type { AccountStatus, AgentConfig, AgentDefaults, AgentView, AccountView, AttachmentRow, ChannelRow, ChannelMemberRow, ChannelPrefRow, DmView, InboxEntry, LeaseRow, MessageRow, NotifyLevel, PatView, PinRow } from '@murmur/shared';

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
  /**
   * 초대 토큰으로 가입한다(#120). `bootstrap` 과 다른 점: 부트스트랩은 "첫 사람"이고 사람
   * 계정이 이미 있으면 409 로 막히지만, 이쪽은 admin 이 발급한 토큰을 쓴다.
   *
   * 세션을 돌려주지 않는다 — 서버가 `{ id }` 만 준다(`POST /auth/register`). 그래서 호출자가
   * 곧바로 `login` 을 이어 불러야 한다(부트스트랩도 같은 모양이다).
   */
  register(handle: string, displayName: string, password: string, inviteToken: string): Promise<{ id: string }> {
    return this.req('POST', '/auth/register', { handle, displayName, password, inviteToken });
  }
  me(): Promise<AccountView> { return this.req('GET', '/auth/me'); }
  /**
   * 내 상태를 정한다(#186). `statusText` 는 **키 부재와 null 을 구분한다** — 부재는
   * '문구는 손대지 않음', null 은 '지우기'다. 그래서 `undefined` 를 넣어 지우기를
   * 표현하지 않는다: `JSON.stringify` 가 그 키를 통째로 버려 지우기가 조용히 무시된다.
   */
  setMyStatus(input: { status: AccountStatus; statusText?: string | null }):
  Promise<{ status: AccountStatus; statusText: string | null }> {
    return this.req('PUT', '/accounts/me/status', input);
  }
  logout(): Promise<void> { return this.req('POST', '/auth/logout'); }
  /** 채널 전체의 읽음 상태를 한 번에. 채널마다 묻지 않기 위한 표면이다. */
  async reads(): Promise<{ channelId: string; lastReadSeq: number; unread: number }[]> {
    return (await this.req<{ reads: { channelId: string; lastReadSeq: number; unread: number }[] }>('GET', '/reads')).reads;
  }
  markChannelRead(channelId: string, seq: number): Promise<void> {
    return this.req('PUT', `/channels/${channelId}/read`, { seq });
  }
  /**
   * 미읽음 표시(#154). 읽음 ack 와 **다른 엔드포인트**다 — 서버가 자동 전진과 사람의 조작을
   * 구분해야 단조성을 깨지 않고 되돌릴 수 있다.
   *
   * `seq: null` 이 표시 지우기다. `undefined` 로 표현하면 `JSON.stringify` 가 키를 버려
   * 서버가 못 받는다.
   */
  markChannelUnread(channelId: string, seq: number | null): Promise<void> {
    return this.req('PUT', `/channels/${channelId}/unread`, { seq });
  }
  async accounts(): Promise<AccountView[]> {
    return (await this.req<{ accounts: AccountView[] }>('GET', '/accounts')).accounts;
  }
  async channels(): Promise<ChannelRow[]> {
    return (await this.req<{ channels: ChannelRow[] }>('GET', '/channels')).channels;
  }
  createChannel(
    input: { name: string; topic?: string; repo?: string; visibility?: 'public' | 'private' },
  ): Promise<ChannelRow> {
    return this.req('POST', '/channels', input);
  }

  /** 채널 멤버 목록. private 채널에서는 곧 '이 채널을 볼 수 있는 사람 전부'다. */
  async channelMembers(id: string): Promise<ChannelMemberRow[]> {
    return (await this.req<{ members: ChannelMemberRow[] }>('GET', `/channels/${id}/members`)).members;
  }

  /** 초대. 서버가 갱신된 목록을 돌려주므로 호출부가 다시 조회하지 않아도 된다. */
  async inviteChannelMember(id: string, accountId: string): Promise<ChannelMemberRow[]> {
    return (await this.req<{ members: ChannelMemberRow[] }>('POST', `/channels/${id}/members`, { accountId })).members;
  }

  async removeChannelMember(id: string, accountId: string): Promise<ChannelMemberRow[]> {
    return (await this.req<{ members: ChannelMemberRow[] }>('DELETE', `/channels/${id}/members/${accountId}`)).members;
  }

  /**
   * 채널을 편집한다.
   *
   * `topic` 은 간단한 옵션 값이다 — 값을 넣으면 갱신, 안 넣으면 기존 그대로.
   * `repo` 는 `null` (바인딩 해제)과 키 부재 (기존 그대로)를 **반드시 구분**해야 한다.
   * 호출자가 이 구분을 잃으면(빈 문자열을 보내거나 항상 두 필드를 다 보내면) 운영자가 topic 만
   * 고치려다 avcs 바인딩이 조용히 끊긴다.
   */
  updateChannel(
    id: string,
    input: { topic?: string; repo?: string | null; archived?: boolean; visibility?: 'public' | 'private' },
  ): Promise<ChannelRow> {
    return this.req('PATCH', `/channels/${id}`, input);
  }

  archiveChannel(id: string, archived: boolean): Promise<ChannelRow> {
    return this.updateChannel(id, { archived });
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
  /**
   * 링크가 가리키는 메시지 하나(#178). 채널 경로가 **아니다** — 링크를 받은 사람은 채널을
   * 모르고, 그것을 알려 주는 것이 이 응답의 `channelId`·`threadRootId` 다.
   *
   * 실패를 삼키지 않는다: 없는 메시지(404)·볼 수 없는 메시지(403)는 `ApiError` 로 올라가고
   * 호출부가 사람에게 보여 준다.
   */
  message(id: string): Promise<MessageRow> {
    return this.req('GET', `/messages/${id}`);
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
  /**
   * inbox 전체 — 읽은 것까지(#185). `inboxUnread` 와 갈라 두는 이유는 **쓰는 곳이 다른 것을
   * 물어보기 때문**이다: 배지·알림은 "아직 안 본 것"만 알면 되고(그래서 `?unread=1`),
   * 목록 화면은 읽은 것도 있어야 "안 읽음만" 필터가 고를 것이 생긴다. 안 읽은 것만 받아
   * 놓고 안 읽음 필터를 붙이면 그 스위치는 항상 참이라 아무것도 거르지 않는다.
   *
   * 서버 파라미터를 새로 만들지 않았다 — `GET /inbox` 는 `unread` 가 없으면 이미 전체를
   * 준다(`listInbox` 의 `unreadOnly` 기본값이 false).
   */
  async inbox(): Promise<InboxEntry[]> {
    return (await this.req<{ entries: InboxEntry[] }>('GET', '/inbox')).entries;
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

  async listPats(accountId: string): Promise<PatView[]> {
    const res = await this.req<{ pats: PatView[] }>('GET', `/accounts/${accountId}/pats`);
    return res.pats;
  }

  async revokePat(accountId: string, label: string): Promise<{ revoked: number }> {
    return this.req('DELETE', `/accounts/${accountId}/pats/${encodeURIComponent(label)}`);
  }

  updateAgent(id: string, patch: Partial<AgentConfig> & { displayName?: string }): Promise<AgentView> {
    return this.req('PATCH', `/accounts/agents/${id}`, patch);
  }

  /**
   * 러너에게 **종료를 요청한다**(#129). 재시작이 아니다 — murmur 는 러너를 띄우지 않으므로
   * 다시 띄우는 것은 사람의 몫이다. 정의 수정(PATCH)과 섞지 않고 별도 라우트인 이유:
   * 이 값은 운영자가 편집하는 정의가 아니라 러너에게 보내는 일회성 요청이다.
   *
   * 응답은 갱신된 정의다 — 목록을 다시 받지 않고도 요청 시각을 바로 그린다.
   */
  requestAgentStop(agentId: string): Promise<AgentView> {
    return this.req('POST', `/accounts/agents/${agentId}/stop`);
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

  async channelPrefs(): Promise<ChannelPrefRow[]> {
    return (await this.req<{ prefs: ChannelPrefRow[] }>('GET', '/channels/prefs')).prefs;
  }

  /** `muted` 는 없다 — `notifyLevel` 이 대체했다(#224). */
  updateChannelPref(channelId: string, patch: { notifyLevel?: NotifyLevel; starred?: boolean }): Promise<ChannelPrefRow> {
    return this.req('PATCH', `/channels/${channelId}/pref`, patch);
  }

  /**
   * #171: 새 에이전트의 기본값. admin 전용이다.
   * 실패를 여기서 삼키지 않는다 — 호출부가 "못 읽었다" 를 사람에게 보여야 한다.
   */
  agentDefaults(): Promise<AgentDefaults> {
    return this.req('GET', '/settings/agent-defaults');
  }

  /** model·effort 를 지우는 것은 **명시적 null** 이다 — 키를 빼면 '손대지 않음'이 된다. */
  updateAgentDefaults(patch: Partial<AgentDefaults>): Promise<AgentDefaults> {
    return this.req('PUT', '/settings/agent-defaults', patch);
  }

  /** #139: 에이전트 메모리 조회. MCP 는 에이전트 전용이라 사람은 이 REST 를 쓴다. */
  async agentMemory(agentId: string): Promise<{ slug: string; value: string; updatedAt: string }[]> {
    return (await this.req<{ memories: { slug: string; value: string; updatedAt: string }[] }>(
      'GET', `/accounts/agents/${agentId}/memory`,
    )).memories;
  }

  deleteAgentMemory(agentId: string, slug: string): Promise<void> {
    return this.req('DELETE', `/accounts/agents/${agentId}/memory/${encodeURIComponent(slug)}`);
  }

  /**
   * 채널에 고정된 메시지들(#218). **계정별 선호(`channelPrefs`)와 다른 표면이다** — 핀은
   * 채널 전역 상태라 누가 물어도 같은 답이 온다.
   */
  async pins(channelId: string): Promise<PinRow[]> {
    return (await this.req<{ pins: PinRow[] }>('GET', `/channels/${channelId}/pins`)).pins;
  }

  pinMessage(channelId: string, messageId: string): Promise<PinRow> {
    return this.req('POST', `/channels/${channelId}/pins`, { messageId });
  }

  /** 해제는 고정한 사람 또는 admin 만 된다 — 아니면 서버가 403 을 준다. */
  unpinMessage(channelId: string, messageId: string): Promise<void> {
    return this.req('DELETE', `/channels/${channelId}/pins/${messageId}`);
  }

  /**
   * #221: `channelId` 를 주면 서버가 질의를 좁힌다. 받아 온 결과를 여기서 거르지 않는 이유는
   * 전역 결과가 상위 N 건에서 잘려 이 채널 것이 아예 안 실려 올 수 있기 때문이다.
   */
  async search(q: string, channelId?: string | null): Promise<MessageRow[]> {
    const scope = channelId ? `&channelId=${encodeURIComponent(channelId)}` : '';
    return (await this.req<{ messages: MessageRow[] }>('GET', `/search?q=${encodeURIComponent(q)}${scope}`)).messages;
  }
}
