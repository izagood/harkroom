import type { AccountStatus, AddTeamToChannelResult, AgentConfig, AgentDefaults, AgentSessionView, AgentTeamMemberRow, AgentTeamRow, AgentView, AccountView, AttachmentRow, ChannelAutoMentionRow, ChannelDoc, ChannelFileRow, ChannelRow, ChannelMemberRow, ChannelPrefRow, DmView, HandleGroupRow, InboxEntry, LeaseRow, LinkPreviewView, MessageRow, NotifyLevel, PatView, PinRow, ProjectionConfigView, ProjectionStatus, SavedMessageRow, ScheduledMessageView, WorkspaceSkillView } from '@murmur/shared';
import { readNotifiedHeaders, type NotifiedResult } from './notified';

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

  /**
   * 본문과 **응답 헤더를 함께** 낸다.
   *
   * 이 통로가 필요한 이유: `req` 는 본문만 돌려주고 `Response` 를 그 자리에서 버린다.
   * 그런데 서버는 응답의 **부수 사실**을 헤더로 싣는 관례가 있고(`NOTIFIED_HEADER` 주석 —
   * 본문은 `MessageRow` 그 자체로 남아야 하므로 형제 키를 얹을 수 없다), 그 사실을 읽으려면
   * 헤더가 버려지기 전에 붙잡아야 한다. `attachmentRoutes`·`avatarRoutes` 도 같은 관례를 쓴다.
   *
   * `req` 를 이 함수로 감싸고 **`req` 의 시그니처는 한 글자도 바꾸지 않는다**: 헤더가 필요한
   * 호출부는 지금 하나뿐인데, 그것 때문에 100 곳이 넘는 나머지 호출부가 봉투를 벗기게 되면
   * 헤더를 안 읽는 자리마다 `.body` 가 붙는다. 필요한 곳만 이쪽을 부른다.
   */
  private async reqWithHeaders<T>(
    method: string, path: string, body?: unknown, extra?: Record<string, string>,
  ): Promise<{ body: T; headers: Headers }> {
    const headers: Record<string, string> = { ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return { body: undefined as T, headers: res.headers };
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(res.status, err?.code ?? 'unknown', err?.message ?? `HTTP ${res.status}`, json);
    }
    return { body: json as T, headers: res.headers };
  }

  private async req<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
    return (await this.reqWithHeaders<T>(method, path, body, extra)).body;
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
  /**
   * 디렉터리 한 번. 계정·집합·팀이 **한 응답에** 온다 — 셋 다 멘션 자동완성의 후보이고,
   * 후보 목록을 세 요청으로 나누면 그 중 하나만 실패했을 때 부를 수 있는 이름의 일부만
   * 보이는 화면이 된다.
   *
   * `teams` 가 옵셔널인 이유는 옛 서버다 — `AgentTeamRow.memberCount` 는 필수지만 이
   * 필드 자체는 팀 멘션(#172) 이전 서버에는 없다. 없으면 팀이 후보에 안 서는 것이 맞다:
   * 그 서버는 팀을 부르지 못하므로 후보에 세우면 아무도 안 깨는 이름을 가르치게 된다.
   */
  async accounts(): Promise<{ accounts: AccountView[]; groups: HandleGroupRow[]; teams?: AgentTeamRow[] }> {
    return this.req<{ accounts: AccountView[]; groups: HandleGroupRow[]; teams?: AgentTeamRow[] }>('GET', '/accounts');
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
    opts?: { since?: number; before?: number; around?: number; limit?: number; thread?: string },
  ): Promise<{ messages: MessageRow[]; hasMore: boolean }> {
    const q = new URLSearchParams();
    if (opts?.since !== undefined) q.set('since', String(opts.since));
    if (opts?.before !== undefined) q.set('before', String(opts.before));
    if (opts?.around !== undefined) q.set('around', String(opts.around));
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
  /**
   * 메시지를 보낸다. **본문과 함께 "누가 불렸는지"를 낸다**(계획 Task 8 Step 3).
   *
   * 왜 `MessageRow` 하나가 아니라 봉투인가: 집합·`@channel` 을 펼친 결과는 서버만 안다.
   * 그리고 그 사실은 `MessageRow` 에 **없다** — 헤더로 오기 때문이고, 그것이 헤더인 이유는
   * `NOTIFIED_HEADER` 주석에 있다(본문에 형제 키를 얹으면 WebSocket 으로 오는 같은 메시지와
   * 모양이 갈린다). 여기서 헤더를 버리면 화면은 "셋을 불러 둘만 깼다"를 말할 재료가 없고,
   * 그것이 정본 문서가 **조용한 실패**로 부르는 것이다.
   *
   * 호출부가 둘뿐이라(`controller.send`·`controller.reply`) 별도 메서드를 만들지 않고 이
   * 메서드의 반환형을 넓혔다 — 두 메서드로 두면 한쪽만 고쳐지는 자리가 생기고, 그때 어느
   * 경로로 보낸 메시지인지에 따라 부름의 결과가 보이거나 보이지 않는다.
   */
  async postMessage(
    channelId: string, body: string, threadRootId?: string, idempotencyKey?: string,
    attachmentIds: string[] = [], alsoInChannel?: boolean,
  ): Promise<{ message: MessageRow; notified: NotifiedResult }> {
    const res = await this.reqWithHeaders<MessageRow>('POST', `/channels/${channelId}/messages`,
      {
        body,
        ...(threadRootId ? { threadRootId } : {}),
        // 빈 배열은 보내지 않는다 — 첨부를 쓰지 않는 요청의 본문을 넓히지 않는다.
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(alsoInChannel ? { alsoInChannel } : {}),
      },
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined);
    return { message: res.body, notified: readNotifiedHeaders(res.headers) };
  }
  /**
   * 선택 요청에 답한다. 답은 원본의 `meta.ask` 에 기록되므로 갱신된 **그 메시지**가 돌아온다.
   * 이미 답이 있으면 서버가 409 를 준다 — 먼저 누른 쪽이 이긴다.
   */
  answerAsk(channelId: string, messageId: string, optionId: string): Promise<MessageRow> {
    return this.req('POST', `/channels/${channelId}/messages/${messageId}/ask-answer`, { optionId });
  }
  /** 답하지 않기로 한다 — 고른 것 없이 그 물음을 닫는다(2026-09-09). */
  closeAsk(channelId: string, messageId: string): Promise<MessageRow> {
    return this.req('POST', `/channels/${channelId}/messages/${messageId}/ask-close`, {});
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

  /**
   * 메시지를 지운다. **돌아오는 것이 두 가지다.**
   *
   * 보통은 204(=`undefined`) 다 — 행이 사라졌다. 답글이 남은 스레드 머리를 지웠을 때만
   * 200 으로 **자리표시자 행**이 온다(본문·첨부·리액션이 떼어진 행). 그 스레드는 계속
   * 열려 있어야 하므로 부른 쪽은 목록에서 빼는 대신 이 행을 덮는다.
   */
  deleteMessage(channelId: string, messageId: string): Promise<MessageRow | undefined> {
    return this.req('DELETE', `/channels/${channelId}/messages/${messageId}`);
  }

  /**
   * 채널로 함께 올린 스레드 답을 채널에서 거둔다(#231 되돌리기). 메시지는 지우지 않는다 —
   * 갱신된 행이 돌아오고 `alsoInChannel` 만 false 다.
   */
  recallFromChannel(channelId: string, messageId: string): Promise<MessageRow> {
    return this.req('DELETE', `/channels/${channelId}/messages/${messageId}/also-in-channel`);
  }

  /**
   * 이미 쓴 스레드 답을 나중에 채널로 올린다 — 거두기와 **같은 자원의 PUT** 이다.
   * 새 메시지를 만들지 않으므로 돌아오는 것은 갱신된 같은 행이고 `alsoInChannel` 만 true 다.
   */
  postToChannel(channelId: string, messageId: string): Promise<MessageRow> {
    return this.req('PUT', `/channels/${channelId}/messages/${messageId}/also-in-channel`);
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
   * 그 종료 요청을 **되돌린다**(#427). `requestAgentStop` 의 대칭이다.
   *
   * 러너를 지금 띄우는 것이 아니다 — 지우는 것은 정의의 시각 둘이고, 그러면 **다음 기동
   * 때** 자동 기동 대상에 다시 들어온다(`runnerLauncher.startAll` 의 `!a.stopRequestedAt`
   * 필터). 그래서 이름이 `startAgent` 가 아니다.
   *
   * 요청이 없던 에이전트에 불러도 200 이다 — 부르는 쪽이 원한 상태가 이미 성립해 있는
   * 것이라 실패가 아니다(서버 `undoAgentStopRequest` 주석). 응답은 요청과 마찬가지로
   * 갱신된 정의라, 목록을 다시 받지 않고도 지워진 사실을 바로 그린다.
   */
  undoAgentStopRequest(agentId: string): Promise<AgentView> {
    return this.req('POST', `/accounts/agents/${agentId}/stop/undo`);
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
   *
   * 쓰기 차례는 이 응답에 없다 — attach 뒤 서버가 소켓으로 `writer` 프레임을 보내 알린다
   * (스펙 §5-2 결정 2, `agentTerminal.ts::AttachCallbacks.onWriter`). 응답에 실으면 attach
   * 시점의 판정이 얼어붙어, 다른 창이 붙고 떠나며 차례가 오가는 사실을 담지 못한다.
   */
  attachAgentSession(sessionId: string): Promise<{ ticket: string; session: AgentSessionView }> {
    return this.req('POST', `/agent-sessions/${sessionId}/attach`);
  }

  /**
   * 도는 턴 하나를 **그만두게 한다**(Agents 관제 3단계). 러너가 그 턴의 PTY 에 SIGTERM 을
   * 보낸다.
   *
   * **러너 종료(`stopAgent`)와 다른 일이다** — 이쪽은 러너가 살아 있어 다음 멘션을
   * 정상으로 받는다. 두 호출을 한 버튼에 묶지 마라: 사람은 폭주를 멈추려고 팀원을 해고한다.
   *
   * 성공은 `202` 이고 **끝났다는 뜻이 아니다**: 하네스가 SIGTERM 을 정리하는 시간이 있고,
   * 끝의 증거는 그 턴이 스레드에 남기는 실패 카드다. 그래서 화면은 이 프라미스가 풀린
   * 것으로 "중단됐다"고 말하지 않고 목록이 사라지는 것으로 말한다.
   *
   * 404 는 실패로 다루지 않는 편이 낫다 — 누르는 사이에 턴이 스스로 끝난 것이고(26초짜리
   * 턴에서 흔하다), 사람이 원한 결과와 같다. 409 는 사유가 둘이다(`no_runner` ·
   * `runner_outdated`) — 사람이 할 일이 다르므로 문구를 뭉치지 않는다.
   */
  cancelAgentSession(sessionId: string): Promise<{ ok: true }> {
    return this.req('POST', `/agent-sessions/${sessionId}/cancel`);
  }

  /**
   * 진행 중인 턴이 없어도 스스로 인터랙티브 터미널을 연다(#337, 스펙 §5-2 결정 4).
   * 세션이 아니라 **스레드**를 가리킨다 — 러너가 세션을 확보(없으면 생성)해 인터랙티브
   * PTY 를 띄우고, 응답의 티켓은 attach 와 같은 1회용이라 기존 attach 흐름에 그대로
   * 합류한다. 실패(러너 오프라인 404 / 구버전 409 / codex 거절 409 / 응답 없음 504)는
   * 서버 문구 그대로 ApiError 로 던진다 — 화면이 그 문구를 그대로 보여준다.
   */
  /**
   * 인터랙티브 터미널을 연다(#337). 진행 중인 턴이 있으면 러너가 그 세션을 그대로 주고,
   * 없으면 새 PTY 를 띄운다 — 어느 쪽이든 티켓 하나로 수렴한다.
   */
  openInteractiveSession(
    agentAccountId: string, channelId: string, threadRootId: string,
  ): Promise<{ ticket: string; session: AgentSessionView; waiting: boolean }> {
    return this.req('POST', '/agent-sessions/interactive', { agentAccountId, channelId, threadRootId });
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
   *
   * **`fetch` 가 아니라 `XMLHttpRequest` 다.** 이유는 하나뿐이다: fetch 는 요청 바디가
   * 얼마나 갔는지 알려 주지 않는다(`ReadableStream` 업로드는 아직 이 런타임에서 못 쓴다).
   * 진행률을 못 받으면 화면이 "올리는 중"을 **길이 없는 스피너**로만 그릴 수 있고, 그러면
   * 큰 파일에서 멈춘 것과 가는 중인 것이 구별되지 않는다 — 사람이 오류로 읽는 자리다.
   *
   * `onProgress` 는 0~1 이다. 서버가 total 을 안 주는 경우(`lengthComputable === false`)에는
   * **부르지 않는다** — 가짜 비율을 그리면 막대가 거짓말을 한다.
   */
  upload(file: File, onProgress?: (fraction: number) => void): Promise<AttachmentRow> {
    const form = new FormData();
    form.append('file', file);
    return new Promise<AttachmentRow>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.baseUrl}/uploads`);
      if (this.token) xhr.setRequestHeader('authorization', `Bearer ${this.token}`);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
        };
      }
      xhr.onload = () => {
        // 바이트가 다 간 뒤에도 서버가 저장·검증을 하는 동안은 응답이 안 온다. 그 구간을
        // 100% 로 못박아 둔다 — 99% 에서 멈춘 막대는 실패처럼 보인다.
        onProgress?.(1);
        let body: unknown = null;
        try { body = JSON.parse(xhr.responseText) as unknown; } catch { body = null; }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body as AttachmentRow);
          return;
        }
        const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
        reject(new ApiError(xhr.status, err?.code ?? 'upload_failed', err?.message ?? `HTTP ${xhr.status}`));
      };
      // 네트워크가 끊긴 경우다. status 는 0 이라 위의 분기로는 잡히지 않는다.
      xhr.onerror = () => reject(new ApiError(0, 'upload_failed', 'network error'));
      xhr.onabort = () => reject(new ApiError(0, 'upload_aborted', 'aborted'));
      xhr.send(form);
    });
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
  /**
   * 에이전트의 사진. **자기 사진을 올릴 손이 없으므로** 소유자·admin 이 대신 건다
   * (서버가 `requireOwnerOrAdmin` 으로 판정한다).
   */
  setAgentAvatar(
    agentId: string, attachmentId: string | null,
  ): Promise<{ avatarAttachmentId: string | null }> {
    return this.req('PUT', `/accounts/agents/${agentId}/avatar`, { attachmentId });
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
    patch: {
      notifyLevel?: NotifyLevel; starred?: boolean; section?: string | null; sortOrder?: number | null;
      /** 사이드바에서 치우기(#376). 시각이 아니라 불리언 — "언제 숨겼나"는 서버가 정한다. */
      hidden?: boolean;
    },
  ): Promise<ChannelPrefRow> {
    return this.req('PATCH', `/channels/${channelId}/pref`, patch);
  }

  /** 섹션 이름 바꾸기(#323). 새 이름이 이미 존재하면 합친다. */
  renameSection(oldName: string, newName: string | null): Promise<{ prefs: ChannelPrefRow[] }> {
    return this.req('PATCH', `/channels/sections/${encodeURIComponent(oldName)}`, { name: newName });
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

  /**
   * 투영 설정. **admin 전용 라우트다** — admin 이 아니면 403 이고, 호출부는 그것을 오류로
   * 그리지 않는다(권한이 없는 것은 고장이 아니다).
   *
   * 실패를 여기서 삼키지 않는다 — 호출부가 "못 읽었다" 를 사람에게 보여야 한다.
   */
  projectionConfig(): Promise<ProjectionConfigView> {
    return this.req('GET', '/settings/projection');
  }

  /** 지우기는 **명시적 null** 이다 — 키를 빼면 `JSON.stringify` 가 버려 '손대지 않음'이 된다. */
  setProjectionConfig(url: string | null): Promise<ProjectionConfigView> {
    return this.req('PUT', '/settings/projection', { url });
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
  async search(
    q: string,
    scope: { channelId?: string | null; threadRootId?: string | null; offset?: number } = {},
  ): Promise<{ messages: MessageRow[]; hasMore: boolean }> {
    const params = new URLSearchParams({ q });
    if (scope.channelId) params.set('channelId', scope.channelId);
    if (scope.threadRootId) params.set('threadRootId', scope.threadRootId);
    if (scope.offset) params.set('offset', String(scope.offset));
    return await this.req<{ messages: MessageRow[]; hasMore: boolean }>('GET', `/search?${params.toString()}`);
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

  /**
   * 워크스페이스 스킬 목록(#311). 목록은 로그인한 사람 모두 볼 수 있다(`requireAccount`).
   *
   * 라우트는 **배열을 그대로** 돌려준다 — `{ skills: [...] }` 로 감싸지 않는다.
   * (초판이 `.skills` 를 꺼내려다 `undefined` 를 받아 화면이 통째로 죽었다.)
   *
   * #325 — `state` 파라미터로 필터링한다. 없으면 전부다.
   */
  listSkills(state?: 'pending' | 'approved' | 'disabled'): Promise<WorkspaceSkillView[]> {
    const query = state ? `?state=${state}` : '';
    return this.req('GET', `/skills${query}`);
  }

  /** 스킬 상세. 본문은 곧 시스템 프롬프트이므로 인증이 필요하다. */
  async getSkill(slug: string): Promise<WorkspaceSkillView> {
    return this.req<WorkspaceSkillView>('GET', `/skills/${encodeURIComponent(slug)}`);
  }

  /** 스킬 승인(#311). admin 전용. */
  approveSkill(slug: string): Promise<WorkspaceSkillView> {
    return this.req('POST', `/skills/${encodeURIComponent(slug)}/approve`);
  }

  /** 스킬 비활성화/거부(#311). admin 전용. */
  disableSkill(slug: string): Promise<WorkspaceSkillView> {
    return this.req('DELETE', `/skills/${encodeURIComponent(slug)}`);
  }
}
