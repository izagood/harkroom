import type { AccountStatus, AddTeamToChannelResult, AgentView, AgentTeamMemberRow, AgentTeamRow, AttachmentRow, ChannelAutoMentionMode, ChannelAutoMentionRow, ChannelDoc, ChannelRow, ChannelMemberRow, ChannelPrefRow, HandleGroupRow, InboxEntry, MessageRow, NotifyLevel, SavedMessageRow, WsServerEvent, WorkspaceSkillView } from '@harkroom/shared';
import { countsAsReply, notifyLevelOf } from '@harkroom/shared';
import { ApiClient, ApiError } from '../lib/api';
import { connectWs, type WsDownReason, type WsHandle } from '../lib/ws';
import { sessionStore } from '../lib/session';
import { silentNotifier, type NotificationTarget, type Notifier } from '../lib/notify';
import { bodyRecipients, displayBody } from '../lib/mention';
import { calledGroups, notifiedSummary, type NotifiedResult } from '../lib/notified';
import { RunnerLauncher, tauriDaemonObserver, tauriLoginPathReader, tauriSecretStore, daemonSpawner, tauriAppVersionReader, type AppVersionReader, type DaemonObserver, type LoginPathReader, type RunnerSecretStore, type RunnerSpawner } from '../lib/runnerLauncher';
import { staleRunners } from '../lib/runnerVersions';
// 만들기 흐름이 러너를 띄우기 **전에** 풀 배정을 쓴다 — 근거는 `createAgent` 안에 있다.
import { assignAgentPool } from '../lib/claudeAccounts';
import type { AppStore } from './appStore';
import { communityLabel, getActiveController, getActiveStore, useCommunityRegistry, type CommunityEntry } from './communities';
import { usePrefsStore } from './prefsStore';
import { detectLocale, isLocale, translator, type Translate } from '../i18n';

/**
 * 채널을 **처음** 열 때 받아 오는 히스토리 창(행 수).
 *
 * 왜 서버 기본값(200)으로는 모자라나(jaebin 보고 2026-09-10: "이전 메시지들 다 어디갔어"):
 * 이 창은 **화면에 그려지지 않는 행까지 센다.** 스레드 답글·`progress`·`wake` 가 모두 한
 * 행이므로, 에이전트가 도는 채널에서는 하루가 창을 통째로 먹는다 — 실측(#murmur, 09-10)
 * 으로 최신 200 행이 전부 그날치였고 그중 채널 최상위로 그려지는 것은 25개뿐이었다.
 * 사람 눈에는 사흘치 대화가 사라진 것으로 보인다.
 *
 * 그래서 첫 창을 서버 상한(500)까지 넓힌다. **이것만으로는 답이 아니다** — 하루가 500 행이
 * 되면 같은 일이 다시 벌어진다. 진짜 해법은 목록 맨 위에 닿으면 다음 페이지를 스스로
 * 받아 오는 것이고(`ChannelPane` 의 `maybeLoadOlder`), 이 값은 "첫 화면에서 며칠은 보인다"를
 * 맡는다. 증분 조회(`since > 0`)에는 붙이지 않는다 — 그쪽은 새로 생긴 것만 받는 길이다.
 */
export const INITIAL_HISTORY_LIMIT = 500;

/**
 * `openThread` 의 선택 인자들. **자리 인자였다가 묶었다** — `channelId` 를 더하면 넷이 되고,
 * 넷째 자리에 채널이 오는 호출은 읽는 사람이 무엇을 주는지 셀 수 없다. 이름으로 주면
 * `{ channelId }` 하나만 주는 흔한 경우가 짧아진다.
 */
export interface OpenThreadOpts {
  /** 그 뿌리가 사는 채널. 활성 채널과 다르면 **먼저 옮긴다**. 없으면 활성 채널이다. */
  channelId?: string;
  /** 그 답글 자리에 세운다(#624 요구 3). 강조를 수단으로 쓴다. */
  focusMessageId?: string;
  /** 그 답글이 보이는 창을 달라는 것(⌘F 의 스레드 스코프). */
  aroundSeq?: number;
}

export class Controller {

  /**
   * 이 컨트롤러가 쓰는 번역기. **부를 때마다 언어를 다시 읽는다** — `translator(locale)` 을
   * 한 번 만들어 두면 그 함수가 **컨트롤러 수명 동안 그 언어로 굳고**, 사람이 설정에서
   * 언어를 바꿔도 여기서 나온 말만 옛 언어로 남는다(컨트롤러는 앱이 사는 동안 다시 안
   * 만들어진다).
   *
   * 저장값이 `'system'` 이거나 우리가 모르는 언어면 브라우저에게 묻는다 — `useT` 가
   * 화면에서 하는 판단과 **같은 규약**이어야 한국어 화면에 영어가 섞이지 않는다
   * (`useT.ts::useLocale` 주석).
   */
  private t(): Translate {
    const pref = usePrefsStore.getState().locale;
    return translator(isLocale(pref) ? pref : detectLocale());
  }
  private ws: WsHandle | null = null;
  private unreadFetchSeq = 0;
  /** 히스토리를 이미 통째로 받은 채널. 이 집합에 없으면 openChannel이 증분이 아니라 전체를 받는다. */
  private loadedChannels = new Set<string>();
  /** 이미 알린 inbox 항목. 같은 항목을 두 번 알리면 알림이 쓸모없어진다. */
  private announced = new Set<number>();
  /**
   * 이미 OS 알림을 보낸 메시지 id(#224). `all` 채널에서는 같은 메시지가 `message.created`
   * 와 `inbox.updated` 두 경로로 오기 때문에, 이것이 없으면 그 채널의 멘션이 두 번 울린다.
   * 두 경로가 서로의 기록을 보므로 어느 쪽이 먼저 도착해도 한 번만 울린다.
   */
  private notifiedMessages = new Set<string>();
  private runnerLauncher: RunnerLauncher;
  /** 이번 `start()` 에서 러너 자동 기동을 이미 했는가(#250). */
  private runnerAutoStartDone = false;
  /** 비동기 부트스트랩 도중 교체·해제된 컨트롤러가 뒤늦게 살아나는 것을 막는다. */
  private stopped = false;

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
    /** 테스트가 키체인·자식 프로세스를 목으로 바꿔 끼우는 자리(#250). */
    secrets: RunnerSecretStore = tauriSecretStore,
    spawner: RunnerSpawner = daemonSpawner,
    /** 로그인 셸 `PATH` 조회(#305). 테스트가 조회 실패를 만들 수 있게 주입한다. */
    loginPath: LoginPathReader = tauriLoginPathReader,
    /**
     * 이 컨트롤러가 쓰는 커뮤니티의 스토어(#166). 예전에는 모듈 최상위 싱글턴을 직접
     * 읽었다 — 그러면 보고 있지 않은 커뮤니티의 이벤트가 **활성 커뮤니티의 스토어**로
     * 들어가, A 의 메시지가 B 의 채널에 조용히 붙는다. 인스턴스를 들고 있으면 그 사고가
     * 구조적으로 불가능하다.
     *
     * 기본값이 활성 스토어인 이유는 **생성 시점에 한 번** 평가되기 때문이다 — 뒤에 활성이
     * 바뀌어도 이 컨트롤러는 자기 것을 계속 쓴다. 커뮤니티를 지목해 띄우는 자리
     * (`startCommunitySession`)는 언제나 명시적으로 넘긴다.
     */
    private store: AppStore = getActiveStore(),
    /**
     * daemon 에게 "무엇이 돌고 있나"를 묻는 표면(`#431` 2단계 A). 테스트가 장부를
     * 만들 수 있게 주입한다 — `spawner`·`secrets` 와 같은 이유다.
     */
    daemonObserver: DaemonObserver = tauriDaemonObserver,
    /**
     * 이 앱 번들의 버전을 읽는 표면. 러너에 심는 `AGENT_VERSION` 과 뒤처짐 판정이
     * **같은 값**을 써야 하므로 한 곳에서 읽는다(`AppVersionReader` 주석).
     */
    appVersion: AppVersionReader = tauriAppVersionReader,
  ) {
    this.runnerLauncher = new RunnerLauncher(
      {
        baseUrl: api.baseUrl,
        mintPat: (accountId, label) => api.mintPat(accountId, label),
        listPats: (accountId) => api.listPats(accountId),
        revokePat: (accountId, label) => api.revokePat(accountId, label),
      },
      secrets,
      spawner,
      loginPath,
      undefined, // now — 재발급 라벨의 시각. 기본값(Date.now)을 그대로 쓴다.
      daemonObserver,
      appVersion,
      undefined, // restartWait — 실제 종료를 기다리는 방식. 기본값을 그대로 쓴다.
      // 러너 사유의 번역기(`#619`). **감싸서 넘기는 것이 요점이다** — `this.t()` 를
      // 그대로 넘기면 지금의 언어로 굳는다(그 메서드 주석).
      (key, args) => this.t()(key, args),
    );
    // 앱 버전을 **스토어로 밀어 넣는다** — 화면이 컨트롤러에게 묻지 않게(`appVersion`
    // 필드 주석). 실패해도 앱은 떠야 하므로 fire-and-forget 이고, 못 얻으면 `null` 로
    // 남아 화면이 "판정할 수 없다"고 말한다.
    void this.runnerLauncher.currentAppVersion()
      .then((v) => { this.store.getState().set({ appVersion: v }); })
      .catch(() => {});
    this.runnerLauncher.setOnStateChange((states) => {
      this.store.getState().set({
        runnerStates: Object.fromEntries(states.map((s) => [s.agentId, s])),
      });
    });
    // daemon 이 **직접 확인한 사실**을 스토어로 밀어 넣는다(`#443`). 판정
    // (`runnerStates`)과 나란히 서고 섞이지 않는 이유는 `appStore.ts::daemonRunners`
    // 주석의 표에 있다.
    //
    // **통째로 갈아 끼운다** — 병합하지 않는다. 관측은 그 순간의 장부 전체이고, 장부에서
    // 사라진 러너는 daemon 이 더 이상 그것에 대해 아무것도 모른다는 뜻이다. 옛 항목을
    // 남겨 두면 화면이 이미 없는 러너의 pid 를 계속 보이고, 사람은 그 pid 로 `ps` 를 쳐
    // 아무것도 못 찾는다 — 그것이 정확히 이 이슈가 없애려는 낡은 사실이다.
    this.runnerLauncher.setOnObservation((runners) => {
      this.store.getState().set({
        daemonRunners: Object.fromEntries(runners.map((r) => [r.agentId, r])),
      });
    });
  }

  /**
   * 설정 화면의 "PAT 재발급" 이 부르는 자리. 실행기를 화면에 직접 노출하지 않는다.
   *
   * 대상을 **여기서 다시 조회한다** — 실행기가 자동 기동 때 본 것을 기억해 두고 그것에
   * 기대면, 자동 기동을 끄고 쓰는 사람에게는 이 버튼이 영원히 죽어 있다(누를 수는 있고
   * 아무 일도 일어나지 않는다).
   */
  async reissueRunnerPat(agentId: string): Promise<void> {
    const agents = await this.api.listAgents();
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) throw new Error('에이전트를 찾지 못했다 — 목록을 다시 읽어라');
    await this.runnerLauncher.reissue({ agent });
  }

  /**
   * 내가 소유한 에이전트의 러너를 띄운다(#250). presence 를 받은 뒤에 불린다.
   *
   * 토글이 꺼져 있으면 아무것도 하지 않는다 — 상태도 만들지 않는다: 안 띄우기로 한 것에
   * '꺼짐' 배지를 달면 뭔가 잘못된 것처럼 보인다.
   */
  private async startRunners(): Promise<void> {
    const prefs = usePrefsStore.getState();
    if (!prefs.runnerAutoStart) return;
    const input = await this.launchInput();
    if (!input) return;
    await this.runnerLauncher.startAll(input);
  }

  /**
   * 러너를 띄울 때 쓰는 입력. 자동 기동과 재기동이 **같은 판정**을 쓰게 한 곳에 둔다 —
   * 갈라지면 "전체 재기동"이 고른 대상과 자동 기동이 고르는 대상이 어긋난다.
   */
  private async launchInput(): Promise<{
    agents: AgentView[]; myAccountId: string; liveAccountIds: Set<string> | null;
  } | null> {
    const store = this.store.getState();
    const myId = store.me?.id;
    if (!myId) return null;
    const agents = await this.api.listAgents();
    return {
      agents,
      myAccountId: myId,
      // `connected` 가 false 면 presence 는 '모른다'다 — 빈 배열이 '아무도 없다'가 아니다.
      liveAccountIds: store.connected ? new Set(store.online) : null,
    };
  }

  /** 이 앱 번들의 버전. 화면이 뒤처짐을 말할 때 쓰는 기준값. */
  appVersion(): Promise<string | null> {
    return this.runnerLauncher.currentAppVersion();
  }

  /**
   * 이 에이전트의 러너를 **새 번들로 갈아 띄운다.** 실제 순서(죽이라고 말하고, 종료를
   * 확인하고, 띄운다)는 실행기가 갖는다 — 컨트롤러가 하는 일은 대상과 입력을 대는 것뿐이다.
   */
  async restartRunner(agentId: string): Promise<void> {
    const input = await this.launchInput();
    if (!input) return;
    const target = input.agents.find((a) => a.id === agentId);
    // 서버 목록에 없는 에이전트는 재기동할 대상이 아니다 — 지어내지 않는다.
    if (!target) return;
    // 소유자만 띄운다(`startAll` 의 술어와 같다). admin 이라도 남의 러너를 이 기기로
    // 가져오지 않는다 — 그것은 재기동이 아니라 소유 이전이다.
    if (target.ownerAccountId !== input.myAccountId) return;
    await this.runnerLauncher.restart(target, input);
  }

  /**
   * 뒤처진 러너를 **전부** 새 번들로 갈아 띄운다. 고르는 것은
   * `runnerVersions.ts::staleRunners` 하나이고(화면과 같은 판정), 돌려주는 것은
   * 실제로 예약한 목록이다 — 화면이 "N대 재기동했다"를 지어내지 않게.
   *
   * **동시에 예약한다(순차가 아니다).** 순차로 돌면 첫 러너의 턴이 끝날 때까지 나머지는
   * `running` 으로 남고, 사람은 "한 대만 재기동 중"으로 읽는다 — 실측 5분 넘는 턴도
   * 있으므로 그 오독은 길다. 예약은 전부에게 **지금** 걸려야 하고, 그 뒤의 기다림은 각자의
   * 턴 길이만큼이면 된다.
   *
   * 동시에 걸어도 안전한 이유: `observe()` 는 읽기이고, 종료 판정은 러너마다 자기
   * `agentId` 만 본다(`awaitRunnerExit`). 서로의 확인을 헷갈릴 자리가 없다.
   */
  async restartStaleRunners(): Promise<string[]> {
    const input = await this.launchInput();
    if (!input) return [];
    const appVersion = await this.appVersion();
    const states = this.store.getState().runnerStates;
    const live = new Set(
      input.agents
        .filter((a) => {
          const status = states[a.id]?.status;
          return status === 'running' || status === 'adopted';
        })
        .map((a) => a.id),
    );
    // `startAll` 과 **같은 술어**로 좁힌다 — 러너를 띄우는 것은 소유자의 일이고
    // (`startAll` 의 대상 선별), 남의 에이전트를 재기동하면 그 러너의 PAT·소유가 이
    // 기기로 옮겨 온다. 화면은 `runnerStates`(소유한 것만 든다)로 이미 좁혀져 있지만,
    // 판정을 데이터의 우연에 맡기지 않는다.
    const mine = input.agents.filter((a) => a.ownerAccountId === input.myAccountId);
    const { stale } = staleRunners({ agents: mine, live, appVersion });
    await Promise.all(stale.map((agentId) => {
      const target = mine.find((a) => a.id === agentId);
      return target ? this.runnerLauncher.restart(target, input) : Promise.resolve();
    }));
    return stale;
  }

  /** 재기동 예약을 취소한다 — **뜨는 것만** 취소된다(실행기 주석 참조). */
  cancelRestart(agentId: string): void {
    this.runnerLauncher.cancelRestart(agentId);
  }

  /**
   * 알림 제목에 붙일 커뮤니티 꼬리표(#166 §6). 커뮤니티가 **하나뿐이면 빈 문자열**이다 —
   * 하나뿐인데 이름을 붙이면 오늘 보던 알림이 달라진다(이 이슈의 성공 기준은 사용자 눈에
   * 보이는 변화가 0 인 것이다). 둘 이상이면 어느 커뮤니티에서 온 것인지 드러내야 한다:
   * 같은 이름의 채널이 커뮤니티마다 있고, 제목만으로는 구분이 안 된다.
   *
   * 자기 엔트리를 스토어 신원으로 찾는다 — 커뮤니티 id 를 따로 들고 다니면 레지스트리에서
   * 빠진 뒤에도 남아 있는 값이 생긴다.
   */
  private communitySuffix(): string {
    const { entries } = useCommunityRegistry.getState();
    if (entries.length < 2) return '';
    const mine = this.communityEntry();
    return mine ? ` (${communityLabel(mine)})` : '';
  }

  /**
   * 이 컨트롤러가 어느 커뮤니티의 것인지. 스토어 신원으로 찾는다 — 커뮤니티 id 를 따로
   * 들고 다니면 레지스트리에서 빠진 뒤에도 남아 있는 값이 생긴다(`communitySuffix` 와
   * 같은 이유이고, **같은 자리 하나**를 쓴다: 꼬리표와 알림 목적지가 서로 다른 커뮤니티를
   * 가리키는 상태를 만들 방법이 없어야 한다).
   */
  private communityEntry() {
    return useCommunityRegistry.getState().entries.find((e) => e.store === this.store);
  }

  /** 알림에 실을 목적지(#542). 레지스트리에서 자기를 못 찾으면 목적지 없이 알린다. */
  private notificationTarget(messageId: string): NotificationTarget | undefined {
    const mine = this.communityEntry();
    return mine ? { communityId: mine.id, messageId } : undefined;
  }

  // fire-and-forget 호출의 unhandled rejection 방지 — 실패는 조용히 무시(다음 이벤트/리컨실이 자연 복구).
  private swallow(p: Promise<unknown>): void { void p.catch(() => {}); }
  private projectionRefreshInterval: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    const store = this.store.getState();
    const [me, { accounts, groups, teams }, channels, dms, leases, unread, reads] = await Promise.all([
      this.api.me(), this.api.accounts(), this.api.channels(),
      this.api.dms(), this.api.leases(), this.api.inboxUnread(), this.api.reads(),
    ]);
    // React StrictMode 정리나 재로그인이 위 요청 도중 stop() 할 수 있다. 그 뒤 계속하면
    // 폐기된 컨트롤러가 WS와 러너를 다시 만들며 세션 하나가 둘로 갈라진다.
    if (this.stopped) return;
    store.set({
      me, channels, dms, leases, unread,
      accounts: Object.fromEntries(accounts.map((a) => [a.id, a])),
      groups,
      // 옛 서버는 `teams` 를 안 싣는다. **그것을 빈 배열로 바꾸지 않는다** — 팀이
      // 없는 것과 목록을 못 받은 것은 다른 사실이고, 합치면 설정 격자가 있는 팀을
      // 없다고 단언한다(`appStore.ts::teams` 의 그 표). `undefined` 대신 `null` 인
      // 것은 "모른다"를 스토어의 값으로 쓰기 위해서다.
      teams: teams ?? null,
      reads: Object.fromEntries(reads.map((r) => [r.channelId, { lastReadSeq: r.lastReadSeq, unread: r.unread }])),
    });
    // 초안은 기기 로컬에 있으므로 서버 왕복이 없다 — 크리티컬 패스에 둬도 비용이 없다.
    store.hydrateDrafts();
    // 고정 멘션도 같은 자리에서 읽는다(#706) — 초안만 복원하면 "이 스레드는 그 에이전트를
    // 부르는 중"이라는 절반만 돌아온다.
    store.hydrateStickyMentions();

    // 채널 선호는 **크리티컬 패스에서 뺀다.** 위 Promise.all 에 넣으면 이 엔드포인트가
    // 없는 서버(구버전)에 붙었을 때 앱이 기동조차 못 한다. 선호는 UI 편의값이라 없으면
    // 정렬이 이름순으로 남을 뿐이다 — `refreshAccounts` 가 같은 이유로 실패를 삼킨다.
    this.swallow(this.refreshChannelPrefs());
    // 담아 둔 메시지 요약(#219)도 같은 방식으로 fire-and-forget 으로 받는다.
    this.swallow(this.loadSavedSummary());
    // 투영 상태도 60초마다 갱신한다(#267) — 앱 기동 시 한 번과 정기적으로.
    this.swallow(this.refreshProjectionStatus());
    this.projectionRefreshInterval = setInterval(() => {
      this.swallow(this.refreshProjectionStatus());
    }, 60_000);
    // 앱을 열자마자 쌓여 있던 미읽음이 한꺼번에 터지면 알림이 소음이 된다.
    for (const e of unread) this.announced.add(e.id);
    // 장기 토큰은 ApiClient 가 헤더로만 쓴다 — WS URL 에는 단기 티켓만 실린다.
    this.ws = this.makeWs(this.api.baseUrl, () => this.api.wsTicket(), {
      onEvent: (e) => this.handleEvent(e),
      onOpen: () => {
        this.store.getState().set({ connected: true });
        this.swallow(this.reconcile());
        // 서버 버전은 **소켓이 열릴 때마다** 다시 묻는다(#693). 주기 갱신이 아닌 이유:
        // 이 값은 서버 프로세스가 다시 뜰 때만 바뀌고, 그때 소켓은 **반드시 끊겼다가
        // 다시 붙는다.** 그래서 재접속이 곧 "버전이 바뀌었을 수 있는 유일한 순간"이다 —
        // 60초 타이머를 얹으면 아무것도 더 못 잡으면서 요청만 늘어난다.
        this.swallow(this.refreshServerVersion());
      },
      onDown: (reason) => this.handleDown(reason),
    });

    // **daemon 은 여기서 세운다** — 러너를 띄울지 정하기 **전에**(`#431` 2단계 A).
    //
    // 러너가 하나도 없어도, 자동 기동 토글이 꺼져 있어도 부른다. daemon 은 러너의
    // 부산물이 아니라 상주 프로세스이고(사용자 결정: *"daemon 은 그냥 떠 있는 것"*),
    // 무엇보다 **daemon 이 떠 있어야 "무엇이 돌고 있나"를 물을 상대가 생긴다.**
    //
    // 앞 판본에는 이 줄이 없었고, daemon 에 닿는 자리는 `daemonSpawner.spawn()` 하나뿐이었다.
    // 그런데 그 앞단이 presence 를 보고 `external` 로 판정하면 `spawn()` 이 안 불려서
    // daemon 도 안 떴다 — 장부에 없는 남의 러너가 살아 있기만 해도 앱이 아무것도 못 띄우고,
    // 사람이 `ps` 로 찾아 죽여야 풀렸다(실측 2026-09-06, 두 번). 이 한 줄이 그 고리를 끊는다.
    //
    // fire-and-forget 인 이유: daemon 확보는 기동의 **전제가 아니다.** 실패해도 앱은 떠야
    // 하고(채팅은 daemon 없이도 된다), 그 실패는 러너를 띄우려 할 때 러너 상태에 사유로
    // 오른다(`RunnerLauncher.startAll`). 여기서 await 하면 소켓 왕복이 창 표시를 늦춘다.
    this.swallow(this.runnerLauncher.ensureDaemon());

    // 러너 자동 기동은 **presence 를 받은 뒤**에 한다 — 여기서 바로 부르면 `online` 이
    // 아직 빈 배열이고, presence 는 이제 판정을 안 하지만 어긋남을 말하는 데 쓰인다
    // (`StartAllInput.liveAccountIds`). 중복 기동을 막는 것은 daemon 장부다.
    // 이 플래그는 start() 마다 초기화된다.
    this.runnerAutoStartDone = false;
  }

  stop(): void {
    this.stopped = true;
    this.runnerLauncher.dispose();
    this.ws?.close();
    this.ws = null;
    if (this.projectionRefreshInterval) { clearInterval(this.projectionRefreshInterval); this.projectionRefreshInterval = null; }
  }

  /**
   * 서버가 말하는 자기 버전을 스토어에 넣는다(#693).
   *
   * **실패를 삼킨다** — 투영 상태(`refreshProjectionStatus`)와 반대다. 그쪽은 조회 실패가
   * 곧 화면이 답해야 할 질문이지만, 여기서는 못 읽었다는 사실이 이미 다른 값으로 보인다:
   * `/healthz` 가 안 되는 서버면 소켓도 없어 그 줄은 `Disconnected` 로 그려진다. 오류를
   * 따로 실어 올리면 같은 사실을 두 곳에서 말하게 된다.
   *
   * **못 읽었을 때 이전 값을 지우지 않는다.** 붙어 있는 서버의 버전은 여전히 그 값이고,
   * 한 번 실패했다고 화면에서 지우면 "모르는 서버"로 되돌아간다.
   */
  private async refreshServerVersion(): Promise<void> {
    const serverVersion = await this.api.serverVersion();
    if (this.stopped) return;
    this.store.getState().set({ serverVersion });
  }

  /**
   * 투영 상태를 갱신한다(#267). 기동 시 한 번, 이후 60초마다.
   *
   * **실패를 삼키지 않는다.** 다른 fire-and-forget 조회(`swallow`)와 다른 이유가 있다:
   * 이 조회의 결과물이 곧 "투영이 어떤 상태인가"를 말하는 화면이므로, 실패를 삼키면
   * 마지막 성공 상태(또는 `null`)가 그대로 남아 **못 읽고 있는 화면이 정상으로 보인다**.
   * 그것이 이 이슈가 닫으려는 결함 그 자체다. 그래서 실패는 `projectionStatusError` 로
   * 화면까지 올라가고, 다음 주기가 성공하면 지워진다.
   */
  private async refreshProjectionStatus(): Promise<void> {
    try {
      const status = await this.api.projectionStatus();
      this.store.getState().set({ projectionStatus: status, projectionStatusError: null });
    } catch (err) {
      this.store.getState().set({
        projectionStatusError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 문구는 UI 문자열이라 영어다(저장소 관례). 사유별로 다른 이유: 사용자가 할 일이 다르다. */
  private static readonly LOST_MESSAGE: Record<Exclude<WsDownReason, 'network'>, string> = {
    credential: 'Your session is no longer valid — it expired, or it was signed out elsewhere. Please sign in again.',
    origin: "The server rejected this app's origin. Ask the server administrator to allow it (CORS_ORIGINS).",
  };

  private handleDown(reason: WsDownReason): void {
    this.store.getState().set({ connected: false });
    // 네트워크 끊김은 기다리면 낫는다 — 세션을 건드리지 않는다. 잠깐 끊겼다고 로그아웃시키면 최악이다.
    if (reason === 'network') return;
    // 되돌릴 수 없는 사유다. 로컬 상태를 비우고 사유를 위로 올린다 — 안 그러면 사용자는
    // 빨간 점과 영구 재연결만 본다(조용한 실패).
    // **`me` 를 먼저 읽는다.** `clearLocal()` 이 스토어를 reset 하므로 그 뒤에 읽으면
    // 항상 null 이고, accountId 가 빈 문자열이 되어 App 이 활성 커뮤니티를 못 알아본다.
    const accountId = this.store.getState().me?.id ?? '';
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
    this.store.getState().clearDrafts();
    // 고정은 문장이 아니지만 *누구와 이야기하던 자리인가*는 남는다. 초안과 같은 매체에
    // 같은 수명으로 두기로 했으므로 지우는 자리도 여기다(#706).
    this.store.getState().clearStickyMentions();
    this.store.getState().reset();
  }

  private handleEvent(e: WsServerEvent): void {
    const store = this.store.getState();
    switch (e.type) {
      case 'message.created':
        store.upsertMessages(e.message.channelId, [e.message]);
        this.bumpUnread(e.message.channelId, e.message.authorId);
        this.swallow(this.announceNewMessage(e.message));
        if (e.message.threadRootId) {
          store.bumpThreadCounts(
            e.message.channelId, e.message.threadRootId, 1, countsAsReply(e.message.kind),
          );
        }
        // 서버는 기동 시 투영용 system 계정을 만든다 — 그보다 먼저 부트스트랩한 클라이언트는
        // 그 계정을 모르고, 작성자가 '…'로 표시된다. 디렉터리는 정적이 아니다.
        if (!store.accounts[e.message.authorId]) this.swallow(this.refreshAccounts());
        break;
      case 'message.updated':
        // 같은 id 로 덮어쓰면 upsert 가 제자리 교체한다.
        store.upsertMessages(e.message.channelId, [e.message]);
        break;
      case 'message.deleted': {
        /**
         * **지우면 수도 줄어야 한다.** 여기서 집계를 되돌리지 않아 `message.created` 만
         * 더하고 아무도 빼지 않았고, 답글을 지운 채널은 다시 받아오기 전까지 없는 답글을
         * 셌다(2026-09-09).
         *
         * 지워질 행에서 재료를 먼저 읽는다 — `removeMessage` 뒤에는 이 메시지가 어느
         * 스레드의 무엇이었는지 알 방법이 없다(삭제 이벤트에는 id 와 채널뿐이다).
         * 스토어에 없으면(아직 안 받아온 채널) 아무것도 하지 않는다: 모르는 것을
         * 짐작해 빼면 맞는 수를 틀리게 만든다.
         */
        const gone = (store.messages[e.channelId] ?? []).find((m) => m.id === e.messageId);
        store.removeMessage(e.channelId, e.messageId);
        if (gone?.threadRootId) {
          store.bumpThreadCounts(e.channelId, gone.threadRootId, -1, countsAsReply(gone.kind));
        }
        // 루트가 사라진 스레드를 계속 열어 두면 답글만 남은 빈 패널에 갇힌다.
        if (store.threadRootId === e.messageId) store.set({ threadRootId: null });
        break;
      }
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
          // 선호도 다시 읽는다(#376). 나를 부르는 것이 오면 **서버가** 그 채널의 숨김을
          // 풀기 때문이다(`services/messages.ts` 의 `insertInbox`). 같은 판정을 여기서 다시
          // 구현하면 두 곳이 갈라져 "서버는 풀었는데 사이드바에는 안 보이는" 채널이 생긴다 —
          // 규칙은 서버 한 곳에 두고 이쪽은 결과만 다시 읽는다.
          //
          // **숨긴 채널이 하나도 없으면 읽지 않는다.** 서버가 혼자 바꾸는 값은 `hiddenAt`
          // 하나뿐이라, 숨긴 것이 없으면 다시 읽어도 같은 값이다. 무조건 읽으면 멘션마다
          // 왕복이 하나 늘고, 방금 로컬에 반영한 선호(음소거 해제 등)를 한 박자 늦은 응답이
          // 되돌리는 창이 생긴다 — `channelMute` · `channelNotifyLevel` 회귀선이 그 창을 본다.
          if (Object.values(store.channelPrefs).some((p) => p?.hiddenAt)) {
            this.swallow(this.refreshChannelPrefs());
          }
        }
        break;
      case 'lease.changed':
        this.swallow(this.api.leases().then((leases) => this.store.getState().set({ leases })));
        break;
      case 'presence.snapshot':
        store.set({ online: e.online });
        // #250: 러너 자동 기동은 **여기서** 시작한다. presence 가 도착한 이 순간이
        // "누가 이미 붙어 있는가"를 처음 아는 시점이고, 그것을 모른 채 띄우면 중복 러너가
        // 생긴다. 재접속마다 다시 하지 않는다(플래그) — 재접속은 러너의 생사와 무관하다.
        if (!this.runnerAutoStartDone) {
          this.runnerAutoStartDone = true;
          this.swallow(this.startRunners());
        }
        break;
      case 'agent.attention': {
        // 관문에 걸린 턴은 화면에 아무 신호도 남기지 않는다 — 답이 안 올 뿐이다. 사람은
        // [터미널 열기]를 누를 이유조차 모르므로, 앱이 먼저 그 화면을 띄운다.
        const 지금 = store.terminalTarget;
        const 같은자리 = 지금
          && 지금.agentAccountId === e.agentAccountId
          && 지금.channelId === e.channelId
          && 지금.threadRootId === e.threadRootId;
        // 이미 보고 있으면 아무것도 안 한다. 같은 자리를 다시 세우면 xterm 이 다시 붙어
        // 화면이 깜빡이고, 사람이 치고 있던 입력이 끊긴다.
        if (같은자리) break;
        store.set({
          notice: `${e.agentHandle} needs you in the terminal (account ${e.accountLabel}).`,
        });
        // **사람이 보던 화면을 빼앗지 않는다.** 다른 스레드의 터미널을 보고 있다면 그
        // 사람은 지금 다른 것을 하는 중이고, 안내가 그것을 알린다.
        // 스레드 루트가 없으면 열 자리 자체가 없다(`terminalTarget` 은 스레드를 가리킨다).
        if (지금 || !e.threadRootId) break;
        store.set({
          terminalTarget: {
            agentAccountId: e.agentAccountId,
            channelId: e.channelId,
            threadRootId: e.threadRootId,
          },
        });
        break;
      }
      case 'presence.changed': {
        const cur = new Set(this.store.getState().online);
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
      case 'avatar.changed':
        store.applyAvatar(e.accountId, e.avatarAttachmentId);
        if (!store.accounts[e.accountId]) this.swallow(this.refreshAccounts());
        break;
      case 'account.handle_changed':
        store.applyHandle(e.accountId, e.newHandle);
        if (!store.accounts[e.accountId]) this.swallow(this.refreshAccounts());
        break;
      case 'channel.created':
        // 새 채널을 목록에 추가한다. public 은 전원에게 오고, private 은 멤버에게만 온다.
        // 이미 있으면 무시(upsert 가 아니라 adds 를 쓴다).
        if (!store.channels.some((c) => c.id === e.channel.id)) {
          store.set({ channels: [...store.channels, e.channel] });
        }
        break;
      case 'channel.updated':
        // 목록에 있으면 교체하고, **없으면 넣는다.** private→public 전환이 그 경우다:
        // 그때까지 목록에 없던 사람에게도 이벤트가 오는데(이제 볼 수 있으므로) 교체만
        // 하면 아무 일도 일어나지 않아, 새로 열린 채널이 새로고침 전까지 보이지 않는다.
        store.set({
          channels: store.channels.some((c) => c.id === e.channel.id)
            ? store.channels.map((c) => (c.id === e.channel.id ? e.channel : c))
            : [...store.channels, e.channel],
        });
        break;
      case 'channel.deleted':
        // 채널을 목록에서 제거한다. 보고 있던 채널이면 선택을 비우고 안내를 보인다.
        store.set({
          channels: store.channels.filter((c) => c.id !== e.channelId),
          ...(store.activeChannelId === e.channelId
            ? { activeChannelId: null, threadRootId: null, notice: 'This channel was deleted.' }
            : {}),
        });
        break;
      case 'saved.changed':
        // 담기 상태가 바뀌면 사이드바의 "Saved N" 을 갱신한다(#219).
        if (e.accountId === store.me?.id) {
          this.swallow(this.loadSavedSummary());
        }
        break;
      case 'channel.member_added':
      case 'channel.member_removed':
        // 멤버 집합이 바뀌었다(#300). 이미 들고 있는 채널의 멤버 목록만 다시 받는다 —
        // 들고 있다는 것은 멤버 패널이나 사이드바가 그것을 그리고 있다는 뜻이고, 안 들고
        // 있는 채널까지 받으면 남이 사람을 옮길 때마다 안 보는 채널의 조회가 폭주한다.
        // 목록 자체가 생기거나 사라지는 일은 같이 오는 channel.created/deleted 가 맡는다.
        if (store.channelMembers[e.channelId]) {
          this.swallow(this.loadChannelMembers(e.channelId));
        }
        break;
      case 'handle_group.changed':
        // 집합 목록과 구성원 수를 갱신한다(#300).
        this.swallow(this.refreshAccounts({ force: true }));
        break;
      case 'agent_team.changed':
        // 팀 목록과 팀원 수를 갱신한다(#172). 집합과 **같은 경로**를 탄다 — 둘이 한
        // 응답에 오므로(`GET /accounts`) 여기서 따로 부를 것이 없고, 따로 부르면 두
        // 조회가 서로 다른 순간의 디렉터리를 보고 스토어를 반쪽씩 덮는다.
        this.swallow(this.refreshAccounts({ force: true }));
        break;
      case 'link_preview.ready':
        // 카드가 준비됐다는 신호만 남긴다(#215). 내용은 그 URL 을 그리는 컴포넌트가
        // 스스로 읽는다 — 지금 화면에 없는 URL 의 카드를 미리 받아 둘 이유가 없다.
        store.set({ linkPreviewReadyAt: { ...store.linkPreviewReadyAt, [e.url]: Date.now() } });
        break;
      /**
       * 워크스페이스 스킬(#311). 제안·승인·비활성을 받으면 **신호만** 올린다 —
       * 열려 있는 스킬 설정 화면이 그것을 보고 목록을 다시 읽는다.
       *
       * 이벤트가 실어 온 `skill` 을 스토어에 넣지 않는 이유: 목록은 서버에 하나뿐이고,
       * 여기서 한 건만 끼워 넣으면 그 사이 다른 admin 이 한 승인이 화면에서 사라진다.
       * 신호를 받고 통째로 다시 읽는 쪽이 언제나 서버와 같다.
       */
      case 'skill.proposed':
      case 'skill.approved':
      case 'skill.disabled':
        store.set({ skillsRevision: store.skillsRevision + 1 });
        break;
    }
  }

  /**
   * 배지를 올린다. 보고 있는 채널과 내가 쓴 것은 올리지 않는다 — 열려 있는 채널에 배지가
   * 뜨면 배지가 "가봐야 할 곳"이라는 뜻을 잃고, 자기 발화에 배지가 뜨면 더 무의미하다.
   */
  private bumpUnread(channelId: string, authorId: string): void {
    const store = this.store.getState();
    if (channelId === store.activeChannelId || authorId === store.me?.id) return;
    const cur = store.reads[channelId] ?? { lastReadSeq: 0, unread: 0 };
    store.set({ reads: { ...store.reads, [channelId]: { ...cur, unread: cur.unread + 1 } } });
  }

  private async reconcile(): Promise<void> {
    const { activeChannelId, messages } = this.store.getState();
    if (activeChannelId) {
      const maxSeq = Math.max(0, ...(messages[activeChannelId] ?? []).map((m) => m.seq));
      const page = await this.api.messages(activeChannelId, { since: maxSeq });
      this.store.getState().upsertMessages(activeChannelId, page.messages);
    }
    await this.refreshUnread();
    this.store.getState().set({ leases: await this.api.leases() });
  }

  /** 미지의 작성자가 연달아 오면 요청이 폭주하므로, 진행 중인 조회 하나에 합류시킨다. */
  private accountsInFlight: Promise<void> | null = null;
  private lastAccountsRefresh = 0;
  private static readonly ACCOUNTS_REFRESH_INTERVAL_MS = 5_000;
  /**
   * 나간 순서와 **적용된 순서**를 재는 두 번호. 아래 `force` 가 진행 중인 조회를
   * 앞지를 수 있게 된 순간부터, 두 응답이 겹쳐 도착할 수 있다 — 늦게 온 낡은 응답이
   * 새 것을 덮으면 이 함수가 고치려는 그 상태(스토어가 옛 디렉터리를 든다)로 되돌아간다.
   */
  private accountsSeq = 0;
  private accountsAppliedSeq = 0;

  /**
   * 디렉터리를 다시 읽는다.
   *
   * ## `force` 는 **진행 중인 조회에 합류하지 않는다**
   *
   * 합류는 스로틀과 같은 목적으로 있다 — 미지의 작성자가 연달아 오면 같은 조회가 폭주하고,
   * 그때는 이미 나간 것 하나로 충분하다. **`force` 는 그 경우가 아니다:** 사람이 방금
   * 팀을 만들었거나(`AgentsSettings::reloadTeams`) 서버가 바뀌었다고 알려 온 것이고
   * (`agent_team.changed`·`handle_group.changed`), 진행 중인 조회는 **그 사건이 일어나기
   * 전에 시작된 것**이라 새 팀이 실려 있을 리가 없다. 앞 판은 `??=` 하나로 둘을 같이
   * 처리해서, 갱신을 부른 그 순간 다른 조회가 떠 있으면 `force` 가 조용히 무력화됐다 —
   * 만든 팀이 격자에 안 나타나고 다음 갱신까지 그대로 남는다.
   *
   * 그래서 `force` 는 늘 새 요청을 낸다. 대신 겹쳐 도착하는 응답의 순서를 **번호로**
   * 지킨다(위 두 필드): 먼저 나간 응답이 나중에 도착해도 새 것을 덮지 못한다.
   */
  refreshAccounts(opts: { force?: boolean } = {}): Promise<void> {
    const now = Date.now();
    if (!opts.force) {
      if (now - this.lastAccountsRefresh < Controller.ACCOUNTS_REFRESH_INTERVAL_MS) {
        return Promise.resolve();
      }
      if (this.accountsInFlight) return this.accountsInFlight;
    }
    this.lastAccountsRefresh = now;
    const seq = ++this.accountsSeq;
    const inFlight = this.api
      .accounts()
      .then(({ accounts, groups, teams }) => {
        // 나보다 뒤에 나간 응답이 이미 적용됐으면 아무것도 하지 않는다.
        if (seq < this.accountsAppliedSeq) return;
        this.accountsAppliedSeq = seq;
        this.store.getState().set({
          accounts: Object.fromEntries(accounts.map((a) => [a.id, a])),
          groups,
          // `?? null` 인 이유는 `start()` 의 같은 자리 주석에 있다.
          teams: teams ?? null,
        });
      })
      // 합류시킬 대상은 **가장 최근에 나간 것**이다 — 늦게 끝난 옛 요청이 그 자리를
      // 비우면, 아직 도는 새 요청이 있는데도 다음 호출이 또 하나를 낸다.
      .finally(() => { if (this.accountsInFlight === inFlight) this.accountsInFlight = null; });
    this.accountsInFlight = inFlight;
    return inFlight;
  }

  /**
   * 알림 수준이 `all` 인 채널의 **일반 새 메시지**를 알린다(#224).
   *
   * `announceNewMentions` 와 나뉘어 있는 이유는 재료가 다르기 때문이다: 저쪽은 서버가 만든
   * `InboxEntry`(나를 부른 것)를 순회하고, 이쪽은 그 목록에 아예 오르지 않는 평범한 메시지를
   * 다룬다. `mentions` 는 "나를 부른 것만"이므로 여기서 걸러지고, `none` 도 마찬가지다.
   *
   * 여기서는 `announced` 같은 '지나간 것' 기록이 필요 없다. 이 경로는 소켓 이벤트 하나당
   * 한 번 도는 것이라 다시 훑는 일이 없다 — 한꺼번에 터질 목록 자체가 존재하지 않는다.
   * 되훑는 쪽(`announceNewMentions`)에만 그 기록이 있다.
   */
  private async announceNewMessage(message: MessageRow): Promise<void> {
    const store = this.store.getState();
    // 내가 쓴 것은 알리지 않는다. 보고 있는 창에도 띄우지 않는다 — 배지가 그 일을 한다.
    if (message.authorId === store.me?.id || document.hasFocus()) return;
    /**
     * 진행 한 줄·대기 줄은 알리지 않는다(2026-09-09). 채널을 `all` 로 둔 것은 **오가는
     * 말**을 다 받겠다는 뜻이지, 에이전트가 일하는 동안 남기는 상태 표시까지 받겠다는
     * 뜻이 아니다 — 화면도 그것을 말풍선이 아니라 `ProgressRow`·`WakeRow` 로 그린다.
     *
     * 서버가 같은 종류로 `thread_reply`·`dm` inbox 를 만들지 않게 됐지만(`postMessage`),
     * 이 경로는 inbox 를 거치지 않고 **소켓 이벤트에서 바로** 알린다. 그래서 판정이
     * 여기에도 필요하다 — 기준은 `countsAsReply` 한 문장으로 같다.
     */
    if (!countsAsReply(message.kind)) return;
    if (notifyLevelOf(store.channelPrefs[message.channelId]) !== 'all') return;
    // 이 채널을 `all` 로 둔 것이 옵트인이지만, 기기 전체 스위치는 여전히 위에 있다.
    const prefs = usePrefsStore.getState().notifications;
    if (!prefs.enabled) return;
    // 멘션 경로가 이미 알렸으면 두 번 울리지 않는다.
    if (this.notifiedMessages.has(message.id)) return;

    const channel = store.channels.find((c) => c.id === message.channelId);
    const dm = store.dms.find((d) => d.id === message.channelId);
    const where = channel
      ? `#${channel.name}`
      : dm
        ? dm.memberIds.filter((id) => id !== store.me?.id).map((id) => store.accounts[id]?.handle ?? '…').join(', ')
        : 'Harkroom';
    const author = store.accounts[message.authorId]?.handle;

    this.notifiedMessages.add(message.id);
    await this.notifier.notify({
      title: `${author ? `@${author} ` : ''}posted in ${where}`.trim() + this.communitySuffix(),
      // 미리보기를 끄면 제목(누가·어디서)은 남기고 대화 내용만 뺀다 — 멘션 알림과 같은 규칙이다.
      // 본문은 `displayBody` 를 지난다(#329) — 시스템 메시지는 자리표시자를 갖고 있어
      // 원본을 그대로 실으면 OS 알림에만 그 글자가 뜬다.
      body: prefs.showPreview ? displayBody(message, store.accounts) : 'New message',
      // 눌렀을 때 갈 곳(#542). 제목의 `where` 는 사람이 읽는 문자열이고, 이동에는 id 를 쓴다.
      target: this.notificationTarget(message.id),
    });
  }

  /** 새로 들어온 미읽음을 OS 알림으로 알린다. 보고 있는 창에는 띄우지 않는다 — 배지가 그 일을 한다. */
  private async announceNewMentions(): Promise<void> {
    const { unread, me, channels, dms, accounts, messages, channelPrefs } = this.store.getState();
    if (document.hasFocus()) {
      // 포커스 중에는 알리지 않되, 본 것으로 처리해 나중에 뒤늦게 터지지 않게 한다.
      for (const e of unread) this.announced.add(e.id);
      return;
    }

    const prefs = usePrefsStore.getState().notifications;
    /**
     * 두 표는 **총체(total)여야 한다** — `Record<InboxEntry['reason'], …>` 로 못 박는 이유가
     * 그것이다. 사유가 늘 때 표를 빠뜨리면 `wanted[reason]` 이 undefined(falsy)라 알림이
     * 조용히 사라지거나, `label[reason]` 이 undefined 라 "undefined #ch" 가 나간다.
     * 타입이 그 자리에서 컴파일을 세우면 새 사유를 넣는 사람이 이 결정을 마주한다.
     *
     * `wake` 는 에이전트가 **자기에게** 건 대기다(마이그레이션 040). 사람의 inbox 에는
     * 오지 않지만, 온다 해도 알리지 않는다 — 사람에게 온 말이 아니고, 화면에는 이미
     * 대기 줄로 보인다(WakeRow). 남의 기다림이 내 밤을 깨울 이유가 없다.
     *
     * `ask_answered` 도 같다(마이그레이션 043): 에이전트가 낸 선택지에 **사람이** 답한
     * 것을 그 에이전트에게 알리는 사유다. 답한 사람은 방금 자기가 누른 것이라 알림이
     * 필요 없고, 다른 사람에게는 남의 대화다.
     */
    const label: Record<InboxEntry['reason'], string> = {
      mention: 'mentioned you in', thread_reply: 'replied in a thread in', dm: 'messaged you in',
      wake: 'is waiting in', ask_answered: 'got an answer in', ask_closed: 'got no answer in',
      /**
       * `team_mention` 은 **에이전트에게만 가는 사유**다(047) — 팀에는 에이전트만 들고
       * (`not_an_agent`) 팀장은 그 팀원 중 하나이므로, 사람의 inbox 에는 이 사유가 오지
       * 않는다. 그래도 표를 채우는 이유는 위 문단이 말한 그대로다: 총체가 아니면 새 사유가
       * `undefined` 로 새어 "undefined #ch" 를 내보낸다.
       *
       * 알리지 않는(`wanted: false`) 이유는 `wake`·`ask_answered` 와 같다 — 사람에게 온
       * 말이 아니다. 사람이 팀을 부른 그 발화 자체는 팀장의 일이고, 부른 사람에게는 이미
       * 자기가 쓴 말이다.
       */
      team_mention: 'called your team in',
      /**
       * 위임 사유 둘도 **에이전트에게만 가는 것**이다(050) — 팀에는 에이전트만 들고
       * 위임은 팀장과 팀원 사이의 말이다. 그래도 표를 채우는 이유는 위 문단 그대로다:
       * 총체가 아니면 새 사유가 `undefined` 로 새어 "undefined #ch" 를 내보낸다.
       */
      team_delegated: 'handed you work in',
      delegation_done: 'got results in',
    };
    const wanted: Record<InboxEntry['reason'], boolean> = {
      mention: prefs.mention, thread_reply: prefs.threadReply, dm: prefs.dm,
      wake: false, ask_answered: false, ask_closed: false, team_mention: false,
      team_delegated: false, delegation_done: false,
    };

    for (const e of unread) {
      if (e.readAt || this.announced.has(e.id)) continue;
      // 끈 알림도 여기서 '지나간 것'으로 표시한다 — 아니면 사용자가 알림을 켜는 순간
      // 그동안 쌓인 것이 한꺼번에 터진다. 포커스 분기와 같은 이유다.
      this.announced.add(e.id);
      // 채널 알림 수준(#224). **`none` 이면 멘션도 알리지 않는다** — #229 가 "음소거는
      // 멘션·DM도 예외가 아니다"로 갔고, 세분화가 생긴 지금 그 결정을 **명시적으로
      // 유지한다**: 덜 받고 싶은 사람에게는 `mentions` 라는 자리가 따로 생겼으므로
      // `none` 을 고른 것은 정말로 전부 끄겠다는 뜻이다. `mutedAt` 은 보지 않는다 —
      // 같은 질문에 두 컬럼이 답하면 한쪽만 고치는 사고가 난다.
      //
      // 건너뛰기 전에 위에서 이미 '지나간 것'으로 적었다. 그 순서가 중요하다: 나중에
      // 수준을 올리는 순간 그동안 묶여 있던 알림이 한꺼번에 터지지 않게 하는 자리다.
      if (notifyLevelOf(channelPrefs[e.channelId]) === 'none') continue;
      // `all` 채널이면 `announceNewMessage` 가 같은 메시지를 이미 알렸을 수 있다.
      if (this.notifiedMessages.has(e.messageId)) continue;
      if (!prefs.enabled || !wanted[e.reason]) continue;

      const row = (messages[e.channelId] ?? []).find((m) => m.id === e.messageId);
      const author = row ? accounts[row.authorId]?.handle : null;
      const channel = channels.find((c) => c.id === e.channelId);
      const dm = dms.find((d) => d.id === e.channelId);
      const where = channel
        ? `#${channel.name}`
        : dm
          ? dm.memberIds.filter((id) => id !== me?.id).map((id) => accounts[id]?.handle ?? '…').join(', ')
          : 'Harkroom';
      // 본문이 스토어에 없으면(창 밖으로 밀려난 채널 등) 이유만으로도 알림은 성립한다.
      const generic = `New ${e.reason.replace('_', ' ')}`;

      this.notifiedMessages.add(e.messageId);
      await this.notifier.notify({
        title: `${author ? `@${author} ` : ''}${label[e.reason]} ${where}`.trim() + this.communitySuffix(),
        // 미리보기를 끄면 제목(누가·어디서)은 남기고 대화 내용만 뺀다.
        // `displayBody` 를 지나는 이유는 `announceNewMessage` 와 같다(#329) — 본문을
        // 사람에게 보여 주는 자리는 예외 없이 같은 함수를 지나야 자리표시자가 새지 않는다.
        body: prefs.showPreview ? (row ? displayBody(row, accounts) : generic) : generic,
        // 스레드 답글이면 `openMessage` 가 스레드 패널까지 연다 — 목적지에 담을 것은
        // 그 메시지 id 하나뿐이고, 스레드 여부를 여기서 판단하지 않는다(#542).
        target: this.notificationTarget(e.messageId),
      });
    }
  }

  /**
   * 채널 선호를 서버에서 다시 읽는다. 기동(`start`)과 inbox 갱신(#376) 두 곳이 **같은 함수**를
   * 쓴다 — 두 곳에 복제하면 한쪽만 고쳐져 어떤 경로에서는 숨김이 풀린 것이 화면에 안 온다.
   */
  private async refreshChannelPrefs(): Promise<void> {
    const prefs = await this.api.channelPrefs();
    this.store.getState().set({ channelPrefs: Object.fromEntries(prefs.map((p) => [p.channelId, p])) });
  }

  // 단조 버전 가드 — 나중에 발행됐지만 먼저 도착한 응답만 반영되도록, stale 응답은 버린다.
  /**
   * 반영과 **함께 `inboxRevision` 을 올린다**(2026-09-10). 이 함수가 도는 자리가 곧 "서버의
   * 인박스가 달라진 것을 방금 확인했다"는 자리다 — `inbox.updated` 이벤트와, 소켓이 다시
   * 붙은 뒤의 `reconcile` 둘뿐이다. 그래서 신호를 이벤트 처리기가 아니라 여기에 둔다:
   * 끊긴 동안 놓친 항목도 재연결 한 번으로 열려 있는 인박스에 닿는다.
   *
   * stale 응답에서는 올리지 않는다 — 낡은 목록을 버리면서 "바뀌었다"고 알리면, 받는 쪽은
   * 아무것도 달라지지 않은 채로 조회를 한 번 더 낸다.
   */
  private async refreshUnread(): Promise<void> {
    const seq = ++this.unreadFetchSeq;
    const entries = await this.api.inboxUnread();
    if (seq !== this.unreadFetchSeq) return;
    const store = this.store.getState();
    store.set({ unread: entries, inboxRevision: store.inboxRevision + 1 });
  }

  async openChannel(channelId: string): Promise<void> {
    const store = this.store.getState();
    // 채널·스레드 열림은 이력에 추가한다. 뒤로/앞으로 이동은 pushHistory 를 안 부른다.
    store.pushHistory({ channelId, threadRootId: null });
    // 다른 곳으로 움직이면 이전 링크 강조는 뜻을 잃는다 — 남겨 두면 엉뚱한 메시지가 계속 빛난다.
    // 펼쳐 둔 긴 메시지도 같이 접는다(#217) — 나갔다 돌아온 채널에서 긴 메시지가 여전히
    // 펼쳐져 있으면, 애초에 접기가 막으려던 상태(하나가 화면을 다 먹는 것)로 되돌아간다.
    store.set({ activeChannelId: channelId, threadRootId: null, highlightedMessageId: null });
    // 투영된 system 메시지는 사용자가 그 채널을 보고 있지 않아도 WS로 들어와 maxSeq를 올린다.
    // 그 상태에서 증분 조회를 하면 backlog 전체가 건너뛰어져 채널이 거의 비어 보인다 —
    // 그래서 처음 여는 채널은 히스토리를 통째로 받는다(since=0 → 서버가 최신 N개를 준다).
    const since = this.loadedChannels.has(channelId)
      ? Math.max(0, ...(store.messages[channelId] ?? []).map((m) => m.seq))
      : 0;
    // 핀은 **크리티컬 패스에서 뺀다.** 이 엔드포인트가 없는 서버(구버전)에 붙었을 때
    // 채널이 아예 안 열리면 안 된다 — 채널 선호(`start`)와 같은 이유다.
    this.swallow(this.loadPins(channelId));
    // 자동 멘션(#173)도 같은 이유로 크리티컬 패스 밖이다. 못 받으면 칩이 없는 것뿐이고,
    // 그때 글을 보내면 접두가 안 붙는다 — 채널이 안 열리는 것보다 낫다.
    this.swallow(this.loadChannelAutoMentions(channelId));
    const page = await this.api.messages(channelId, { since, limit: since === 0 ? INITIAL_HISTORY_LIMIT : undefined });
    this.loadedChannels.add(channelId);
    this.store.getState().upsertMessages(channelId, page.messages);
    // **증분 응답으로 `hasMore` 를 덮지 않는다.** 서버는 그 값을 `messages.length > 0 &&
    // hasOlderMessages(첫 행)` 로 계산하므로, 새 메시지가 없는 증분 페이지는 0 행이 되어
    // `hasMore: false` 로 돌아온다 — "과거가 없다"는 뜻이 아니라 "새 것이 없다"는 뜻인데
    // 그것을 스토어에 쓰면 목록 맨 위의 `Load older messages` 가 사라진다. 그러면 조용할 때
    // 채널을 한 번 더 누른 사람은 과거로 돌아갈 길을 잃는다(검색 말고는 없다).
    // 첫 로드(`since === 0`)의 응답만 이 사실을 정직하게 말할 수 있다.
    if (since === 0) {
      this.store.getState().set({
        hasMore: { ...this.store.getState().hasMore, [channelId]: page.hasMore },
      });
    }
    const ids = this.store.getState().unread
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
    const store = this.store.getState();
    const frozen = store.reads[channelId]?.lastReadSeq ?? 0;
    store.set({ dividerSeq: { ...store.dividerSeq, [channelId]: frozen } });

    const newest = Math.max(0, ...(store.messages[channelId] ?? []).map((m) => m.seq));
    if (newest <= frozen) return;
    await this.api.markChannelRead(channelId, newest);
    const after = this.store.getState();
    after.set({ reads: { ...after.reads, [channelId]: { lastReadSeq: newest, unread: 0 } } });
  }

  /**
   * 스레드를 연다. `focusMessageId` 를 주면 **그 답글 자리**에 세운다(#624 요구 3) —
   * 채널에 함께 올라온 답에서 "최근 댓글 보기"로 들어오는 경우다. 그 사람의 질문은
   * "이 스레드가 뭐였나"가 아니라 **"이 말 뒤에 무슨 말이 더 있었나"** 이므로, 뿌리부터
   * 다시 읽히면 답글이 백 개 달린 스레드에서 방금 본 그 말을 다시 찾아야 한다.
   *
   * 세우는 수단은 기존 강조(`highlightedMessageId`)를 그대로 쓴다 — 링크로 도달한 자리를
   * 화면에 세우고 몇 초 뒤 스스로 풀리는 것이 이미 `MessageItem` 에 있다(#178·#397).
   * 답글이 **로드된 뒤에** 걸어야 한다: 화면에 없는 메시지에 강조를 걸면 스크롤이
   * 일어나지 않고, 강조는 5초 뒤 조용히 풀린다.
   */
  /**
   * `aroundSeq` 는 **그 답글이 보이는 창**을 달라는 것이다(검색 결과로 점프할 때). 없으면
   * 지금까지대로 스레드의 최신 페이지를 뜬다 — 답글이 그보다 많은 스레드에서 옛 답글로
   * 점프하면 대상이 창에 없어 강조가 아무 일도 하지 않는다.
   *
   * ## `channelId` 는 **인자다** — 활성 채널에서 읽지 않는다
   *
   * `send()` 를 #223 에서 고친 것과 같은 이유이고, 같은 결함이 여기서 실제로 났다
   * (jaebin 보고, 2026-09-09): 인박스의 `WAITING ON` 줄은 **다른 채널의** 뿌리를 가리키는데
   * 이 함수가 활성 채널을 스토어에서 읽었다. 그래서 `#api-farm` 을 보는 중에 `#murmur` 의
   * 대기 줄을 누르면 `?thread=<#murmur 의 뿌리>` 를 **`#api-farm` 에** 물었고, 서버는
   * 200 에 0줄을 주고(그 채널에 없는 뿌리다) 패널은 **영원히 빈 채로** 열려 있었다.
   *
   * 주면 그 채널로 **먼저 옮긴다**. 안 주면 지금까지대로 활성 채널이다 — 같은 채널 안에서
   * 부르는 자리(`MessageItem`)는 그것이 맞고, 거기에 채널을 적게 하면 같은 값을 두 번 쓴다.
   *
   * ## 0줄이면 패널을 닫는다
   *
   * 위 사고에서 화면이 말한 것은 "빈 스레드"가 아니라 **"끝난 스레드"** 였다
   * (`threadState` 가 빈 목록을 `done` 으로 읽었다). 못 불러온 것을 끝난 것으로 그리는
   * 것이 `design.md` §4 가 금지한 그 거짓말이므로, **뿌리가 응답에 없으면 열지 않는다** —
   * 조회 실패도 `openMessage` 와 같게 사람에게 보인다.
   */
  async openThread(rootId: string, opts: OpenThreadOpts = {}): Promise<void> {
    const channelId = opts.channelId ?? this.store.getState().activeChannelId;
    if (!channelId) return;
    // 다른 채널의 스레드면 채널을 먼저 옮긴다 — 스레드 패널은 **활성 채널의** 목록에서
    // 그 뿌리를 찾으므로(`ThreadPanel`), 채널을 두고 뿌리만 세우면 찾을 것이 없다.
    if (this.store.getState().activeChannelId !== channelId) await this.openChannel(channelId);
    this.store.getState().pushHistory({ channelId, threadRootId: rootId });
    this.store.getState().set({ threadRootId: rootId });
    let page;
    try {
      page = await this.api.messages(channelId, { thread: rootId, around: opts.aroundSeq });
    } catch {
      // 열다 만 패널을 남기지 않는다. 남기면 그 자리가 "답이 하나도 없는 끝난 스레드"로
      // 읽힌다 — 연결이 끊긴 것과 정반대의 사실이다.
      this.store.getState().set({
        threadRootId: null,
        notice: 'Could not open that thread. Check your connection and try again.',
      });
      return;
    }
    this.store.getState().upsertMessages(channelId, page.messages);
    /**
     * **한 줄도 없으면 스레드가 아니다.** 여기 걸리는 것은 그 채널에 아예 없는 뿌리(위
     * 사고)와 흔적까지 사라진 스레드다. 둘 다 사람이 할 일은 같다: 이 패널을 닫고 왜
     * 아무것도 없는지 말해 주는 것.
     *
     * **"뿌리가 응답에 있는가"로 재지 않는다.** 지워진 머리는 답글이 남아 있는 한
     * 자리표시자로 실려 오지만(`LIST_VISIBLE`), 남은 답글이 진행뿐이면 머리 없이 답글만
     * 온다 — 그 스레드는 **볼 것이 있다.** 그것까지 닫으면 이 관문이 고치려던 것과 같은
     * 종류의 거짓말(있는 것을 없다고 하기)을 반대 방향으로 하게 된다.
     */
    if (page.messages.length === 0) {
      this.store.getState().set({
        threadRootId: null,
        notice: 'That thread is gone — it was deleted, or it does not live in this conversation.',
      });
      return;
    }
    if (opts.focusMessageId) this.store.getState().set({ highlightedMessageId: opts.focusMessageId });
  }

  /**
   * 링크가 가리키는 메시지로 이동한다(#178). 채널을 열고(이력에도 남긴다), 답글이면
   * 스레드 패널까지 열고, 그 메시지에 강조를 건다.
   *
   * **실패는 반드시 사람에게 보인다.** 조용히 아무 일도 안 하면 링크를 누른 사람은 앱이
   * 멈춘 것으로 보고 같은 링크를 계속 누른다. 사유를 셋으로 나누는 이유: 지워진 것과
   * 볼 수 없는 것과 연결이 끊긴 것은 사람이 다음에 할 일이 서로 다르다.
   */
  /**
   * 도는 턴들을 **그만두게 한다**(Agents 관제 3단계). 화면은 줄·스레드·전부를 같은 이
   * 경로로 보낸다 — 서버에도 묶음 전용 문이 없다(무엇이 한 묶음인지는 화면의 일이다).
   *
   * ## 404 는 실패가 아니다
   *
   * 누르는 사이에 그 턴이 스스로 끝난 것이고(26초짜리 턴에서 흔하다), **사람이 원한
   * 결과와 같다.** 그것을 통지로 올리면 성공한 중단마다 빨간 줄이 뜬다.
   *
   * ## 여러 개를 한 번에 눌러도 통지는 하나다
   *
   * 스레드 하나에 턴이 넷이면 실패도 넷이 될 수 있고, 그 넷이 대개 **같은 원인**이다
   * (러너가 안 붙어 있거나 구 버전이다). 네 줄을 쌓으면 사람은 원인 하나를 네 번 읽는다.
   *
   * 성공은 통지하지 않는다: 중단됐다는 증거는 이 왕복이 아니라 **목록에서 그 줄이 사라지고
   * 스레드에 실패 카드가 뜨는 것**이다. 서버의 202 는 "러너에게 넘겼다"까지다.
   */
  async cancelAgentTurns(sessionIds: readonly string[]): Promise<void> {
    let firstFailure: string | null = null;
    for (const sessionId of sessionIds) {
      try {
        await this.api.cancelAgentSession(sessionId);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) continue;
        // 서버가 쓴 문구를 그대로 올린다 — `no_runner`(러너를 띄워라)와
        // `runner_outdated`(러너를 올려라)는 사람이 할 일이 다르고, 그 구분은 서버가 썼다.
        if (!firstFailure) firstFailure = e instanceof Error ? e.message : String(e);
      }
    }
    if (firstFailure) {
      this.store.getState().set({ notice: `Could not stop that turn — ${firstFailure}` });
    }
  }

  async openMessage(messageId: string): Promise<void> {
    let target: MessageRow;
    try {
      target = await this.api.message(messageId);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      this.store.getState().set({
        notice: status === 404
          ? 'That message is gone — it was deleted, or the link points at nothing.'
          : status === 403
            ? "You can't open that message — it's in a conversation you're not part of."
            : 'Could not open that message. Check your connection and try again.',
      });
      return;
    }
    await this.openChannel(target.channelId);
    /**
     * 옛 메시지는 `openChannel` 이 불러온 **최신 페이지에 없다** — 강조할 DOM 이 없으니
     * 강조도 스크롤도 일어나지 않는다(검색 결과를 눌러도 아무 일이 없던 이유다). 그래서
     * 그 자리를 가운데 둔 창을 따로 받아 채운다. 이미 실려 있으면 왕복을 만들지 않는다.
     *
     * 창은 기존 목록에 **합친다**(갈아치우지 않는다) — 갈아치우면 이미 읽어 둔 최신 쪽을
     * 버리게 되고, 라이브로 들어오는 새 메시지가 옛 창 바로 아래 붙어 더 이상해진다.
     * 대신 창과 최신 페이지 사이가 200 개 넘게 벌어진 채널에서는 그 사이가 비어 보인다 —
     * 사이를 메우는 '여기부터 새 메시지' 구분선은 별개 과제다(`loadOlder` 로 위로 올라가면
     * 메워진다).
     */
    if (!(this.store.getState().messages[target.channelId] ?? []).some((m) => m.id === target.id)) {
      try {
        const page = await this.api.messages(target.channelId, { around: target.seq });
        this.store.getState().upsertMessages(target.channelId, page.messages);
        this.store.getState().set({
          hasMore: { ...this.store.getState().hasMore, [target.channelId]: page.hasMore },
        });
      } catch {
        // 창을 못 받아도 채널은 이미 열렸다. 강조만 안 걸릴 뿐이라 사람을 막지 않는다
        // (구 버전 서버는 `around` 를 모르고 400 을 준다).
      }
    }
    // 답글은 스레드 패널까지 연다 — 스레드 밖에서 보면 무엇에 대한 답인지 잃는다.
    // 대상의 seq 를 함께 준다: 스레드도 최신 페이지만 뜨므로, 주지 않으면 옛 답글은
    // 채널 쪽 창을 받아 놓고도 스레드 패널에는 없다(강조가 걸릴 DOM 이 그쪽이다).
    if (target.threadRootId) {
      // 채널을 **명시한다**: 여기서 활성 채널을 다시 읽으면 이 왕복 도중에 사람이 채널을
      // 옮긴 경우 엉뚱한 채널에 그 뿌리를 세운다(위 `openThread` 주석의 사고와 같은 모양).
      await this.openThread(target.threadRootId, { channelId: target.channelId, aroundSeq: target.seq });
    }
    // 강조는 openChannel 이 지운 **뒤에** 건다. 순서가 뒤바뀌면 방금 건 강조를 스스로 지운다.
    this.store.getState().set({ highlightedMessageId: target.id, notice: null });
  }

  /** 상단에 도달했을 때 한 페이지 더 과거로. 남은 게 없으면 요청하지 않는다. */
  async loadOlder(): Promise<void> {
    const { activeChannelId, messages, hasMore } = this.store.getState();
    if (!activeChannelId || !hasMore[activeChannelId]) return;
    const rows = messages[activeChannelId] ?? [];
    if (!rows.length) return;
    const oldest = Math.min(...rows.map((m) => m.seq));

    const page = await this.api.messages(activeChannelId, { before: oldest });
    this.store.getState().upsertMessages(activeChannelId, page.messages);
    this.store.getState().set({
      hasMore: { ...this.store.getState().hasMore, [activeChannelId]: page.hasMore },
    });
  }

  closeThread(): void {
    // 스레드를 닫으면 강조도 해제 — 스레드로 도달해 확인하고 닫는 것이 가장 흔한 경로다(#397).
    this.store.getState().set({ threadRootId: null, highlightedMessageId: null });
  }

  /**
   * 보낼 자리를 **인자로 받는다**(#223). 스토어의 활성 채널을 호출 시점에 읽으면, 보냄 취소
   * 창이 도는 동안 채널을 옮긴 사람의 메시지가 **옮긴 채널로 나간다** — #184 가 닫은 결함과
   * 같은 모양이다. 호출부가 글을 쓴 순간의 채널을 붙여 주면 시점이 어긋날 자리가 없다.
   *
   * 인자를 생략하면 예전처럼 활성 채널로 간다 — 즉시 보내는 호출부는 그 편이 짧다.
   */
  async send(body: string, attachmentIds: string[] = [], channelId?: string): Promise<void> {
    const target = channelId ?? this.store.getState().activeChannelId;
    // 파일만 보내는 것은 자연스럽다 — 본문이 비었다고 막으면 첨부를 보낼 길이 없다.
    if (!target || (!body.trim() && !attachmentIds.length)) return;
    const { message, notified } = await this.api.postMessage(target, body, undefined, crypto.randomUUID(), attachmentIds);
    this.store.getState().upsertMessages(target, [message]);
    this.recordNotifiedGap(message.id, body, notified);
  }

  /**
   * **조용한 실패로 끝난 집합 호출을 기록한다**(정본 문서: 집합 호출의 결과).
   *
   * 여기인 이유: 판정에 필요한 재료가 셋인데 그 셋이 모이는 자리가 여기뿐이다 —
   * 서버가 준 결과(`notified`), 내가 쓴 본문(무슨 집합을 불렀나), 스토어의 집합 목록
   * (`memberCount`). 화면 컴포넌트에서 판정하면 본문을 다시 파싱해야 하고, 그 파싱이
   * `bodyRecipients`(보내기 전 목록)와 갈라지는 순간 보내기 전과 보낸 뒤가 다른 수를 말한다.
   *
   * **덜 깬 발화만 스토어에 넣는다** — `notifiedSummary` 가 `null` 을 주면 아무것도 하지
   * 않는다. 셋을 불러 셋이 깨면 화면은 조용하다.
   *
   * 자기 자신은 `bodyRecipients` 가 이미 뺀다(그 함수의 `selfHandle` 인자) — 서버도 부른
   * 사람을 알림에서 걸러 내므로(`fanOutMention` ②) 양쪽 셈이 같은 규칙을 본다.
   */
  private recordNotifiedGap(messageId: string, body: string, notified: NotifiedResult): void {
    const state = this.store.getState();
    const groups = state.groups;
    // 목록을 못 받은 서버에서는 **빈 목록이 사실이다** — 그 서버는 `@팀` 을 해석하지
    // 못하므로(#172 가 디렉터리와 멘션을 한 커밋에 넣었다) 부를 수 있는 팀이 없다.
    // 이 `??` 는 뭉개는 것이 아니라 이 자리의 판단이다(`appStore.ts::teams` 의 그 표).
    const teams = state.teams ?? [];
    const recipients = bodyRecipients(
      body,
      Object.values(state.accounts).map((a) => a.handle),
      // 집합과 팀을 **한 배열로** 준다 — `Composer.tsx` 의 `groupHandleList` 와 같은
      // 인자여야 한다. 여기서 팀을 빼면 보내기 전 목록에는 팀이 서고 보낸 뒤 판정은
      // 그것을 못 세어, 팀의 조용한 실패가 통째로 삼켜진다.
      [...groups.map((g) => g.handle), ...teams.map((t) => t.name)],
      state.me?.handle ?? null,
    );
    const summary = notifiedSummary(notified, calledGroups(recipients, groups, teams));
    if (!summary) return;
    this.store.getState().set({
      notifiedGaps: { ...this.store.getState().notifiedGaps, [messageId]: summary },
    });
  }

  /**
   * 스레드 답글도 같은 이유로 자리를 인자로 받는다. 여기는 사유가 하나 더 있다 — 스레드
   * 패널을 닫으면 `threadRootId` 가 null 이 되어, 창이 도는 동안 닫으면 답글이 **아예
   * 사라진다**(아래 가드에서 그냥 반환된다).
   *
   * `alsoInChannel`(#231)은 그 뒤에 온다 — 자리를 앞에 끼우면 기존 호출부가 조용히
   * 어긋난다.
   */
  async reply(
    body: string, attachmentIds: string[] = [], channelId?: string, threadRootId?: string,
    alsoInChannel = false,
  ): Promise<void> {
    const state = this.store.getState();
    const target = channelId ?? state.activeChannelId;
    const root = threadRootId ?? state.threadRootId;
    if (!target || !root || (!body.trim() && !attachmentIds.length)) return;
    const { message, notified } = await this.api.postMessage(target, body, root, crypto.randomUUID(), attachmentIds, alsoInChannel);
    this.store.getState().upsertMessages(target, [message]);
    // 스레드 답글도 집합을 부를 수 있다 — 채널 최상위만 재면 스레드에서 부른 집합의
    // 조용한 실패가 그대로 삼켜진다. 여기서 서버가 `thread_reply` 로 루트 작성자까지
    // 같은 `notified` 에 담는다는 사실이 셈을 **보수적으로** 만든다(`notifiedSummary` 주석).
    this.recordNotifiedGap(message.id, body, notified);
  }

  /**
   * 선택지에서 하나를 고른다(Task 3).
   *
   * **낙관적 갱신을 하지 않는다** — 리액션의 선례다(화면은 언제나 서버와 같다). 두 사람이
   * 동시에 누르면 먼저 도착한 쪽이 이기고, 진 쪽은 409 를 받는다. 낙관적으로 그려 두면
   * 진 쪽 화면에 자기가 고른 것이 잠깐 보였다가 남의 답으로 바뀐다.
   *
   * 실패를 삼킨다: 답이 이미 있는 것은 오류가 아니라 경합의 정상 결과이고, 그 사실은
   * `message.updated` 이벤트로 곧 화면에 온다.
   */
  async answerAsk(messageId: string, optionId: string, channelId?: string): Promise<void> {
    const state = this.store.getState();
    const target = channelId
      ?? Object.values(state.messages).flat().find((m) => m.id === messageId)?.channelId
      ?? state.activeChannelId;
    if (!target) return;
    try {
      const m = await this.api.answerAsk(target, messageId, optionId);
      this.store.getState().upsertMessages(target, [m]);
    } catch {
      // 진 경합·권한 없음 — 서버가 참이고, 화면은 이벤트로 따라온다.
    }
  }

  /**
   * **답하지 않기로 한다**(2026-09-09). `answerAsk` 와 같은 모양으로 두는 이유는 카드에서
   * 사람이 하는 일이 둘 중 하나이고 둘 다 그 물음을 닫는 것이기 때문이다.
   *
   * 낙관적 갱신을 하지 않는 것도 같다 — 화면은 이 응답과 `message.updated` 로만 바뀐다.
   */
  async closeAsk(messageId: string, channelId?: string): Promise<void> {
    const state = this.store.getState();
    const target = channelId
      ?? Object.values(state.messages).flat().find((m) => m.id === messageId)?.channelId
      ?? state.activeChannelId;
    if (!target) return;
    try {
      const m = await this.api.closeAsk(target, messageId);
      this.store.getState().upsertMessages(target, [m]);
    } catch {
      // 진 경합(이미 답이 있다)·권한 없음 — 서버가 참이고, 화면은 이벤트로 따라온다.
    }
  }

  /**
   * 입력 중임을 알린다. 소켓으로 보내는 유일한 방향이다(그 외는 서버 → 클라이언트 단방향).
   * 소켓이 없으면 조용히 넘긴다 — 입력 중 표시는 없어도 대화가 되는 기능이다.
   */
  notifyTyping(on: boolean): void {
    const { activeChannelId, threadRootId } = this.store.getState();
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

  fetchAvatar(accountId: string): Promise<Blob> {
    return this.api.fetchAvatar(accountId);
  }

  /**
   * 내 프로필 사진을 바꾼다(#159). 파일을 주면 기존 업로드 경로로 올린 뒤 그 첨부를 걸고,
   * `null` 을 주면 지운다 — 지우기는 **명시적 null** 이다.
   *
   * 서버가 받아들인 뒤에 화면을 갱신한다: 미리 그려 두면 서버가 거절한 사진(이미지가 아닌
   * 파일은 400 이다)이 잠깐 내 얼굴로 떴다가 사라진다.
   */
  async setAvatar(file: File | null, onProgress?: (fraction: number) => void): Promise<void> {
    const attachmentId = file ? (await this.api.upload(file, onProgress)).id : null;
    const { avatarAttachmentId } = await this.api.setAvatar(attachmentId);
    const me = this.store.getState().me;
    if (me) this.store.getState().applyAvatar(me.id, avatarAttachmentId);
  }

  /**
   * 에이전트의 사진을 건다(identity 문서 Task 15-4). `setAvatar` 와 같은 두 걸음이다 —
   * 업로드는 기존 `POST /uploads` 를 쓰고, 여기서는 그 업로드 하나를 계정에 잇는다.
   *
   * 스토어의 계정 표를 함께 갱신한다: 그러지 않으면 방금 올린 사진이 설정 화면에만 보이고
   * 대화·그리드의 아바타는 옛 색으로 남는다.
   */
  async setAgentAvatar(
    agentId: string, file: File | null, onProgress?: (fraction: number) => void,
  ): Promise<void> {
    const attachmentId = file ? (await this.api.upload(file, onProgress)).id : null;
    const { avatarAttachmentId } = await this.api.setAgentAvatar(agentId, attachmentId);
    this.store.getState().applyAvatar(agentId, avatarAttachmentId);
  }

  /**
   * 첨부를 사용자 디스크에 저장한다. objectURL + `download` 앵커를 쓴다 — 토큰을 URL 에
   * 넣지 않으려면 바이트를 먼저 받아야 하고, 받은 다음에는 이것이 가장 단순한 저장 경로다.
   * 실패하면 Notice 로 사람 앞에 세운다.
   */
  async saveAttachment(attachment: AttachmentRow): Promise<void> {
    let blob: Blob;
    try {
      blob = await this.fetchAttachment(attachment.id);
    } catch (e) {
      const t = this.t();
      this.store.getState().set({
        notice: t(e instanceof ApiError && e.code === 'attachment_missing'
          ? 'attachment.missing'
          : 'attachment.fetchFailed'),
      });
      return;
    }
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
    const me = this.store.getState().me;
    if (!me) return;
    if (on) await this.api.addReaction(channelId, messageId, emoji);
    else await this.api.removeReaction(channelId, messageId, emoji);
    this.store.getState().applyReaction(channelId, messageId, emoji, me.id, on);
  }

  async editMessage(messageId: string, body: string): Promise<void> {
    const { activeChannelId } = this.store.getState();
    if (!activeChannelId || !body.trim()) return;
    const updated = await this.api.editMessage(activeChannelId, messageId, body);
    this.store.getState().upsertMessages(activeChannelId, [updated]);
  }

  /**
   * 채널로 잘못 내보낸 스레드 답을 채널에서 거둔다(#231 되돌리기).
   *
   * `deleteMessage` 와 달리 **스토어에서 빼지 않는다** — 메시지는 스레드에 그대로 있고
   * 갱신된 행을 덮어쓰기만 한다. 채널 목록은 `alsoInChannel` 로 거르므로(`ChannelPane`)
   * 그 한 값이 false 로 바뀌는 것만으로 채널에서 사라지고 스레드에는 남는다.
   *
   * 열려 있는 스레드를 닫지 않는 이유도 같다: 없어진 것이 아니다.
   */
  async recallFromChannel(messageId: string): Promise<void> {
    const { activeChannelId } = this.store.getState();
    if (!activeChannelId) return;
    const updated = await this.api.recallFromChannel(activeChannelId, messageId);
    this.store.getState().upsertMessages(activeChannelId, [updated]);
  }

  /**
   * 이미 쓴 스레드 답을 나중에 채널로 올린다(거두기의 반대).
   *
   * `send` 를 부르지 않는다 — 새 메시지를 만드는 것이 아니라 있던 메시지 하나가
   * 채널에도 보이게 되는 것이다. 그래서 여기서도 갱신된 행을 덮어쓰기만 하고,
   * 채널 목록은 `alsoInChannel` 로 거르므로(`ChannelPane`) 그 한 값으로 채널에 나타난다.
   *
   * **채널 목록에서 이 메시지는 원래 자리(`seq`)에 나타난다.** 방금 올렸어도 맨 아래가
   * 아니다 — `seq` 를 새로 주면 같은 메시지가 두 번 온 것이 되어 읽음 경계가 뒤로 밀린다.
   */
  async postToChannel(messageId: string): Promise<void> {
    const { activeChannelId } = this.store.getState();
    if (!activeChannelId) return;
    const updated = await this.api.postToChannel(activeChannelId, messageId);
    this.store.getState().upsertMessages(activeChannelId, [updated]);
  }

  /**
   * 이 채널의 고정 목록을 서버에서 다시 받는다(#218).
   *
   * 델타가 아니라 목록 전체를 갈아 끼운다: 핀은 채널 전역 상태라 다른 사람이 고정·해제한
   * 것도 섞여 들어오고, 그때 내 로컬 델타만 쌓으면 화면이 서버와 조용히 갈라진다.
   */
  async loadPins(channelId: string): Promise<void> {
    const pins = await this.api.pins(channelId);
    const store = this.store.getState();
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
      this.store.getState().set({
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
      this.store.getState().set({
        notice: e instanceof ApiError && e.status === 403
          ? 'Only the person who pinned that message, or an admin, can unpin it.'
          : 'Could not unpin that message. Check your connection and try again.',
      });
      return;
    }
    await this.loadPins(channelId);
  }

  /**
   * 채널 문서를 서버에서 받는다(#188).
   *
   * **실패를 삼키지 않는다** — try/catch 로 빈 문서를 넣으면 "못 읽었다"가 "비어 있다"로
   * 보이고, 그 위에 저장하면 남의 문서를 빈 본문으로 덮어쓴다. 던지는 것이 호출부의
   * 책임을 강제한다.
   */
  async loadChannelDoc(channelId: string): Promise<ChannelDoc> {
    const doc = await this.api.channelDoc(channelId);
    const store = this.store.getState();
    store.set({ channelDocs: { ...store.channelDocs, [channelId]: doc } });
    return doc;
  }

  /**
   * 채널 문서를 저장한다(#188).
   *
   * 409 `doc_stale` 도 그대로 던진다 — 여기서 삼키면 화면은 저장된 줄 안다. 다만 그 오류가
   * 실어 온 **현재 본문**은 스토어에 반영한다: 사람이 두 판을 나란히 보고 판단해야 하므로
   * 화면이 그 값을 필요로 하고, 다시 저장할 때 쓸 `expectedUpdatedAt` 도 그 값에서 온다.
   */
  async saveChannelDoc(
    channelId: string, body: string, expectedUpdatedAt: number | null,
  ): Promise<ChannelDoc> {
    try {
      const doc = await this.api.updateChannelDoc(channelId, body, expectedUpdatedAt);
      const store = this.store.getState();
      store.set({ channelDocs: { ...store.channelDocs, [channelId]: doc } });
      return doc;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'doc_stale') {
        const current = (err.payload as { doc?: ChannelDoc } | null)?.doc;
        if (current) {
          const store = this.store.getState();
          store.set({ channelDocs: { ...store.channelDocs, [channelId]: current } });
        }
      }
      throw err;
    }
  }

  async deleteMessage(messageId: string): Promise<void> {
    const { activeChannelId, threadRootId } = this.store.getState();
    if (!activeChannelId) return;
    const tombstone = await this.api.deleteMessage(activeChannelId, messageId);
    /**
     * 답글이 남은 스레드 머리를 지우면 서버가 **자리표시자 행**을 돌려준다. 그것을 목록에서
     * 빼면 살아 있는 답글로 들어갈 문이 함께 사라진다 — 신고된 결함의 반대 방향이다.
     * 그래서 빼지 않고 덮고, **스레드도 닫지 않는다**: 지운 것은 내 첫 줄이고 그 아래
     * 히스토리는 그대로 있다.
     */
    if (tombstone) {
      this.store.getState().upsertMessages(activeChannelId, [tombstone]);
      return;
    }
    this.store.getState().removeMessage(activeChannelId, messageId);
    // 내가 지운 경우에도 같다. WS 이벤트를 기다리지 않고 즉시 닫는다.
    if (threadRootId === messageId) this.store.getState().set({ threadRootId: null });
  }

  listAgents(): Promise<import('@harkroom/shared').AgentView[]> {
    return this.api.listAgents();
  }

  /**
   * 생성·PAT 발급·키체인 저장·선택적 즉시 기동을 한 흐름으로 묶는다.
   * 러너 준비 실패는 RunnerState 에 남고, 이미 성공한 계정 생성과 PAT 원문은 호출자에게
   * 그대로 돌려준다 — 화면이 "생성 실패"라고 거짓말하거나 유일한 PAT 를 잃으면 안 된다.
   */
  async createAgent(
    input: { handle: string; displayName: string } & Partial<import('@harkroom/shared').AgentConfig>,
    opts?: { claudePool?: string },
  ): Promise<{ agent: import('@harkroom/shared').AgentView; pat: string; poolError: string | null }> {
    const agent = await this.api.createAgent(input);
    const pat = await this.api.mintPat(agent.id, 'runner');
    /**
     * 계정 풀 배정은 **러너가 뜨기 전에** 쓴다.
     *
     * 러너는 자기 풀을 시작할 때 한 번만 읽는다(`ClaudeAccountsSettings` 의 안내:
     * *"A runner reads its pool once at startup"*). 아래 `startCreated` 가 `autoStart`
     * 에서 러너를 띄우므로, 배정을 그 뒤에 쓰면 **방금 만든 에이전트의 첫 러너는 기본
     * 풀로 돈다** — 만들기 화면에서 풀을 고른 사람에게 그 선택은 재시작 전까지 아무 일도
     * 하지 않고, 화면에는 고른 값이 그대로 보이므로 그 어긋남을 알 방법이 없다.
     *
     * 서버로 가지 않는 값이라 `input` 에 실을 수 없다(`useAgentPool` 머리말: 풀은 이
     * 기기에만 존재하는 자원이다). 그래서 별도 인자로 받는다.
     *
     * **실패가 생성을 되돌리지 않는다.** 계정과 PAT 는 이미 만들어졌고 PAT 원문은 지금
     * 놓치면 다시 볼 수 없다 — 여기서 던지면 화면이 "만들지 못했다"를 그리며 유일한
     * 토큰을 버린다(이 메서드 머리말이 러너 준비 실패에 대해 정한 것과 같은 규율).
     * 대신 사유를 돌려주고, 화면이 "만들어졌지만 풀은 배정하지 못했다"를 말한다.
     */
    let poolError: string | null = null;
    if (opts?.claudePool) {
      try {
        await assignAgentPool(agent.id, opts.claudePool);
      } catch (err) {
        poolError = err instanceof Error ? err.message : String(err);
      }
    }
    const prefs = usePrefsStore.getState();
    const store = this.store.getState();
    await this.runnerLauncher.startCreated({
      agent,
      pat: { label: 'runner', token: pat },
      autoStart: prefs.runnerAutoStart,
      liveAccountIds: store.connected ? new Set(store.online) : null,
    });
    return { agent, pat, poolError };
  }

  updateAgent(
    id: string, patch: Partial<import('@harkroom/shared').AgentConfig> & { displayName?: string },
  ): Promise<import('@harkroom/shared').AgentView> {
    return this.api.updateAgent(id, patch);
  }

  /** #129: 러너 종료 요청. 실패를 삼키지 않는다 — 요청이 갔는지 화면이 말해야 한다. */
  requestAgentStop(agentId: string): Promise<import('@harkroom/shared').AgentView> {
    return this.api.requestAgentStop(agentId);
  }

  /**
   * #427: 그 요청을 되돌린다. 위와 같은 이유로 실패를 삼키지 않는다.
   *
   * **여기서 러너를 띄우지 않는다.** 되돌리기는 서버 정의에서 시각을 지울 뿐이고, 그 뒤
   * `startAll` 이 도는 순간(다음 기동·자동 기동 토글) 필터가 그 에이전트를 다시 고른다.
   * 여기서 `runnerLauncher.startOne` 을 부르고 싶어지지만 그러면 안 된다 — 이 조작의 뜻은
   * "지금 띄워라"가 아니라 "더 이상 막지 마라"이고, 둘을 섞으면 서버 정의와 앱 동작이
   * 갈릴 때(예: 되돌리기는 성공했는데 기동은 실패) 화면이 무엇을 말해야 할지 모른다.
   */
  undoAgentStopRequest(agentId: string): Promise<import('@harkroom/shared').AgentView> {
    return this.api.undoAgentStopRequest(agentId);
  }

  /**
   * #251: 에이전트 비활성화/재활성화. 설정 저장(`updateAgent`)과 별도 경로인 이유는
   * `api.setAgentDisabled` 주석에 있다.
   *
   * **스토어의 계정 표를 함께 갱신한다.** 이 사실을 읽는 화면은 설정 화면이 아니다 —
   * 멘션 후보를 거르는 `Composer` 와 `비활성` 배지를 그리는 `Directory` 가 스토어의
   * `accounts` 를 본다(shared 의 `AccountView.disabled` 주석). 설정 화면의 지역 상태만
   * 고치면 끈 직후에도 그 에이전트가 여전히 자동완성에 뜨고, 부른 사람은 답이 올 것이라
   * 믿는다. 갱신을 여기서 하는 이유는 스토어를 아는 곳이 컨트롤러 하나이기 때문이다.
   *
   * 서버가 돌려준 뷰를 그대로 넣는다 — 목록을 다시 받아 오지 않는 이유는 `AgentView` 가
   * `AccountView` 를 포함해서 이미 정본이고, 다시 받으면 그 사이의 다른 변경까지 섞여
   * "내가 방금 한 일"과 구분되지 않기 때문이다.
   */
  async setAgentDisabled(
    agentId: string, disabled: boolean,
  ): Promise<import('@harkroom/shared').AgentView> {
    const updated = await this.api.setAgentDisabled(agentId, disabled);
    const store = this.store.getState();
    store.set({ accounts: { ...store.accounts, [updated.id]: updated } });
    return updated;
  }

  /** #171: 새 에이전트의 기본값. 실패를 삼키지 않는다 — 화면이 실패를 그려야 한다. */
  agentDefaults(): Promise<import('@harkroom/shared').AgentDefaults> {
    return this.api.agentDefaults();
  }

  updateAgentDefaults(
    patch: Partial<import('@harkroom/shared').AgentDefaults>,
  ): Promise<import('@harkroom/shared').AgentDefaults> {
    return this.api.updateAgentDefaults(patch);
  }

  /** 투영 설정. admin 전용이라 실패를 삼키지 않는다 — 화면이 실패를 그려야 한다. */
  projectionConfig(): Promise<import('@harkroom/shared').ProjectionConfigView> {
    return this.api.projectionConfig();
  }

  setProjectionConfig(
    url: string | null,
  ): Promise<import('@harkroom/shared').ProjectionConfigView> {
    return this.api.setProjectionConfig(url);
  }

  /**
   * 투영 상태를 **지금** 다시 읽는다. 저장 직후에 쓴다.
   *
   * 정기 갱신은 60 초 주기다(`projectionRefreshInterval`). 그 주기에 맡기면 방금 켠 투영이
   * 최대 1 분 동안 꺼진 것처럼 보이고 사용자는 저장이 실패했다고 읽는다.
   *
   * 화면이 `api.projectionStatus()` 를 직접 부르지 않는 이유: `refreshProjectionStatus` 가
   * 지키는 규칙(**실패를 삼키지 않고 `projectionStatusError` 로 올린다**)을 한 벌 더
   * 적지 않기 위해서다.
   */
  refreshProjection(): Promise<void> {
    return this.refreshProjectionStatus();
  }

  /** #139: 에이전트 메모리. 실패를 삼키지 않는다 — 호출부가 "없다" 와 "못 읽었다" 를 가른다. */
  agentMemory(agentId: string): Promise<{ slug: string; value: string; updatedAt: string }[]> {
    return this.api.agentMemory(agentId);
  }

  deleteAgentMemory(agentId: string, slug: string): Promise<void> {
    return this.api.deleteAgentMemory(agentId, slug);
  }

  listPats(accountId: string): Promise<import('@harkroom/shared').PatView[]> {
    return this.api.listPats(accountId);
  }

  revokePat(accountId: string, label: string): Promise<{ revoked: number }> {
    return this.api.revokePat(accountId, label);
  }

  mintPat(accountId: string, label: string): Promise<string> {
    return this.api.mintPat(accountId, label);
  }

  /**
   * 핸들 집합 관리(#285). **모든 변경이 스토어의 `groups` 를 함께 고친다.**
   *
   * 이유는 위 `setAgentDisabled` 와 같다: 이 사실을 읽는 화면은 설정 화면이 아니라
   * 작성창의 멘션 후보다. 설정 화면의 지역 상태만 고치면 이름을 바꾼 직후에도 후보에는
   * 옛 이름이 남고, 부르는 사람은 자기가 고친 것이 반영되지 않았다고 읽는다.
   *
   * 목록을 다시 받아 오지 않고 서버가 돌려준 행을 그대로 넣는 것도 같은 이유다 — 다시
   * 받으면 그 사이의 다른 변경까지 섞여 "내가 방금 한 일"과 구분되지 않는다.
   */
  async createHandleGroup(input: { handle: string; displayName: string }): Promise<HandleGroupRow> {
    const group = await this.api.createHandleGroup(input);
    const store = this.store.getState();
    store.set({ groups: [...store.groups, group] });
    return group;
  }

  getHandleGroup(id: string): Promise<{ group: HandleGroupRow; members: string[] }> {
    return this.api.getHandleGroup(id);
  }

  async updateHandleGroup(id: string, patch: { displayName: string }): Promise<HandleGroupRow> {
    const updated = await this.api.updateHandleGroup(id, patch);
    const store = this.store.getState();
    store.set({ groups: store.groups.map((g) => (g.id === id ? updated : g)) });
    return updated;
  }

  async deleteHandleGroup(id: string): Promise<void> {
    await this.api.deleteHandleGroup(id);
    const store = this.store.getState();
    store.set({ groups: store.groups.filter((g) => g.id !== id) });
  }

  /**
   * 구성원 추가·제거. 라우트는 **바뀐 뒤의 명단 전체**를 준다 — 그래서 후보에 보이는
   * 구성원 수를 추측하지 않고 그 길이로 정확히 고친다. 추측(±1)으로 두면 같은 계정을
   * 두 번 넣는 요청에서 수가 실제와 갈라지고, 그 어긋남은 다음 조회까지 화면에 남는다.
   */
  private applyGroupMembers(id: string, members: string[]): string[] {
    const store = this.store.getState();
    store.set({
      groups: store.groups.map((g) => (g.id === id ? { ...g, memberCount: members.length } : g)),
    });
    return members;
  }

  async addHandleGroupMembers(id: string, accountIds: string[]): Promise<string[]> {
    const { members } = await this.api.addHandleGroupMembers(id, accountIds);
    return this.applyGroupMembers(id, members);
  }

  async removeHandleGroupMembers(id: string, accountIds: string[]): Promise<string[]> {
    const { members } = await this.api.removeHandleGroupMembers(id, accountIds);
    return this.applyGroupMembers(id, members);
  }

  /**
   * 채널을 만들고 목록에 반영한 뒤 그 채널을 연다 — `startDm` 과 같은 모양이다.
   * 컴포넌트가 `api` 를 직접 부르고 스토어를 손으로 갱신하면 그 절차가 화면마다 흩어지고,
   * 서버가 채운 필드(kind·topic 기본값)를 클라이언트가 추측하게 된다. 목록은 다시 받아온다.
   */
  async createChannel(name: string, visibility: 'public' | 'private' = 'public'): Promise<ChannelRow> {
    const created = await this.api.createChannel({ name, visibility });
    this.store.getState().set({ channels: await this.api.channels() });
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
    const store = this.store.getState();
    store.set({ channelMembers: { ...store.channelMembers, [channelId]: members } });
    return members;
  }

  /**
   * 이 채널의 자동 멘션 목록(#173)을 서버에서 다시 받는다. 핀과 같이 목록 전체를 갈아 끼운다
   * — admin 이 다른 기기에서 바꾼 것도 섞여 들어오므로 로컬 델타는 갈라진다.
   * **실패를 빈 목록으로 삼키지 않는다** — 빈 목록은 "아무도 안 부른다"는 거짓 사실이 된다.
   */
  async loadChannelAutoMentions(channelId: string): Promise<ChannelAutoMentionRow[]> {
    const rows = await this.api.channelAutoMentions(channelId);
    const store = this.store.getState();
    store.set({ channelAutoMentions: { ...store.channelAutoMentions, [channelId]: rows } });
    return rows;
  }

  /**
   * 건다(또는 이미 걸린 것의 모드를 바꾼다). 실패를 삼키지 않는다 — 호출부(설정 화면)가
   * 사유를 사람에게 보여 준다.
   */
  async setChannelAutoMention(
    channelId: string, agentAccountId: string, mode: ChannelAutoMentionMode,
  ): Promise<void> {
    await this.api.setChannelAutoMention(channelId, agentAccountId, mode);
    await this.loadChannelAutoMentions(channelId);
  }

  async unsetChannelAutoMention(channelId: string, agentAccountId: string): Promise<void> {
    await this.api.unsetChannelAutoMention(channelId, agentAccountId);
    await this.loadChannelAutoMentions(channelId);
  }

  async inviteChannelMember(channelId: string, accountId: string): Promise<ChannelMemberRow[]> {
    const members = await this.api.inviteChannelMember(channelId, accountId);
    const store = this.store.getState();
    store.set({ channelMembers: { ...store.channelMembers, [channelId]: members } });
    return members;
  }

  /**
   * 나가기/내보내기. 나간 뒤에는 **채널 목록을 다시 받는다** — private 채널에서 나가면 그
   * 채널은 더 이상 내게 존재하지 않으므로 사이드바에 남아 있으면 안 된다.
   */
  async leaveChannel(channelId: string, accountId: string): Promise<void> {
    const members = await this.api.removeChannelMember(channelId, accountId);
    const store = this.store.getState();
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
    this.store.getState().set({ channels: await this.api.channels() });
    return updated;
  }

  async archiveChannel(id: string, archived: boolean): Promise<ChannelRow> {
    const updated = await this.api.archiveChannel(id, archived);
    this.store.getState().set({ channels: await this.api.channels() });
    return updated;
  }

  /**
   * 삭제 확인에 쓸 수치(#155). **개수를 모르면 모른다고 말할 수 있어야** 하므로 실패를
   * 삼키지 않는다 — 0 으로 갈아 넣으면 확인 문구가 "메시지 0개를 지운다"고 거짓을 말한다.
   */
  channelDeleteInfo(id: string): Promise<{ name: string; messageCount: number }> {
    return this.api.deleteChannelInfo(id);
  }

  /**
   * 채널을 영구히 삭제한다(#155). 실패를 삼키지 않는다 — 호출부가 사람에게 보여 줘야 한다.
   *
   * 목록을 다시 받는 이유는 `leaveChannel` 과 같다: 그 채널은 더 이상 존재하지 않으므로
   * 사이드바에 남아 있으면 안 된다.
   *
   * **보고 있던 채널이었으면 선택을 비운다.** 안 비우면 `activeChannelId` 가 없는 채널을
   * 가리킨 채 남아, 본문 열은 빈 채널을 그리고 작성창은 보낼 곳이 없는 글을 받는다.
   * `leaveChannel` 이 이것을 안 하는 것은 나간 채널이 public 이면 여전히 볼 수 있기
   * 때문이다 — 삭제는 그럴 여지가 없다.
   */
  async deleteChannel(id: string): Promise<void> {
    await this.api.deleteChannel(id);
    const store = this.store.getState();
    store.set({
      channels: await this.api.channels(),
      ...(store.activeChannelId === id ? { activeChannelId: null, threadRootId: null } : {}),
    });
  }

  async startDm(accountId: string): Promise<void> {
    const dm = await this.api.createDm([accountId]);
    this.store.getState().set({ dms: await this.api.dms() });
    await this.openChannel(dm.id);
  }

  /**
   * 채널 알림 수준을 정한다(#224). 음소거 토글을 대체한다 — 토글과 수준이 같이 있으면
   * 같은 사실을 두 곳이 말하게 되고, 그 둘이 갈라진다.
   */
  async setChannelNotifyLevel(channelId: string, notifyLevel: NotifyLevel): Promise<void> {
    const store = this.store.getState();
    const updated = await this.api.updateChannelPref(channelId, { notifyLevel });
    store.set({ channelPrefs: { ...store.channelPrefs, [channelId]: updated } });
  }

  /**
   * 내 상태를 서버에 정하고 로컬에도 반영한다(#186). 소켓 이벤트가 곧 돌아오지만 그것만
   * 기다리면 누른 뒤 한 왕복 동안 화면이 예전 값을 보여 준다 — 같은 값이 두 번 들어와도
   * `applyStatus` 는 덮어쓰기라 두 번 세는 문제가 없다(리액션과 다른 점이다).
   */
  async setStatus(status: AccountStatus, statusText?: string | null): Promise<void> {
    const store = this.store.getState();
    // 키 부재와 null 을 구분해서 그대로 넘긴다 — 여기서 `?? null` 로 뭉개면 '문구는
    // 손대지 않음'이 '지우기'가 된다.
    const saved = await this.api.setMyStatus(statusText === undefined ? { status } : { status, statusText });
    const meId = store.me?.id;
    if (meId) store.applyStatus(meId, saved.status, saved.statusText);
  }

  /**
   * 내 handle 을 서버에 정하고 로컬에도 반영한다(#271). 소켓 이벤트가 곧 돌아오지만 그것만
   * 기다리면 누른 뒤 한 왕복 동안 화면이 예전 값을 보여 준다.
   */
  async setHandle(handle: string): Promise<void> {
    const saved = await this.api.updateMyHandle(handle);
    const store = this.store.getState();
    const meId = store.me?.id;
    if (meId) store.applyHandle(meId, saved.handle);
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
    const store = this.store.getState();
    const cur = store.reads[channelId] ?? { lastReadSeq: 0, unread: 0 };
    const boundary = Math.min(cur.lastReadSeq, seq - 1);
    const unread = (store.messages[channelId] ?? [])
      .filter((m) => m.seq > boundary && m.authorId !== store.me?.id).length;
    store.set({ reads: { ...store.reads, [channelId]: { lastReadSeq: boundary, unread } } });
  }

  /**
   * 이 채널을 사이드바에서 치운다/다시 꺼낸다(#376).
   *
   * `toggleChannelStar` 와 달리 **토글이 아니라 값을 받는다.** 숨김은 서버가 혼자서 되돌리는
   * 상태이기 때문이다(부름이 오면 풀린다) — 스토어의 값을 뒤집어 보내면 그 사이에 서버가
   * 풀어 둔 채널을 "다시 숨기기"로 잘못 보낼 수 있다. 메뉴가 무엇을 하려는지 그대로 보낸다.
   *
   * 되돌리는 길이 **이 한 함수**다: 숨긴 채널 목록에서 '숨김 해제'가 같은 함수를 `false` 로
   * 부른다. 남에게 요청할 일이 없다는 것이 나가기(#344)와의 차이다.
   */
  async setChannelHidden(channelId: string, hidden: boolean): Promise<void> {
    const store = this.store.getState();
    const updated = await this.api.updateChannelPref(channelId, { hidden });
    store.set({ channelPrefs: { ...store.channelPrefs, [channelId]: updated } });
  }

  async toggleChannelStar(channelId: string): Promise<void> {
    const store = this.store.getState();
    const current = store.channelPrefs[channelId];
    const starred = !current?.starredAt;
    const updated = await this.api.updateChannelPref(channelId, { starred });
    store.set({ channelPrefs: { ...store.channelPrefs, [channelId]: updated } });
  }

  /**
   * 채널의 섹션을 설정한다(#157). 빈 문자열은 null(섹션 없음)로 저장.
   * DM 에는 사용할 수 없다 — 400 을 받으면 그대로 던진다.
   */
  async setChannelSection(channelId: string, section: string | null): Promise<void> {
    const store = this.store.getState();
    const updated = await this.api.updateChannelPref(channelId, { section });
    store.set({ channelPrefs: { ...store.channelPrefs, [channelId]: updated } });
  }

  /**
   * 섹션 이름 바꾸기(#323). 새 이름이 이미 존재하면 합친다.
   */
  async renameSection(oldName: string, newName: string | null): Promise<void> {
    const store = this.store.getState();
    const { prefs } = await this.api.renameSection(oldName, newName);
    const prefsMap: Record<string, typeof prefs[0]> = {};
    for (const p of prefs) {
      prefsMap[p.channelId] = p;
    }
    store.set({ channelPrefs: { ...store.channelPrefs, ...prefsMap } });
  }

  /**
   * 채널의 `sortOrder` 를 설정한다(#157). 섹션 안 순서 조절의 최소 단위다.
   */
  async setChannelSortOrder(channelId: string, sortOrder: number | null): Promise<void> {
    const store = this.store.getState();
    const updated = await this.api.updateChannelPref(channelId, { sortOrder });
    store.set({ channelPrefs: { ...store.channelPrefs, [channelId]: updated } });
  }

  /**
   * 한 섹션의 채널 순서를 통째로 다시 매긴다(#157) — 받은 배열 순서대로 0..n-1 이다.
   *
   * **일부만 매기지 않는 이유**: `sortOrder` 가 null 인 채널은 값이 있는 것들보다 뒤로
   * 가므로, 두 개만 바꿔 쓰면 나머지가 전부 아래로 쏟아진다. 그 묶음을 통째로 명시로
   * 만들면 다음 클릭도 예측대로 돈다.
   *
   * 스토어는 **한 번에** 갈아 끼운다. 응답마다 `set` 하면 중간 상태가 화면에 그려져
   * 순서가 잠깐 뒤엉킨다.
   */
  async reorderChannels(orderedChannelIds: string[]): Promise<void> {
    const updated: ChannelPrefRow[] = [];
    for (const [index, channelId] of orderedChannelIds.entries()) {
      updated.push(await this.api.updateChannelPref(channelId, { sortOrder: index }));
    }
    const store = this.store.getState();
    store.set({
      channelPrefs: {
        ...store.channelPrefs,
        ...Object.fromEntries(updated.map((p) => [p.channelId, p])),
      },
    });
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
    const { history, historyIndex } = this.store.getState();
    for (let i = historyIndex + step; i >= 0 && i < history.length; i += step) {
      const entry = history[i]!;
      const st = this.store.getState();
      const exists = st.channels.some((c) => c.id === entry.channelId) ||
        st.dms.some((d) => d.id === entry.channelId);
      if (!exists) continue;
      st.set({ historyIndex: i });
      await this.openChannelWithoutHistory(entry.channelId);
      if (entry.threadRootId) this.store.getState().set({ threadRootId: entry.threadRootId });
      return true;
    }
    return false;
  }

  /** 채널을 연다(히스토리 미추가). 뒤로·앞으로 이동 전용. */
  private async openChannelWithoutHistory(channelId: string): Promise<void> {
    const store = this.store.getState();
    // 뒤로·앞으로 이동도 채널을 새로 여는 것이다 — 접힘 기본값이 여기서 갈리면
    // 같은 채널이 어떻게 도착했는지에 따라 다르게 보인다(#217).
    store.set({ activeChannelId: channelId, threadRootId: null, highlightedMessageId: null });
    const since = this.loadedChannels.has(channelId)
      ? Math.max(0, ...(store.messages[channelId] ?? []).map((m) => m.seq))
      : 0;
    // 핀은 **크리티컬 패스에서 뺀다.** 이 엔드포인트가 없는 서버(구버전)에 붙었을 때
    // 채널이 아예 안 열리면 안 된다 — 채널 선호(`start`)와 같은 이유다.
    this.swallow(this.loadPins(channelId));
    this.swallow(this.loadChannelAutoMentions(channelId));
    const page = await this.api.messages(channelId, { since, limit: since === 0 ? INITIAL_HISTORY_LIMIT : undefined });
    this.loadedChannels.add(channelId);
    store.upsertMessages(channelId, page.messages);
    // 증분 응답은 `hasMore` 를 말할 자격이 없다 — 근거는 `openChannel` 의 같은 자리.
    if (since === 0) {
      store.set({
        hasMore: { ...store.hasMore, [channelId]: page.hasMore },
      });
    }
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

  /**
   * 담긴 목록 한 탭. **스토어에 쓰지 않고 그대로 돌려준다** — 패널의 지역 상태다.
   * 여기서 전역에 쓰면 '완료' 탭을 본 뒤 `⋯` 메뉴가 open 인 메시지를 담기지 않은 것으로 읽는다.
   * 실패는 삼키지 않고 그대로 던진다 — 부르는 화면이 "못 읽었다"를 그린다.
   */
  loadSavedMessages(state: 'open' | 'done'): Promise<SavedMessageRow[]> {
    return this.api.savedMessages(state);
  }

  /** 사이드바 배지(open 개수)와 `⋯` 메뉴 문구(담겼는가)를 한 왕복으로 갱신한다. */
  async loadSavedSummary(): Promise<{ openCount: number; messageIds: string[] }> {
    const summary = await this.api.savedSummary();
    this.store.getState().set({ savedCount: summary.openCount, savedIds: summary.messageIds });
    return summary;
  }

  async saveMessage(messageId: string): Promise<void> {
    await this.api.saveMessage(messageId);
    await this.loadSavedSummary();
  }

  async unsaveMessage(messageId: string): Promise<void> {
    await this.api.unsaveMessage(messageId);
    await this.loadSavedSummary();
  }

  async updateSavedMessageState(messageId: string, state: 'open' | 'done'): Promise<void> {
    await this.api.updateSavedMessage(messageId, state);
    await this.loadSavedSummary();
  }

  async listTeams(): Promise<AgentTeamRow[]> {
    return this.api.teams();
  }

  createTeam(name: string): Promise<AgentTeamRow> {
    return this.api.createTeam(name);
  }

  updateTeam(id: string, name: string): Promise<AgentTeamRow> {
    return this.api.updateTeam(id, name);
  }

  deleteTeam(id: string): Promise<void> {
    return this.api.deleteTeam(id);
  }

  setTeamLead(id: string, accountId: string | null): Promise<AgentTeamRow> {
    return this.api.setTeamLead(id, accountId);
  }

  async getTeam(id: string): Promise<{ team: AgentTeamRow; members: AgentTeamMemberRow[] }> {
    return this.api.team(id);
  }

  addTeamMember(teamId: string, accountId: string): Promise<{ members: AgentTeamMemberRow[] }> {
    return this.api.addTeamMember(teamId, accountId);
  }

  removeTeamMember(teamId: string, accountId: string): Promise<{ members: AgentTeamMemberRow[] }> {
    return this.api.removeTeamMember(teamId, accountId);
  }

  addTeamToChannel(channelId: string, teamId: string): Promise<AddTeamToChannelResult> {
    return this.api.addTeamToChannel(channelId, teamId);
  }

  /** 워크스페이스 스킬 목록(#311). #325 — `state` 파라미터로 필터링한다. */
  listSkills(state?: 'pending' | 'approved' | 'disabled'): Promise<WorkspaceSkillView[]> {
    return this.api.listSkills(state);
  }

  /** 스킬 상세 조회. */
  getSkill(slug: string): Promise<WorkspaceSkillView> {
    return this.api.getSkill(slug);
  }

  /** 스킬 승인(#311). admin 전용. */
  approveSkill(slug: string): Promise<WorkspaceSkillView> {
    return this.api.approveSkill(slug);
  }

  /** 스킬 비활성화/거부(#311). admin 전용. */
  disableSkill(slug: string): Promise<WorkspaceSkillView> {
    return this.api.disableSkill(slug);
  }
}

/**
 * 활성 커뮤니티의 컨트롤러를 꽂는다(#166).
 *
 * 레지스트리 등록(`startCommunitySession`)이 정식 경로지만 이 함수를 남긴다 — 오늘 여러
 * 테스트가 이것으로 가짜 컨트롤러를 활성 자리에 꽂는다. 이름과 시그니처를 지키면 이 이슈의
 * diff 가 "상태 구조" 에 머문다.
 */
export function setController(c: Controller | null): void {
  const { activeId, attachController } = useCommunityRegistry.getState();
  attachController(activeId, c);
}

/**
 * 호출부 수십 곳이 이 이름으로 "그 서버" 를 뜻한다. 이름과 시그니처를 그대로 두고 **내부만**
 * 레지스트리를 보게 바꿨다 — 이제 뜻은 "활성 커뮤니티의 컨트롤러" 다.
 */
export function getController(): Controller {
  return getActiveController();
}

/**
 * 커뮤니티 하나의 세션을 띄운다(#166). 스토어를 만들고, 그 스토어에 묶인 컨트롤러를 만들고,
 * WS 를 붙인다.
 *
 * **보고 있지 않은 커뮤니티도 붙여 둔다** — 안 그러면 알림이 오지 않는다. 다만 히스토리는
 * 늦게 받는다: `start()` 는 채널 목록·미읽음·읽음 위치까지만 받고 메시지 본문은 받지 않으며,
 * `onOpen` 의 `reconcile()` 은 `activeChannelId` 가 있을 때만 페이지를 읽는다. 비활성
 * 커뮤니티는 그것이 `null` 이므로 이벤트로 미읽음·알림만 갱신되고, 본문 로드는 활성화되어
 * `openChannel` 이 불릴 때 일어난다.
 *
 * `active: false` 로 부르면 활성 커뮤니티를 바꾸지 않는다. 두 번째 커뮤니티를 등록하는
 * 경로는 지금 그것뿐이고 **화면에서는 부르지 않는다** — 등록·전환 UI 는 #165 의 몫이다.
 */
export async function startCommunitySession(opts: {
  baseUrl: string;
  token: string;
  active: boolean;
  /**
   * 이 커뮤니티에 로그인한 계정 id(#165). **필수다** — 옵셔널로 두면 배선을 잊은 호출부가
   * 빈 문자열 엔트리를 만들고, 그 커뮤니티는 보관본에서도 세션 손실 판정에서도 자기를
   * 못 찾는다(`CommunityEntry.accountId`).
   */
  accountId: string;
  /** 이 기기에서 붙인 표시 이름(#165). `null` 은 "붙이지 않았다" — 호스트명으로 떨어진다. */
  label: string | null;
  onSessionLost?: (message: string, accountId: string) => void;
  makeWs?: typeof connectWs;
  notifier?: Notifier;
  /** 테스트가 서버 왕복 없이 이 경로를 그대로 지나가는 자리. 주지 않으면 진짜 클라이언트를 만든다. */
  api?: ApiClient;
}): Promise<CommunityEntry> {
  const registry = useCommunityRegistry.getState();
  // `active` 는 "화면이 이것을 본다" 이므로 **활성 엔트리를 그 커뮤니티로 만든다** — 새로
  // 덧붙이지 않는다. 그래야 재로그인이 목록을 늘리지 않는다.
  const input = { baseUrl: opts.baseUrl, accountId: opts.accountId, label: opts.label };
  const entry = opts.active
    ? registry.claimActive(input)
    : registry.register(input);
  // 같은 활성 커뮤니티의 재로그인·StrictMode 재기동은 이전 세션을 대체한다. 보존된
  // 컨트롤러를 먼저 끝내야 WS와 로컬 runner가 계정당 하나라는 불변식이 유지된다.
  entry.controller?.stop();
  const api = opts.api ?? new ApiClient(opts.baseUrl, opts.token);
  const controller = new Controller(
    api,
    opts.makeWs ?? connectWs,
    opts.notifier ?? silentNotifier,
    opts.onSessionLost ?? (() => {}),
    undefined,
    undefined,
    undefined,
    entry.store,
  );
  useCommunityRegistry.getState().attachController(entry.id, controller);
  try {
    await controller.start();
  } catch (err) {
    /**
     * 시작에 실패한 커뮤니티를 목록에 **남기지 않는다**(#165). 남기면 전환기 레일에 영원히
     * 끊긴 타일이 서고, 사용자가 그것을 뺄 이유를 이 실패에서 알아낼 방법이 없다.
     *
     * 활성 엔트리(초기 로그인·재로그인)는 빼지 않는다 — 그 자리는 기동 엔트리라 뺄 수도
     * 없고(마지막 하나), 실패는 화면이 `phase` 로 이미 처리한다.
     */
    controller.stop();
    const current = useCommunityRegistry.getState().entries.find((item) => item.id === entry.id);
    // 겹친 새 기동이 이미 자리를 차지했다면, 늦게 실패한 옛 기동이 그것까지 떼면 안 된다.
    if (current?.controller === controller) {
      useCommunityRegistry.getState().attachController(entry.id, null);
    }
    if (!opts.active) useCommunityRegistry.getState().remove(entry.id);
    throw err;
  }
  return { ...entry, controller };
}

/**
 * 보고 있는 커뮤니티를 바꾼다(#165).
 *
 * 보관본의 `active` 도 함께 옮긴다 — 안 그러면 전환한 뒤 앱을 다시 켤 때마다 예전 커뮤니티로
 * 돌아가고, 사용자는 자기가 무엇을 잘못했는지 알 수 없다.
 *
 * **보관 실패로 전환을 막지 않는다.** 화면 전환은 이미 끝났고(레지스트리), 키체인 쓰기 실패는
 * `sessionStore.save` 가 자기 자리에서 사람에게 말한다(#212). 여기서 던지면 눈에 보이는
 * 전환은 됐는데 오류 문구가 뜨는 모순된 화면이 된다.
 */
export async function switchCommunity(id: string): Promise<void> {
  const registry = useCommunityRegistry.getState();
  const entry = registry.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`모르는 커뮤니티다: ${id}`);
  registry.setActive(id);
  if (!entry.accountId) return;
  const stored = await sessionStore.load();
  if (!stored) return;
  await sessionStore.save({ ...stored, active: entry.accountId });
}

/**
 * OS 알림을 눌렀을 때 그 대화로 간다(#542).
 *
 * 이 함수가 화면 대신 여기 있는 이유: 이동은 커뮤니티 전환(`switchCommunity`)과 메시지 열기
 * (`controller.openMessage`) 두 조작의 **순서**이고, 그 둘이 다 이 모듈의 것이다. 화면에
 * 두면 알림 경로만 자기 순서를 따로 갖게 되고, 그것은 링크 클릭(#178)과 갈린다.
 *
 * **모르는 커뮤니티는 조용히 끝낸다.** 알림을 보낸 뒤 그 커뮤니티를 이 기기에서 뺄 수 있고
 * (`removeCommunity`), 그때 id 는 아무것도 가리키지 않는다. `switchCommunity` 는 모르는 id
 * 에 던지므로 그 예외가 이벤트 핸들러에서 터지게 두지 않는다 — 갈 곳이 없어진 것은 오류가
 * 아니라 사용자가 한 일의 결과다.
 *
 * 못 여는 메시지(지워짐·권한 없음·연결 실패)를 사람에게 알리는 일은 `openMessage` 가 자기
 * 자리에서 한다 — 여기서 한 번 더 판단하면 같은 사실에 두 문구가 생긴다.
 */
export async function openNotificationTarget(target: NotificationTarget): Promise<void> {
  const registry = useCommunityRegistry.getState();
  const entry = registry.entries.find((e) => e.id === target.communityId);
  if (!entry) return;
  // 화면을 먼저 옮긴다. 순서가 뒤바뀌면 메시지가 보이지 않는 스토어에 들어가고, 사용자는
  // 아무 일도 안 난 것으로 본다.
  if (registry.activeId !== entry.id) await switchCommunity(entry.id);
  // 컨트롤러가 아직 안 꽂힌 순간이 실제로 있다(스토어는 있고 세션은 안 붙은 엔트리).
  // 그때는 전환까지가 할 수 있는 전부다.
  await useCommunityRegistry.getState().entries
    .find((e) => e.id === entry.id)?.controller?.openMessage(target.messageId);
}

/**
 * 이 기기에서의 표시 이름을 바꾼다(#165). 빈 입력은 **명시적 `null`**(= 이름 없음)이 되어
 * 호스트명으로 돌아간다.
 *
 * 낙관적 갱신을 하지 않는다 — 보관에 실패했는데 화면에만 새 이름이 남으면, 다음 기동에
 * 이름이 조용히 되돌아간다. 보관이 끝난 뒤에 레지스트리를 고친다.
 */
export async function setCommunityLabel(id: string, label: string): Promise<void> {
  const registry = useCommunityRegistry.getState();
  const entry = registry.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`모르는 커뮤니티다: ${id}`);
  const next = label.trim() ? label.trim() : null;
  if (entry.accountId) await sessionStore.setLabel(entry.accountId, next);
  useCommunityRegistry.getState().setLabel(id, next);
}

/**
 * 커뮤니티를 **이 기기의 목록에서** 뺀다(#165 결정 4).
 *
 * **`controller.logout()` 을 부르지 않는다.** 그것은 서버 세션까지 폐기하므로, 같은 서버에
 * 다른 기기로 붙어 있던 세션까지 함께 죽는다 — 커뮤니티를 이 기기에서 치우겠다는 조작이
 * 다른 기기의 로그아웃을 뜻하게 되는 것은 오답이다. 여기까지가 전부다: WS 를 끊고, 키체인
 * 항목을 지우고, 레지스트리에서 뺀다.
 *
 * 마지막 하나면 레지스트리에서 빼지 않고 **엔트리를 비운다** — 활성 스토어가 없는 상태를
 * 만들지 않는다(`useCommunityRegistry.remove` 가 그것을 거절하는 이유와 같다). 그때는 정말
 * 세션이 없으므로 호출부가 `phase` 를 `connect` 로 돌린다. 그 판단을 여기서 하지 않고
 * `{ empty }` 로 올려 보내는 이유는, `phase` 는 화면의 것이고 이 함수는 화면을 모르기 때문이다.
 */
export async function removeCommunity(id: string): Promise<{ empty: boolean }> {
  const registry = useCommunityRegistry.getState();
  const entry = registry.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`모르는 커뮤니티다: ${id}`);
  entry.controller?.stop();
  if (entry.accountId) await sessionStore.remove(entry.accountId);
  if (registry.entries.length > 1) {
    useCommunityRegistry.getState().remove(id);
    return { empty: false };
  }
  entry.store.getState().reset();
  useCommunityRegistry.getState().claimActive({ baseUrl: '', accountId: '', label: null });
  return { empty: true };
}
