import { create } from 'zustand';
import { draftsStorage, stickyMentionsStorage } from '../lib/prefs';
import type { AccountStatus, AccountView, AgentTeamRow, ChannelAutoMentionRow, ChannelDoc, ChannelRow, ChannelMemberRow, ChannelPrefRow, DmView, HandleGroupRow, InboxEntry, LeaseRow, MessageRow, PinRow, ProjectionStatus, ServerVersion } from '@harkroom/shared';
import type { ObservedRunner, RunnerState } from '../lib/runnerLauncher';
import type { NotifiedSummary } from '../lib/notified';

export interface HistoryEntry {
  channelId: string;
  threadRootId: string | null;
}

const MAX_HISTORY_LENGTH = 50;

export interface AppState {
  me: AccountView | null;
  accounts: Record<string, AccountView>;
  groups: HandleGroupRow[];
  /**
   * 부를 수 있는 에이전트 팀(#172). `groups` 와 **나란히** 산다 — 둘 다 "한 이름으로
   * 여럿을 부른다"는 같은 사실이고, 자동완성 후보와 조용한 실패 판정이 둘을 같은
   * 자리에서 읽는다(`Composer.tsx`·`lib/notified.ts`).
   *
   * 명단은 여기 없다. 팀 명단을 주는 라우트는 `GET /teams/:id` 하나뿐이고, 후보를
   * 그리는 데 필요한 것은 이름과 규모뿐이다(`AgentTeamRow.memberCount`).
   *
   * ## `null` 은 **"목록을 못 받았다"** 다 — 빈 배열과 다른 사실이다
   *
   * `teams` 를 싣는 것은 `GET /accounts` 뿐이고(`directoryRoutes.ts`), 그 필드가 없는
   * 서버가 실제로 있다 — 팀 라우트(`/teams`)는 이미 있는데 디렉터리 응답에는 팀이
   * 없는 중간 버전이다(#172 가 멘션·`memberCount`·디렉터리를 한 커밋에 넣기 전에
   * 빌드된 서버). 그 서버에 붙으면 이 값이 `null` 이다.
   *
   * 앞 판은 그것을 `?? []` 로 뭉갰고, 근거는 *"그 서버는 팀을 부르지도 못하므로 빈
   * 목록이 맞다"* 였다. **그 근거는 한 소비자에게만 맞는다:**
   *
   * | 이 값을 읽는 곳 | 묻는 것 | 빈 배열이 맞나 |
   * |---|---|---|
   * | 자동완성 후보 · 조용한 실패 판정 | 지금 부를 수 있는 팀은? | **맞다** — 그 서버는 `@팀` 을 해석하지 못한다 |
   * | 설정 › 에이전트 › 팀 격자 | 이 워크스페이스에 팀이 있나? | **틀리다** — `POST /teams` 는 그 서버에서도 되고, 만든 팀은 진짜로 있다 |
   *
   * 실제로 그 어긋남이 화면에서 나왔다: 팀을 만들면 격자는 *"아직 팀이 없다"* 라고
   * 단언하는데 다시 만들면 서버가 `name_taken` 으로 거절한다. 모르는 것을 없는 것으로
   * 그리지 말라는 `docs/design.md` §4 가 막으려던 그것이다.
   *
   * 그래서 **모르는 것은 `null` 로 남기고**, 빈 목록이 맞는 소비자가 자기 자리에서
   * `?? []` 한다(`Composer.tsx`·`MessageBody.tsx`·`controller.ts::recordNotifiedGap`).
   * 그 `??` 는 뭉개는 것이 아니라 *"여기서는 빈 목록이 사실이다"* 라는 판단이고,
   * 그 판단이 필요 없는 격자는 `null` 을 받아 사실대로 말한다(`TeamGrid`).
   */
  teams: AgentTeamRow[] | null;
  channels: ChannelRow[];
  dms: DmView[];
  activeChannelId: string | null;
  threadRootId: string | null;
  messages: Record<string, MessageRow[]>;
  /** channelId → 입력 중인 accountId 들. 서버가 상태 전체를 보내므로 덮어쓰기만 한다. */
  typing: Record<string, string[]>;
  /** 채널별 '더 오래된 것이 남았는가'. */
  hasMore: Record<string, boolean>;
  unread: InboxEntry[];
  /**
   * 인박스가 서버에서 바뀐 것을 **확인한 횟수**(2026-09-10). `refreshUnread` 가 새 목록을
   * 반영할 때마다 1 올라간다 — 그 함수가 도는 자리가 곧 "서버의 인박스가 달라졌다"를 아는
   * 자리다(`inbox.updated` 이벤트, 그리고 재연결 뒤의 `reconcile`).
   *
   * 인박스 패널은 위의 `unread` 를 자기 목록으로 쓸 수 없다 — 그 배열은 `?unread=1` 로만
   * 채워져 읽은 줄이 없다(`Inbox.tsx` 의 주석). 그래서 자기 목록을 따로 조회하는데, 예전에는
   * **열 때 한 번만** 조회했다: 열어 둔 채로 멘션이 와도 화면에 아무 일이 없어 닫았다 열어야
   * 보였다(2026-09-10 신고). 이 수가 그 패널에 "다시 읽어라"만 전한다 — 목록 자체를 여기
   * 담지 않는 이유는 `skillsRevision` 과 같다(두 벌을 두면 어느 쪽이 최신인지 갈린다).
   *
   * **시각이 아니라 세는 수인 이유도 그것과 같다:** 같은 밀리초에 둘이 오면 `Date.now()` 는
   * 같은 값이라 화면이 두 번째를 못 본다.
   */
  inboxRevision: number;
  /** 채널별 읽음 상태(서버 진실). 사이드바 배지가 여기서 나온다. */
  reads: Record<string, { lastReadSeq: number; unread: number }>;
  /**
   * 채널을 **열 때** 얼려 둔 읽음 위치. 구분선은 이 값으로 그린다 — 라이브 `reads` 를 쓰면
   * 열자마자 읽음 처리가 돌아 구분선이 즉시 사라져 아무 쓸모가 없다.
   */
  dividerSeq: Record<string, number>;
  online: string[];
  /**
   * 지금 터미널 패널이 보고 있는 대상(#141, #339). `null` 은 패널이 닫혀 있다는 뜻이다.
   *
   * 세션 id 가 아닌 이유: 칩은 메시지 행에서 뜨고, 세션 id 는 러너만 안다 — 어느 세션에
   * 붙을지는 패널이 목록을 받아 정한다. 에이전트 id **하나만으로도 안 되는** 이유(#339):
   * 세션은 (에이전트, 스레드)당 하나라(스펙 §5), 같은 에이전트가 스레드 여럿에서 동시에
   * 턴을 돌면 에이전트 id 만으로는 임의의 첫 세션에 붙는다. 그래서 칩을 누른 메시지의
   * 채널·스레드까지 함께 든다. `threadRootId` 는 #98 앵커식으로 항상 채워진 문자열이다 —
   * 채널 최상위 멘션은 그 멘션 메시지 자신이 루트다.
   */
  terminalTarget: { agentAccountId: string; channelId: string; threadRootId: string } | null;
  leases: LeaseRow[];
  connected: boolean;
  /**
   * 지금 붙어 있는 서버가 말한 자기 버전(#693). `/healthz` 에서 온다.
   *
   * **`null` 은 "아직/못 물어봤다"** 다 — "버전이 없는 서버"가 아니다. 이 값을 안 싣는 옛
   * 서버는 `version`·`commit` 이 `null` 인 `ServerVersion` 으로 들어오므로(응답에 필드가
   * 없으면 `undefined` 지만 `??` 로 눕힌다), 화면에서 "모른다"와 "낡았다"가 갈린다.
   *
   * 커뮤니티마다 **자기 스토어에** 산다 — 활성 커뮤니티의 버전을 목록 전체에 쓰면
   * 셋 중 하나만 낡은 상황이 화면에서 사라진다(`CommunityRow` 가 `connected` 를 자기
   * 스토어에서 읽는 것과 같은 이유, #166).
   */
  serverVersion: ServerVersion | null;
  /**
   * avcs 투영 상태(#267). 60초마다 갱신한다. `null` 은 **"아직 모른다"** 다 —
   * "투영이 없다"가 아니다. 화면이 둘을 갈라 말해야 하므로 별도의 값으로 둔다.
   */
  projectionStatus: ProjectionStatus | null;
  /**
   * 투영 상태를 **읽지 못한** 이유(#267). `null` 이면 실패하지 않았다는 뜻이다.
   *
   * 왜 별도 필드인가: 조회 실패를 `projectionStatus: null` 로만 표현하면 "아직 안 왔다"와
   * "물어봤는데 실패했다"가 한 값에 뭉치고, 화면은 그 둘을 같은 문구로 그린다 —
   * 이 이슈가 닫으려는 결함이 스토어 층에 그대로 되살아난다(docs/design.md §4).
   */
  projectionStatusError: string | null;
  /** 계정별 채널 음소거·즐겨찾기. channelId → preference */
  channelPrefs: Record<string, ChannelPrefRow>;
  /**
   * 채널별 고정 메시지(#218). `channelPrefs` 와 나란히 있지만 **성질이 다르다** — 저쪽은
   * 내 취향이고 이쪽은 채널 전역 사실이라 누가 봐도 같은 값이다. 그래서 로그아웃 시
   * 초안처럼 비밀로 다룰 것이 없고, 다음 사람이 열면 서버에서 다시 받는다.
   */
  pins: Record<string, PinRow[]>;
  /**
   * 채널별 문서(#188). **키가 없는 것과 본문이 빈 문서는 다르다** — 없으면 "아직 안
   * 받았다", 있는데 본문이 ''면 "정말 비어 있다"다. 조회 실패를 빈 문서로 채우면 두
   * 상태가 같은 화면이 되고, 사람은 못 읽은 문서를 없는 문서로 읽는다.
   *
   * `pins` 와 같은 이유로 로그아웃 시 비밀로 다룰 것이 없다 — 채널 전역 사실이다.
   */
  channelDocs: Record<string, ChannelDoc>;
  /**
   * 내가 담아 둔 메시지의 id 전부(#219). `open` 과 `done` 을 **둘 다** 담는다 —
   * `⋯` 메뉴가 "담겨 있는가"를 이것으로 판단하고, 완료로 옮긴 메시지도 담긴 상태다.
   *
   * 목록 화면의 행들을 여기 두지 않는 이유: 패널은 탭 하나(`open` 또는 `done`)만 받아
   * 오는데 그것을 이 자리에 쓰면 '완료' 탭을 한 번 본 뒤로 메뉴가 `open` 인 메시지를
   * 담기지 않은 것으로 읽는다. 행들은 패널의 지역 상태다.
   */
  savedIds: string[];
  /**
   * 담아 둔 것 중 `open` 개수. 사이드바 배지에 쓴다 — `savedIds.length` 가 아니다
   * (완료로 옮긴 것은 배지에서 빠져야 한다).
   */
  savedCount: number;
  /**
   * 채널별 멤버 목록. channelId → members. **키가 없는 것과 빈 배열은 다르다** —
   * 없으면 "아직 안 받았다", 빈 배열이면 "정말 아무도 없다"다. 조회 실패를 빈 배열로
   * 채우면 그 구분이 사라져 나가기 경고가 조용히 꺼진다.
   */
  channelMembers: Record<string, ChannelMemberRow[]>;
  /**
   * 채널별 자동 멘션 에이전트(#173). `pins` 와 같은 채널 전역 사실이다 — 내 취향이 아니라
   * 누가 봐도 같은 값이라 비밀로 다룰 것이 없다. `channelMembers` 와 같이 **키가 없는 것과
   * 빈 배열은 다르다**: 없으면 아직 못 받았다, 빈 배열이면 정말 아무도 없다.
   */
  channelAutoMentions: Record<string, ChannelAutoMentionRow[]>;
  /**
   * 스코프별 초안. 키는 scopeKey (channelId 또는 thread:<rootId>).
   * 설정과 달리 사용자가 쓴 문장 전체이므로 로그아웃 시 반드시 삭제한다.
   */
  drafts: Record<string, string>;
  /**
   * 스코프별 **멘션 고정**(#706). 키는 초안과 같은 scopeKey 다 — 같은 입력창의 두 반쪽이므로
   * 수명도 같아야 한다.
   *
   * 컴포저의 지역 state 가 아닌 이유가 이 필드의 존재 이유다: 스레드 패널은 조건부 렌더라
   * (`Workspace.tsx` 의 `{threadRootId && <ThreadPanel/>}`) 다른 채널을 한 번 누르면
   * 언마운트된다. 지역 state 에 두면 그때 고정이 사라지는데 초안은 여기 남아 돌아오므로,
   * 사람은 칩 없는 입력창에 대고 "아직 그 에이전트를 부르는 중"이라고 믿는다.
   *
   * 값은 소문자 handle 목록이고 **부른 순서를 지킨다**(`lib/mention.ts::withStickyMentions`).
   * 걸러내기(사라진 계정·자동 멘션과 겹치는 것)는 읽는 자리에서 한다 — 저장된 것은 사람이
   * 고정한 사실 그대로다.
   */
  stickyMentions: Record<string, string[]>;
  /** 뒤로/앞으로 탐색용 이력 스택. 채널·스레드만 담고 스크롤 위치는 담지 않는다.
   * 뒤로/앞으로 이동 시에는 push 하지 않는다 — 그렇게 하면 뒤로 갈 때마다 스택이 자라
   * 영원히 빠져나오지 못한다. openChannel/openThread 에서만 새 항목을 밀어 넣는다.
   * 세션 한정 인메모리다 — localStorage 에 넣지 않는다. */
  history: HistoryEntry[];
  historyIndex: number;
  /**
   * 사람에게 보여야 하는 짧은 알림·오류(#178). 조용히 삼키면 안 되는 실패가 여기로 온다 —
   * 링크가 가리키는 메시지를 못 열었다, 클립보드 쓰기가 막혔다 같은 것들.
   * 없으면 null 이다. 화면 상태이므로 영속하지 않는다.
   */
  notice: string | null;
  /**
   * **조용한 실패로 끝난 집합 호출**(정본 문서: 집합 호출의 결과). messageId → 말할 한 줄.
   *
   * 왜 `MessageRow` 가 아니라 여기인가: 이 사실은 서버에서 **헤더로** 오고
   * (`NOTIFIED_HEADER` 주석 — 본문은 `MessageRow` 그 자체로 남아야 한다) 그 요청을 보낸
   * 사람에게만 온다. `MessageRow` 에 얹으면 같은 메시지가 WebSocket 으로 오는 다른 사람의
   * 화면과 모양이 갈리고, 그것이 서버가 헤더를 고른 이유 그 자체다.
   *
   * **덜 깬 발화만 들어온다** — 셋을 불러 셋이 깨면 키가 생기지 않는다. 성공까지 담으면
   * 화면이 "무엇을 그릴지"를 매 렌더에서 다시 판정하게 되고, 그 판정이 두 곳(채널·스레드)에
   * 갈라진다. 판정은 `notifiedSummary` 한 자리에 있고 스토어는 그 결과만 든다.
   *
   * 화면 상태이므로 영속하지 않는다. 앱을 다시 켜면 사라진다 — 부름의 결과는 **보낸
   * 직후**에 쓸모가 있는 사실이고(다시 부를지 정한다), 어제의 부름에 대해 오늘 이 줄이 서면
   * 그것은 이미 지난 사정이다. 서버에서 다시 받을 길도 없다(헤더는 그 응답에만 있었다).
   */
  notifiedGaps: Record<string, NotifiedSummary>;
  /**
   * 투영 고장 띠를 **어느 사정에 대해** 닫았는가(#488 A3-a). 닫지 않았으면 null 이다.
   *
   * 불리언이 아닌 이유: 투영이 꺼진 것을 닫아 뒀는데 그 뒤 투영이 **멈추면** 그것은
   * 다른 사실이므로 띠가 다시 서야 한다. 한 번 닫은 것으로 이후의 모든 고장을 덮으면
   * 닫기가 곧 **알림 끄기**가 된다.
   *
   * 화면 상태이므로 영속하지 않는다 — 앱을 다시 켜면 고장은 다시 말해야 한다.
   */
  projectionBannerDismissed: string | null;
  /**
   * 호환 하한보다 낮은 서버를 말하는 띠를 **어느 버전에 대해** 닫았는가(#693 후속).
   * 닫지 않았으면 null 이고, 값은 그때 서버가 말한 버전 문자열이다.
   *
   * 불리언이 아닌 이유는 위와 같다: 재배포했는데 **여전히** 하한보다 낮으면(예: 두 판
   * 올렸지만 아직 모자라면) 그것은 다른 사실이라 띠가 다시 서야 한다. 재배포가 먹혔는지를
   * 사람이 다시 확인할 수 있어야 하고, 한 번 닫은 것으로 그 뒤를 전부 덮으면 닫기가
   * **알림 끄기**가 된다.
   */
  serverCompatBannerDismissed: string | null;
  /**
   * 링크로 방금 이동한 메시지(#178). **메시지 데이터가 아니라 화면 상태다** — 여기 두지
   * 않고 `MessageRow` 에 넣으면 서버에서 온 사실과 지금 화면의 사정이 한 값에 섞인다.
   * 다음 이동 때 갈아탄다(`openChannel` 이 지우고 `openMessage` 가 다시 건다).
   */
  highlightedMessageId: string | null;
  /** 에이전트별 러너 실행 상태. agentId → state */
  runnerStates: Record<string, RunnerState>;
  /**
   * daemon 이 **직접 확인한** 러너의 사실. agentId → 관측(`#443`).
   *
   * ## 왜 `runnerStates` 를 늘리지 않았나
   *
   * 둘은 **출처와 수명이 다르다.**
   *
   * | | `runnerStates` | `daemonRunners` |
   * |---|---|---|
   * | 누가 쓰나 | 이 앱의 실행기(`RunnerLauncher.setState`) | daemon(`observe()` 의 응답) |
   * | 무엇인가 | 이 앱이 **내린 판정**(띄웠다·실패했다·기다린다) | daemon 이 `kill(pid,0)` 등으로 **본 사실** |
   * | 언제 갱신되나 | 실행기가 무언가 할 때마다 | 관측할 때만 |
   *
   * `RunnerState` 에 `pid` 를 넣으면 실행기의 모든 `setState` 가 그 값을 함께 실어야
   * 한다 — `Omit<RunnerState,'agentId'>` 를 통째로 갈아 끼우는 구조라(그 함수 시그니처)
   * 한 자리라도 빠뜨리면 **관측된 pid 가 판정 갱신에 지워진다.** 사실이 판정의 부산물로
   * 사라지는 그 모습이 정확히 `#443` 이 고치려는 것이므로, 나르는 그릇을 갈라 둔다.
   *
   * 또 `faceState`(`lib/faceState.ts`)가 `runnerStates` 를 **판정의 유일한 입력**으로
   * 쓴다. 사실을 그 안에 섞으면 다음 사람이 `pid` 를 보고 얼굴을 정하게 되고, 그것은
   * daemon 에게 판단을 시키는 것이다(`RunnerInfo.alive` 주석이 금지한 그 방향).
   *
   * **비어 있음이 곧 "러너가 없다"가 아니다** — 관측에 실패했거나(daemon 에 못 닿았다)
   * 아직 안 했을 수도 있다. 그래서 화면은 여기 없는 에이전트에 대해 아무 말도 하지 않는다.
   */
  daemonRunners: Record<string, ObservedRunner>;
  /**
   * 이 앱 번들의 버전. **컨트롤러가 기동 때 한 번 밀어 넣는다** — `runnerStates` 와 같은
   * 방향이다(컨트롤러가 밀고 화면은 읽는다). 화면이 컨트롤러에게 직접 물으면 컨트롤러를
   * 목으로 세우는 모든 테스트가 그 메서드를 알아야 하고, 실패는 렌더 도중의 예외가 된다.
   *
   * `null` 은 '아직 모른다' 또는 '얻지 못했다'다. 그때 화면은 뒤처짐을 판정하지 않는다 —
   * 비교 기준 없이 단정하는 것이 docs/design.md §4 가 금지하는 거짓 신호다.
   */
  appVersion: string | null;
  /**
   * 링크 미리보기가 준비된 시각. url → 타임스탬프(#215).
   *
   * 카드 **내용**을 여기 담지 않는 이유: 캐시는 서버에 하나뿐이고, 두 벌을 두면 어느 쪽이
   * 최신인지 화면마다 갈린다. 여기 있는 것은 "다시 읽어라"는 신호뿐이다.
   */
  linkPreviewReadyAt: Record<string, number>;
  /**
   * 스킬 목록이 바뀐 횟수(#311). `skill.*` 이벤트를 받을 때마다 1 올라간다.
   *
   * 목록을 여기 담지 않는 이유는 미리보기와 같다 — 목록은 서버에 하나뿐이고, 두 벌을
   * 두면 어느 쪽이 최신인지 갈린다. 여기 있는 것은 "다시 읽어라"는 신호뿐이다.
   *
   * **시각이 아니라 세는 수인 이유:** 같은 밀리초에 두 이벤트가 오면 `Date.now()` 는
   * 같은 값이라 화면이 두 번째를 못 본다. 세는 수는 그런 자리가 없다.
   */
  skillsRevision: number;
  set(partial: Partial<AppState>): void;
  upsertMessages(channelId: string, rows: MessageRow[]): void;
  /**
   * 스레드 루트의 두 집계를 함께 움직인다(2026-09-09). 예전 이름은 `incrementReplyCount`
   * 였고 **더하기만** 있었다 — 답글을 지워도 그 수가 줄지 않아, 다시 받아오기 전까지
   * 채널이 없는 답글을 셌다.
   *
   * `countsAsReply` 는 서버의 기준을 그대로 옮긴 것이다: `progress`·`wake` 는 활동이지
   * 답글이 아니므로 `activityCount` 만 움직인다. 두 수를 한 함수로 움직이는 이유는
   * 나뉘면 한쪽만 부르는 자리가 생기고, 그것이 정확히 지금 고치는 결함이기 때문이다.
   */
  bumpThreadCounts(channelId: string, messageId: string, delta: 1 | -1, countsAsReply: boolean): void;
  applyReaction(channelId: string, messageId: string, emoji: string, accountId: string, on: boolean): void;
  removeMessage(channelId: string, messageId: string): void;
  /**
   * 사람이 고른 상태를 반영한다(#186). `online` 은 **건드리지 않는다** — 연결 여부는
   * presence 이벤트만이 정한다. 둘을 한 자리에서 갱신하면 상태 변경이 연결 표시를
   * 흔들어, 소켓이 멀쩡한 사람이 잠깐 회색으로 보인다.
   */
  applyStatus(accountId: string, status: AccountStatus, statusText: string | null): void;
  /** 그 계정의 프로필 사진 첨부 id 를 갈아 끼운다. null 은 지우기다(#159). */
  applyAvatar(accountId: string, avatarAttachmentId: string | null): void;
  /** 그 계정의 handle 을 바꾼다(#271). */
  applyHandle(accountId: string, handle: string): void;
  reset(): void;
  clearDrafts(): void;
  setDraft(scopeKey: string, draft: string): void;
  /** 기동 시 보관소에서 초안을 읽어 온다. */
  hydrateDrafts(): void;
  /** 그 자리의 멘션 고정을 갈아 끼운다. 빈 배열이면 키를 지운다. */
  setStickyMentions(scopeKey: string, handles: string[]): void;
  /** 로그아웃 시 보관된 고정까지 비운다(`clearDrafts` 와 같은 이유). */
  clearStickyMentions(): void;
  /** 기동 시 보관소에서 고정을 읽어 온다. */
  hydrateStickyMentions(): void;
  /** 새 채널·스레드를 열 때 이력에 추가한다. 뒤로/앞로 이동에서는 부른다. */
  pushHistory(entry: HistoryEntry): void;
  /** 이력에서 뒤로 간다. 이미 첫 항목이면 아무 일도 하지 않는다. */
  goBack(): HistoryEntry | null;
  /** 이력에서 앞으로 간다. 이미 마지막 항목이면 아무 일도 하지 않는다. */
  goForward(): HistoryEntry | null;
  /** 현재 위치에서 미래 이력을 모두 잘라낸다(새 항목 추가 시). */
  truncateForward(): void;
}

/**
 * 팀 목록을 못 받았을 때(`teams === null`) 후보를 만드는 자리가 자기 사실로 쓰는 빈 목록.
 *
 * **모듈 상수인 것이 요점이다.** 읽는 자리에서 `?? []` 를 적으면 렌더마다 새 배열이 나고,
 * 그것을 의존에 둔 `useMemo`(`Composer`·`MessageBody` 의 후보 목록)가 매 렌더 다시 돈다.
 */
export const NO_TEAMS: AgentTeamRow[] = [];

const initial = {
  me: null, accounts: {}, groups: [], teams: null, channels: [], dms: [], activeChannelId: null, threadRootId: null,
  messages: {}, typing: {}, hasMore: {}, unread: [], inboxRevision: 0, reads: {}, dividerSeq: {},
  online: [], terminalTarget: null, leases: [], connected: false, serverVersion: null,
  projectionStatus: null, projectionStatusError: null,
  channelPrefs: {}, pins: {}, channelDocs: {}, channelMembers: {}, channelAutoMentions: {}, drafts: {}, stickyMentions: {},
  history: [], historyIndex: -1, notice: null, notifiedGaps: {}, projectionBannerDismissed: null, serverCompatBannerDismissed: null,
  highlightedMessageId: null,
  runnerStates: {}, daemonRunners: {}, appVersion: null, savedIds: [], savedCount: 0,
  linkPreviewReadyAt: {}, skillsRevision: 0,
};

/**
 * 커뮤니티 하나의 세계를 담는 스토어를 만든다(#166).
 *
 * 예전에는 이 자리에 모듈 최상위 싱글턴 `useAppStore` 가 있었고, 그 하나가 곧 "그 서버"
 * 였다. 커뮤니티가 N 개가 되면 그 전제가 깨지므로 **팩토리**로 바꾼다. `AppState`·
 * `initial`·`reset()` 의 모양은 하나도 건드리지 않았다 — 이 이슈가 바꾸는 것은 상태의
 * 모양이 아니라 그것이 **몇 벌 존재하는가**다.
 *
 * 활성 커뮤니티의 것을 읽는 자리는 `state/communities.ts` 의 `useActiveStore` 다.
 */
export function createAppStore() {
  return create<AppState>((set, get) => ({
    ...initial,
    set: (partial) => set(partial),
    upsertMessages: (channelId, rows) => {
      const byId = new Map((get().messages[channelId] ?? []).map((m) => [m.id, m]));
      for (const r of rows) byId.set(r.id, r);
      const merged = [...byId.values()].sort((a, b) => a.seq - b.seq);
      set({ messages: { ...get().messages, [channelId]: merged } });
    },
    bumpThreadCounts: (channelId, messageId, delta, countsAsReply) => {
      const rows = get().messages[channelId];
      if (!rows) return;
      const parent = rows.find((m) => m.id === messageId);
      if (!parent) return;
      // 0 아래로 내려가지 않는다 — 삭제 이벤트가 두 번 오거나(재연결 뒤 재생) 서버가 이미
      // 뺀 수를 받아 둔 뒤 오면 음수가 되고, `hasReplies`/`hasActivity` 가 뒤집힌다.
      const clamp = (n: number | null): number => Math.max(0, (n ?? 0) + delta);
      const next = rows.map((m) => (m.id === messageId
        ? {
          ...m,
          replyCount: countsAsReply ? clamp(m.replyCount) : (m.replyCount ?? 0),
          activityCount: clamp(m.activityCount),
        }
        : m));
      set({ messages: { ...get().messages, [channelId]: next } });
    },
    /**
     * 리액션 델타를 적용한다. 같은 사람이 두 번 들어오지 않게 하는 것이 핵심이다 — 내가 누른
     * 것은 로컬 갱신과 소켓 이벤트로 두 번 도착하고, 두 번 세면 1 이 2 로 보인다.
     */
    applyReaction: (channelId, messageId, emoji, accountId, on) => {
      const rows = get().messages[channelId];
      if (!rows) return;
      const next = rows.map((m) => {
        if (m.id !== messageId) return m;
        const others = m.reactions.filter((r) => r.emoji !== emoji);
        const hit = m.reactions.find((r) => r.emoji === emoji);
        const ids = (hit?.accountIds ?? []).filter((id) => id !== accountId);
        if (on) ids.push(accountId);
        // 아무도 남지 않으면 칩을 지운다 — 0 이 적힌 칩은 UI 의 거짓말이다.
        if (!ids.length) return { ...m, reactions: others };
        // 이모지의 원래 자리를 지킨다. 뒤로 밀면 누를 때마다 칩이 춤춘다.
        return {
          ...m,
          reactions: m.reactions.map((r) => (r.emoji === emoji ? { emoji, accountIds: ids } : r))
            .concat(hit ? [] : [{ emoji, accountIds: ids }]),
        };
      });
      set({ messages: { ...get().messages, [channelId]: next } });
    },
    removeMessage: (channelId, messageId) => {
      const rows = get().messages[channelId];
      if (!rows) return;
      set({ messages: { ...get().messages, [channelId]: rows.filter((m) => m.id !== messageId) } });
    },
    applyStatus: (accountId, status, statusText) => {
      const cur = get().accounts[accountId];
      // 처음 보는 계정이면 디렉터리에 없다는 뜻이다. 여기서 껍데기를 만들면 handle 없는
      // 계정이 멘션 후보·작성자 표에 섞인다 — 계정을 다시 받아오는 것은 컨트롤러의 몫이다.
      if (!cur) return;
      const patched = { ...cur, status, statusText };
      const me = get().me;
      // `me` 는 accounts 와 **별도 객체**다. 한쪽만 고치면 내가 정한 상태가 남의 화면에는
      // 보이는데 내 사이드바에는 안 보이는(또는 그 반대인) 갈라짐이 생긴다.
      set({
        accounts: { ...get().accounts, [accountId]: patched },
        ...(me?.id === accountId ? { me: { ...me, status, statusText } } : {}),
      });
    },
    /**
     * 프로필 사진이 바뀌었다(#159). `applyStatus` 와 같은 이유로 `me` 도 함께 고친다 —
     * 한쪽만 고치면 내가 방금 올린 사진이 남의 화면에는 보이는데 내 화면에는 안 보인다.
     */
    applyAvatar: (accountId, avatarAttachmentId) => {
      const cur = get().accounts[accountId];
      const me = get().me;
      // 디렉터리에 없는 계정에 껍데기를 만들지 않는다 — `applyStatus` 와 같은 판단이다.
      if (!cur && me?.id !== accountId) return;
      set({
        ...(cur ? { accounts: { ...get().accounts, [accountId]: { ...cur, avatarAttachmentId } } } : {}),
        ...(me?.id === accountId ? { me: { ...me, avatarAttachmentId } } : {}),
      });
    },
    /**
     * handle 이 바뀌었다(#271). `applyStatus` 와 같은 이유로 `me` 도 함께 고친다 —
     * 한쪽만 고치면 내가 방금 바꾼 이름이 남의 화면에는 보이는데 내 화면에는 안 된다.
     */
    applyHandle: (accountId, handle) => {
      const cur = get().accounts[accountId];
      const me = get().me;
      if (!cur && me?.id !== accountId) return;
      set({
        ...(cur ? { accounts: { ...get().accounts, [accountId]: { ...cur, handle } } } : {}),
        ...(me?.id === accountId ? { me: { ...me, handle } } : {}),
      });
    },
    reset: () => set({ ...initial }),
    clearDrafts: () => { set({ drafts: {} }); draftsStorage.clear(); },
    /**
     * 스토어가 초안의 **단일 원천**이다. 영속도 여기서 한다 — 컴포저가 지역 state 와
     * 보관소를 각각 들면 진실이 둘이 되고, 실제로 초판이 그랬다(스토어 쪽은 아무도
     * 쓰지 않는 죽은 코드였고 로그아웃이 그쪽을 비우지 않았다).
     *
     * 맵이 이미 메모리에 있으므로 키 입력마다 보관소를 **읽지** 않는다. 초판은 매
     * 글자마다 load() 로 JSON 을 파싱했다 — murmur 메시지는 길다는 것이 이 기능의
     * 전제인데 그 전제와 정면으로 어긋난다.
     */
    setDraft: (scopeKey, draft) => {
      const next = { ...get().drafts };
      if (draft) next[scopeKey] = draft;
      else delete next[scopeKey];
      set({ drafts: next });
      draftsStorage.save(next);
    },
    hydrateDrafts: () => set({ drafts: draftsStorage.load() }),
    /**
     * 초안과 **같은 규약**이다(위 `setDraft` 주석): 스토어가 단일 원천이고 영속도 여기서
     * 한다. 빈 배열에서 키를 지우는 것도 같은 이유다 — 남겨 두면 보관소가 다시는 지워지지
     * 않는 빈 항목으로 자란다.
     */
    setStickyMentions: (scopeKey, handles) => {
      const next = { ...get().stickyMentions };
      if (handles.length) next[scopeKey] = handles;
      else delete next[scopeKey];
      set({ stickyMentions: next });
      stickyMentionsStorage.save(next);
    },
    clearStickyMentions: () => { set({ stickyMentions: {} }); stickyMentionsStorage.clear(); },
    hydrateStickyMentions: () => set({ stickyMentions: stickyMentionsStorage.load() }),
    pushHistory: (entry) => {
      const { history, historyIndex } = get();
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(entry);
      if (newHistory.length > MAX_HISTORY_LENGTH) {
        newHistory.shift();
        set({ history: newHistory, historyIndex: newHistory.length - 1 });
      } else {
        set({ history: newHistory, historyIndex: newHistory.length - 1 });
      }
    },
    goBack: () => {
      const { history, historyIndex } = get();
      if (historyIndex <= 0) return null;
      const entry = history[historyIndex - 1];
      return entry ?? null;
    },
    goForward: () => {
      const { history, historyIndex } = get();
      if (historyIndex >= history.length - 1) return null;
      const entry = history[historyIndex + 1];
      return entry ?? null;
    },
    truncateForward: () => {
      const { history, historyIndex } = get();
      set({ history: history.slice(0, historyIndex + 1) });
    },
  }));
}

/** `createAppStore()` 가 만든 스토어 하나. 커뮤니티 엔트리가 이것을 들고 있다. */
export type AppStore = ReturnType<typeof createAppStore>;
