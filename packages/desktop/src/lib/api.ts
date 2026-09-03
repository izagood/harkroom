import type { AccountStatus, AddTeamToChannelResult, AgentConfig, AgentDefaults, AgentSessionView, AgentTeamMemberRow, AgentTeamRow, AgentView, AccountView, AttachmentRow, ChannelAutoMentionRow, ChannelDoc, ChannelFileRow, ChannelRow, ChannelMemberRow, ChannelPrefRow, DmView, HandleGroupRow, InboxEntry, LeaseRow, LinkPreviewView, MessageRow, NotifyLevel, PatView, PinRow, ProjectionStatus, SavedMessageRow, ScheduledMessageView } from '@murmur/shared';

export class ApiError extends Error {
  /**
   * 서버가 오류와 **함께 보낸 것**. 응답 본문을 그대로 들고 온다.
   *
   * 이것이 필요한 이유: 409 `doc_stale` 은 거절만 하지 않고 **현재 본문**을 함께 준다
   * (`{ error, doc }`). 그것을 여기서 버리면 화면이 "누가 먼저 고쳤다"고만 말하고 무엇이
   * 달라졌는지는 못 보여 준다 — 사람은 자기 편집을 버릴지 말지 판단할 근거가 없어진다.
   */
  constructor(
    public status: number, public code: string, message: string,
    public payload: unknown = null,
  ) {
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
      throw new ApiError(res.status, err?.code ?? 'unknown', err?.message ?? `HTTP ${res.status}`, json);
    }
    return json as T;
  }

  login(loginId: string, password: string): Promise<{ token: string }> {
    return this.req('POST', '/auth/login', { loginId, password });
  }
  bootstrap(loginId: string, handle: string, displayName: string, password: string): Promise<{ id: string }> {
    return this.req('POST', '/bootstrap', { loginId, handle, displayName, password });
  }
  /**
   * 초대 토큰으로 가입한다(#120). `bootstrap` 과 다른 점: 부트스트랩은 "첫 사람"이고 사람
   * 계정이 이미 있으면 409 로 막히지만, 이쪽은 admin 이 발급한 토큰을 쓴다.
   *
   * 세션을 돌려주지 않는다 — 서버가 `{ id }` 만 준다(`POST /auth/register`). 그래서 호출자가
   * 곧바로 `login` 을 이어 불러야 한다(부트스트랩도 같은 모양이다).
   */
  register(loginId: string, handle: string, displayName: string, password: string, inviteToken: string): Promise<{ id: string }> {
    return this.req('POST', '/auth/register', { loginId, handle, displayName, password, inviteToken });
  }
  me(): Promise<AccountView> { return this.req('GET', '/auth/me'); }
  /**
   * 내 handle 을 바꾼다(#271).
   */
  updateMyHandle(handle: string): Promise<{ handle: string }> {
    return this.req('PATCH', '/accounts/me/handle', { handle });
  }
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
  async accounts(): Promise<{ accounts: AccountView[]; groups: HandleGroupRow[] }> {
    return this.req<{ accounts: AccountView[]; groups: HandleGroupRow[] }>('GET', '/accounts');
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

  /** 채널을 영구히 삭제한다(#155). 보관된 표준 채널만 가능하고 admin 만 할 수 있다. */
  deleteChannel(id: string): Promise<void> {
    return this.req('DELETE', `/channels/${id}`);
  }

  /** 채널 삭제 전 확인용 메시지 수 조회(#155). */
  async deleteChannelInfo(id: string): Promise<{ name: string; messageCount: number }> {
    return this.req('GET', `/channels/${id}/delete-info`);
  }
  async dms(): Promise<DmView[]> {
    return (await this.req<{ dms: DmView[] }>('GET', '/dms')).dms;
  }
  async leases(): Promise<LeaseRow[]> {
    return (await this.req<{ leases: LeaseRow[] }>('GET', '/leases')).leases;
  }
  /** avcs 투영 상태(#267). */
  async projectionStatus(): Promise<ProjectionStatus> {
    return this.req<ProjectionStatus>('GET', '/projection/status');
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
    attachmentIds: string[] = [], alsoInChannel?: boolean,
  ): Promise<MessageRow> {
    return this.req('POST', `/channels/${channelId}/messages`,
      {
        body,
        ...(threadRootId ? { threadRootId } : {}),
        // 빈 배열은 보내지 않는다 — 첨부를 쓰지 않는 요청의 본문을 넓히지 않는다.
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(alsoInChannel ? { alsoInChannel } : {}),
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
   * 에이전트를 비활성화하거나 다시 활성화한다(#251). 설정 저장이 아니라 감사 대상 생애주기
   * 상태이므로 `updateAgent` 와 별도 메서드로 둔다. 요청 본문은 `{ disabled }` 하나만 보내며,
   * 다른 필드를 보내면 서버가 거절한다.
   */
  setAgentDisabled(id: string, disabled: boolean): Promise<AgentView> {
    return this.req('PATCH', `/accounts/agents/${id}`, { disabled });
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

  /**
   * 진행 중인 에이전트 PTY 세션 목록(#141). **내가 볼 수 있는 것만 온다** — 소유하지
   * 않은 에이전트의 세션은 목록에 아예 없다(403 이 아니라 부재다).
   */
  async agentSessions(): Promise<AgentSessionView[]> {
    const res = await this.req<{ sessions: AgentSessionView[] }>('GET', '/agent-sessions');
    return res.sessions;
  }

  /**
   * 세션 하나에 attach 한다. 인가는 **여기서** 끝난다 — 돌려받는 티켓은 그 세션 하나에만
   * 쓸 수 있는 1회용이고, WS 핸드셰이크는 그 티켓만 소모한다.
   */
  attachAgentSession(sessionId: string): Promise<{ ticket: string; session: AgentSessionView }> {
    return this.req('POST', `/agent-sessions/${sessionId}/attach`);
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

  /**
   * 아바타 바이트를 받는다(#159). `fetchAttachment` 과 같은 이유로 토큰을 URL 에 넣지 않고,
   * 받은 blob 으로 objectURL 을 만들어 그린다. 첨부와 **다른 라우트**인 이유: 첨부 다운로드는
   * 메시지에 붙지 않은 업로드를 올린 사람에게만 내주고, 아바타는 영원히 메시지에 붙지 않는다.
   */
  async fetchAvatar(accountId: string): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/accounts/${accountId}/avatar`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'avatar_failed', `HTTP ${res.status}`);
    return res.blob();
  }

  /**
   * 내 아바타를 정하거나(첨부 id) 지운다(**명시적 null**). 키를 생략하지 않는다 —
   * `undefined` 는 `JSON.stringify` 가 버려서 지우기가 조용히 무시된다.
   */
  setAvatar(attachmentId: string | null): Promise<{ avatarAttachmentId: string | null }> {
    return this.req('PUT', '/accounts/me/avatar', { attachmentId });
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
  updateChannelPref(
    channelId: string,
    patch: { notifyLevel?: NotifyLevel; starred?: boolean; section?: string | null; sortOrder?: number | null },
  ): Promise<ChannelPrefRow> {
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
   * 이 채널에 오간 파일들(#232). `before` 는 메시지 seq 커서다 — 메시지 목록의 `before` 와
   * 같은 단위이므로, 파일 하나를 누르면 그 seq 로 대화를 찾아 들어갈 수 있다.
   */
  channelFiles(
    channelId: string, opts?: { before?: number; limit?: number },
  ): Promise<{ files: ChannelFileRow[]; hasMore: boolean }> {
    const q = new URLSearchParams();
    if (opts?.before !== undefined) q.set('before', String(opts.before));
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
    const qs = q.size ? `?${q.toString()}` : '';
    return this.req('GET', `/channels/${channelId}/files${qs}`);
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
   * 채널이 자동으로 멘션하는 에이전트들(#173). 핀과 같은 채널 전역 사실이라 채널을 볼 수
   * 있는 사람 누구나 받는다 — 작성창이 칩을 그려야 하기 때문이다.
   */
  async channelAutoMentions(channelId: string): Promise<ChannelAutoMentionRow[]> {
    return (await this.req<{ autoMentions: ChannelAutoMentionRow[] }>('GET', `/channels/${channelId}/auto-mentions`)).autoMentions;
  }

  /** 건다. admin 이 아니면 서버가 403, 에이전트가 아니거나 비활성이면 400 을 준다. */
  setChannelAutoMention(channelId: string, agentAccountId: string): Promise<ChannelAutoMentionRow> {
    return this.req('PUT', `/channels/${channelId}/auto-mentions/${agentAccountId}`);
  }

  unsetChannelAutoMention(channelId: string, agentAccountId: string): Promise<void> {
    return this.req('DELETE', `/channels/${channelId}/auto-mentions/${agentAccountId}`);
  }

  /**
   * #221: `channelId` 를 주면 서버가 질의를 좁힌다. 받아 온 결과를 여기서 거르지 않는 이유는
   * 전역 결과가 상위 N 건에서 잘려 이 채널 것이 아예 안 실려 올 수 있기 때문이다.
   */
  async search(q: string, channelId?: string | null): Promise<MessageRow[]> {
    const scope = channelId ? `&channelId=${encodeURIComponent(channelId)}` : '';
    return (await this.req<{ messages: MessageRow[] }>('GET', `/search?q=${encodeURIComponent(q)}${scope}`)).messages;
  }

  /**
   * 링크 미리보기 카드(#215). 아직 없으면 서버가 404 를 준다 — **여기서 삼키지 않는다.**
   * 삼키면 "아직 안 왔다"와 "요청이 실패했다"가 한 값이 되고, 그러면 호출부가 다시 읽을
   * 이유를 판단할 수 없다. 카드가 장식이라 조용히 넘어가는 판단은 호출부(`LinkPreview`)가 한다.
   */
  getLinkPreview(url: string): Promise<LinkPreviewView> {
    return this.req<LinkPreviewView>('GET', `/link-previews?url=${encodeURIComponent(url)}`);
  }

  /** 이 채널에서 내가 예약한 메시지 목록(#222). */
  async scheduledMessages(channelId: string): Promise<ScheduledMessageView[]> {
    return (await this.req<{ scheduled: ScheduledMessageView[] }>('GET', `/channels/${channelId}/scheduled`)).scheduled;
  }

  /**
   * 예약 메시지 생성(#222). 서버는 목록과 **같은 봉투**(`{ scheduled }`)로 답한다 —
   * 여기서 벗겨 호출부에는 뷰 하나만 준다.
   */
  async scheduleMessage(channelId: string, body: string, sendAt: string, threadRootId?: string): Promise<ScheduledMessageView> {
    return (await this.req<{ scheduled: ScheduledMessageView }>(
      'POST', `/channels/${channelId}/scheduled`, { body, sendAt, ...(threadRootId ? { threadRootId } : {}) },
    )).scheduled;
  }

  /** 예약 메시지 취소(#222). */
  cancelScheduledMessage(id: string): Promise<void> {
    return this.req('DELETE', `/scheduled/${id}`);
  }

  /**
   * 채널 문서 조회(#188). 가시성은 서버가 검사한다. 아직 저장된 것이 없으면 본문 `''` 이고
   * `updatedBy`·`updatedAt` 이 `null` 인 문서가 온다 — "아직 아무도"다.
   */
  async channelDoc(channelId: string): Promise<ChannelDoc> {
    return this.req('GET', `/channels/${channelId}/doc`);
  }

  /**
   * 채널 문서 저장(#188). `expectedUpdatedAt` 은 내가 읽은 판의 시각(epoch ms)이고,
   * 아직 문서가 없다고 믿을 때는 `null` 이다 — 서버가 "검사 생략"으로 읽지 않는다.
   *
   * 서버가 어긋남을 보면 409 `doc_stale` 을 던진다. 그 `ApiError.payload.doc` 에 **현재
   * 본문**이 들어 있으므로 호출부가 그것을 사람에게 보여 줄 수 있다.
   */
  async updateChannelDoc(
    channelId: string, body: string, expectedUpdatedAt: number | null,
  ): Promise<ChannelDoc> {
    return this.req('PUT', `/channels/${channelId}/doc`, { body, expectedUpdatedAt });
  }

  // #219: `state` 는 **필수**다 — 기본값을 여기서 공급하면 호출부가 어느 탭을 받는지 적지
  // 않아도 통과하고, 그 화면은 늘 '할 것'만 보게 된다.
  async savedMessages(state: 'open' | 'done'): Promise<SavedMessageRow[]> {
    return (await this.req<{ entries: SavedMessageRow[] }>('GET', `/saved?state=${state}`)).entries;
  }

  savedSummary(): Promise<{ openCount: number; messageIds: string[] }> {
    return this.req('GET', '/saved/summary');
  }

  saveMessage(messageId: string): Promise<SavedMessageRow> {
    return this.req('PUT', `/saved/${messageId}`);
  }

  updateSavedMessage(messageId: string, state: 'open' | 'done'): Promise<SavedMessageRow> {
    return this.req('PATCH', `/saved/${messageId}`, { state });
  }

  unsaveMessage(messageId: string): Promise<void> {
    return this.req('DELETE', `/saved/${messageId}`);
  }

  /**
   * 핸들 집합 관리(#285). `GET /handle-groups` 를 여기 두지 않는 이유: 그 라우트는
   * **admin 전용**이고, 집합 목록은 `GET /accounts`(모든 계정)가 계정과 함께 이미 준다.
   * 두 경로로 같은 목록을 받으면 비-admin 화면에서 한쪽이 403 이 되고, 그 403 이
   * "집합이 없다"로 그려진다 — `HandleGroupsSettings` 의 주석이 그 결정을 적는다.
   */
  async createHandleGroup(input: { handle: string; displayName: string }): Promise<HandleGroupRow> {
    return this.req('POST', '/handle-groups', input);
  }

  async getHandleGroup(id: string): Promise<{ group: HandleGroupRow; members: string[] }> {
    return this.req('GET', `/handle-groups/${id}`);
  }

  async updateHandleGroup(id: string, patch: { displayName: string }): Promise<HandleGroupRow> {
    return this.req('PATCH', `/handle-groups/${id}`, patch);
  }

  async deleteHandleGroup(id: string): Promise<void> {
    return this.req('DELETE', `/handle-groups/${id}`);
  }

  async addHandleGroupMembers(id: string, accountIds: string[]): Promise<{ members: string[] }> {
    return this.req('POST', `/handle-groups/${id}/members`, { accountIds });
  }

  async removeHandleGroupMembers(id: string, accountIds: string[]): Promise<{ members: string[] }> {
    return this.req('DELETE', `/handle-groups/${id}/members`, { accountIds });
  }

  async teams(): Promise<AgentTeamRow[]> {
    return (await this.req<{ teams: AgentTeamRow[] }>('GET', '/teams')).teams;
  }

  createTeam(name: string): Promise<AgentTeamRow> {
    return this.req('POST', '/teams', { name });
  }

  updateTeam(id: string, name: string): Promise<AgentTeamRow> {
    return this.req('PATCH', `/teams/${id}`, { name });
  }

  deleteTeam(id: string): Promise<void> {
    return this.req('DELETE', `/teams/${id}`);
  }

  async team(id: string): Promise<{ team: AgentTeamRow; members: AgentTeamMemberRow[] }> {
    return this.req('GET', `/teams/${id}`);
  }

  addTeamMember(teamId: string, accountId: string): Promise<{ members: AgentTeamMemberRow[] }> {
    return this.req('PUT', `/teams/${teamId}/members/${accountId}`);
  }

  removeTeamMember(teamId: string, accountId: string): Promise<{ members: AgentTeamMemberRow[] }> {
    return this.req('DELETE', `/teams/${teamId}/members/${accountId}`);
  }

  addTeamToChannel(channelId: string, teamId: string): Promise<AddTeamToChannelResult> {
    return this.req('POST', `/channels/${channelId}/teams/${teamId}/add`);
  }
}
