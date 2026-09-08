import type { Message } from './types';

/**
 * **영어가 원본이다.** 다른 언어는 이 파일을 보고 만들어지고, 이 파일의 키 집합이 곧
 * 타입이 된다(`Catalog` = `typeof en`).
 *
 * ## 키 구조 — 세 칸, 그 이상 안 판다
 *
 * ```
 * <영역>.<덩어리>.<이름>
 * ```
 *
 * - **영역**은 `common` 또는 화면/기능 하나(`waitChain`·`settings`·`inbox`·`composer`).
 * - **덩어리**는 그 영역 안의 구획. 없으면 생략해 두 칸이 된다(`common.cancel`).
 * - **이름**은 그 문구가 무엇인지. **영어 원문을 키로 쓰지 않는다** — 원문이 바뀌면
 *   키가 바뀌고, 그러면 다른 언어의 번역이 전부 조용히 떨어져 나간다.
 *
 * ### 다음 PR 이 새 화면을 옮길 때 — 어디에 넣나
 *
 * 판단 순서가 하나뿐이다. **위에서부터 걸리는 첫 칸에 넣는다.**
 *
 * 1. **두 화면 이상이 이미 쓰고 있나** → `common.*`. 예: `Save`·`Cancel`.
 *    "쓸 것 같다"는 안 된다 — **실제로 두 번째 화면이 부를 때** 옮긴다. 미리 올려 두면
 *    `common` 이 아무도 안 읽는 사전이 되고, 그때부터 다들 자기 화면에 다시 적는다.
 * 2. **`lib/` 판정 함수가 내는 말인가** → 그 함수의 영역에 넣고 **키를 함수가 들고
 *    있는다**(아래 `waitChain.*` 이 그 본이다). 화면 이름이 아니라 **판정 이름**을
 *    쓴다 — 같은 판정을 두 화면이 그리면(사슬은 스레드와 인박스 둘이 그린다) 화면
 *    이름을 쓴 순간 둘 중 하나가 남의 키를 부르게 된다.
 * 3. **그 외** → 화면 이름 영역. `settings.agents.*` 처럼 화면 안 구획까지 판다.
 *
 * ### 평면도 아니고 깊지도 않은 이유
 *
 * 평면(`saveButtonLabelInSettings`)은 277개가 들어오면 **알파벳순 목록**이 되어 찾을
 * 수 없다. 네 칸 이상(`settings.agents.detail.daemon.facts.pid.label`)은 옮기는 사람이
 * 매번 "이건 detail 인가 facts 인가"를 새로 판단하게 만들고, 그 판단이 사람마다 갈리면
 * 구조가 있으나 마나다. 세 칸은 **화면을 열고 구획을 짚으면 키가 나온다.**
 *
 * ## 영어를 새로 설계한 자리 — 번역이 아니다
 *
 * 정본 문서 셋이 어휘를 **한국어로** 정했다. 그것을 영어로 옮기는 것은 낱말 대치가
 * 아니라 뜻을 다시 세우는 일이라, 고른 이유를 여기 남긴다.
 *
 * | 한국어 | 영어 | 왜 |
 * |---|---|---|
 * | 기다린다 | `is waiting for` | 진행형이다. `waits` 는 습관을 뜻해서 **지금 멈춰 있다**는 사실이 안 온다 |
 * | 막혔다 / 교착 | `Deadlock` | `Stuck` 도 후보였으나 그것은 `stuck` 상태(실패 포함)의 이름이라 겹친다. 교착은 **서로 기다려 아무 데도 안 닿는 것**이고 그 말이 `deadlock` 이다 |
 * | 사람만이 풀 수 있다 | `only a human can break this` | `resolve` 가 아니라 `break` 다 — 교착은 답해서 풀리는 것이 아니라 **끊어야** 끝난다 |
 * | 응답이 없다 | `is not responding` | `no response` 는 명사구라 누가 안 하는지가 빠진다. 러너가 죽은 것이므로 주어가 있어야 한다 |
 * | 답하면 N개가 풀린다 | `answering unblocks N` | `N will be resolved` 는 수동이라 **내가 하면**이 사라진다. 규칙 05 가 말하는 "사람이 답할 이유"가 그 조건절이다 |
 * | 사람 | `someone` | `a human` 은 종을 가리켜 에이전트와 대비될 때만 맞다. 여기서는 `AskAudience` 의 `'human'` = **아무나 한 사람**이라 `someone` 이 그 뜻이다 |
 * | 기다리는 것 | `Waiting on` | 구획 제목이다. `Wait chain` 은 우리 내부 용어(`waitChain`)라 화면에 내면 사람이 못 읽는다 |
 * | 전체 · 멘션만 · 없음 | `Everything` · `Only mentions` · `Nothing` | **셋이 한 축(양)에 선다.** `All`/`Mentions only`/`None` 은 앞의 둘이 양이고 `None` 만 다른 축(있다/없다)이라, `none` 이 `mentions` 보다 **더 적다**는 사다리가 이름에서 안 읽힌다 — 그런데 그것이 `shared` 가 정한 뜻이다(`none` 은 멘션도 안 준다) |
 * | ~에 실패했다 | `The X was not Yed` | `Failed to ~` 는 **동작이 실패했다**만 말하고 지금 무엇이 참인지를 안 말한다. 이 저장소의 오류는 *"무엇이 잘못됐고 어떻게 고치는가"* 를 적으므로, **결과 상태**로 쓴다: `초대에 실패했다` → `The invite did not go through`(그 사람은 아직 밖에 있다), `나가기에 실패했다` → `You are still in the channel` |
 * | 보관된 채널은 읽기 전용이라 멤버를 바꿀 수 없다 | `An archived channel is read-only, so its members cannot be changed` | 서버 사유(`archived channels are read-only`)를 그대로 안 쓴다 — 그것은 **상태**만 말하고 이 화면에서 그래서 무엇을 못 하는지를 안 말한다 |
 * | 정말 삭제 | `Delete for good` | `Confirm delete` 는 **버튼이 아니라 절차의 이름**이다. 사람이 누르는 것은 "정말 지운다"는 결정이고, `for good` 이 그 되돌릴 수 없음을 진다 |
 * | 목록을 받지 못했다 | `The X list did not arrive` | `Failed to load` 는 앱을 탓하고, `did not arrive` 는 **화면이 지금 무엇을 모르는지**를 말한다 — 그 구별이 이 저장소가 빈 목록과 못 받은 목록을 가르는 이유와 같다 |
 * | 기다리는 것이 없다 | `Nothing is waiting` | `No waits` 는 0을 세는 말투다. 문서가 *"한 줄로 조용히"* 라고 했으므로 문장으로 둔다 |
 * | 아직 다 보지 못했다 | `Not everything has been checked yet` | **"없다"가 아니라 "모른다"** 를 말해야 한다(design.md §4). `Still loading` 은 거짓이다 — 로딩 중이 아니라 안 연 채널이 있는 것이다 |
 * | 서로를 기다린다 | `waiting on each other` | |
 * | 답할 쪽이 멈췄다 | `the answering side has stopped` | |
 * | 뒤처짐 | `Outdated` | (다음 PR) `Behind` 는 무엇에 뒤졌는지가 없다. 앱 버전보다 낮다는 뜻이라 `Outdated` 가 곧다 |
 * | 버전 모름 | `Version unknown` | (다음 PR) *"모르는 것을 뒤처졌다고 하지 않는다"*(`runnerVersions.ts`) — `Unknown` 만 두면 무엇이 모르는지가 빠진다 |
 * | 멈추는 중 | `Stopping` | (다음 PR) 종료 요청은 갔고 아직 안 죽었다. `Stopped` 와 갈려야 한다 |
 *
 * 표의 아래 셋은 **이 PR 이 옮기지 않은 화면**의 어휘다. 다음 PR 이 그 화면을 옮길 때
 * 어휘를 처음부터 다시 정하지 않도록 판단만 남겨 둔다 — 여기 키를 미리 만들어 두지는
 * 않는다(안 쓰는 키는 검사할 방법이 없어 조용히 썩는다).
 *
 * ## 남은 것 — 다음 PR 들이 할 일
 *
 * 뼈대 PR 이 **대기 사슬** 13개를, 이 PR 이 **사이드바** 107개를 옮겼다.
 * 남은 것을 무게순으로 적어 둔다 — 각각이 **한 PR** 이다.
 *
 * | 남은 것 | 규모 | 먼저 풀어야 할 것 |
 * |---|---|---|
 * | `AgentsSettings` · `AgentGrid` | 214 · 99 | 버전 칩 어휘(`뒤처짐`·`버전 모름`·`멈추는 중`)를 위 표에서 가져온다 |
 * | `runnerLauncher.ts` | 118 | **판정 함수다** — `chainSentences` 와 같은 (b) 주입을 쓴다 |
 * | `controller.ts` | 59 | 판정 함수. 위와 같다 |
 * | `MessageItem` | 57 | **손으로 하는 복수형이 여기 있다**(`replyCount === 1 ? 'reply' : 'replies'`) — `waitChain.unblocks` 와 같은 모양으로 사전에 넘긴다. `subjectParticle` 을 아직 쓰는 유일한 자리이기도 하다(그 함수는 그때 지운다) |
 * | `Composer` · `Inbox` | 55 · 49 | |
 * | `daemonFacts.ts` | 38 | 판정 함수. **회귀선이 판정 낱말 7개를 검사한다**(`daemonFacts.test.tsx` 의 제약 2) — 그 축은 문구에 `이상`·`비정상` 이 **없음**을 재므로, 옮긴 뒤에도 문구를 재야 한다(키로는 못 잰다) |
 * | ~~시간 표기~~ | — | **끝났다** — 아래 `time.*` 과 `lib/time.ts` 를 보라 |
 * | 설정 목차 14개 · `Save`·`Cancel`·`Invite` 등 | 소수 | 이미 영어다 — **키만 씌우면 된다.** 둘 이상이 쓰므로 `common.*` 로 간다 |
 * | `RunnerStatus.tsx::runnerStatusLabel` · `lib/presenceView.ts::PRESENCE_LABEL` | 소수 | **사이드바가 이미 부르고 있다**(`sidebar.runner.state` 가 그 값을 감싼다). 둘 다 세 화면 이상이 쓰므로 옮길 때 `common.*` 후보다 |
 *
 * ### `common` 이 아직 비어 있는 이유
 *
 * 사이드바가 `Save`·`Cancel`·`Invite`·`Person`·`Agent` 를 쓰는데 전부 `sidebar.*` 에
 * 있다. **판단 순서 1번이 "실제로 두 번째 화면이 부를 때"** 이기 때문이다 — 지금은 그
 * 화면이 하나다. 설정 화면을 옮기는 PR 이 같은 말을 부르는 순간, 그때 `common.*` 로
 * 올리고 사이드바 키를 지운다. 미리 올려 두면 `common` 이 아무도 안 읽는 사전이 된다.
 *
 * 그래서 `sidebar.channel.cancel`·`sidebar.delete.cancel`·`sidebar.edit.cancel`·
 * `sidebar.section.cancel` 넷이 같은 값을 갖고 있다. **중복이 아니라 아직 안 온 승격이다** —
 * 한 폼의 취소만 문구를 바꾸는 일이 실제로 있고(예: 삭제 확인에서 `Keep the channel`),
 * 그때 한 키를 넷이 나눠 쓰고 있으면 나머지 셋이 함께 바뀐다.
 *
 * ## 시간 표기는 끝났다 — 남은 화면들이 다시 정하지 않는다
 *
 * 이 표가 *"사전에 넣기 전에 `Intl.RelativeTimeFormat` 으로 갈지 **먼저 정해야 한다**"*
 * 고 남겼던 것이 풀렸다. 실측 표와 근거는 `lib/time.ts` 머리말에 있고, 결론만 옮긴다:
 *
 * > **숫자는 `Intl` 이, 뜻은 사전이.**
 *
 * 남은 아홉 화면이 시간을 말할 때 **사전에 새 키를 만들지 않는다.** `agoLabel` ·
 * `durationLabel` · `runningLabel` · `tookLabel` 넷 중 하나를 부르면 그 언어의 말이
 * 나온다. `{n}분 전` 같은 문구를 사전에 새로 적는 PR 이 있다면 그것은 이 결정을 모르고
 * 쓴 것이다.
 *
 * 그리고 **설정 화면에 언어 고르는 자리가 아직 없다.** 값과 배선은 다 있다
 * (`prefs.locale` · `setLocale` · `LOCALE_NAMES`) — `AppearanceSettings` 가 색 모드를
 * 그리는 그 자리에 한 줄 더하면 된다. 이 PR 이 안 한 이유는 그 화면이 아직 한국어라,
 * 언어 고르개만 영어로 서면 그 화면 혼자 두 언어가 되기 때문이다.
 */
export const en = {
  // ---------------------------------------------------------------------------
  // common — **두 화면 이상이 실제로 부르는 것만** 온다. 미리 올려 두지 않는다.
  // ---------------------------------------------------------------------------
  'common.someone': 'someone',

  // ---------------------------------------------------------------------------
  // sidebar — **화면 이름이다.** 이 말들을 내는 판정이 `lib/` 에 없다: 사이드바가
  // 스스로 쓰는 라벨·오류·안내이고, 그리는 화면이 `Sidebar.tsx` 하나다.
  //
  // **덩어리는 사이드바 안의 구획을 그대로 따른다** — 화면을 열고 짚으면 키가 나온다.
  //
  // | 덩어리 | 그 구획 |
  // |---|---|
  // | `brand` | 맨 위 로고 띠 · 연결 점 · 접기 |
  // | `channel` | 채널 행 · 만들기 폼 |
  // | `delete` | 채널 삭제 확인 |
  // | `edit` | 채널 편집 폼 |
  // | `members` | 멤버 패널(자동 멘션 · 팀 추가 포함) |
  // | `menu` | 채널 행 오른쪽 `⋯` 메뉴 |
  // | `notify` | 알림 3단 — 그 메뉴 안이지만 **값 집합이 `shared` 의 것**이라 따로 둔다 |
  // | `resize` | 너비 손잡이 |
  // | `runner` | DM 줄이 러너에 대해 내는 말 |
  // | `section` | 섹션 만들기·이름 바꾸기 |
  //
  // 덩어리 안은 **키 이름 알파벳순**이다. 값의 뜻이 아니라 이름으로 줄을 세운 이유는
  // 리베이스다 — 다른 작업이 같은 파일에 키를 더할 때 충돌이 나도 사람이 두 쪽을 보고
  // 합칠 수 있어야 하고, 그러려면 **넣을 자리가 기계적으로 정해져** 있어야 한다.
  // ---------------------------------------------------------------------------

  'sidebar.brand.collapse': 'Collapse sidebar',
  'sidebar.brand.connected': 'Connected to the server',
  /**
   * 끊겼을 때. **`Disconnected` 한 단어로 끝내지 않는다** — 원래 주석이 적은 대로
   * 이 점의 값은 "그래서 아래 목록을 믿을 수 없다"를 미리 말하는 데 있다. 한국어가
   * 두 마디(`끊김 — 알 수 없다`)로 그렇게 하고 있었고, 영어도 두 마디를 유지한다.
   */
  'sidebar.brand.disconnected':
    'Disconnected — until it reconnects, nothing below can be trusted to be live',
  'sidebar.brand.nav': 'Channels',

  'sidebar.channel.archived': 'Archived ({count})',
  'sidebar.channel.cancel': 'Cancel',
  'sidebar.channel.create': 'Create channel',
  'sidebar.channel.createFailed': 'The channel was not created',
  /**
   * 이름 규칙. **`Invalid name` 이 아니라 무엇이 되는지를 적는다** — 이 저장소의
   * 오류는 *"무엇이 잘못됐고 어떻게 고치는가"* 를 말하고, 이름 규칙은 그 '어떻게'가
   * 규칙 자체다. `-`·`_` 는 글자로 적는다(기호만 늘어놓으면 읽히지 않는다).
   */
  'sidebar.channel.createInvalidName':
    'Names take lowercase letters, digits, hyphens and underscores — 1 to 48 characters',
  'sidebar.channel.createSubmit': 'Create',
  'sidebar.channel.favorites': 'Favorites',
  'sidebar.channel.heading': 'Channels',
  'sidebar.channel.hidden': 'Hidden ({count})',
  'sidebar.channel.private': 'Private channel',
  'sidebar.channel.privateOption': 'Private (members only)',
  'sidebar.channel.unread': '{count} unread in {name}',

  'sidebar.delete.cancel': 'Cancel',
  'sidebar.delete.confirm': 'Delete for good',
  'sidebar.delete.countFailed': 'The message count could not be read',
  /** 못 읽었을 때는 개수를 지어내지 않는다 — 화면이 세는 중임을 말한다. */
  'sidebar.delete.counting': 'Counting messages…',
  'sidebar.delete.failed': 'The channel was not deleted',
  /**
   * 되돌릴 수 없는 조작의 규모. **복수형이 실제로 갈린다** — 한국어는 `{count}개` 로
   * 한 갈래지만 영어는 `1 message` / `2 messages` 다.
   */
  'sidebar.delete.scope': {
    one: 'This deletes the channel and its {count} message for good. It cannot be undone.',
    other: 'This deletes the channel and its {count} messages for good. It cannot be undone.',
  },
  'sidebar.delete.title': 'Delete {name}',

  /**
   * DM 목록의 `+` 라벨. **`New DM` 이 아니다** — 그 목록에는 이제 사람과 에이전트가
   * 함께 서고(레일 2단계), 머리글이 없어 문맥이 목록 자신이다. 붙은 `+` 가 무엇을
   * 새로 만드는지는 그 자리가 말한다.
   */
  'sidebar.dm.new': 'New',

  'sidebar.edit.cancel': 'Cancel',
  'sidebar.edit.failed': 'The channel was not saved',
  'sidebar.edit.repoPlaceholder': 'repo (empty unbinds)',
  'sidebar.edit.save': 'Save',
  'sidebar.edit.title': 'Edit {name}',
  'sidebar.edit.topicPlaceholder': 'topic (optional)',

  'sidebar.members.adminBadge': 'Workspace admin',
  /** 채널 역할이 아니라 계정 속성이다 — 원래 `title` 이 그것을 말하고 있었다. */
  'sidebar.members.adminBadgeTitle': 'Workspace admin — not a channel role',
  /**
   * 꺼진 에이전트 배지. **`Off` 가 아니다** — 이것은 자동 멘션 체크박스의 켬/끔이
   * 아니라 **계정 자체가 꺼진 것**이고, 두 상태가 같은 줄에 나란히 선다. 같은 낱말을
   * 쓰면 체크가 비어 있는 줄에 `Off` 가 또 붙어 무엇이 꺼진 것인지 알 수 없다.
   */
  'sidebar.members.agentDisabled': 'Disabled',
  'sidebar.members.autoMentionBadge': 'Auto',
  'sidebar.members.autoMentionCheckbox': 'Auto-mention @{handle}',
  'sidebar.members.autoMentionEmptyAdmin': 'No agent can be turned on here',
  'sidebar.members.autoMentionEmptyReader': 'No agent is called automatically',
  'sidebar.members.autoMentionFailed': 'The auto-mention was not changed',
  'sidebar.members.autoMentionHeading': 'Auto-mention',
  'sidebar.members.autoMentionListFailed': 'The auto-mention list did not arrive',
  /**
   * 자동 멘션 안내. 긴 문장이지만 **두 사실을 다 지고 있다** — 무엇이 일어나는가,
   * 그리고 한 번만 빼려면 어디를 누르는가. 그 둘 중 하나를 잘라 내면 사람이 칩을
   * 발견하지 못한다.
   */
  'sidebar.members.autoMentionNote':
    'Agents turned on here are called at the front of every message a person writes in this channel. '
    + 'Use the × on the chip in the composer to leave one out of a single message.',
  'sidebar.members.autoMentionNoteReadOnly': ' Only an admin can change this.',
  'sidebar.members.close': 'Close',
  'sidebar.members.empty': 'No members',
  'sidebar.members.invite': 'Invite',
  'sidebar.members.inviteFailed': 'The invite did not go through',
  'sidebar.members.invitePick': 'Pick an account…',
  'sidebar.members.inviteSelect': 'Account to invite',
  'sidebar.members.kindAgent': 'Agent',
  'sidebar.members.kindHuman': 'Person',
  /**
   * 마지막 멤버가 나갈 때. **두 사실을 붙여 둔다** — 아무도 못 보게 된다는 것과,
   * 그래도 채널은 남는다는 것. 뒤엣것이 없으면 사람은 이것을 삭제로 읽는다.
   */
  'sidebar.members.lastMemberWarning':
    'Leaving means nobody can see this channel — you are the last member. The channel itself stays.',
  'sidebar.members.leave': 'Leave',
  'sidebar.members.leaveConfirm': 'Leave for good',
  'sidebar.members.leaveFailed': 'You are still in the channel',
  'sidebar.members.listFailed': 'The member list did not arrive',
  'sidebar.members.loading': 'Loading…',
  'sidebar.members.notAMember': 'You are not a member of this channel',
  /**
   * 보관된 채널의 멤버 조작. **`read-only` 를 그대로 옮기지 않는다** — 서버의 사유는
   * 상태를 말하고, 화면은 **그래서 무엇을 할 수 없는지**를 말해야 한다(원래 한국어가
   * 그렇게 적혀 있었다: *"보관된 채널은 읽기 전용이라 멤버를 바꿀 수 없다"*).
   */
  'sidebar.members.readOnlyArchived':
    'An archived channel is read-only, so its members cannot be changed',
  'sidebar.members.remove': 'Remove',
  'sidebar.members.removeAction': 'Remove {handle}',
  'sidebar.members.removeFailed': 'The member is still in the channel',
  /** public 과 private 에서 이 목록의 **뜻이 다르다** — 두 문장이 따로 있는 이유다. */
  'sidebar.members.scopePrivate': 'This list is everyone who can see this channel.',
  'sidebar.members.scopePublic':
    'Anyone can read and write here — this list is who subscribed, not who can see it.',
  'sidebar.members.teamAdd': 'Add',
  'sidebar.members.teamAddFailed': 'The team was not added',
  'sidebar.members.teamAdded': 'Added: {names}',
  'sidebar.members.teamAlready': 'Already here: {names}',
  'sidebar.members.teamHeading': 'Add a team',
  'sidebar.members.teamListFailed': 'The team list did not arrive',
  'sidebar.members.teamPick': 'Pick a team…',
  'sidebar.members.teamSelect': 'Team to add',
  'sidebar.members.teamSkipped': 'Skipped: {names}',
  'sidebar.members.title': 'Members of {name}',

  'sidebar.menu.archive': 'Archive',
  'sidebar.menu.copyId': 'Copy channel ID',
  'sidebar.menu.copyName': 'Copy channel name',
  'sidebar.menu.delete': 'Delete',
  'sidebar.menu.edit': 'Edit channel',
  'sidebar.menu.hide': 'Hide',
  'sidebar.menu.invite': 'Invite',
  'sidebar.menu.leave': 'Leave',
  'sidebar.menu.markUnread': 'Mark as unread',
  'sidebar.menu.members': 'View members',
  'sidebar.menu.moveDown': 'Move down',
  'sidebar.menu.moveUp': 'Move up',
  /** `{name}` 은 사람이 지은 섹션 이름이다 — 번역하지 않는다. */
  'sidebar.menu.section': 'Section: {name}',
  'sidebar.menu.sectionClear': 'Remove from section',
  'sidebar.menu.sectionNew': 'New section…',
  'sidebar.menu.star': 'Add to favorites',
  'sidebar.menu.unarchive': 'Unarchive',
  'sidebar.menu.unhide': 'Unhide',
  'sidebar.menu.unstar': 'Remove from favorites',

  // ---------------------------------------------------------------------------
  // notify — 알림 3단. **한 축(양)으로 줄을 세운다.**
  //
  // 값 집합은 `shared` 의 `NOTIFY_LEVELS` 이고 그 주석이 뜻을 정했다:
  // `all` 은 전부, `mentions` 는 나를 부른 것만, `none` 은 **멘션도 아니다**.
  //
  // 그래서 셋의 관계가 보여야 한다 — `All`/`Mentions only`/`None` 은 앞의 둘이 양이고
  // `None` 만 다른 축(있다/없다)이라, `none` 이 `mentions` 보다 **더 적다**는 것이
  // 이름에서 안 읽힌다. `Everything`/`Only mentions`/`Nothing` 은 셋이 같은 축에 서서
  // 사다리가 그대로 보인다: 전부 → 부른 것만 → 아무것도.
  //
  // `Mute` 를 쓰지 않는 것은 이 저장소가 이미 정한 것이다(#224 가 음소거 토글을 이
  // 3단으로 바꿨다) — 음소거는 켬/끔이라 가운데 칸을 말할 수 없다.
  // ---------------------------------------------------------------------------

  'sidebar.notify.all': 'Everything',
  /** `{level}` 에 아래 셋 중 하나가 들어간다. `{check}` 는 지금 고른 것 앞의 `✓ `. */
  'sidebar.notify.item': '{check}Notify: {level}',
  'sidebar.notify.mentions': 'Only mentions',
  'sidebar.notify.none': 'Nothing',

  'sidebar.resize.handle': 'Resize sidebar',

  /**
   * 러너가 안 뜬 이유. **`Launch failed` 가 아니라 무엇이 안 됐는지를 앞에 둔다** —
   * 뒤에 사유(`{reason}`)가 붙으므로 앞머리는 그 사유가 무엇에 대한 것인지만 말한다.
   * 하네스·로그인 사유는 이 앞머리를 안 받는다(그것들은 실패가 아니라 준비 부족이고,
   * 화면이 이미 주의색으로 가른다) — 그 분기는 화면이 진다.
   */
  'sidebar.runner.launchFailed': 'Did not start — {reason}',
  /** 아바타 한 칸이 실은 상태를 글자로도 낸다(`#443`). */
  'sidebar.runner.state': 'Runner: {label}',

  'sidebar.section.cancel': 'Cancel',
  'sidebar.section.movePlaceholder': 'Section name',
  'sidebar.section.moveSubmit': 'Move',
  'sidebar.section.name': 'New section name',
  'sidebar.section.rename': 'Rename',
  'sidebar.section.renameName': 'New name for the section',
  'sidebar.section.renamePlaceholder': 'New name',
  'sidebar.section.renameSubmit': 'Rename',
  // time — **`Intl` 이 못 내는 것만 온다.**
  //
  // 시간 표기의 경계는 `lib/time.ts` 머리말이 실측 표로 정했다: **숫자는 `Intl` 이,
  // 뜻은 사전이.** 그래서 여기에는 `11분 전`·`4분 12초` 같은 수량이 **없다** — 그것은
  // `Intl` 이 어느 언어로든 낸다. 여기 남는 넷은 수량이 아니라 우리가 정한 뜻이다:
  //
  // - `justNow`  — "숫자를 말하지 않기로 한" 결정. `Intl` 의 `now`/`지금` 은 우리가
  //                고른 말이 아니다
  // - `none`     — 잴 값 자체가 없다(`lastTurnAt === null`). 시간이 아니다
  // - `running`  — **상**[aspect]이다. `3분` 과 `3분째` 는 다른 사실이고 `Intl` 은
  //                후자를 못 낸다
  // - `took`     — `running` 의 짝. 둘을 사전 항목으로 갈라야 각 언어가 제 방식으로
  //                가른다(이전 코드는 한국어 어미를 `replace(/째$/, '')` 로 잘랐다 —
  //                그 정규식은 영어에서 아무것도 안 자른다)
  //
  // `{duration}` 에 들어오는 것은 `Intl` 이 이미 그 언어로 만든 글자다(`4h 12m`·`4시간 12분`).
  // 어느 `Intl` 로 조립하는지는 `lib/time.ts` 가 진다 — 사전은 그 결과만 받는다.
  // ---------------------------------------------------------------------------

  /** 1분 미만. `0 minutes ago` 는 사람이 쓰지 않는 말이다. */
  'time.justNow': 'just now',
  /** 한 번도 없었다 — **'죽었다'가 아니다**(`lastTurn.ts`). 그래서 `never` 가 아니라 `none`. */
  'time.none': 'none',
  /**
   * 아직 도는 중. 영어는 어미가 없으므로 **말을 앞에 세운다** — 이것이 상을 사전에
   * 둬야 하는 이유 그대로다. 한국어는 `{duration}째` 로 어미를 붙인다.
   */
  'time.running': 'running {duration}',
  /** 끝난 것의 길이. 과거형이 그 사실을 말한다. */
  'time.took': 'took {duration}',

  // ---------------------------------------------------------------------------
  // waitChain — **판정 이름이지 화면 이름이 아니다.**
  //
  // 이 말들은 `lib/waitChain.ts` 의 판정에서 나오고, 그리는 화면은 둘이다
  // (스레드 패널의 `WaitChainLine`, 인박스의 `WaitChainSection`). 화면 이름으로
  // 영역을 잡았으면 둘 중 하나가 남의 키를 부르게 된다.
  // ---------------------------------------------------------------------------

  /**
   * 사슬 한 마디. **`{waiter}` 와 `{blockedBy}` 의 순서가 언어마다 다르다** — 이것이
   * 문장을 조각으로 쪼개면 안 되는 이유다. 한국어는 `A가 B의 답을 기다린다`(목적어가
   * 동사 앞), 영어는 `A is waiting for B`(동사 뒤). 조각(`'가'` + 이름 + `'의 답을'`)
   * 으로 두면 영어에서 그 조각들이 갈 자리가 없다.
   */
  'waitChain.link': '{waiter} is waiting for {blockedBy}',
  /**
   * 사람 아무나를 기다리는 마디. 한국어 쪽 주석이 적어 둔 사정이 그대로다 —
   * 이름 자리에 보통명사를 끼우면 조사가 어긋나므로 **문장을 따로 둔다.**
   * 영어는 조사가 없어 이 분리가 필요 없지만, **원본이 분리를 없애면 한국어가
   * 그것을 되살릴 방법이 없다.** 그래서 원본이 갈라 둔다.
   */
  'waitChain.linkAnyone': '{waiter} is waiting for someone to answer',

  'waitChain.deadlock': 'Deadlock',
  'waitChain.deadlockCycle': '{names} are waiting on each other — only a human can break this',
  'waitChain.deadlockDeadRunner': '{waiter} is waiting for {blockedBy}, which is not responding',

  /**
   * **복수형이 실제로 갈리는 자리.** `unblocks 1` 은 화면에 안 나오지만(하나뿐이면
   * 말하지 않는다 — 잡음이다) `one` 갈래를 비워 두지 않는다: 그 판단은 화면의 것이지
   * 이 사전의 것이 아니고, 다음에 누가 하나짜리도 그리기로 하면 사전이 준비돼 있어야 한다.
   */
  'waitChain.unblocks': {
    one: 'answering unblocks {count} thread',
    other: 'answering unblocks {count} threads',
  },

  'waitChain.sectionTitle': 'Waiting on',
  'waitChain.sectionTitleCount': 'Waiting on ({count})',
  'waitChain.empty': 'Nothing is waiting',
  /** **"없다"가 아니라 "모른다"** 다(design.md §4). */
  'waitChain.unseen': 'Not everything has been checked yet',
  'waitChain.dm': 'DM',
  'waitChain.reasonCycle': 'waiting on each other',
  'waitChain.reasonDeadRunner': 'the answering side has stopped',

  // ---------------------------------------------------------------------------
  // message — 메시지 행(`components/MessageItem.tsx`)이 그리는 말.
  //
  // **이 영역은 #624 가 새로 만든 세 마디로 시작한다.** 그 행의 나머지 문구는 아직
  // 사전 밖에 있다(하드코딩) — 새로 생기는 말만 사전을 지나게 해서, 옮기지 않은 화면이
  // 사전을 **뒤로** 늘리는 일이 없게 한다.
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 채널에도 전송됨 | `Also sent to the channel` | 상태(과거)다. `Send to channel` 은 동작이라 누를 것처럼 보인다 — 이것은 배지이지 버튼이 아니다 |
  // | 스레드에 댓글 남김 | `Replied in a thread` | `In thread` 는 자리만 말하고 **무슨 일이 있었나**가 빠진다. 이 사본은 답글이므로 동작이 주어다 |
  // | 최근 댓글 보기 | `View recent replies` | `View in thread`(옛 문구)는 목적지를 말했다. 새 목적지는 스레드 머리가 아니라 **이 말 뒤의 댓글**이라 그것을 말한다 |
  // ---------------------------------------------------------------------------

  'message.channelEcho': 'Also sent to the channel',
  /**
   * 출처 줄의 라벨. **뿌리 본문은 이 문장에 끼우지 않는다** — 화면에서 그 조각만
   * 잘라 접어야 하고(`truncate`), 문장 안에 넣으면 접을 대상을 가리킬 수 없다.
   * 라벨과 본문 사이의 콜론은 화면이 붙인다: 언어마다 갈릴 만한 어순이 여기엔 없다.
   */
  'message.threadOrigin': 'Replied in a thread',
  'message.recentReplies': 'View recent replies',
} satisfies Record<string, Message>;

/**
 * **키 집합의 정본.**
 *
 * `typeof en` 을 그대로 쓰지 않는다. `as const` 로 굳히면 각 값의 타입이 **영어 문장
 * 그 자체**(`'Deadlock'`)가 되어, 어떤 번역도 그 타입을 만족할 수 없다 — 한국어 사전
 * 전체가 컴파일 오류가 된다(실측으로 잡았다, 2026-09-08). 계약은 **키와 모양**이지
 * 값이 아니다.
 *
 * 그래서 키는 `typeof en` 에서 뽑고 값은 `Message` 로 넓힌다. 이러면 다른 언어가
 * 키를 빠뜨렸을 때 여전히 컴파일이 막히고(`satisfies Catalog`), 값은 자유롭다.
 *
 * **복수형 여부까지는 안 잡는다** — 원본이 복수형인 키를 번역이 평문으로 두어도 타입은
 * 조용하다. `Message` 가 그 둘의 합이기 때문이다. 그 자리는 회귀선이 갚는다
 * (`i18n.test.tsx` 의 자리표시자·복수형 축).
 */
export type Catalog = Record<keyof typeof en, Message>;
export type MessageKey = keyof typeof en;
