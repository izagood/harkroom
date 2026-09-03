import type { AccountStatus, AttachmentRow, ChannelRow, ChannelMemberRow, ChannelPrefRow, MessageRow, WsServerEvent } from '@murmur/shared';
import { ApiError, type ApiClient } from '../lib/api';
import { connectWs, type WsDownReason, type WsHandle } from '../lib/ws';
import { sessionStore } from '../lib/session';
import { silentNotifier, type Notifier } from '../lib/notify';
import { useAppStore } from './appStore';
import { sortSweepItems, sweepLabel, type SweepItem } from './sweep';
import { usePrefsStore } from './prefsStore';

export class Controller {
  private ws: WsHandle | null = null;
  private unreadFetchSeq = 0;
  /** 히스토리를 이미 통째로 받은 채널. 이 집합에 없으면 openChannel이 증분이 아니라 전체를 받는다. */
  private loadedChannels = new Set<string>();
  /** 이미 알린 inbox 항목. 같은 항목을 두 번 알리면 알림이 쓸모없어진다. */
  private announced = new Set<number>();

  constructor(
    public api: ApiClient,
    private makeWs: typeof connectWs = connectWs,
    private notifier: Notifier = silentNotifier,
    /**
     * 세션이 되돌릴 수 없이 죽었을 때 호출된다(자격증명 폐기·origin 거부).
     * 컨트롤러는 화면을 모르므로 사유 문구만 위로 올리고, 무엇을 보여줄지는 App 이 정한다.
     * #164: accountId 파라미터가 추가되어 어느 커뮤니티의 세션이 죽었는지 알 수 있다.
     */
    private onSessionLost: (message: string, accountId: string) => void = () => {},
  ) {}

  // fire-and-forget 호출의 unhandled rejection 방지 — 실패는 조용히 무시(다음 이벤트/리컨실이 자연 복구).
  private swallow(p: Promise<unknown>): void { void p.catch(() => {}); }

  async start(): Promise<void> {
    const store = useAppStore.getState();
    const [me, accounts, channels, dms, leases, unread, reads] = await Promise.all([
      this.api.me(), this.api.accounts(), this.api.channels(),
      this.api.dms(), this.api.leases(), this.api.inboxUnread(), this.api.reads(),
    ]);
    store.set({
      me, channels, dms, leases, unread,
      accounts: Object.fromEntries(accounts.map((a) => [a.id, a])),
      reads: Object.fromEntries(reads.map((r) => [r.channelId, { lastReadSeq: r.lastReadSeq, unread: r.unread }])),
    });
    // 초안은 기기 로컬에 있으므로 서버 왕복이 없다 — 크리티컬 패스에 둬도 비용이 없다.
    store.hydrateDrafts();

    // 채널 선호는 **크리티컬 패스에서 뺀다.** 위 Promise.all 에 넣으면 이 엔드포인트가
    // 없는 서버(구버전)에 붙었을 때 앱이 기동조차 못 한다. 선호는 UI 편의값이라 없으면
    // 정렬이 이름순으로 남을 뿐이다 — `refreshAccounts` 가 같은 이유로 실패를 삼킨다.
    this.swallow(this.api.channelPrefs().then((prefs) => {
      useAppStore.getState().set({ channelPrefs: Object.fromEntries(prefs.map((p) => [p.channelId, p])) });
    }));
    // 앱을 열자마자 쌓여 있던 미읽음이 한꺼번에 터지면 알림이 소음이 된다.
    for (const e of unread) this.announced.add(e.id);
    // 장기 토큰은 ApiClient 가 헤더로만 쓴다 — WS URL 에는 단기 티켓만 실린다.
    this.ws = this.makeWs(this.api.baseUrl, () => this.api.wsTicket(), {
      onEvent: (e) => this.handleEvent(e),
      onOpen: () => { useAppStore.getState().set({ connected: true }); this.swallow(this.reconcile()); },
      onDown: (reason) => this.handleDown(reason),
    });
  }

  stop(): void { this.ws?.close(); this.ws = null; }

  /** 문구는 UI 문자열이라 영어다(저장소 관례). 사유별로 다른 이유: 사용자가 할 일이 다르다. */
  private static readonly LOST_MESSAGE: Record<Exclude<WsDownReason, 'network'>, string> = {
    credential: 'Your session is no longer valid — it expired, or it was signed out elsewhere. Please sign in again.',
    origin: "The server rejected this app's origin. Ask the server administrator to allow it (CORS_ORIGINS).",
  };

  private handleDown(reason: WsDownReason): void {
    useAppStore.getState().set({ connected: false });
    // 네트워크 끊김은 기다리면 낫는다 — 세션을 건드리지 않는다. 잠깐 끊겼다고 로그아웃시키면 최악이다.
    if (reason === 'network') return;
    // 되돌릴 수 없는 사유다. 로컬 상태를 비우고 사유를 위로 올린다 — 안 그러면 사용자는
    // 빨간 점과 영구 재연결만 본다(조용한 실패).
    // **`me` 를 먼저 읽는다.** `clearLocal()` 이 스토어를 reset 하므로 그 뒤에 읽으면
    // 항상 null 이고, accountId 가 빈 문자열이 되어 App 이 활성 커뮤니티를 못 알아본다.
    const accountId = useAppStore.getState().me?.id ?? '';
    this.clearLocal(accountId);
    this.onSessionLost(Controller.LOST_MESSAGE[reason], accountId);
  }

  /** 서버 호출 없이 로컬만 비운다. 이미 죽은 자격증명으로 로그아웃을 보내는 것은 무의미하다. */
  /**
   * `accountId` 를 주면 **그 커뮤니티만** 보관소에서 뺀다(#164). 세션 하나가 죽었다고
   * 나머지 커뮤니티의 토큰까지 지우면 사용자가 그 커뮤니티들을 통째로 잃는다.
   * 주지 않으면(명시적 로그아웃) 전부 지운다.
   */
  private clearLocal(accountId?: string): void {
    this.stop();
    // 키체인 삭제는 비동기다. 로그아웃이 그것을 기다릴 이유는 없다 — 실패해도 다음 기동의
    // load()가 다시 정리를 시도하고, 로컬 상태는 아래에서 즉시 비워진다.
    this.swallow(accountId ? sessionStore.remove(accountId) : sessionStore.clear());
    // 초안은 사용자가 쓴 문장 전체다. 계정이 로그아웃된 뒤에도 디스크에 남으면
    // #92(argv 노출)와 PAT 키체인 결정이 세운 기준과 어긋난다. 스토어 액션이
    // 인메모리와 보관소를 함께 비운다 — 보관소만 지우면 스토어에 남는다.
    useAppStore.getState().clearDrafts();
    useAppStore.getState().reset();
  }

  private handleEvent(e: WsServerEvent): void {
    const store = useAppStore.getState();
    switch (e.type) {
      case 'message.created':
        store.upsertMessages(e.message.channelId, [e.message]);
        this.bumpUnread(e.message.channelId, e.message.authorId);
        // 서버는 기동 시 투영용 system 계정을 만든다 — 그보다 먼저 부트스트랩한 클라이언트는
        // 그 계정을 모르고, 작성자가 '…'로 표시된다. 디렉터리는 정적이 아니다.
        if (!store.accounts[e.message.authorId]) this.swallow(this.refreshAccounts());
        break;
      case 'message.updated':
        // 같은 id 로 덮어쓰면 upsert 가 제자리 교체한다.
        store.upsertMessages(e.message.channelId, [e.message]);
        break;
      case 'message.deleted':
        store.removeMessage(e.channelId, e.messageId);
        // 루트가 사라진 스레드를 계속 열어 두면 답글만 남은 빈 패널에 갇힌다.
        if (store.threadRootId === e.messageId) store.set({ threadRootId: null });
        break;
      case 'reaction.added':
      case 'reaction.removed':
        store.applyReaction(e.channelId, e.messageId, e.emoji, e.accountId, e.type === 'reaction.added');
        // 누른 사람이 처음 보는 계정이면 툴팁에 이름 대신 빈칸이 남는다.
        if (!store.accounts[e.accountId]) this.swallow(this.refreshAccounts());
        break;
      case 'typing.changed': {
        // 서버가 상태 전체를 보낸다 — 더하고 빼는 로직을 두면 두 곳에서 같은 맵을 갱신하게
        // 되고, 그 두 곳이 갈라진다. 여기서는 덮어쓰기만 한다.
        const next = { ...store.typing };
        if (e.accountIds.length) next[e.channelId] = e.accountIds;
        else delete next[e.channelId];
        store.set({ typing: next });
        // 처음 보는 계정이면 이름 대신 아무것도 못 그린다.
        if (e.accountIds.some((id) => !store.accounts[id])) this.swallow(this.refreshAccounts());
        break;
      }
      case 'inbox.updated':
        if (e.accountId === store.me?.id) {
          this.swallow(this.refreshUnread().then(() => this.announceNewMentions()));
        }
        break;
      case 'lease.changed':
        this.swallow(this.api.leases().then((leases) => useAppStore.getState().set({ leases })));
        break;
      case 'presence.snapshot':
        store.set({ online: e.online });
        break;
      case 'presence.changed': {
        const cur = new Set(useAppStore.getState().online);
        if (e.online) cur.add(e.accountId); else cur.delete(e.accountId);
        store.set({ online: [...cur] });
        break;
      }
      case 'status.changed':
        // presence 와 **다른 자리**를 갱신한다. 여기서 online 을 손대면 사람이 상태를
        // 바꿨을 뿐인데 연결 표시가 흔들린다 — 두 사실을 분리한 이유가 무너진다.
        store.applyStatus(e.accountId, e.status, e.statusText);
        // 아직 못 본 계정이면 상태만 와도 이름을 그리지 못한다.
        if (!store.accounts[e.accountId]) this.swallow(this.refreshAccounts());
        break;
    }
  }

  /**
   * 배지를 올린다. 보고 있는 채널과 내가 쓴 것은 올리지 않는다 — 열려 있는 채널에 배지가
   * 뜨면 배지가 "가봐야 할 곳"이라는 뜻을 잃고, 자기 발화에 배지가 뜨면 더 무의미하다.
   */
  private bumpUnread(channelId: string, authorId: string): void {
    const store = useAppStore.getState();
    if (channelId === store.activeChannelId || authorId === store.me?.id) return;
    const cur = store.reads[channelId] ?? { lastReadSeq: 0, unread: 0 };
    store.set({ reads: { ...store.reads, [channelId]: { ...cur, unread: cur.unread + 1 } } });
  }

  private async reconcile(): Promise<void> {
    const { activeChannelId, messages } = useAppStore.getState();
    if (activeChannelId) {
      const maxSeq = Math.max(0, ...(messages[activeChannelId] ?? []).map((m) => m.seq));
      const page = await this.api.messages(activeChannelId, { since: maxSeq });
      useAppStore.getState().upsertMessages(activeChannelId, page.messages);
    }
    await this.refreshUnread();
    useAppStore.getState().set({ leases: await this.api.leases() });
  }

  /** 미지의 작성자가 연달아 오면 요청이 폭주하므로, 진행 중인 조회 하나에 합류시킨다. */
  private accountsInFlight: Promise<void> | null = null;
  private lastAccountsRefresh = 0;
  private static readonly ACCOUNTS_REFRESH_INTERVAL_MS = 5_000;

  refreshAccounts(opts: { force?: boolean } = {}): Promise<void> {
    const now = Date.now();
    if (!opts.force && now - this.lastAccountsRefresh < Controller.ACCOUNTS_REFRESH_INTERVAL_MS) {
      return Promise.resolve();
    }
    this.lastAccountsRefresh = now;
    this.accountsInFlight ??= this.api
      .accounts()
      .then((accounts) => {
        useAppStore.getState().set({ accounts: Object.fromEntries(accounts.map((a) => [a.id, a])) });
      })
      .finally(() => { this.accountsInFlight = null; });
    return this.accountsInFlight;
  }

  /** 새로 들어온 미읽음을 OS 알림으로 알린다. 보고 있는 창에는 띄우지 않는다 — 배지가 그 일을 한다. */
  private async announceNewMentions(): Promise<void> {
    const { unread, me, channels, dms, accounts, messages, channelPrefs } = useAppStore.getState();
    if (document.hasFocus()) {
      // 포커스 중에는 알리지 않되, 본 것으로 처리해 나중에 뒤늦게 터지지 않게 한다.
      for (const e of unread) this.announced.add(e.id);
      return;
    }

    const prefs = usePrefsStore.getState().notifications;
    const label = { mention: 'mentioned you in', thread_reply: 'replied in a thread in', dm: 'messaged you in' };
    const wanted = { mention: prefs.mention, thread_reply: prefs.threadReply, dm: prefs.dm };

    for (const e of unread) {
      if (e.readAt || this.announced.has(e.id)) continue;
      // 끈 알림도 여기서 '지나간 것'으로 표시한다 — 아니면 사용자가 알림을 켜는 순간
      // 그동안 쌓인 것이 한꺼번에 터진다. 포커스 분기와 같은 이유다.
      this.announced.add(e.id);
      // 음소거한 채널도 마찬가지로 '지나간 것'으로 표시한 뒤 건너뛴다(#229). 음소거는
      // "덜 방해받겠다"는 약속이므로 멘션·DM도 예외가 아니다 — 세분화(전체/멘션만/없음)는
      // #224 의 몫이고, 지금 스키마는 on/off 하나뿐이니 끄면 끈다.
      if (channelPrefs[e.channelId]?.mutedAt) continue;
      if (!prefs.enabled || !wanted[e.reason]) continue;

      const row = (messages[e.channelId] ?? []).find((m) => m.id === e.messageId);
      const author = row ? accounts[row.authorId]?.handle : null;
      const channel = channels.find((c) => c.id === e.channelId);
      const dm = dms.find((d) => d.id === e.channelId);
      const where = channel
        ? `#${channel.name}`
        : dm
          ? dm.memberIds.filter((id) => id !== me?.id).map((id) => accounts[id]?.handle ?? '…').join(', ')
          : 'murmur';
      // 본문이 스토어에 없으면(창 밖으로 밀려난 채널 등) 이유만으로도 알림은 성립한다.
      const generic = `New ${e.reason.replace('_', ' ')}`;

      await this.notifier.notify({
        title: `${author ? `@${author} ` : ''}${label[e.reason]} ${where}`.trim(),
        // 미리보기를 끄면 제목(누가·어디서)은 남기고 대화 내용만 뺀다.
        body: prefs.showPreview ? (row?.body ?? generic) : generic,
      });
    }
  }

  // 단조 버전 가드 — 나중에 발행됐지만 먼저 도착한 응답만 반영되도록, stale 응답은 버린다.
  private async refreshUnread(): Promise<void> {
    const seq = ++this.unreadFetchSeq;
    const entries = await this.api.inboxUnread();
    if (seq === this.unreadFetchSeq) useAppStore.getState().set({ unread: entries });
  }

  async openChannel(channelId: string): Promise<void> {
    const store = useAppStore.getState();
    // 채널·스레드 열림은 이력에 추가한다. 뒤로/앞으로 이동은 pushHistory 를 안 부른다.
    store.pushHistory({ channelId, threadRootId: null });
    // 다른 곳으로 움직이면 이전 링크 강조는 뜻을 잃는다 — 남겨 두면 엉뚱한 메시지가 계속 빛난다.
    // 펼쳐 둔 긴 메시지도 같이 접는다(#217) — 나갔다 돌아온 채널에서 긴 메시지가 여전히
    // 펼쳐져 있으면, 애초에 접기가 막으려던 상태(하나가 화면을 다 먹는 것)로 되돌아간다.
    store.set({ activeChannelId: channelId, threadRootId: null, highlightedMessageId: null, expandedMessageIds: {} });
    // 투영된 system 메시지는 사용자가 그 채널을 보고 있지 않아도 WS로 들어와 maxSeq를 올린다.
    // 그 상태에서 증분 조회를 하면 backlog 전체가 건너뛰어져 채널이 거의 비어 보인다 —
    // 그래서 처음 여는 채널은 히스토리를 통째로 받는다(since=0 → 서버가 최신 N개를 준다).
    const since = this.loadedChannels.has(channelId)
      ? Math.max(0, ...(store.messages[channelId] ?? []).map((m) => m.seq))
      : 0;
    // 핀은 **크리티컬 패스에서 뺀다.** 이 엔드포인트가 없는 서버(구버전)에 붙었을 때
    // 채널이 아예 안 열리면 안 된다 — 채널 선호(`start`)와 같은 이유다.
    this.swallow(this.loadPins(channelId));
    const page = await this.api.messages(channelId, { since });
    this.loadedChannels.add(channelId);
    useAppStore.getState().upsertMessages(channelId, page.messages);
    useAppStore.getState().set({
      hasMore: { ...useAppStore.getState().hasMore, [channelId]: page.hasMore },
    });
    const ids = useAppStore.getState().unread
      .filter((e) => e.channelId === channelId && !e.readAt)
      .map((e) => e.id);
    if (ids.length) {
      await this.api.markRead(ids);
      await this.refreshUnread();
    }
    await this.settleReadPosition(channelId);
  }

  /**
   * 채널을 열었을 때 (a) **그 순간의** 읽음 위치를 구분선용으로 얼려 두고 (b) 최신까지 읽음
   * 처리한다. 순서가 중요하다 — 얼리기 전에 읽음 처리하면 구분선이 사라진다.
   *
   * 얼린 값은 그 채널을 다시 열 때까지 유지된다. 보고 있는 동안 새 메시지가 와도 구분선이
   * 그 자리에 남는 것이 의도다("내가 열었을 때 어디까지 읽었는가"를 말하는 선이다).
   */
  private async settleReadPosition(channelId: string): Promise<void> {
    const store = useAppStore.getState();
    const frozen = store.reads[channelId]?.lastReadSeq ?? 0;
    store.set({ dividerSeq: { ...store.dividerSeq, [channelId]: frozen } });

    const newest = Math.max(0, ...(store.messages[channelId] ?? []).map((m) => m.seq));
    if (newest <= frozen) return;
    await this.api.markChannelRead(channelId, newest);
    const after = useAppStore.getState();
    after.set({ reads: { ...after.reads, [channelId]: { lastReadSeq: newest, unread: 0 } } });
  }

  async openThread(rootId: string): Promise<void> {
    const channelId = useAppStore.getState().activeChannelId;
    if (!channelId) return;
    useAppStore.getState().pushHistory({ channelId, threadRootId: rootId });
    useAppStore.getState().set({ threadRootId: rootId });
    const page = await this.api.messages(channelId, { thread: rootId });
    useAppStore.getState().upsertMessages(channelId, page.messages);
  }

  /**
   * 링크가 가리키는 메시지로 이동한다(#178). 채널을 열고(이력에도 남긴다), 답글이면
   * 스레드 패널까지 열고, 그 메시지에 강조를 건다.
   *
   * **실패는 반드시 사람에게 보인다.** 조용히 아무 일도 안 하면 링크를 누른 사람은 앱이
   * 멈춘 것으로 보고 같은 링크를 계속 누른다. 사유를 셋으로 나누는 이유: 지워진 것과
   * 볼 수 없는 것과 연결이 끊긴 것은 사람이 다음에 할 일이 서로 다르다.
   */
  async openMessage(messageId: string): Promise<void> {
    let target: MessageRow;
    try {
      target = await this.api.message(messageId);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      useAppStore.getState().set({
        notice: status === 404
          ? 'That message is gone — it was deleted, or the link points at nothing.'
          : status === 403
            ? "You can't open that message — it's in a conversation you're not part of."
            : 'Could not open that message. Check your connection and try again.',
      });
      return;
    }
    await this.openChannel(target.channelId);
    // 답글은 스레드 패널까지 연다 — 스레드 밖에서 보면 무엇에 대한 답인지 잃는다.
    if (target.threadRootId) await this.openThread(target.threadRootId);
    // 강조는 openChannel 이 지운 **뒤에** 건다. 순서가 뒤바뀌면 방금 건 강조를 스스로 지운다.
    useAppStore.getState().set({ highlightedMessageId: target.id, notice: null });
  }

  /** 상단에 도달했을 때 한 페이지 더 과거로. 남은 게 없으면 요청하지 않는다. */
  async loadOlder(): Promise<void> {
    const { activeChannelId, messages, hasMore } = useAppStore.getState();
    if (!activeChannelId || !hasMore[activeChannelId]) return;
    const rows = messages[activeChannelId] ?? [];
    if (!rows.length) return;
    const oldest = Math.min(...rows.map((m) => m.seq));

    const page = await this.api.messages(activeChannelId, { before: oldest });
    useAppStore.getState().upsertMessages(activeChannelId, page.messages);
    useAppStore.getState().set({
      hasMore: { ...useAppStore.getState().hasMore, [activeChannelId]: page.hasMore },
    });
  }

  closeThread(): void { useAppStore.getState().set({ threadRootId: null }); }

  async send(body: string, attachmentIds: string[] = []): Promise<void> {
    const { activeChannelId } = useAppStore.getState();
    // 파일만 보내는 것은 자연스럽다 — 본문이 비었다고 막으면 첨부를 보낼 길이 없다.
    if (!activeChannelId || (!body.trim() && !attachmentIds.length)) return;
    const m = await this.api.postMessage(activeChannelId, body, undefined, crypto.randomUUID(), attachmentIds);
    useAppStore.getState().upsertMessages(activeChannelId, [m]);
  }

  async reply(body: string, attachmentIds: string[] = []): Promise<void> {
    const { activeChannelId, threadRootId } = useAppStore.getState();
    if (!activeChannelId || !threadRootId || (!body.trim() && !attachmentIds.length)) return;
    const m = await this.api.postMessage(activeChannelId, body, threadRootId, crypto.randomUUID(), attachmentIds);
    useAppStore.getState().upsertMessages(activeChannelId, [m]);
  }

  /**
   * 입력 중임을 알린다. 소켓으로 보내는 유일한 방향이다(그 외는 서버 → 클라이언트 단방향).
   * 소켓이 없으면 조용히 넘긴다 — 입력 중 표시는 없어도 대화가 되는 기능이다.
   */
  notifyTyping(on: boolean): void {
    const { activeChannelId, threadRootId } = useAppStore.getState();
    // 스레드에서 쓰는 것도 그 채널에서 입력 중이다 — 채널 단위로 보낸다.
    void threadRootId;
    if (!activeChannelId) return;
    this.ws?.send({ type: on ? 'typing' : 'typing.stop', channelId: activeChannelId });
  }

  /** 파일을 고른 순간 올린다 — 전송 시점에 올리면 Enter 를 누르고 기다려야 한다. */
  upload(file: File): Promise<AttachmentRow> {
    return this.api.upload(file);
  }

  fetchAttachment(id: string): Promise<Blob> {
    return this.api.fetchAttachment(id);
  }

  /**
   * 첨부를 사용자 디스크에 저장한다. objectURL + `download` 앵커를 쓴다 — 토큰을 URL 에
   * 넣지 않으려면 바이트를 먼저 받아야 하고, 받은 다음에는 이것이 가장 단순한 저장 경로다.
   */
  async saveAttachment(attachment: AttachmentRow): Promise<void> {
    const blob = await this.api.fetchAttachment(attachment.id);
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.filename;
      a.click();
    } finally {
      // 즉시 revoke 하면 브라우저가 저장을 시작하기 전에 사라질 수 있다.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }

  /**
   * 리액션을 켜고 끈다. 서버가 받아들인 뒤에 화면을 갱신한다 — 미리 그려 두면 서버가 거절한
   * 리액션(개수 상한·권한)이 새로고침에서 사라져 사용자가 무엇이 진짜인지 알 수 없다.
   * 뒤이어 오는 소켓 이벤트는 같은 결과를 내므로(멱등) 두 번 반영되지 않는다.
   */
  async toggleReaction(channelId: string, messageId: string, emoji: string, on: boolean): Promise<void> {
    const me = useAppStore.getState().me;
    if (!me) return;
    if (on) await this.api.addReaction(channelId, messageId, emoji);
    else await this.api.removeReaction(channelId, messageId, emoji);
    useAppStore.getState().applyReaction(channelId, messageId, emoji, me.id, on);
  }

  async editMessage(messageId: string, body: string): Promise<void> {
    const { activeChannelId } = useAppStore.getState();
    if (!activeChannelId || !body.trim()) return;
    const updated = await this.api.editMessage(activeChannelId, messageId, body);
    useAppStore.getState().upsertMessages(activeChannelId, [updated]);
  }

  /**
   * 이 채널의 고정 목록을 서버에서 다시 받는다(#218).
   *
   * 델타가 아니라 목록 전체를 갈아 끼운다: 핀은 채널 전역 상태라 다른 사람이 고정·해제한
   * 것도 섞여 들어오고, 그때 내 로컬 델타만 쌓으면 화면이 서버와 조용히 갈라진다.
   */
  async loadPins(channelId: string): Promise<void> {
    const pins = await this.api.pins(channelId);
    const store = useAppStore.getState();
    store.set({ pins: { ...store.pins, [channelId]: pins } });
  }

  /**
   * 고정한다. 성공 응답의 핀을 목록에 얹지 않고 **다시 받아 온다** — 정렬(최근 순)이
   * 서버의 것이라 여기서 자리를 추측하면 다음 새로고침에 순서가 바뀐다.
   *
   * 실패를 삼키지 않는다: 보관된 채널이나 남의 DM 은 서버가 403 을 주고, 그 사실이
   * 사람에게 보여야 한다 — 조용히 아무 일도 안 하면 계속 다시 누른다.
   */
  async pinMessage(channelId: string, messageId: string): Promise<void> {
    try {
      await this.api.pinMessage(channelId, messageId);
    } catch (e) {
      useAppStore.getState().set({
        notice: e instanceof ApiError && e.code === 'channel_archived'
          ? "This channel is archived — it's read-only, so nothing new can be pinned."
          : 'Could not pin that message. Check your connection and try again.',
      });
      return;
    }
    await this.loadPins(channelId);
  }

  /** 해제한다. 고정한 사람도 admin 도 아니면 서버가 403 을 주고, 그 사유를 그대로 보여 준다. */
  async unpinMessage(channelId: string, messageId: string): Promise<void> {
    try {
      await this.api.unpinMessage(channelId, messageId);
    } catch (e) {
      useAppStore.getState().set({
        notice: e instanceof ApiError && e.status === 403
          ? 'Only the person who pinned that message, or an admin, can unpin it.'
          : 'Could not unpin that message. Check your connection and try again.',
      });
      return;
    }
    await this.loadPins(channelId);
  }

  async deleteMessage(messageId: string): Promise<void> {
    const { activeChannelId, threadRootId } = useAppStore.getState();
    if (!activeChannelId) return;
    await this.api.deleteMessage(activeChannelId, messageId);
    useAppStore.getState().removeMessage(activeChannelId, messageId);
    // 내가 지운 경우에도 같다. WS 이벤트를 기다리지 않고 즉시 닫는다.
    if (threadRootId === messageId) useAppStore.getState().set({ threadRootId: null });
  }

  listAgents(): Promise<import('@murmur/shared').AgentView[]> {
    return this.api.listAgents();
  }

  /** 생성과 PAT 발급을 함께 한다 — 러너를 띄우려면 둘 다 필요하고, PAT 는 지금만 볼 수 있다. */
  async createAgent(
    input: { handle: string; displayName: string } & Partial<import('@murmur/shared').AgentConfig>,
  ): Promise<{ agent: import('@murmur/shared').AgentView; pat: string }> {
    const agent = await this.api.createAgent(input);
    const pat = await this.api.mintPat(agent.id, 'runner');
    return { agent, pat };
  }

  updateAgent(
    id: string, patch: Partial<import('@murmur/shared').AgentConfig> & { displayName?: string },
  ): Promise<import('@murmur/shared').AgentView> {
    return this.api.updateAgent(id, patch);
  }

  /** #129: 러너 종료 요청. 실패를 삼키지 않는다 — 요청이 갔는지 화면이 말해야 한다. */
  requestAgentStop(agentId: string): Promise<import('@murmur/shared').AgentView> {
    return this.api.requestAgentStop(agentId);
  }

  /** #171: 새 에이전트의 기본값. 실패를 삼키지 않는다 — 화면이 실패를 그려야 한다. */
  agentDefaults(): Promise<import('@murmur/shared').AgentDefaults> {
    return this.api.agentDefaults();
  }

  updateAgentDefaults(
    patch: Partial<import('@murmur/shared').AgentDefaults>,
  ): Promise<import('@murmur/shared').AgentDefaults> {
    return this.api.updateAgentDefaults(patch);
  }

  /** #139: 에이전트 메모리. 실패를 삼키지 않는다 — 호출부가 "없다" 와 "못 읽었다" 를 가른다. */
  agentMemory(agentId: string): Promise<{ slug: string; value: string; updatedAt: string }[]> {
    return this.api.agentMemory(agentId);
  }

  deleteAgentMemory(agentId: string, slug: string): Promise<void> {
    return this.api.deleteAgentMemory(agentId, slug);
  }

  listPats(accountId: string): Promise<import('@murmur/shared').PatView[]> {
    return this.api.listPats(accountId);
  }

  revokePat(accountId: string, label: string): Promise<{ revoked: number }> {
    return this.api.revokePat(accountId, label);
  }

  mintPat(accountId: string, label: string): Promise<string> {
    return this.api.mintPat(accountId, label);
  }

  /**
   * 채널을 만들고 목록에 반영한 뒤 그 채널을 연다 — `startDm` 과 같은 모양이다.
   * 컴포넌트가 `api` 를 직접 부르고 스토어를 손으로 갱신하면 그 절차가 화면마다 흩어지고,
   * 서버가 채운 필드(kind·topic 기본값)를 클라이언트가 추측하게 된다. 목록은 다시 받아온다.
   */
  async createChannel(name: string, visibility: 'public' | 'private' = 'public'): Promise<ChannelRow> {
    const created = await this.api.createChannel({ name, visibility });
    useAppStore.getState().set({ channels: await this.api.channels() });
    await this.openChannel(created.id);
    return created;
  }

  /**
   * 멤버 목록을 받아 스토어에 넣는다. **실패를 빈 목록으로 삼키지 않는다** — 조회가
   * 실패했는데 화면이 "멤버 없음"을 그리면, private 채널에서 그것은 "이 채널은 아무도
   * 볼 수 없다"는 거짓 사실이 되고 나가기 경고가 사라진다. 던져서 호출부가 안내하게 한다.
   */
  async loadChannelMembers(channelId: string): Promise<ChannelMemberRow[]> {
    const members = await this.api.channelMembers(channelId);
    const store = useAppStore.getState();
    store.set({ channelMembers: { ...store.channelMembers, [channelId]: members } });
    return members;
  }

  async inviteChannelMember(channelId: string, accountId: string): Promise<ChannelMemberRow[]> {
    const members = await this.api.inviteChannelMember(channelId, accountId);
    const store = useAppStore.getState();
    store.set({ channelMembers: { ...store.channelMembers, [channelId]: members } });
    return members;
  }

  /**
   * 나가기/내보내기. 나간 뒤에는 **채널 목록을 다시 받는다** — private 채널에서 나가면 그
   * 채널은 더 이상 내게 존재하지 않으므로 사이드바에 남아 있으면 안 된다.
   */
  async leaveChannel(channelId: string, accountId: string): Promise<void> {
    const members = await this.api.removeChannelMember(channelId, accountId);
    const store = useAppStore.getState();
    store.set({
      channelMembers: { ...store.channelMembers, [channelId]: members },
      channels: await this.api.channels(),
    });
  }

  /**
   * 채널을 편집하고 목록을 갱신한다 — sidebar 가 `repo` 배지와 topic 을 직접 보여주므로
   * 편집 결과를 반영하려면 목록을 다시 받아야 한다. `createChannel` 과 같은 이유다.
   */
  async updateChannel(
    id: string, input: { topic?: string; repo?: string | null; visibility?: 'public' | 'private' },
  ): Promise<ChannelRow> {
    const updated = await this.api.updateChannel(id, input);
    useAppStore.getState().set({ channels: await this.api.channels() });
    return updated;
  }

  async archiveChannel(id: string, archived: boolean): Promise<ChannelRow> {
    const updated = await this.api.archiveChannel(id, archived);
    useAppStore.getState().set({ channels: await this.api.channels() });
    return updated;
  }

  async startDm(accountId: string): Promise<void> {
    const dm = await this.api.createDm([accountId]);
    useAppStore.getState().set({ dms: await this.api.dms() });
    await this.openChannel(dm.id);
  }

  async toggleChannelMute(channelId: string): Promise<void> {
    const store = useAppStore.getState();
    const current = store.channelPrefs[channelId];
    const muted = !current?.mutedAt;
    const updated = await this.api.updateChannelPref(channelId, { muted });
    store.set({ channelPrefs: { ...store.channelPrefs, [channelId]: updated } });
  }

  /**
   * 내 상태를 서버에 정하고 로컬에도 반영한다(#186). 소켓 이벤트가 곧 돌아오지만 그것만
   * 기다리면 누른 뒤 한 왕복 동안 화면이 예전 값을 보여 준다 — 같은 값이 두 번 들어와도
   * `applyStatus` 는 덮어쓰기라 두 번 세는 문제가 없다(리액션과 다른 점이다).
   */
  async setStatus(status: AccountStatus, statusText?: string | null): Promise<void> {
    const store = useAppStore.getState();
    // 키 부재와 null 을 구분해서 그대로 넘긴다 — 여기서 `?? null` 로 뭉개면 '문구는
    // 손대지 않음'이 '지우기'가 된다.
    const saved = await this.api.setMyStatus(statusText === undefined ? { status } : { status, statusText });
    const meId = store.me?.id;
    if (meId) store.applyStatus(meId, saved.status, saved.statusText);
  }

  /**
   * 이 채널을 미읽음으로 표시한다(#154). `seq` 부터가 미읽음이 된다.
   *
   * 낙관적 갱신은 **서버의 경계 규칙을 그대로 흉내낸다**(`readPositions.ts` 의
   * `UNREAD_BOUNDARY`): 경계는 `min(현재 위치, seq - 1)` 이고 그 뒤의, 내가 쓰지 않은
   * 메시지가 미읽음이다. 여기서 다르게 세면 새로고침 전까지 사이드바가 서버와 다른 말을 한다.
   *
   * 위치를 여기서 되돌려 두는 것이 중요하다 — 이 채널을 다시 열면 `settleReadPosition` 이
   * "최신이 위치보다 뒤에 있다"를 보고 읽음 ack 를 보내고, 그 ack 가 표시를 지운다.
   */
  async markChannelUnread(channelId: string, seq: number): Promise<void> {
    await this.api.markChannelUnread(channelId, seq);
    const store = useAppStore.getState();
    const cur = store.reads[channelId] ?? { lastReadSeq: 0, unread: 0 };
    const boundary = Math.min(cur.lastReadSeq, seq - 1);
    const unread = (store.messages[channelId] ?? [])
      .filter((m) => m.seq > boundary && m.authorId !== store.me?.id).length;
    store.set({ reads: { ...store.reads, [channelId]: { lastReadSeq: boundary, unread } } });
  }

  async toggleChannelStar(channelId: string): Promise<void> {
    const store = useAppStore.getState();
    const current = store.channelPrefs[channelId];
    const starred = !current?.starredAt;
    const updated = await this.api.updateChannelPref(channelId, { starred });
    store.set({ channelPrefs: { ...store.channelPrefs, [channelId]: updated } });
  }

  /**
   * 훑기 목록을 만든다(#227) — `reads` 맵 기반의 **전체 미읽음** 모드다.
   *
   * `openChannel` 을 쓰지 않는 것이 핵심이다. 채널을 열면 `settleReadPosition` 이 최신까지
   * 읽음 ack 를 보내므로, 열어서 보여 주는 훑기에는 '그냥 다음'이 존재할 수 없다 — 지나간 것이
   * 전부 읽음이 된다. 그래서 훑기는 자기 조회로 내용을 들고 와 화면 안에서 보여 준다.
   *
   * 채널마다 한 번씩 조회한다. 서버가 채널별 '가장 오래된 미읽음의 시각'을 주지 않아
   * **정렬 기준을 메시지에서만 얻을 수 있기 때문**이다(`seq` 는 채널마다 독립이라 채널을
   * 가로질러 비교할 수 없다). 어차피 훑기는 그 내용을 보여 줘야 하므로 같은 조회가 정렬 기준과
   * 화면 내용을 함께 준다. 채널 수가 커지면 `/reads` 에 시각을 실어 주는 쪽이 다음 수순이다.
   *
   * **실패를 삼키지 않는다.** 여기서 던지는 예외를 빈 목록으로 바꾸면 화면이 "다 봤다"고
   * 말하게 되는데, 그것은 못 불러온 것을 다 읽었다고 하는 거짓말이다(docs/design.md §4).
   */
  async loadUnreadSweep(): Promise<SweepItem[]> {
    const reads = await this.api.reads();
    const store = useAppStore.getState();
    // 조회한 김에 배지도 같은 값으로 맞춘다 — 훑기와 사이드바가 서로 다른 미읽음을 말하면
    // 어느 쪽이 맞는지 사람이 판단할 수 없다.
    store.set({ reads: Object.fromEntries(reads.map((r) => [r.channelId, { lastReadSeq: r.lastReadSeq, unread: r.unread }])) });
    // 음소거된 채널은 뜨지 않는다(#229). 음소거는 "이 채널은 나를 부르지 마라"이고
    // 훑기 목록에 오르는 것은 부름의 한 형태다 — 여기서 빠뜨리면 음소거의 뜻이 다시 무너진다.
    const candidates = reads.filter((r) => r.unread > 0 && !store.channelPrefs[r.channelId]?.mutedAt);
    const pages = await Promise.all(
      // `lastReadSeq` 가 0(한 번도 안 읽음)이면 서버는 최신 한 페이지를 준다 — 그 채널의
      // 정렬 기준은 '받아 온 것 중 가장 오래된 것'이 된다. 훑기가 보여 줄 수 있는 범위와
      // 정렬 기준을 같은 것으로 두는 편이, 못 본 메시지를 기준으로 줄 세우는 것보다 정직하다.
      candidates.map((r) => this.api.messages(r.channelId, { since: r.lastReadSeq })),
    );
    const after = useAppStore.getState();
    const items: SweepItem[] = [];
    candidates.forEach((r, i) => {
      const page = pages[i];
      if (!page) return;
      // 내가 쓴 메시지는 미읽음이 아니다 — 서버의 미읽음 셈(`readPositions.ts`)과 같은 기준이다.
      const unreadMessages = page.messages.filter((m) => m.seq > r.lastReadSeq && m.authorId !== after.me?.id);
      const oldest = unreadMessages[0];
      // 보여 줄 것이 없으면 항목을 만들지 않는다. 눌러도 아무것도 없는 항목은
      // "여기 볼 것이 있다"는 거짓 신호다.
      if (!oldest) return;
      items.push({
        channelId: r.channelId,
        label: sweepLabel(after, r.channelId),
        messages: unreadMessages,
        oldestAt: oldest.createdAt,
        newestSeq: Math.max(...page.messages.map((m) => m.seq)),
      });
    });
    return sortSweepItems(items);
  }

  /**
   * 이 채널을 `seq` 까지 읽음 처리한다(#227의 '읽음 처리하고 다음').
   *
   * `markChannelUnread` 의 반대편이고 `settleReadPosition` 과 같은 ack 를 쓴다 — 서버가
   * 단조 전진(`readPositions.ts`: "되돌아가지 않고")을 지키므로 낙관적 갱신도 되돌리지 않는다.
   */
  async markChannelReadUpTo(channelId: string, seq: number): Promise<void> {
    await this.api.markChannelRead(channelId, seq);
    const store = useAppStore.getState();
    const cur = store.reads[channelId] ?? { lastReadSeq: 0, unread: 0 };
    store.set({ reads: { ...store.reads, [channelId]: { lastReadSeq: Math.max(cur.lastReadSeq, seq), unread: 0 } } });
  }

  /** 뒤로 탐색. 이력 스택에서 이전 항목으로 이동한다.
   * 사라진 채널을 만나면 건너뛴다. 갈 곳이 없으면 false 를 반환한다. */
  async goBack(): Promise<boolean> {
    // 목표 인덱스를 **먼저 찾고 한 번만 적용한다.** 찾는 도중에 인덱스를 내리면
    // 갈 곳이 없어 실패했을 때도 위치가 움직여 있다.
    //
    // 그리고 `store.goBack()` 은 인덱스를 바꾸지 않는 **순수 조회**다 — 인덱스를 내리지
    // 않은 채 그것을 다시 부르면 같은 항목이 영원히 돌아와 **사라진 채널 하나가 앱을
    // 멈춘다.** 그래서 조회를 반복하지 않고 배열을 직접 훑는다.
    return this.navigateHistory(-1);
  }

  /** 앞으로 탐색. 이력 스택에서 다음 항목으로 이동한다.
   * 사라진 채널을 만나면 건너뛴다. 갈 곳이 없으면 false 를 반환한다. */
  async goForward(): Promise<boolean> {
    return this.navigateHistory(1);
  }

  /**
   * 이력을 한 방향으로 훑어 **살아 있는 채널**을 가리키는 첫 항목으로 이동한다.
   * 사라진 채널을 가리키는 항목은 건너뛴다 — 사람이 지운 채널을 다시 보여줄 수 없는
   * 것은 오류가 아니므로 조용히 넘어가고, 갈 곳이 하나도 없으면 아무것도 하지 않는다.
   */
  private async navigateHistory(step: -1 | 1): Promise<boolean> {
    const { history, historyIndex } = useAppStore.getState();
    for (let i = historyIndex + step; i >= 0 && i < history.length; i += step) {
      const entry = history[i]!;
      const st = useAppStore.getState();
      const exists = st.channels.some((c) => c.id === entry.channelId) ||
        st.dms.some((d) => d.id === entry.channelId);
      if (!exists) continue;
      st.set({ historyIndex: i });
      await this.openChannelWithoutHistory(entry.channelId);
      if (entry.threadRootId) useAppStore.getState().set({ threadRootId: entry.threadRootId });
      return true;
    }
    return false;
  }

  /** 채널을 연다(히스토리 미추가). 뒤로·앞으로 이동 전용. */
  private async openChannelWithoutHistory(channelId: string): Promise<void> {
    const store = useAppStore.getState();
    // 뒤로·앞으로 이동도 채널을 새로 여는 것이다 — 접힘 기본값이 여기서 갈리면
    // 같은 채널이 어떻게 도착했는지에 따라 다르게 보인다(#217).
    store.set({ activeChannelId: channelId, threadRootId: null, highlightedMessageId: null, expandedMessageIds: {} });
    const since = this.loadedChannels.has(channelId)
      ? Math.max(0, ...(store.messages[channelId] ?? []).map((m) => m.seq))
      : 0;
    // 핀은 **크리티컬 패스에서 뺀다.** 이 엔드포인트가 없는 서버(구버전)에 붙었을 때
    // 채널이 아예 안 열리면 안 된다 — 채널 선호(`start`)와 같은 이유다.
    this.swallow(this.loadPins(channelId));
    const page = await this.api.messages(channelId, { since });
    this.loadedChannels.add(channelId);
    store.upsertMessages(channelId, page.messages);
    store.set({
      hasMore: { ...store.hasMore, [channelId]: page.hasMore },
    });
    const ids = store.unread
      .filter((e) => e.channelId === channelId && !e.readAt)
      .map((e) => e.id);
    if (ids.length) {
      await this.api.markRead(ids);
      await this.refreshUnread();
    }
    await this.settleReadPosition(channelId);
  }

  logout(): void {
    // 서버 세션 폐기를 **발사하되 기다리지 않는다.** 응답을 기다리면 오프라인일 때 로그아웃이
    // 멈추고, 실패해도 로컬은 반드시 비워야 한다 — 안 그러면 사용자가 로그인 상태에 갇힌다.
    // 남은 서버 세션은 TTL 만료와 소켓 재검증 sweep 이 정리한다.
    this.swallow(this.api.logout());
    this.clearLocal();
  }

  /** 초대 토큰을 발급한다 — admin 전용. */
  createInvite(): Promise<string> {
    return this.api.createInvite();
  }
}

let current: Controller | null = null;
export function setController(c: Controller | null): void { current = c; }
export function getController(): Controller {
  if (!current) throw new Error('controller not initialized');
  return current;
}
