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
 * 뼈대 PR 이 **대기 사슬** 13개를, 그 다음이 **사이드바** 107개를, 그 다음이
 * **에이전트 설정**(`AgentsSettings`) 146개를, 그 다음이 **러너 판정 둘**
 * (`runnerLauncher.ts` 35 · `daemonFacts.ts` 18)을, 그다음이 **대화 화면 묶음**
 * (여덟 가지 말 · 메시지 행 · `threadState` · `inboxRow`)을, 이 PR 이 **러너·투영 화면**
 * (`TerminalPanel` 23 · `ProjectionUrl` 16 · `projectionBanner.ts` 11 ·
 * `RunnerStatus` 10 · 나머지 넷 11)을 옮겼다.

 * 남은 것을 무게순으로 적어 둔다 — 각각이 **한 PR** 이다.
 *
 * **집계를 따옴표로만 세지 마라.** 이 PR 이 받은 예상치는 56 이었고 실제는 71 이었다
 * (1.27배) — 맨몸 JSX 텍스트 노드와 템플릿 리터럴 조각이 안 세어진다. `AgentGrid` 는
 * 아래 표가 99 라고 적어 뒀는데 **이미 0 이었다**(그 사이 다른 PR 이 옮겼다). 옮기기 전에
 * 파서로 한 번 세는 것이 그 두 오차를 다 없앤다.
 *
 * | 남은 것 | 규모 | 먼저 풀어야 할 것 |
 * |---|---|---|
 * | ~~`AgentGrid`~~ | — | **끝났다**(아래 `grid.*`). 그 영역 머리말이 이 표의 *"`agents.*` 에 붙는다"* 를 실측으로 뒤집은 근거를 적어 뒀다 — 두 화면이 공유하는 컴포넌트라 화면 이름으로 영역을 잡으면 사이드바가 남의 키를 부른다 |
 * | `TeamDetail` · `TeamGrid` · `TeamMemberPicker` | 8 · 4 · 5 | **`agents.teams.*` 가 이미 서 있다.** 팀 묶음의 격자 머리와 만들기 폼은 이 PR 이 옮겼고, 상세는 그 파일들에 남아 있다 |
 * | `Profile` | 소수 | `lastTurnLabel` 이 **이미 번역기를 받는다**(이 PR 이 그렇게 바꿨다) — 그 화면이 `useT` 를 이미 들고 있으므로 나머지는 키만 씌우면 된다 |
 * | ~~`runnerLauncher.ts`~~ | — | **끝났다**(아래 `runner.*`). 남은 일곱은 `throw new Error(...)` 라 **사람에게 가는 말이 아니다** — 그 영역 머리말이 안 넣은 이유를 적었다 |
 * | `controller.ts` | 59 | 판정 함수. **번역기를 넘기는 배선은 이 PR 이 이미 깔았다**(`RunnerLauncher` 생성자의 마지막 인자) — 그 자리를 그대로 쓰면 된다 |
 * | `packages/shared::installHint` · `PROJECTION_UNCONFIGURED_*` | 3 · 2 | **이 저장소의 다른 패키지다.** 서버·러너가 함께 쓰는 패키지라 데스크탑 사전이 닿을 수 없다 — `runner.exit.notFound` 뒤에 붙는 설치 안내 한 줄과, 투영이 꺼졌을 때의 머리·본문 둘이 그것이다(`projection` 머리말이 그래서 그 키를 안 만든 이유를 적었다). **이제 자리가 둘이니 한 PR 로 함께 푼다.** 먼저 정할 것: `Translate` 를 `shared` 로 내릴지, 아니면 그 상수들이 **키만 내고** 데스크탑이 문구를 씌울지 — 뒤엣것이면 `shared` 를 쓰는 서버·러너 쪽에는 사전이 없다는 것을 함께 풀어야 한다 |
 * | ~~`MessageItem`~~ | — | **끝났다**(아래 `message.*`·`speech.*`). 그 표가 지목한 손수 복수형(`replyCount === 1 ? 'reply' : 'replies'`)은 `message.summary.replies` 로 갔고, **`subjectParticle` 과 `lib/particle.ts` 는 지웠다** — 그 함수의 마지막 호출처가 이 행의 말 슬롯이었고, 조사는 이제 번역기 안에 있다 |
 * | ~~여덟 가지 말~~ | — | **끝났다**(아래 `speech.*`). `AskCard`·`FailureCard`·`ReportCard`·`ProgressRow`·`AgentExchange` 다섯이 이루는 어휘 하나이고, 그리는 화면이 넷이라 판정도 화면도 아닌 **어휘 이름**으로 영역을 잡았다 |
 * | ~~`threadState.ts`~~ | — | **끝났다**(아래 `thread.*`). `THREAD_STATE_LABEL` 이 **모듈 상수라 로드 시점 언어로 굳어 있었다** — `SkillsSettings`·`STRANGER_ATTACHED` 와 같은 모양이고 같은 방식으로 함수로 내렸다 |
 * | ~~`inboxRow.ts`~~ | — | **끝났다**(아래 `inbox.*`). 번역기를 **필수 인자로 맨 뒤에** 받는다 |
 * | `Composer` | 55 | |
 * | `Inbox` | 49 | **말표는 이미 옮겼다**(`inbox.label.*`) — 그 화면이 `useT` 를 이미 들고 있으므로 나머지는 키만 씌우면 된다 |
 * | ~~`daemonFacts.ts`~~ | — | **끝났다**(아래 `daemonFacts.*`). 그 표가 경고한 대로 회귀선을 **키가 아니라 문구로** 남겼다 — `i18n.test.tsx` 가 제약 1(주어)·제약 2(판정 낱말 없음)를 **두 언어로** 다시 잰다 |
 * | ~~시간 표기~~ | — | **끝났다** — 아래 `time.*` 과 `lib/time.ts` 를 보라 |
 * | 설정 목차 14개 · `Save`·`Cancel`·`Invite` 등 | 소수 | 이미 영어다 — **키만 씌우면 된다.** 둘 이상이 쓰므로 `common.*` 로 간다 |
 * | ~~`ChannelPane`·`ChannelDocPanel`·`ChannelFiles`·`ChannelEmptyState`~~ | — | **끝났다**(아래 `channel.*`). 곁창 둘을 따로 안 연 근거가 그 머리말에 있다 |
 * | ~~`SearchPalette` · `ChannelDirectory` · `Directory` · `SavedMessages`~~ | — | **끝났다**(아래 `search`·`channelDirectory`·`directory`·`saved`). 넷 다 겹창이지만 **묻는 것이 달라** 영역이 넷이다 |
 * | ~~`SidebarFind` · `Rail` · `CommunityRail`~~ | — | **끝났다.** 찾기 줄은 `Sidebar` 가 그리므로 `sidebar.find.*` 로 갔고(새 영역을 안 열었다), 레일 둘은 사이드바 **밖**이라 `rail.*` 을 함께 쓴다 |
 * | ~~`StatusPicker` · `Identity` · `Workspace` · `BootNotice` · `InviteSettings`~~ | — | **끝났다**(아래 `status`·`identity`·`workspace`·`boot`·`invite`). 앞 둘이 한 벌의 어휘라 `status` 가 화면 이름을 안 쓴다 |
 * | 나머지 설정 화면들(`Gallery`·`Skills`·`HandleGroups`·`AgentDefaults` 등) | 42 · 19 · 16 · 11 | 각각 자기 영역(`gallery`·`skills`·…)을 연다. 영역 이름을 `settings.*` 로 묶지 않는 근거는 아래 `agents` 머리말에 있다 |
 * | ~~`RunnerStatus.tsx::runnerStatusLabel` · `lib/presenceView.ts::PRESENCE_LABEL`~~ | — | **끝났다**(아래 `runnerState.*` · `presence.*`). 둘이 **다르게** 풀렸다: 앞은 함수로 내리고 뒤는 표를 남긴 채 값만 키로 바꿨다 — 갈리는 근거(자리표시자와 갈래의 유무)는 `runnerState` 머리말에 있다. `common.*` 후보라던 이 표의 예상은 **틀렸다**: 셋 이상이 쓰는 것은 맞지만 그것들은 `lib/` 판정이 내는 말이라 판단 순서 2번(판정 이름)에 먼저 걸린다 |
 * | `ThreadPanel` · `WakeRow` · `Reactions` 등 대화 화면의 나머지 | 소수 | 이 PR 이 옮긴 것은 **말과 행**이지 그 화면들의 껍데기가 아니다. `thread.*` 가 이미 서 있으므로 스레드 패널의 머리띠는 그 영역에 붙는다 |
 * | `RunnerStatus.tsx::runnerStatusLabel` · `lib/presenceView.ts::PRESENCE_LABEL` | 소수 | **사이드바가 이미 부르고 있다**(`sidebar.runner.state` 가 그 값을 감싼다). 둘 다 세 화면 이상이 쓰므로 옮길 때 `common.*` 후보다. `Directory` 도 `PRESENCE_LABEL` 을 부르므로 이제 **세 번째 화면이 왔다** |
 *
 * ### 굳은 모듈 상수 — 화면을 옮길 때마다 나온다
 *
 * `SkillsSettings` 에서 처음 잡힌 결함 형태(`const X: Record<K, string> = { a: '한국어' }`
 * 가 모듈 로드 시점 언어로 굳는다)가 **이 PR 에서 넷 더 나왔다**: `SidebarFind::
 * KIND_LABEL` · `StatusPicker::LABELS` · `Identity::STATUS_MARKS` · `BootNotice::
 * KEYCHAIN_WAIT_*`. 앞 셋은 **표를 남기고 값만 사전 키로** 바꿨고(`NotifiedGapRow::LABEL`
 * 의 선례 — 키는 언어를 안 지니므로 상수여도 안전하고, `Record<K, …>` 가 지키던
 * *"종류를 추가하면 컴파일이 막힌다"* 가 그대로 산다), 넷째는 **함수로 내렸다**
 * (`threadState::THREAD_STATE_LABEL` 의 선례 — 회귀선이 `export` 를 import 해서 쓰므로
 * 지울 수 없었다).
 *
 * **다음 화면을 옮기는 사람에게**: 파일을 열자마자 `const .*Record<.*string> = {` 를
 * 먼저 찾아라. 사전 대조 회귀선은 이것을 **절대 못 잡는다** — 사전은 갈려 있고 화면만
 * 안 따라오기 때문이다. 잡는 방법은 하나뿐이다: 화면을 렌더하고 언어를 바꿔 보는 것
 * (`i18n.test.tsx` 8·9번 묶음).
 *
 * ### `common` 이 아직 비어 있는 이유 — **두 번째 화면이 왔는데도**
 *
 * 에이전트 설정이 `Cancel` 을 넷(`agents.disable.cancel`·`agents.pat.revokeCancel`·
 * `agents.profile.avatarRemoveCancel`·`agents.teams.cancel`), `Save` 를 하나
 * (`agents.detail.save`) 쓴다. 판단 순서 1번(*"실제로 두 번째 화면이 부를 때"*)만 보면
 * 지금이 승격할 때다. **그런데 승격하지 않았다.**
 *
 * 이유는 바로 아래 문단이 이미 적어 둔 것이다 — 그 규칙과 이 규칙은 같은 문장의 앞뒤다.
 * `Cancel` 이 여러 자리에 있는 것은 **같은 말을 여러 화면이 쓰는 것**이 아니라 *"각
 * 폼의 취소가 저마다 다른 것을 되돌린다"* 이고, 실제로 이 PR 에서 그 갈림이 났다:
 * 기억 지우기의 반대짝은 `Cancel` 이 아니라 `Keep it` 이다(무엇이 남는지를 말해야 한다).
 * 사진 지우기 취소·PAT 폐기 취소·팀 만들기 취소도 각각 다른 것을 되돌린다.
 *
 * 한 키로 묶는 순간 그중 하나를 `Keep the photo` 로 바꾸는 일이 나머지 셋을 함께
 * 바꾼다. **`common` 에 올릴 자격은 "글자가 같다"가 아니라 "뜻이 하나다"** 이고,
 * `Cancel` 은 뒤엣것이 아니다.
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
 * **다음 PR 이 다시 잴 자리**를 적어 둔다: `Loading…` 이 지금 둘이고
 * (`sidebar.members.loading`·`agents.memory.loading`) 뜻도 하나다 — *"아직 못 읽었다"*.
 * 세 번째가 오면 그것이 `common` 의 첫 손님이다. 다만 `agents.run.defaultsLoading`
 * (`Loading the defaults…`)·`agents.pat.loading`(`Reading PATs…`)은 **그 후보가 아니다**:
 * 같은 화면에 여럿이 함께 뜰 수 있어 무엇을 읽는 중인지가 문구에 있어야 한다.
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
  /**
   * **이름을 모를 때 그 자리에 서는 보통명사.** 셋이 부른다(`WaitChain`·
   * `WaitChainSection`·`AskCard`) — 이 PR 이 세 번째를 붙였고, 그것이 `common` 승격
   * 자격을 실제로 만족하는 첫 사례다: 셋 다 **같은 하나의 뜻**을 쓴다(*"사람인데 누구인지
   * 모른다"*). 아직 안 승격한 `Cancel` 과 갈리는 지점이 그것이다 — 그쪽은 글자만 같고
   * 뜻이 자리마다 다르다(위 머리말의 *"`common` 이 아직 비어 있는 이유"*).
   *
   * **`AskCard` 에서는 이름 자리에 들어간다** — 한국어에서는 뒤에 조사가 붙으므로
   * (`{name:이가} 골랐다`) 보통명사여도 문장이 서야 하고, 그것이 이 낱말을 문장 조각이
   * 아니라 **한 낱말**로 두는 이유다.
   */
  'common.someone': 'someone',

  // ---------------------------------------------------------------------------
  // appearance — 화면 이름. `settings/AppearanceSettings.tsx`.
  //
  // 이 화면은 **원래 영어였다**(색 모드 셋). 여기 오는 것은 언어 고르개뿐이고, 그것이
  // 마지막으로 남아 있던 자리다 — 사전과 배선은 진작 있었는데 **고를 자리가 없어서**
  // 사람이 언어를 바꿀 방법이 없었다.
  //
  // 언어 이름 자체(`English` · `한국어`)는 사전에 없다. `LOCALE_NAMES` 가 **각 언어를
  // 그 언어로** 적고 있고, 그것이 옳다 — 영어를 못 읽는 사람이 자기 언어를 찾을 수
  // 있어야 한다. 사전에 넣으면 지금 언어로 번역되어 `Korean` 이 되고, 그러면 한국어를
  // 찾는 사람이 영어 화면에서 자기 언어를 못 찾는다.
  // ---------------------------------------------------------------------------

  'appearance.colorMode': 'Color mode',
  'appearance.description': 'Follow your system or choose a light or dark appearance',
  'appearance.language': 'Language',
  /** `{name}` 은 `LOCALE_NAMES` 의 값이다 — 그 언어로 적힌 이름이라 번역하지 않는다. */
  'appearance.languageOption': 'Use {name}',
  /**
   * 기본값. **`Auto` 가 아니라 `System`** — 색 모드가 같은 자리에서 이미 `System` 을
   * 쓰고 있고, 두 줄이 같은 뜻에 다른 낱말을 쓰면 사람이 그 차이를 찾는다.
   */
  'appearance.languageSystem': 'System',
  'appearance.mode': '{mode} appearance',
  'appearance.title': 'Appearance',

  // ---------------------------------------------------------------------------
  // avatar — **판정 이름이다.** `lib/avatar.ts::avatarErrorMessage` 가 내는 말이고,
  // 그것을 그리는 화면이 둘이다(내 프로필 · 에이전트 프로필). `waitChain` 이 화면 이름을
  // 금지한 조건 그대로다.
  //
  // ## 왜 원인별로 문장이 다른가
  //
  // 앞 판은 무엇이 실패했든 *"이미지 파일만 쓸 수 있습니다"* 하나였다. 서버가 죽었거나
  // 네트워크가 끊겼을 때도 사람에게는 **자기 파일 탓**으로 보이고, 파일을 바꿔 가며 몇
  // 번을 다시 시도하게 만든다. 그래서 각 문장이 **그 사람이 다음에 할 일**을 정한다:
  // 형식을 바꿀지 · 더 작은 그림을 고를지 · 그냥 다시 눌러 볼지.
  //
  // `svg_too_large` 가 따로 있는 이유도 그것이다 — SVG 는 검사에 파일 전체를 읽어야 해서
  // 상한이 다른 형식보다 훨씬 낮다. 뭉개면 SVG 를 든 사람이 *"SVG 만 쓸 수 있습니다"* 를
  // 듣는다.
  //
  // `{formats}`(`PNG · JPEG · …`)와 `{code}` 는 **번역하지 않는다** — 형식 이름과 서버가
  // 낸 코드이고, 코드는 사람이 그대로 옮겨 적어 물어보는 값이다.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // attachment — 첨부를 여는 데 실패했을 때. `state/controller.ts` 가 알림 줄로 낸다.
  //
  // **둘로 갈린 이유**: 서버가 *"그 파일이 없다"* 고 말한 것과, 우리가 아예 못 읽은 것은
  // 사람이 할 일이 다르다 — 앞은 다시 눌러도 소용없고 뒤는 잠시 뒤 되는 수가 있다.
  // ---------------------------------------------------------------------------

  'attachment.fetchFailed': 'The attachment could not be loaded',
  'attachment.missing': 'The attachment is not on the server',

  'avatar.error.notAnImage': '{formats} files only. We judge by content, not by the file name.',
  'avatar.error.notFound': 'The uploaded file was not found. Try again.',
  /** 서버가 코드까지 준 경우. 알 수 없는 코드가 와도 **그 코드를 그대로 보여 준다.** */
  'avatar.error.other': 'The photo was not changed ({code}).',
  /** 서버에 닿지도 못했다 — 파일 문제가 아니라는 것을 말해야 파일을 또 바꾸지 않는다. */
  'avatar.error.unreachable': 'The photo was not changed. The server may be unreachable.',
  'avatar.error.svgTooLarge':
    'SVG is capped at 256 KiB. Use a simpler drawing, or a PNG.',
  'avatar.error.tooLarge': 'The file is too large. Pick a smaller image.',

  // ---------------------------------------------------------------------------
  // avatarEdit — 화면 이름. `settings/avatarEdit.tsx` 의 진행·결과 줄.
  //
  // 진행 문구가 셋인 것은 **단계가 셋이기 때문이다**(올리는 중 · 프로필에 적용 중 ·
  // 지우는 중). 하나로 뭉치면 오래 걸리는 자리에서 사람이 무엇을 기다리는지 모른다.
  // ---------------------------------------------------------------------------

  'avatarEdit.progress.applying': 'Applying to your profile…',
  'avatarEdit.progress.aria': 'Photo upload progress',
  'avatarEdit.progress.removing': 'Removing the photo…',
  'avatarEdit.progress.uploading': 'Uploading the photo…',
  /** 퍼센트가 있을 때. 없을 때(`uploading`)와 갈라 두어야 `…0%` 가 안 뜬다. */
  'avatarEdit.progress.uploadingPct': 'Uploading the photo… {pct}%',
  'avatarEdit.result.changed': 'The photo was changed',
  'avatarEdit.result.removed': 'The photo was removed',
  // sweep — 화면 이름. `components/Sweep.tsx` 의 미읽음 훑기.
  //
  // 두 버튼이 **다른 일**을 한다: `readAndNext` 는 읽음으로 표시하고 넘어가고,
  // `justNext` 는 표시하지 않고 넘어간다. 한 낱말로 뭉치면 훑기의 요점이 사라진다 —
  // 이 화면은 *"읽었다고 칠 것"* 과 *"나중에 볼 것"* 을 가르려고 있다.
  // ---------------------------------------------------------------------------

  'sweep.close': 'Close',
  'sweep.done': 'All caught up',
  'sweep.failed': 'It was not marked as read',
  'sweep.justNext': 'Skip',
  'sweep.loading': 'Loading…',
  'sweep.readAndNext': 'Mark read and go on',
  'sweep.retry': 'Try again',
  'sweep.title': 'Sweep unread',
  /** 서버가 사유를 안 줬을 때. **`{reason}` 자리를 비우지 않는다** — 빈 괄호가 남는다. */
  'sweep.unknownError': 'Unknown error',

  // ---------------------------------------------------------------------------
  // accountOpen — **판정 이름이다.** `lib/accountOpen.ts` 가 내는 접근 이름이고,
  // 이름을 누를 수 있는 자리마다 쓰인다(본문 멘션 · 참여자 줄 · 아바타).
  //
  // 이 둘은 **가는 곳이 다르다** — 설정과 프로필. 스크린리더는 그 차이를 이름으로만
  // 알 수 있으므로 한 낱말로 못 묶는다.
  // ---------------------------------------------------------------------------

  'accountOpen.agentConfig': "Open {handle}'s agent settings",
  'accountOpen.profile': "Open {handle}'s profile",

  // ---------------------------------------------------------------------------
  // mention — 멘션 토큰(`<@id>`)을 이름으로 되돌릴 때 **그 계정을 못 찾은 자리**.
  //
  // 지우지 않고 말한다: 지우면 문장에 구멍이 나고, id 를 그대로 두면 사람이 못 읽는다.
  // ---------------------------------------------------------------------------

  'mention.unknownAccount': 'unknown',

  // ---------------------------------------------------------------------------
  // thread — 스레드 패널. `thread.*` 영역이 이미 있고(상태 다섯), 여기 둘을 더한다.
  // ---------------------------------------------------------------------------

  'thread.alsoPostToChannel': 'Also post to the channel',
  'thread.resizeHandle': 'Resize the thread panel',
  'thread.title': 'Thread',
  // 답글이 하나도 없는 스레드를 열었을 때. 이 줄이 없으면 패널에 머리말 하나만 서서
  // **눌린 것이 맞는지** 화면이 말하지 않는다(툴바의 스레드 칸이 상시 노출이 된 뒤로
  // 이 상태가 흔해졌다 — 전에는 답글이 있는 스레드만 열 수 있었다).
  'thread.empty': 'No replies yet. Start the thread with the first reply.',
  'reactions.pickTitle': 'Pick a reaction',

  // ---------------------------------------------------------------------------
  // gallery — **화면 이름이다.** `settings/GallerySettings.tsx` 가 그리는 말이고,
  // 그 화면은 다른 화면을 재는 **기준자**다(그 파일 머리말).
  //
  // ## 여기 오는 것은 **설명**뿐이다 — 견본은 안 온다
  //
  // 이 화면에는 성격이 다른 두 종류의 글이 있다.
  //
  // | | 예 | 어디에 |
  // |---|---|---|
  // | **설명** — 이 칸이 무엇을 가르치는가 | `강조를 받는 유일한 카드. 누를 수 있다.` | **사전** |
  // | **견본** — 가짜 대화의 내용 | `lint 를 다시 불러 줘` · `008 을 고친다` | **코드에 그대로** |
  //
  // 견본을 사전에 넣지 않는 이유가 둘이다. 첫째, **그것은 화면 문구가 아니라 데이터다** —
  // 카드 안에 흐르는 남의 말이고, 사전에 넣으면 사전이 가짜 대화로 부푼다. 둘째,
  // **번역자가 그것을 옮길 이유가 없다** — 이 화면이 가르치는 것은 카드의 생김새이지 그
  // 안에 무슨 말이 적혔는가가 아니고, 견본이 무슨 언어든 여덟 가지 말의 경계는 그대로
  // 보인다. 사전에 있으면 번역자는 그것을 **옮겨야 할 것**으로 읽는다.
  //
  // 그래서 영어로 이 화면을 열면 **설명은 영어, 카드 속 대화는 한국어**다. 어색해 보이지만
  // 그것이 정직한 상태다 — 저 대화는 murmur 가 하는 말이 아니라 예시로 박아 둔 남의 말이다.
  //
  // **덩어리는 화면의 구획을 따른다.**
  //
  // | 덩어리 | 그 구획 |
  // |---|---|
  // | `page` | 화면 제목 · 에이전트가 모자랄 때의 안내 |
  // | `speech` | 여덟 가지 말 — 선택 셋 · 실패 둘 · 보고 · 진행 · 주고받기 |
  // | `thread` | 스레드 상태 5단 · 대기 사슬 둘 · 참여자 줄 |
  //
  // 덩어리 안은 **키 이름 알파벳순**이다(근거는 `sidebar` 머리말과 같다 — 리베이스).
  //
  // ## 이름은 `title`, 가르치는 것은 `note`
  //
  // 각 칸이 둘을 갖는다. `title` 은 **어휘의 이름**(`Ask — for me`)이고 `note` 는 **왜 이
  // 모양인가**(`The only card that gets the accent…`)다. 한 문장으로 합치지 않는 이유는
  // 화면이 둘을 다른 크기로 세우기 때문이다(`Row`: 제목은 `text-body`, 설명은 `text-meta`).
  // ---------------------------------------------------------------------------

  /**
   * 에이전트가 둘 미만일 때. **비는 것은 이름뿐**이라고 정확히 말한다 — 앞 판본은 넓게
   * 경고했다가 정작 색이 뒤집힌 것은 말하지 않았다(그 파일 주석의 실측). 넓은 경고는
   * 그 경고 자체를 못 믿게 만든다.
   *
   * `{ellipsis}` 로 받는 이유: 화면이 그 자리에만 다른 색을 입힌다(`text-fg-subtle`).
   * 값(`…`)을 사전에 적으면 번역자가 그것을 문장으로 읽고 고치려 든다.
   */
  'gallery.page.namesMissing':
    'With fewer than two agents the name slots stay as {ellipsis}. Colors, recipients and chain '
    + 'shapes are pinned by samples, so they follow the rules — create two agents and the names '
    + 'fill in with real values too.',
  'gallery.page.subtitle': 'The eight kinds of speech and their edge states. If this breaks, the vocabulary broke.',
  'gallery.page.title': 'Component gallery',

  /**
   * 여덟 가지 말. **이름을 `Ask`·`Failure`·`Report` 로 두고 갈래를 `—` 뒤에 적는다** —
   * 한국어 `선택 — 나에게 온 것` 과 같은 구조다. 갈래를 앞에 세우면(`For me — ask`)
   * 같은 어휘의 세 칸이 목록에서 흩어진다.
   */
  'gallery.speech.askDone': 'Ask — already answered',
  'gallery.speech.askDoneNote': 'Only the chosen option remains, and the accent is withdrawn.',
  'gallery.speech.askForMe': 'Ask — for me',
  'gallery.speech.askForMeNote': 'The only card that gets the accent. It can be pressed.',
  /** 규칙 04 를 이름으로 부른다 — 번호가 문서(`docs/design.md`)의 것이라 번역하지 않는다. */
  'gallery.speech.askToAgent': 'Ask — sent to an agent',
  'gallery.speech.askToAgentNote': 'Neutral. Readable but not pressable (rule 04).',
  'gallery.speech.exchange': 'Agents talking to each other',
  'gallery.speech.exchangeNote': 'Folded by default. Unfolded, a thread becomes a log.',
  /**
   * **`'다시 부르기'가 없다`** 를 옮기면서 따옴표를 그대로 둔다 — 그 버튼의 이름을
   * 인용하는 것이라 문장의 일부가 아니다.
   */
  'gallery.speech.failFinal': 'Failure — retrying will not help',
  'gallery.speech.failFinalNote': 'No "Retry" — a door that does not exist is not drawn.',
  'gallery.speech.failRetry': 'Failure — can be retried',
  'gallery.speech.failRetryNote': 'Always comes to a person. The way to fix it sits in the same place.',
  'gallery.speech.progress': 'Progress',
  'gallery.speech.progressNote': 'A stretch that needs no answer. Not a sentence but one line of state.',
  'gallery.speech.report': 'Completion report',
  'gallery.speech.reportNote': 'A message to be read, so it takes no accent. It is the one that stays longest.',

  'gallery.thread.chainMine': 'Wait chain — my turn',
  'gallery.thread.chainMineNote': 'How many unblock is the reason a person answers.',
  'gallery.thread.chainStuck': 'Wait chain — deadlock',
  'gallery.thread.chainStuckNote': 'The chain reaches nowhere. Only a person can break it.',
  'gallery.thread.participants': 'Participant row · terminal picker',
  'gallery.thread.participantsNote': 'Whoever does not answer is dimmed. What you do not own is not in the list.',
  'gallery.thread.states': 'Thread states — five',
  'gallery.thread.statesNote': 'Only two take the accent, and even those two differ in color.',
  // defaults — **화면 이름이다.** `settings/AgentDefaultsSettings.tsx` 가 그리는 말.
  //
  // 작은 화면이라 덩어리를 하나(`field`)만 둔다 — 구획이 하나(값 셋을 세우는 폼)이므로
  // 나누면 덩어리 이름이 화면 이름을 되풀이할 뿐이다.
  //
  // `harness`·`model`·`effort` 는 **옮기지 않는다.** API 필드 이름이자 설정 파일에
  // 그대로 적히는 값이고, 그 값을 고르는 화면이 다른 이름을 쓰면 사람이 둘을 못 잇는다
  // (`sidebar.notify` 가 `all`/`mentions`/`none` 을 안 옮긴 것과 같은 규칙).
  // ---------------------------------------------------------------------------

  'defaults.field.effort': 'Default effort',
  'defaults.field.harness': 'Default harness',
  /** 비었을 때 무엇이 되는가. `<select>` 의 빈 값과 `<input>` 의 placeholder 가 함께 쓴다. */
  'defaults.field.harnessDefault': 'harness default',
  'defaults.field.model': 'Default model',
  /**
   * **비워 두는 것이 선택지다.** murmur 가 모델을 모르는 것이 아니라 *"발화에 실린 것으로만
   * 안다"* — 그 한계를 적어 두지 않으면 빈 칸이 고장으로 읽힌다.
   */
  'defaults.field.modelHint':
    'Leave it empty and the harness picks — murmur only learns that choice from the model carried on a message',
  'defaults.field.applyScope': 'It applies only to agents created after this. Agents that already exist do not change.',
  'defaults.field.loadFailed': 'The defaults did not arrive',
  'defaults.field.loading': 'Loading…',
  'defaults.field.notAdmin': 'Only an admin can set the defaults.',
  'defaults.field.save': 'Save defaults',
  'defaults.field.saved': 'Saved',
  'defaults.field.saveFailed': 'The defaults were not saved',
  'defaults.field.subtitle': 'What a newly created agent inherits. Agents that already exist do not change.',

  // ---------------------------------------------------------------------------
  // groups — **화면 이름이다.** `settings/HandleGroupsSettings.tsx` 가 그리는 말.
  //
  // ## `집합` 을 무엇으로 옮기나
  //
  // 한 handle 로 여러 계정을 한꺼번에 부르는 것이다(`@release` 로 팀 전체). 후보가 셋이었다:
  //
  // - `Set` — 수학 낱말이라 사람 묶음으로 안 읽힌다
  // - `Alias` — 하나를 다른 이름으로 부르는 것이지 여럿을 묶는 것이 아니다
  // - **`Handle group`** ← 이것. 코드가 이미 그 이름이고(`handleGroupRoutes` ·
  //   `HandleGroupsSettings`), 화면과 코드가 같은 낱말을 쓰면 사람이 둘을 잇는다
  //
  // 화면에서는 문맥이 이미 handle 이야기라 짧게 `Group` 으로 쓴다 — 라벨마다
  // `Handle group` 을 반복하면 정작 다른 부분이 안 읽힌다.
  // ---------------------------------------------------------------------------

  'groups.edit.addMember': 'Add member',
  'groups.edit.addMemberFailed': 'The member was not added',
  'groups.edit.displayName': 'Display name',
  /** `{id}` 는 계정 id 다 — 이름을 못 찾았을 때만 뜨므로 옮길 것이 없다. */
  'groups.edit.memberAccountId': 'Account ID: {id}',
  'groups.edit.membersFailed': 'The member list did not arrive',
  'groups.edit.newDisplayName': 'New display name',
  'groups.edit.pick': 'Pick a group',
  'groups.edit.removeMember': 'Remove {name}',
  'groups.edit.removeMemberFailed': 'The member is still in the group',
  'groups.edit.renameFailed': 'The name was not saved',
  /**
   * **이름 규칙을 계정과 잇는다.** `Invalid handle` 이 아니라 *"계정 handle 과 같은
   * 문법"* 이라고 적는 이유는, 사람이 이미 아는 규칙을 가리키는 것이 규칙을 다시
   * 나열하는 것보다 짧고 정확하기 때문이다 — 그리고 그 둘은 실제로 한 네임스페이스다.
   */
  'groups.list.empty': 'None yet',
  'groups.list.heading': 'Groups',
  /**
   * **에이전트 팀과 가르는 문장이다.** 둘은 이름 자리를 함께 쓰므로(한 네임스페이스)
   * 여기서 안 가르면 사람이 에이전트를 이 화면에서 묶으려 한다.
   */
  'groups.list.subtitle':
    'A way to call several people by one name. To group agents, use the team section under Settings › Agents — '
    + 'the two share one namespace for names.',
  'groups.member.empty': 'No members',
  'groups.member.pick': 'Pick an account…',
  'groups.member.remove': 'Remove',
  'groups.new.badHandle': 'A group handle must follow the same grammar as an account handle',
  'groups.new.createFailed': 'The group was not created (the name may already exist)',
  'groups.new.displayName': 'Group display name',
  'groups.new.handle': 'Group handle',
  'groups.new.readOnly': 'Only an admin can create or change groups',
  'groups.new.create': 'Create',
  'groups.new.heading': 'New group',
  'groups.remove.cancel': 'Cancel',
  'groups.remove.confirm': 'Delete for good',
  'groups.remove.start': 'Delete group',
  'groups.rename.name': 'Name',
  'groups.rename.save': 'Save',
  'groups.rename.start': 'Rename',
  'groups.remove.failed': 'The group is still there',

  // ---------------------------------------------------------------------------
  // profileName — **화면 이름이다.** `settings/ProfileSettings.tsx` 의 이름 바꾸기.
  //
  // 영역이 `profile` 이 아닌 이유: `agents.profile` 이 이미 **에이전트의** 프로필을
  // 뜻한다. 같은 낱말이 두 영역에서 다른 것을 가리키면 키를 읽는 사람이 매번 어느
  // 프로필인지 되짚어야 한다.
  //
  // ## 어투를 `~다` 로 맞춘다
  //
  // 이 화면만 `~하세요`·`~습니다` 였다(`새 이름을 입력하세요.` · `변경에 실패했습니다.`).
  // 사전의 한국어는 전부 `~다` 이고, 한 화면만 높임말이면 **같은 앱이 사람을 두 가지로
  // 대한다.** 뜻은 그대로 두고 어투만 맞췄다.
  // ---------------------------------------------------------------------------

  /**
   * 사진 지우기의 확인·취소. **이름 바꾸기의 것과 한 키로 못 묶는다** — 되돌리는 대상이
   * 다르고(`en.ts` 의 `Cancel` 판단), 실제로 문구가 갈릴 수 있는 자리다.
   */
  'profileAvatar.removeCancel': 'Cancel',
  'profileAvatar.removeConfirm': 'Delete for good',

  'profileName.apply': 'Apply',
  'profileName.empty': 'Enter a new name',
  'profileName.cancel': 'Cancel',
  'profileName.confirm': 'Confirm',
  /** 되돌릴 수 없는 조작이라 **두 사실**을 붙여 둔다 — 과거에 미치는 범위와 되돌림 여부. */
  'profileName.effectPast': 'Mentions in past messages will show the new name too.',
  'profileName.effectPermanent': 'This change cannot be undone.',
  'profileName.failed': 'The name was not changed',
  'profileName.heading': 'Display name',
  'profileName.input': 'New name',
  /** 규칙을 나열한다 — `Invalid name` 은 무엇을 고쳐야 하는지 말하지 않는다. */
  'profileName.start': 'Change',
  'profileName.invalidChars': 'Only lowercase letters, digits, underscores and hyphens',
  'profileName.length': 'It must be 2 to 32 characters',
  'profileName.taken': 'That name is already taken',
  'profileName.unusable': 'That name cannot be used',

  // ---------------------------------------------------------------------------
  // skills — **화면 이름이다.** `settings/SkillsSettings.tsx` 가 그리는 말.
  //
  // | 덩어리 | 그 구획 |
  // |---|---|
  // | `confirm` | 되돌리기 어려운 셋을 누르기 전에 뜨는 문장 |
  // | `group` | 세 칸(대기 중 · 승인됨 · 비활성)의 이름과 빈 목록 |
  // | `row` | 스킬 한 줄의 버튼들 |
  //
  // ## 확인 문구가 **무엇이 일어나는지**를 말한다
  //
  // `Are you sure?` 를 쓰지 않는다. 이 셋은 되돌리기 어렵고 **각각 다른 일이 벌어진다** —
  // 승인은 모든 에이전트의 프롬프트에 들어가고, 거부는 되돌리려면 에이전트가 다시
  // 제안해야 하며, 비활성화는 **파일을 지운다**. 그 차이가 문장에 있어야 사람이 무엇을
  // 누르는지 안다(회귀선이 `거부`에는 파일 이야기가 없고 `비활성화`에는 있는 것을 잰다).
  // ---------------------------------------------------------------------------

  'skills.confirm.approve':
    'Approving installs this body as a SKILL.md file for every agent — the harness reads it when it needs it',
  'skills.confirm.disable': 'Disabling means every agent deletes this skill\'s files and links',
  'skills.confirm.reject':
    'Rejecting drops this skill to disabled — to undo it an agent has to propose it again',
  'skills.confirm.approveStart': 'Confirm approve',
  'skills.confirm.cancel': 'Cancel',
  'skills.group.approved': 'Approved',
  'skills.group.approvedEmpty': 'No approved skills',
  'skills.group.disabled': 'Disabled',
  'skills.group.disabledEmpty': 'No disabled skills',
  'skills.group.pending': 'Pending',
  'skills.group.pendingEmpty': 'No skills waiting for approval',
  'skills.group.subtitle':
    'Workspace skills proposed by agents. Approving installs the body as a skill file for every agent, which the harness reads when it needs it.',
  'skills.list.loadFailed': 'The skill list did not arrive',
  'skills.list.loading': 'Loading…',
  'skills.list.refresh': 'Refresh',
  'skills.row.approve': 'Approve',
  'skills.row.approveFailed': 'The skill was not approved',
  'skills.row.confirmDisable': 'Confirm disable',
  'skills.row.confirmReject': 'Confirm reject',
  'skills.row.disable': 'Disable',
  'skills.row.disableFailed': 'The skill is still enabled',
  'skills.row.fold': 'Hide body',
  'skills.row.reject': 'Reject',
  'skills.row.rejectFailed': 'The skill was not rejected',
  'skills.row.unfold': 'Show body',

  // ---------------------------------------------------------------------------
  // agents — **화면 이름이다.** `settings/AgentsSettings.tsx` 가 그리는 말이고,
  // 이 말들을 내는 판정은 `lib/` 에 없다(그쪽에 있는 것은 아래 '안 옮긴 것'에 적었다).
  //
  // 영역 이름이 `settings.agents` 가 아니라 `agents` 인 이유: 세 칸 규칙(`en.ts` 머리말)
  // 에서 `settings` 를 영역으로 쓰면 이 화면의 구획이 셋째 칸을 다 먹어 덩어리가 사라진다
  // (`settings.agents.runnerStopHint` 처럼 이름이 다시 길어진다). 설정 화면들은 서로
  // 문자열을 나눠 쓰지 않으므로 **화면 하나가 영역 하나**다.
  //
  // **덩어리는 이 화면의 실제 구획을 따른다** — 화면을 열고 짚으면 키가 나온다.
  //
  // | 덩어리 | 그 구획 |
  // |---|---|
  // | `create` | 새 에이전트 만들기(이름 규칙 · 실패) |
  // | `detail` | 상세 머리띠 — 돌아가는 길 · 생존 · 소유자 · 기동 실패 |
  // | `disable` | 비활성화/활성화 상자 |
  // | `grid` | 격자 머리 · 탭 · 목록 조회 실패 |
  // | `memory` | 기억(memory) 상자 |
  // | `pat` | PAT 목록 · 발급 · 폐기 |
  // | `permissions` | 「권한」 묶음 — 멘션 권한 · 작업 디렉터리 · 소유자 |
  // | `profile` | 「프로필」 묶음 — 사진 · 이름 · 지시문 |
  // | `run` | 「실행」 묶음 — harness · 기본값 상태 |
  // | `runner` | 러너 (이 앱) · 실행 명령 틀 · 복사 |
  // | `stale` | 뒤처진 러너 재기동 띠 |
  // | `stop` | 러너 실행 · 중지 상자 |
  // | `teams` | 팀 묶음(격자 · 만들기) |
  //
  // 덩어리 안은 **키 이름 알파벳순**이다 — 근거는 아래 `sidebar` 머리말과 같다(리베이스).
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 중지 / 실행 | `Stop` / `Start` | `#493` 이 「종료 요청」·「요청 되돌리기」를 이 한 쌍으로 접었고 그 근거가 *"사람은 내가 보낸 요청을 취소한다고 생각하지 않는다"* 였다. `Resume` 은 멈춘 것이 이어진다는 뜻이라 거짓이다 — 이 버튼이 하는 일은 **자동 기동 대상에 다시 넣기**뿐이고 러너는 다음 기동에 뜬다 |
  // | 연결 끊김 — 알 수 없음 | `Disconnected — its presence is unknown` | `sidebar.brand.disconnected` 와 같은 규율이다. `Disconnected` 만 두면 **그래서 이 에이전트가 살았는지 모른다**가 사라지고, 사람은 그것을 '오프라인'으로 읽는다 |
  // | 활동 없음 | `No activity yet` | `yet` 이 진다. `No activity` 는 '죽었다'로도 읽히는데, `lastTurn.ts` 가 적어 둔 대로 murmur 는 한 번도 안 돈 것과 죽은 것을 **구분할 수단이 없다** |
  // | 기억 | `Memory` | 화면이 이미 `기억 (memory)` 로 원어를 병기하고 있었다 — 영어에서는 그 병기가 같은 말의 반복이라 하나로 둔다 |
  // | 두기 | `Keep it` | 지우기 확인의 반대짝이다. `Cancel` 은 **무엇이 남는지**를 안 말한다 — 여기서 사람이 고르는 것은 '취소'가 아니라 '그 기억을 남긴다'다 |
  // | 뒤처진 러너 전체 재기동 | `Restart all outdated runners ({count})` | `Outdated` 는 위 표(`뒤처짐`)에서 이미 정한 낱말이다. 개수를 이름에 넣는 이유는 원래 주석이 적었다 — **개수가 곧 영향 범위**다 |
  // | 지원 예정 | `planned` | `not supported` 가 아니다. 원래 주석이 가른 그대로다: *"없는 것은 사용자의 CLI 가 아니라 murmur 의 구현이므로 '설치 안 됨'이 아니라 '지원 예정'이다"* |
  // | attach | `attach` | **번역하지 않는다.** 사람이 터미널에서 실제로 하는 조작의 이름이고, 이 제품의 고유어다(`admin`·`PAT`·`harness` 와 같다) |
  //
  // ## 사전에 **안** 넣은 것 — 각각 이유가 다르다
  //
  // - **`runnerStatusLabel`(`RunnerStatus.tsx`) · `daemonFactRows`(`lib/daemonFacts.ts`) ·
  //   `lastTurnAgo`(`lib/lastTurn.ts`)** — **이 파일 밖이다.** 사이드바 PR 이 같은 경계를
  //   지켰다(그 커밋: *"이 파일 밖이라 안 건드렸다"*). 이 화면은 그 값을 **감싸는 틀**만
  //   사전으로 옮긴다(`agents.detail.lastTurn` 이 `{ago}` 를 받는 것이 그것이다)
  // - **경과·시각 표기** — `Intl` 이 이미 아는 것이다. `en.ts` 머리말의 '남은 것' 표가
  //   *"사전에 넣기 전에 `Intl.RelativeTimeFormat` 으로 옮길지 먼저 정해야 한다"* 고
  //   적어 뒀고, 그 판단은 이 PR 의 것이 아니다. `toLocaleString()` 은 이미 로케일을 따른다
  // - **`admin` · `PAT` · `harness` · `daemon` · `attach` · `murmur`** — 이 제품의 고유어다.
  //   옮기면 사람이 문서·터미널·서버 오류에서 보는 말과 화면의 말이 갈라진다
  // - **`auto` · `readonly`** — `MentionPermission` 의 **저장·전송용 값**이다. 옵션 라벨이
  //   `auto — …` 로 값을 앞에 세우는 것은 그 값이 API·설정 파일에도 그대로 나오기 때문이다
  //   (`sidebar.notify` 가 `all`/`mentions`/`none` 을 안 옮긴 것과 같은 규율)
  // - **경로 예시(`/Users/me/some-repo`) · `team-name` · `fizz` · `runner`** — 자리표시다.
  //   번역하면 사람이 그것을 **입력해야 하는 값**으로 읽는다
  // - **종료 코드 `78`·`401`** — 숫자다. 러너 로그에서 보는 그 숫자여야 한다
  // ---------------------------------------------------------------------------

  // --- Agents 칸의 관제 구획(`AgentTurns`) ------------------------------------
  // 이 묶음이 말하는 것은 **지금 도는 턴**이다. `runnerState.*`(러너 프로세스의 생사)와
  // 뭉치지 않는 이유가 화면의 판단 그대로다: 턴은 "이 일"이고 러너는 "이 사람"이다.
  'agentTurns.accountDefault': 'default login',
  'agentTurns.accountTitle': 'Running on this claude account (pool: {pool})',
  'agentTurns.accountTitleRoot': 'Running on this claude account (root pool)',
  'agentTurns.cancel': 'Stop',
  'agentTurns.cancelAll': 'Stop all',
  'agentTurns.cancelAllTitle': 'Stop {n} running turns?',
  'agentTurns.cancelConfirm': 'Stop them',
  'agentTurns.cancelDetail': 'Only the turns stop — the runners stay up and take the next mention. Each stopped turn leaves a failure note in its thread. Turns someone is driving by hand are left alone.',
  'agentTurns.cancelKeep': 'Leave them running',
  'agentTurns.cancelThread': 'Stop thread',
  'agentTurns.cancelThreadTitle': 'Stop every turn running in this thread',
  'agentTurns.checking': 'Checking\u2026',
  'agentTurns.count': '{n} running',
  'agentTurns.human': 'human at the wheel',
  'agentTurns.noThread': 'The runner did not say which thread this turn belongs to',
  'agentTurns.none': 'No turns running',
  'agentTurns.scope': 'Turns the runners reported, for agents you can see.',
  'agentTurns.title': 'Running turns',
  'agentTurns.unknown': "Can't tell what's running",
  'agentTurns.unknownHint': 'This is not zero — a runner may still be working.',
  'agents.create.failed': 'The agent was not created — that name may already be taken',
  /**
   * 이름 규칙. **`Invalid name` 이 아니라 무엇이 되는지를 적는다**(`sidebar.channel
   * .createInvalidName` 과 같은 규율). 뒤의 괄호는 **규칙이 아니라 이유**다 — 이 이름이
   * 채널에서 `@이름` 이 되기 때문에 handle 문법을 따르는 것이고, 그 사실을 빼면 사람은
   * 왜 공백이 안 되는지 모른 채 규칙만 외운다.
   */
  'agents.create.invalidName':
    'Names take lowercase letters, digits, hyphens and underscores — 2 to 32 characters '
    + '(this is what you call in a channel with @name)',
  /**
   * 계정 풀 배정만 실패했을 때. **`agents.create.failed` 와 다른 문장이어야 한다** —
   * 계정과 PAT 는 이미 만들어졌고 그 토큰은 다시 볼 수 없으므로, "만들지 못했다"로
   * 적으면 사람은 화면에 떠 있는 PAT 상자를 무효한 것으로 읽고 버린다.
   */
  'agents.create.poolFailed':
    'The agent was created, but its account pool was not assigned: {reason}',

  'agents.detail.back': '← Agents',
  /**
   * 소켓이 끊겼을 때. **`Disconnected` 한 단어로 끝내지 않는다** — 끊긴 동안 `online` 은
   * 그냥 빈 배열이라(그 화면 주석) 이 에이전트가 살아 있는지를 **모르는** 것이지 죽은
   * 것이 아니다. 한 단어로 줄이면 사람이 그것을 '오프라인'으로 읽는다.
   */
  'agents.detail.disconnected': 'Disconnected — its presence is unknown',
  /**
   * 경과는 `{ago}` 로 받는다 — **계산도 문구도 `lib/lastTurn.ts` 것이다**(위 '안 넣은 것').
   * 이 사전이 지는 것은 접두뿐이고, 그것이 원래 `lastTurnLabel` 이 하던 일 그대로다.
   */
  'agents.detail.lastTurn': 'Last activity: {ago}',
  'agents.detail.launchFailed': 'Did not start',
  /** 사유가 붙을 때. 사유 문구는 러너가 준 것이라 사전이 지지 않는다. */
  'agents.detail.launchFailedReason': 'Did not start — {reason}',
  /**
   * 한 번도 안 돈 에이전트. **`yet` 이 진다** — `lastTurn.ts` 가 적은 대로 murmur 는
   * '한 번도 안 돌았다'와 '죽었다'를 구분할 수단이 없고, `No activity` 만 두면 사람이
   * 뒤엣것으로 읽는다.
   */
  'agents.detail.noActivity': 'No activity yet',
  'agents.detail.offline': 'Offline',
  'agents.detail.online': 'Online',
  'agents.detail.ownerNone': 'None',
  /** 소유자 id 는 있는데 계정 디렉터리에 없다 — **빈 칸으로 그리면 '없다'와 같아진다.** */
  'agents.detail.ownerUnknown': 'Unknown account',
  /**
   * 되돌리기. **`Cancel` 이 아니다** — 이 버튼은 화면을 닫지 않고 서버 값으로 초안을
   * 되채운다(`pick(selected)`). `Cancel` 로 두면 사람은 상세에서 나갈 것으로 읽는다.
   */
  'agents.detail.revert': 'Revert',
  'agents.detail.save': 'Save changes',
  'agents.detail.saveFailed': 'The changes were not saved',
  'agents.detail.submitNew': 'Create agent',
  'agents.detail.titleEdit': 'Edit {handle}',
  'agents.detail.titleNew': 'Add agent',

  'agents.disable.cancel': 'Cancel',
  /**
   * 확인 버튼. **`Confirm` 이 아니다** — 사람이 누르는 것은 절차의 이름이 아니라
   * "정말 끈다"는 결정이고, `for good` 이 PAT 가 안 돌아온다는 되돌릴 수 없음을 진다
   * (`sidebar.delete.confirm` 이 같은 규율이다).
   */
  'agents.disable.confirm': 'Disable for good',
  'agents.disable.disable': 'Disable',
  /**
   * 스크린리더가 읽는 이름. **보이는 글자(`Disable`)보다 길다** — 이 상자에는 `Disable`
   * 과 `Disable for good` 이 나란히 서고, 목록으로 훑는 사람에게는 앞뒤 문맥이 없다.
   * 무엇을 끄는지가 이름에 있어야 그 둘을 가를 수 있다(원래 화면이 그래서 갈라 뒀다).
   */
  'agents.disable.disableAction': 'Disable this agent',
  /**
   * 끄기·켜기의 실패를 **한 문구로 뭉치지 않는다** — 사람이 방금 누른 것이 무엇이었는지가
   * 오류에 남아야 어느 쪽이 실패했는지 안다. 그리고 결과 상태로 쓴다(`en.ts` 머리말의
   * `The X was not Yed`): 지금 그 에이전트가 **여전히 켜져 있다**는 것이 사람이 알아야 할 값이다.
   */
  'agents.disable.disableFailed': 'The agent is still enabled',
  'agents.disable.enable': 'Enable',
  /** 위 `disableAction` 과 같은 이유로 이름이 따로 있다. */
  'agents.disable.enableAction': 'Enable this agent',
  'agents.disable.enableFailed': 'The agent is still disabled',
  'agents.disable.headingDisabled': 'Disabled agent',
  'agents.disable.headingEnabled': 'Agent is enabled',
  /**
   * 꺼진 에이전트를 다시 켤 때. **PAT 가 왜 없는지를 말한다** — 켠 직후 PAT 0개를 보고
   * 사람이 "고장 났나"라고 읽지 않게, 그것이 비활성화의 결과였음을 여기서 잇는다.
   */
  'agents.disable.noteDisabled':
    'This agent is disabled. Enabling it again will report that it has no PAT and needs a '
    + 'new one — disabling revoked every PAT it had.',
  /**
   * 끄기 전 안내. **되돌릴 수 없는 것이 무엇인지**를 말한다 — 끄는 것 자체는 되돌릴 수
   * 있지만 PAT 는 돌아오지 않는다(서버가 해시만 보관한다). 그 비대칭이 이 문장의 전부다.
   *
   * `{strong…}` 은 **굵게 그릴 마디**다. 원래 화면이 그 둘을 굵게 두고 있었고, 그 굵기는
   * 꾸밈이 아니라 문단에서 건져야 할 사실을 가리킨다(`AgentsSettings.emphasize` 머리말).
   */
  'agents.disable.noteEnabled':
    'Disabling an agent {strongRevoked}, and enabling it again does not bring them back — '
    + 'you have to {strongMint}.',
  'agents.disable.noteEnabledMint': 'mint new ones',
  'agents.disable.noteEnabledRevoked': 'revokes every PAT it has',
  /** 확인 단계. 위 안내와 달리 **지금 벌어질 일**을 현재형으로 말한다. */
  'agents.disable.warning':
    '{strongRevoked} and its runner stops. Enabling it again does not bring the PATs back — '
    + 'you have to {strongMint}.',
  'agents.disable.warningMint': 'mint new ones',
  'agents.disable.warningRevoked': 'Every PAT of this agent is revoked',

  'agents.grid.heading': 'Agents',
  'agents.grid.listFailed': 'The agent list did not arrive',
  /** 격자 머리. **이름이 무엇을 하는지**를 말한다 — 카드를 눌러도 되는지가 여기서 온다. */
  'agents.grid.note': 'Call one with @name in a channel. Click a card to open its settings.',
  'agents.grid.tabAgents': 'Agents',
  'agents.grid.tablist': 'Agents and teams',
  'agents.grid.tabTeams': 'Teams',

  'agents.memory.deleteAction': 'Forget {slug}',
  'agents.memory.deleteConfirm': 'Forget it',
  'agents.memory.deleteFailed': 'The memory was not forgotten',
  'agents.memory.deleteStart': 'Forget',
  'agents.memory.empty': 'Nothing remembered yet',
  /** **못 읽은 것과 없는 것은 다르다**(design.md §4) — 그래서 위 `empty` 와 갈라 둔다. */
  'agents.memory.failed': 'The memory did not arrive',
  'agents.memory.heading': 'Memory',
  /** 지우기 확인의 반대짝. **`Cancel` 이 아니다** — 사람이 고르는 것은 '남긴다'다. */
  'agents.memory.keep': 'Keep it',
  'agents.memory.loading': 'Loading…',

  /** 토큰 **자체**를 복사하는 버튼. 버튼 글자는 `agents.runner.copy` 를 쓰고
   *  (`Copy` 하나를 두 벌로 두지 않는다) 무엇을 복사하는지는 이 이름이 가른다. */
  'agents.pat.copyToken': 'Copy the token',
  'agents.pat.label': 'New PAT label',
  /** 라벨 규칙. 서버가 409 로 거절하는 그 규칙이고, **되쓸 수 있다**까지 말해야 막히지 않는다. */
  'agents.pat.labelNote':
    'A label is unique among the live tokens. Revoking one frees its label to be used again.',
  'agents.pat.listFailed': 'The PAT list could not be read',
  'agents.pat.loading': 'Reading PATs…',
  'agents.pat.mint': '+ New PAT',
  'agents.pat.mintFailed': 'The PAT was not minted',
  /** 꺼진 에이전트에 PAT 0개는 **정상이다** — 그래서 재발급을 권하지 않는다. */
  'agents.pat.none': 'No PAT',
  /** 켜진 에이전트에 PAT 0개면 러너가 못 뜬다 — 그 사실과 사유를 함께 말한다. */
  'agents.pat.noneNeedsMint': 'No PAT — mint one (disabling revokes them all)',
  'agents.pat.revoke': 'Revoke',
  'agents.pat.revokeCancel': 'Cancel',
  'agents.pat.revokeConfirm': 'Really revoke',
  'agents.pat.revoked': '(revoked)',
  'agents.pat.revokeFailed': 'The PAT was not revoked',
  /** 발급 직후. **왜 다시 못 보는지**를 함께 적는다 — 그것이 지금 복사해야 하는 이유다. */
  'agents.pat.shownOnce':
    'This token is visible only now — the server keeps only a hash, so it cannot be shown again',

  'agents.permissions.mentionAuto': 'auto — allow every tool on a mention turn',
  /** 이 설정이 **안 걸리는 자리**를 말한다 — 없으면 사람은 터미널에서도 막힐 것으로 읽는다. */
  'agents.permissions.mentionNote':
    'When a person drives it from a terminal, the harness asks regardless of this setting.',
  'agents.permissions.mentionReadonly': 'readonly — read only (for consulting)',
  /** 소유자가 보는 읽기 전용 값. **값을 감추지 않는다** — 감추면 자기 에이전트가 읽기 전용인지도 모른다. */
  'agents.permissions.mentionReadOnlyValue': 'Mention permission: {value} (only an admin changes this)',
  'agents.permissions.note': 'Who drives it, and what it may do.',
  'agents.permissions.ownerLabel': 'Owner',
  'agents.permissions.ownerNone': 'None — cannot attach',
  'agents.permissions.ownerNote': 'Only the owner can attach to this agent.',
  'agents.permissions.ownerReadOnly': 'Owner: @{handle}',
  'agents.permissions.ownerReadOnlyNone': 'Owner: none — cannot attach',
  'agents.permissions.title': 'Permissions',
  /** 비우면 무엇이 되는지까지 말한다 — 비워도 되는 칸임이 그 문장에서만 읽힌다. */
  'agents.permissions.workingDirPlaceholder':
    '/Users/me/some-repo — empty makes a fresh empty directory for each thread',

  'agents.profile.avatarFormats': '{formats} · empty picks a color from the name',
  'agents.profile.avatarRemove': 'Remove',
  'agents.profile.avatarRemoveCancel': 'Cancel',
  'agents.profile.avatarRemoveConfirm': 'Really remove',
  'agents.profile.avatarUpload': 'Upload a photo',
  /** 되돌릴 수 없다는 것을 **이름 칸 아래**에서 말한다 — 만든 뒤에는 이 칸이 잠긴다. */
  'agents.profile.handleNote': 'This is what you call in a channel with @name. It cannot be changed later.',
  'agents.profile.instructionsPlaceholder': 'Write what this agent does.',
  'agents.profile.note': 'How it looks in a channel, and what it does.',
  'agents.profile.title': 'Profile',

  'agents.run.defaultsFailed': 'The defaults did not arrive — a new agent cannot be drafted',
  'agents.run.defaultsLoading': 'Loading the defaults…',
  'agents.run.defaultsNotAdmin': 'Only an admin can create an agent',
  'agents.run.harnessDefault': 'harness default',
  /** 아직 못 돌리는 harness. **`not supported` 가 아니다** — 없는 것은 murmur 의 구현이다. */
  'agents.run.harnessPlanned': '{harness} (planned)',
  'agents.run.note': 'What it runs on.',
  'agents.run.title': 'Run',

  'agents.runner.commandCopy': 'Copy the command',
  'agents.runner.copied': 'Copied',
  'agents.runner.copy': 'Copy',
  /** 선택조차 못 했을 때. 남은 길이 손으로 옮겨 적는 것뿐이라 그것을 말한다. */
  'agents.runner.copyFailedManual':
    'The clipboard is not available and the command could not be selected — copy it by hand',
  /**
   * 클립보드가 없거나 거부됐을 때. **조용히 실패하지 않는다**(`#177`) — 화면의 그 명령을
   * 선택해 두었으므로 **다음에 할 일**을 말한다. 오류만 적고 끝내면 사람은 막힌다.
   */
  'agents.runner.copyFailedSelected':
    'The clipboard is not available — the command is selected, so press ⌘C to copy it',
  /**
   * daemon 이 자기가 띄운 러너만 아는 것은 **한계 고백**이다. 앞 문장에 뭉치면 사람은
   * 손으로 띄운 러너도 여기 나타날 것으로 읽고, 안 나타나면 앱이 고장 났다고 판단한다.
   */
  'agents.runner.daemonScope':
    'The daemon {strongOnlyOwn}. A runner on another machine, or one you started by hand, is not '
    + 'in that ledger and does not show up here — then only the fact that something is attached '
    + 'to the server comes through as a reason, and this app starts its own runner anyway.',
  'agents.runner.daemonScopeOnlyOwn': 'only knows the runners it started itself',
  'agents.runner.factsHeading': 'Runner — what the daemon checked itself',
  'agents.runner.heading': 'Runner (this app)',
  /** `{label}` 은 `runnerStatusLabel` 이 낸다 — 이 사전이 상태 이름을 제 손으로 적지 않는다. */
  'agents.runner.ownedNote':
    'This app starts runners for the agents {strongOwn}. If a runner the {strongDaemon} is still '
    + 'alive, it does not start another and shows it as ‘{label}’ — two runners on one agent split '
    + 'its mentions between them.',
  'agents.runner.ownedNoteDaemon': 'daemon already holds',
  'agents.runner.ownedNoteOwn': 'I own',
  'agents.runner.patGoToMint': 'Go to minting a PAT',
  'agents.runner.reissue': 'Reissue the PAT',
  'agents.runner.reissueFailed': 'The PAT was not reissued: {reason}',
  /**
   * 재발급이 무엇을 하는지. **순서가 요점이다**(새 발급 → 옛 폐기 → 재실행) — 그리고
   * 옛 PAT 로 돌던 러너가 어떻게 물러나는지까지 적는다. 그 러너가 다른 머신에 있으면
   * 사람은 그것을 손으로 죽이러 갈 수 없고, 스스로 물러난다는 사실이 그 걱정을 없앤다.
   */
  'agents.runner.reissueNote':
    'This mints a new PAT, {strongRevoke}, and starts the runner again. A runner still holding '
    + 'the old PAT — including one on another machine — gets a 401 on its next call and steps '
    + 'down with exit code 78.',
  'agents.runner.reissueNoteRevoke': 'revokes the old one',
  'agents.runner.reissuing': 'Reissuing…',
  'agents.runner.startFailed': 'The runner did not start: {reason}',
  /**
   * 손으로 띄우는 명령 **두 갈래의 이름**(`lib/runnerCommand.ts`). 그 파일이 *"두 갈래를
   * 모두 적는다 — 하나만 적으면 반쪽이 또 낡는다"* 고 못 박았고, 사람이 자기 상황을
   * 고르려면 **각 줄이 어느 상황의 것인지**를 알아야 한다.
   *
   * `#` 를 문구에 함께 두는 이유: 이 값은 **셸에 붙여넣는 텍스트**다. 주석 기호를 코드가
   * 붙이고 문구만 사전에서 오면, 번역자가 이것이 셸 주석이라는 것을 모르고 줄바꿈을
   * 넣어 그 아래 명령을 통째로 주석에서 꺼낸다.
   *
   * **`Run a runner` 와 갈린다**(아래 `templateHeading`): 저것은 절의 제목이고 이 둘은
   * 클립보드에 실려 나가는 값이다.
   */
  'agents.runner.commandBundledNote': '# If you installed the app (change the path if you installed it elsewhere)',
  /** 저장소를 클론한 사람만의 길이다 — 배포판에는 이 소스가 없다(그 파일 머리말). */
  'agents.runner.commandDevNote': '# A checkout of the murmur repository',
  'agents.runner.templateHeading': 'Run a runner',
  /** 토큰을 잃었을 때 갈 곳. **글로만 두면 발급 자리를 찾아야 한다**(`#177`). */
  'agents.runner.templateNote': 'A token is visible only when it is minted. If you lost it, mint a new one.',
  /**
   * 남이 소유한 에이전트는 사람이 손으로 띄워야 한다. **세 사실을 진다** — 서버는 안
   * 띄운다 / 이 앱은 내 것만 띄운다 / 그 밖은 이 명령을 직접 돌리기 전까지 답하지 않고
   * 멘션은 쌓인다. 마지막을 자르면 사람은 "부르면 언젠가 오겠지"로 읽는다.
   */
  'agents.runner.whoStarts':
    'The murmur {strongServer} does not start runners. This desktop app starts only the agents '
    + '{strongOwn} — an agent someone else owns, or one with no owner, {strongNoAnswer} '
    + '(the mentions just pile up). The runner ships with the app, so any machine with murmur '
    + 'installed will do — a checkout is only needed for the development branch below.',
  'agents.runner.whoStartsNoAnswer': 'does not answer mentions until you run the command above to attach a runner',
  'agents.runner.whoStartsOwn': 'I own',
  'agents.runner.whoStartsServer': 'server',

  'agents.stale.allCurrent': 'Every running runner is on this bundle.',
  /**
   * 뒤처진 러너가 **보이는데 이 버튼의 대상이 아닐 때.** `allCurrent` 를 그대로 쓰면
   * 카드가 `· Outdated` 를 달고 있는 옆에서 "전부 이 번들이다"를 단정한다 — 그 어긋남이
   * 사람을 비활성 버튼으로 보냈다. 어디서 눌러야 하는지까지 적는다. 복수형이 갈린다.
   */
  'agents.stale.elsewhere': {
    one: 'Every runner this device started is on this bundle. {count} outdated runner belongs to '
      + 'another device and cannot be restarted from here — press it in the murmur on that device.',
    other: 'Every runner this device started is on this bundle. {count} outdated runners belong to '
      + 'another device and cannot be restarted from here — press it in the murmur on that device.',
  },
  /**
   * 재기동이 무엇을 안 하는지. **누르기 전에** 있어야 한다 — 진행 중인 턴이 끊기지
   * 않는다는 것을 모르면 사람은 긴 턴이 도는 동안 이 버튼을 못 누른다.
   */
  'agents.stale.note': 'A restart {strong} — it comes back on the new bundle once the turn is done.',
  'agents.stale.noteStrong': 'does not cut a turn that is in flight',
  /**
   * 개수를 이름에 넣는다 — 원래 주석이 적은 대로 **개수가 곧 영향 범위**다.
   * 복수형이 갈린다: 영어는 `1 runner` / `2 runners` 이고 한국어는 한 갈래다.
   */
  'agents.stale.restart': {
    one: 'Restart the outdated runner ({count})',
    other: 'Restart all outdated runners ({count})',
  },
  /**
   * 끝났다는 사실. **걸었다(`restartRequested`)와 다른 말이다** — 그 사이가 진행 중인
   * 턴을 기다리는 시간이고, 실측 상한이 15분이다. 복수형이 갈린다.
   */
  'agents.stale.restartDone': {
    one: '{count} runner is back on the new bundle.',
    other: '{count} runners are back on the new bundle.',
  },
  'agents.stale.restartFailed': 'The runners were not restarted: {reason}',
  /**
   * 누른 **즉시** 서는 줄. 이 조작은 예약이라 여기서 끝나지 않는다는 것을 함께 적는다 —
   * 안 적으면 사람은 곧 버전이 바뀔 것으로 읽고, 안 바뀌는 동안 다시 누른다.
   */
  'agents.stale.restartRequested': {
    one: 'A restart is queued for {count} runner — it comes back on the new bundle once its turn is done.',
    other: 'A restart is queued for {count} runners — they come back on the new bundle once their turns are done.',
  },
  /**
   * 누르는 동안의 버튼 이름. **개수를 안 싣는다** — 그 수는 바로 아래 진행 줄이 말하고,
   * 버튼은 지금 눌리지 않는다는 사실만 지면 된다.
   */
  'agents.stale.restarting': 'Restarting…',
  /** 앱 버전을 모르면 비교 기준이 없다 — **"전부 최신"은 확인하지 않은 것을 단정하는 말이다.** */
  'agents.stale.unknownAppVersion': 'The app version could not be read, so being outdated cannot be judged.',
  /**
   * 버전을 모르는 러너. **모르는 것을 뒤처졌다고 하지 않는다**(`runnerVersions.ts`) —
   * 대신 값을 채우는 방법을 적는다. 복수형이 갈린다.
   */
  'agents.stale.unknownVersion': {
    one: '{count} runner of unknown version — it was left out because being outdated cannot be judged. '
      + 'Restart it once and its version shows from then on.',
    other: '{count} runners of unknown version — they were left out because being outdated cannot be judged. '
      + 'Restart them once and their versions show from then on.',
  },

  'agents.stop.acked':
    'The runner picked the request up (stop {requestedAt} · acknowledged {ackedAt}). It finishes '
    + 'the turn it was on and exits — whether it actually exited, murmur cannot know.',
  /** 이미 읽어 간 뒤가 오히려 다시 켤 일이 생기는 자리다 — 그 뒤로는 자동 기동이 건너뛴다. */
  'agents.stop.ackedResume': ' Press Start and it is back in the auto-start set from the next start.',
  'agents.stop.heading': 'Start · stop the runner',
  /**
   * 버튼이 짧아진 만큼 **잃으면 안 되는 뉘앙스가 이 문단으로 왔다**(`#493`). 중지는 지금
   * 끊는 것이 아니라 진행 중인 턴을 마친 뒤 스스로 물러나는 것이고, 실행은 **다음 기동**
   * 에서 뜬다. 뒤엣것을 자르면 `#129` 가 금지한 거짓 신호(할 수 없는 일을 이름으로
   * 약속하는 것)를 이름만 바꿔 되살리는 셈이 된다.
   */
  'agents.stop.note':
    '{strongStop} does not cut the runner off now — the runner {strongFinish}. A turn is not cut '
    + 'in the middle so that nobody loses the answer they are waiting for. While it is stopped this '
    + 'agent {strongSkipped}. Press {strongStart} and it is back in the set, so {strongNextStart} — '
    + 'it is not started here and now. Both are reversible at any time.',
  'agents.stop.noteFinish': ' exits by itself after finishing the turn it is on',
  'agents.stop.noteNextStart': 'the runner comes up on the next start',
  'agents.stop.noteSkipped': ' is left out of auto-start',
  'agents.stop.noteStart': 'Start',
  'agents.stop.noteStop': 'Stop',
  'agents.stop.notRequested': 'It is in the auto-start set — no stop has ever been asked for.',
  /** **'멈췄다'고 쓰지 않는다** — 러너가 읽어 가지 않았으면 아무 일도 일어나지 않았다. */
  'agents.stop.requested':
    'Stop asked for ({requestedAt}) — the runner has not picked it up yet. If no runner is '
    + 'attached, there is nobody to pick it up.',
  'agents.stop.start': 'Start',
  'agents.stop.startAction': 'Start the runner',
  'agents.stop.startFailed': 'The stop request was not withdrawn',
  'agents.stop.stop': 'Stop',
  'agents.stop.stopAction': 'Stop the runner',
  'agents.stop.stopFailed': 'The stop was not asked for',

  // ---------------------------------------------------------------------------
  // teams — **덩어리를 늘렸다. 새 영역을 열지 않았다.**
  //
  // 앞 PR 이 격자 머리와 만들기 폼을 여기 두었고, 이 PR 이 나머지 셋(`TeamGrid` 의
  // 검색줄 · `TeamDetail` 상세 전체 · `TeamMemberPicker`)을 같은 덩어리에 붙인다.
  //
  // ## 왜 `teams` 영역을 새로 열지 않았나 — 세 기준이 다 같은 쪽을 가리킨다
  //
  // 1. **`agents` 머리말의 *"한 화면 = 한 영역"***. 파일이 셋으로 갈렸어도 그리는
  //    화면은 하나다 — `AgentsSettings` 가 탭으로 격자를 바꾸고, 카드를 누르면 같은
  //    화면 안에서 상세로 바뀐다(그 파일의 `<TeamDetail>`·`<TeamGrid>` 자리). 파일
  //    개수로 영역을 가르면 `AgentGrid`·`AgentsSettings` 도 갈려야 하는데, 그 둘은
  //    이미 `agents`·`grid` 로 **다른 근거**(아래 `grid` 머리말)에 따라 갈려 있다.
  // 2. **`waitChain`·`runner` 의 *"그리는 화면이 둘 이상이면 판정 이름"***. 이것은
  //    `lib/` 판정에만 걸리는 예외이고, 팀의 말은 판정이 아니라 화면이 스스로 쓰는
  //    라벨·오류다 — `lib/` 어디에도 이 문구를 내는 함수가 없다. 예외의 조건이 안 선다.
  // 3. **`speech` 의 세 번째 경우 — 한 벌의 어휘**. 팀의 말은 한 벌이 아니다. `Create`·
  //    `Cancel`·`The team was not created` 는 다른 화면이 빌려 갈 어휘가 아니라 이
  //    화면의 폼 문구이고, 실제로 빌려 가는 자리(사이드바의 「팀 추가」)는 **자기 것을
  //    이미 갖고 있다**(`sidebar.members.team*`) — 그쪽은 채널에 팀을 넣는 일이라 말이
  //    다르다. 한 벌이라면 그 둘이 같은 키를 봤을 것이다.
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | ← 팀 | `← Teams` | `AgentsSettings` 의 `agent-back` 과 **같은 어휘**여야 한다(그 화면 주석) — 두 상세가 같은 격자에서 열리므로 돌아가는 길이 다르게 생기면 사람이 그것을 배워야 한다. 격자 머리가 `Teams` 이므로 복수로 돌아간다 |
  // | 비활성 — 호출에서 빠진다 | `Disabled — left out when the team is called` | **결과를 적는다.** `Disabled` 만 두면 그것이 러너 상태인지 팀 설정인지 모른다 — 이 줄이 말하는 것은 *"팀을 불러도 이 하나는 안 깬다"* 이고, 그 파일 주석이 그 구별을 이 자리의 존재 이유로 적었다 |
  // | 빼기 | `Remove` | `sidebar.members.remove` 와 같은 낱말이지만 **키를 안 나눈다** — 되돌리는 것이 다르다(채널에서 빼기 대 팀에서 빼기). `common` 승격 기준의 그 갈림이다 |
  // | 정말 지우는가? | `Delete this team?` | 물음이 **무엇을 지우는지** 말한다. `Are you sure?` 는 되돌릴 수 없다는 것도 대상도 말하지 않는다 |
  // | 정말 삭제 | `Delete for good` | 머리말이 이미 정한 낱말이다(`sidebar.delete.confirm`·`sidebar.members.leaveConfirm` 이 같은 어휘를 쓴다) |
  // | 팀을 지워도 팀에 속했던 에이전트는 그대로 있다 | `The agents that were in it stay — only the team goes` | **무엇이 남는지**를 말한다. 삭제 상자에서 사람이 알아야 하는 것은 사라지는 것의 범위이고, 원래 한국어가 그 사실을 지고 있었다 |
  // | 얼굴을 누르면 팀에 들어간다. 멈춘 에이전트도 넣을 수 있다 — 팀에 넣는 것과 지금 도는 것은 다른 일이다 | `Click a face to add it. A stopped agent can join too — being in a team and running right now are different things.` | 뒤 문장이 **회색 얼굴을 눌러도 되는 이유**다(그 파일 주석의 근거). 빼면 사람이 러너를 다 띄운 뒤에 팀을 짜려 든다 |
  // | 계정과 같은 이름 자리를 쓴다 — … | `A team name lives in the same namespace as an account …` | 세 사실을 다 진다: 같은 네임스페이스 · `@name` 이 전원을 깨운다 · 사람 여럿은 Handle Groups. 하나라도 빠지면 이름을 정하는 사람이 모르는 채로 정한다(그 자리 주석) |
  // | 팀원을 바꿀 수 있는 것은 admin 뿐이다 | `Only an admin can change who is in a team` | `admin` 은 안 옮긴다(위 머리말) |
  // | 넣을 수 있는 에이전트가 없다 — 등록된 에이전트가 모두 이 팀에 있다 | `No agent left to add — every registered agent is already in this team` | **왜 비었는지**를 함께 적는다. 그냥 `No agents` 면 사람은 에이전트가 하나도 없는 줄 안다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`@{team.name}` · `@{m.handle}`** — 이름이다. `Handle Groups` 도 그대로 둔다:
  //   설정 목차의 항목 이름이고, 옮기면 사람이 가리킨 자리를 목차에서 못 찾는다
  // - **`admin`** — 이 제품의 고유어다(위 머리말의 그 규율)
  // ---------------------------------------------------------------------------

  /** 상세에서 격자로 돌아가는 길. 화살표까지 값에 든다 — `agents.detail.back` 과 같다. */
  'agents.teams.back': '← Teams',
  'agents.teams.cancel': 'Cancel',
  /** 후보 격자의 검색칸. `AgentGrid.shown` 과 **같은 판정**이라 같은 것을 훑는다고 적는다. */
  'agents.teams.candidateSearch': 'Search team candidates',
  'agents.teams.candidateSearchPlaceholder': 'Search by name or description',
  'agents.teams.create': 'Create',
  'agents.teams.createFailed': 'The team was not created',
  'agents.teams.delete': 'Delete team',
  'agents.teams.deleteConfirm': 'Delete for good',
  /** 물음이 **무엇을** 지우는지 말한다(위 표). */
  'agents.teams.deleteConfirmAsk': 'Delete this team?',
  'agents.teams.deleteFailed': 'The team was not deleted',
  'agents.teams.deleteHeading': 'Delete team',
  /** **무엇이 남는지**를 말한다 — 삭제 상자가 답해야 하는 물음이 그것이다. */
  'agents.teams.deleteNote': 'The agents that were in it stay — only the team goes',
  'agents.teams.detailFailed': 'The team details did not arrive',
  /**
   * 카드의 정보 줄. **한 줄뿐이다**(문서 4단계: 에이전트 카드의 세 줄과 갈리는 자리).
   * `Team` 은 무엇의 수인지를 말하고, 수 자체는 `{count}` 다 — `members` 를 붙이지
   * 않는 이유는 `identity.badge.count` 와 같다(그 수에 사람은 안 든다, 전부 에이전트다).
   */
  'agents.teams.cardInfo': 'Team · {count}',
  /** 목록을 못 받았을 때만 서는 줄. **만들 수는 있다**까지 말한다 — 그 사실이 빠지면
   *  사람은 이 화면이 통째로 죽은 줄 안다. */
  'agents.teams.gridUnavailable':
    'This server does not serve the team list — it is older than the app. You can still create a '
    + 'team, but it will not show up here; check again after the server is upgraded.',
  'agents.teams.gridEmpty': 'No teams yet',
  /** 검색이 아무것도 못 찾았을 때. `{query}` 는 사람이 친 글자 그대로다. */
  /** `grid.search.noMatch` 와 **같은 모양**이다 — 두 격자가 탭으로 갈리는 형제라 못 찾은
   *  말이 다르게 생기면 탭을 옮길 때마다 사람이 다시 읽는다. */
  'agents.teams.gridNoMatch': 'No team matches “{query}”',
  'agents.teams.gridSearch': 'Search teams',
  /** `grid.search.count` 와 같은 짝이다 — 한국어만 단위를 붙인다(그 키의 근거). */
  'agents.teams.gridSearchCount': '{count}',
  'agents.teams.gridSearchPlaceholder': 'Search by name',
  'agents.teams.heading': 'Teams',
  /** 팀 이름도 handle 문법이다 — 서버가 같은 상수로 검사한다(`HANDLE_PATTERN`). */
  'agents.teams.invalidName':
    'Names take letters, digits, hyphens and underscores — 2 to 32 characters',
  /**
   * 팀장의 뜻 — **지금 무엇을 바꾸는가**를 정직하게 적는다. 지정만 열렸고 멘션 라우팅은
   * 아직 명단 전체를 깨우므로(`services/messages.ts`), "창구가 하나로 좁혀졌다"고 읽히면
   * 사람은 팀을 부르고 나서야 그것이 아님을 안다.
   */
  'agents.teams.lead': 'Lead',
  'agents.teams.leadClear': 'Unset',
  'agents.teams.leadClearAction': 'Unset the lead: {handle}',
  'agents.teams.leadFailed': 'The lead was not changed',
  'agents.teams.leadNote':
    'A lead is the one member who speaks for the team. Calling @team still wakes every member — '
    + 'the lead is recorded here, not yet used for routing.',
  'agents.teams.leadSet': 'Make lead',
  'agents.teams.leadSetAction': 'Make the lead: {handle}',
  'agents.teams.listFailed': 'The team list did not arrive',
  'agents.teams.memberAddFailed': 'The agent was not added to the team',
  /**
   * 후보가 하나도 없을 때. **왜 비었는지까지 적는다** — `No agents` 면 사람은 등록된
   * 에이전트가 없는 줄 알고 엉뚱한 화면으로 간다.
   */
  'agents.teams.memberCandidateEmpty':
    'No agent left to add — every registered agent is already in this team',
  'agents.teams.memberCandidateNoMatch': 'No agent matches “{query}”',
  /**
   * 팀 호출에서 빠지는 팀원. **결과를 적는다**(위 표) — `Disabled` 만으로는 이것이
   * 러너가 죽은 것인지 계정이 꺼진 것인지 갈리지 않는다.
   */
  'agents.teams.memberDisabled': 'Disabled — left out when the team is called',
  /**
   * 카드 맨 아래의 예외 줄. **이름을 먼저 세운다** — 어느 팀원이 빠지는지가 답이고,
   * `agents.teams.memberDisabled` 와 갈리는 것은 그 하나다(그쪽은 명단의 한 줄이라
   * 이름이 이미 왼쪽에 있다).
   */
  'agents.teams.cardDisabled': '{names} are disabled — left out when the team is called',
  'agents.teams.memberEmpty': 'No members',
  'agents.teams.memberLoading': 'Loading…',
  /** 후보 얼굴의 접근 이름. **하는 일을 말한다** — 격자의 카드(상세를 여는 문)와 갈린다. */
  'agents.teams.memberPickAction': 'Add to the team: {handle}',
  /** 회색 얼굴을 눌러도 되는 이유가 뒤 문장에 있다(위 표). */
  'agents.teams.memberPickNote':
    'Click a face to add it. A stopped agent can join too — being in a team and running right '
    + 'now are different things.',
  'agents.teams.memberReadOnly': 'Only an admin can change who is in a team',
  'agents.teams.memberRemove': 'Remove',
  'agents.teams.memberRemoveAction': 'Remove from the team: {handle}',
  'agents.teams.memberRemoveFailed': 'The agent is still in the team',
  'agents.teams.membersHeading': 'Members',
  'agents.teams.nameEdit': 'Edit team name',
  'agents.teams.nameHeading': 'Team name',
  'agents.teams.nameLabel': 'New team name',
  /**
   * 이름의 뜻을 말하는 자리 ② — **이름을 정하는 순간**에 필요한 세 사실을 다 진다
   * (그 자리 주석: 이름 위가 아니라 입력칸 아래인 이유가 그것이다). `{name}` 은 화면이
   * 다른 색으로 세우는 자리라 문장에서 뽑혀 있다.
   */
  'agents.teams.nameNote':
    'A team name lives in the same namespace as an account — calling @{name} in a channel wakes '
    + 'every member. To call several people by one name, go to Settings › Handle Groups.',
  'agents.teams.nameSave': 'Save',
  'agents.teams.newTeam': 'New team',
  'agents.teams.renameFailed': 'The name was not changed',
  /** 이름의 뜻을 말하는 자리 ① — **이 격자에 있는 것이 무엇인가**에 답한다. */
  'agents.teams.note':
    'Group agents and call them by one name — calling @teamname in a channel wakes every member. '
    + 'Click a card to change who is in it.',

  // ---------------------------------------------------------------------------
  // daemonFacts — **판정 이름이지 화면 이름이 아니다**(`waitChain` 과 같은 근거).
  //
  // 이 말들은 `lib/daemonFacts.ts::daemonFactRows` 에서 나온다. 지금 그리는 화면은
  // 하나(`AgentsSettings` 의 상세)뿐이라 `agents.*` 에 붙일 수도 있었지만 **안 붙였다** —
  // 위 `agents` 머리말이 *"한 화면 = 한 영역"* 이라 적은 그 규칙의 예외가 `lib/` 판정이고,
  // 그 예외를 세운 것이 `waitChain` 머리말이다: 화면 이름으로 영역을 잡으면 **두 번째
  // 화면이 남의 키를 부르게 된다.** 이 판정은 그 조건에 이미 반쯤 걸려 있다 — daemon 이
  // 확인한 사실은 카드(`AgentGrid`)에도 팀 상세에도 설 수 있는 값이고, 실제로 회귀선이
  // *"격자에는 pid 가 없다"* 를 **문서의 결정으로** 잠가 뒀지 구조로 막아 두지 않았다.
  // 그 결정이 바뀌는 날 `agents.*` 였다면 격자가 `agents.runner.*` 를 부른다.
  //
  // | 덩어리 | 그 행 |
  // |---|---|
  // | `label` | 왼쪽 라벨 칸 — 행 이름 |
  // | `pid` | pid 행의 값에 붙는 세대 |
  // | `liveness` | 생사 행의 값 |
  // | `termination` | 종료 요청 행의 값 — **주어가 있는 문장** |
  // | `signal` | 시그널 행의 값 |
  //
  // ## 문장을 조각으로 쪼개지 않았다 — `waitChain.link` 가 금지한 그것
  //
  // 종료 요청 행은 `사람이 UI 에서 10:23 · 러너가 아직 못 읽음` 이다. 이것을
  // `'사람이 UI 에서'` + 시각 + `'·'` + `'러너가 아직 못 읽음'` 조각으로 두면 영어에서
  // 그 조각들이 갈 자리가 없다. 그래서 **자리표시자를 낀 통짜 문장**으로 둔다 —
  // 어순 전체가 각 언어의 것이다.
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 사람이 UI 에서 {time} | `A person asked from the UI at {time}` | **주어가 문장 앞에 선다** — 이 행의 존재 이유가 그것이다(`daemonProtocol.ts` 의 표: 주어를 빼면 두 사실이 서로를 반박하는 것처럼 읽힌다). `Requested from the UI` 는 수동이라 누가 했는지가 사라진다 |
  // | 러너가 아직 못 읽음 | `the runner has not read it yet` | `unacked` 는 우리 내부 낱말이다. `yet` 이 진다 — **아직**이 빠지면 '영영 못 읽는다'로 읽힌다 |
  // | 러너가 {time} 에 읽었다 | `the runner read it at {time}` | |
  // | daemon 이 시그널로 {time} | `The daemon signalled at {time}` | daemon 자신의 행위다. 위 문장과 **주어가 갈려야** 두 출처가 구별된다 |
  // | 없다 — 아무도 요청하지 않았다 | `None — no one asked` | `No request` 는 명사구라 **아무도**가 사라진다. 이 값은 두 출처를 다 보고서야 말할 수 있는 단정이라(그 함수 주석), 그 단정의 주체를 문장이 지녀야 한다 |
  // | daemon 은 안 보냈다 | `The daemon did not send one` | 이것도 **daemon 이 말한 `null`** 이지 결측이 아니다. `Not sent` 로 줄이면 그 구별이 사라진다 |
  // | {stamp} 에 SIGTERM · 보낸 지 {elapsed}, 아직 살아 있다 | `SIGTERM at {stamp} · sent {elapsed} ago, still alive` | **판정 낱말이 없다**(제약 2). `still alive` 는 사실이고 `not responding` 은 판정이다 — 후자를 쓰려면 러너의 롱폴링 예산을 알아야 하는데 아무도 모른다 |
  // | alive — kill(pid, 0) 확인 | `alive — confirmed with kill(pid, 0)` | **`alive`·`dead` 를 안 옮긴다** — `kill(pid, 0)` 이 내는 그 상태의 이름이고, 사람이 `ps` 와 daemon 로그에서 보는 말이다 |
  // | dead — kill(pid, 0) 이 실패했다 | `dead — kill(pid, 0) failed` | **어떻게 알았는지**가 값에 남는다. 관측이지 판단이 아니라는 것이 이 구획 전체의 태도다 |
  // | 가동 | `Uptime` | |
  // | 생사 | `Liveness` | `Alive?` 는 물음이라 라벨이 아니다. `Status` 는 이 화면의 다른 상태들과 겹친다 |
  // | 종료 요청 | `Stop request` | `Termination` 은 시그널 쪽 낱말이라 아래 행과 겹친다. 사람이 UI 에서 건 것은 **요청**이다(`#493` 이 그 낱말을 정했다) |
  // | 시그널 | `Signal` | |
  // | 세대 {id} | `incarnation {id}` | daemon 장부의 필드 이름이 `incarnationId` 다 — 사람이 로그에서 보는 그 말이어야 한다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`pid`** — 라벨이자 필드 이름이다. 옮기면 사람이 `ps` 로 확인할 때 쓰는 말과 갈린다.
  //   그래도 **키는 만든다**(`daemonFacts.label.pid`) — 값이 같은 것과 사전 밖에 있는 것은
  //   다르고, 라벨 넷 중 하나만 하드코딩으로 남으면 다음 사람이 그 자리를 못 찾는다
  // - **`SIGTERM` · `kill(pid, 0)` · `daemon` · `alive` · `dead`** — 고유어이자 실제 호출·상태
  //   이름이다(`agents` 머리말의 `admin`·`PAT`·`harness` 와 같은 규율)
  // - **시각(`2026-09-07 16:05` · `10:23`) · 경과** — `stamp()`·`clock()` 이 만드는 숫자이고,
  //   경과는 `lib/time.ts` 가 그 언어로 낸다. **숫자는 `Intl` 이, 뜻은 사전이**
  // ---------------------------------------------------------------------------

  'daemonFacts.label.liveness': 'Liveness',
  'daemonFacts.label.pid': 'pid',
  'daemonFacts.label.signal': 'Signal',
  'daemonFacts.label.termination': 'Stop request',
  'daemonFacts.label.uptime': 'Uptime',

  /** **`alive` 를 안 옮긴다** — `kill(pid, 0)` 이 내는 상태의 이름이다(위 표). */
  'daemonFacts.liveness.alive': 'alive — confirmed with kill(pid, 0)',
  'daemonFacts.liveness.dead': 'dead — kill(pid, 0) failed',

  /** pid 옆에 붙는 세대. daemon 장부의 필드 이름(`incarnationId`)을 그대로 쓴다. */
  'daemonFacts.pid.incarnation': 'incarnation {id}',

  /**
   * daemon 이 **말한** `null` 이다("내가 안 보냈다") — 결측이 아니다. 그 구별이 이 행이
   * 서느냐 마느냐를 가르므로(규칙 06) 문장도 **주어를 갖는다**.
   */
  'daemonFacts.signal.none': 'The daemon did not send one',
  /** 이미 죽었다 — 기다림을 적을 이유가 없다. */
  'daemonFacts.signal.sent': 'SIGTERM at {stamp}',
  /**
   * 보냈는데 아직 살아 있다. **경과만 적고 판정하지 않는다**(제약 2) — `still alive` 는
   * 사실이고, `not responding`·`stuck` 은 판정이다. 그 판정을 하려면 러너의 롱폴링
   * 예산을 알아야 하는데 daemon 도 이 화면도 그것을 모른다.
   */
  'daemonFacts.signal.sentStillAlive': 'SIGTERM at {stamp} · sent {elapsed} ago, still alive',

  /**
   * 사람이 UI 에서 건 요청. **주어가 문장 앞에 선다** — 이 행의 존재 이유가 그것이다.
   * `{read}` 에 아래 둘 중 하나가 **통째로** 들어간다(조각이 아니라 문장이다).
   */
  'daemonFacts.termination.byPerson': 'A person asked from the UI at {time} · {read}',
  'daemonFacts.termination.bySignal': 'The daemon signalled at {time}',
  /**
   * 아무도 요청하지 않았다. **두 출처를 다 봤을 때만** 말할 수 있는 단정이라(그 함수
   * 주석) 문장이 그 단정을 지닌다 — `No request` 는 명사구라 '아무도'가 사라진다.
   */
  'daemonFacts.termination.none': 'None — no one asked',
  'daemonFacts.termination.read': 'the runner read it at {time}',
  /** **`yet` 이 진다** — 빠지면 '영영 못 읽는다'로 읽힌다. */
  'daemonFacts.termination.unread': 'the runner has not read it yet',

  /**
   * 가동 행. **절대 시각과 경과를 함께 적는다** — 사람이 뺄셈하게 만들지 않는다(회귀선의
   * 축 이름 그대로다). 한국어의 `부터` 는 시각 **뒤**에 붙는 조사이고 영어의 `since` 는
   * 시각 **앞**에 서는 전치사라, 그 말을 코드에 두면 한쪽 어순이 굳는다.
   */
  'daemonFacts.uptime.since': 'since {stamp} · {elapsed}',

  // ---------------------------------------------------------------------------
  // runner — **판정 이름이다**(`lib/runnerLauncher.ts`). 화면 이름이 아니다.
  //
  // 이 말들은 러너 상태(`RunnerState.message`)로 올라가고, 그것을 그리는 화면이 **이미
  // 넷이다**: `AgentGrid`(카드) · `AgentsSettings`(상세) · `Sidebar`(러너 줄) ·
  // `dmMergedList`(DM 목록의 사유 줄). `waitChain` 머리말이 둘로도 충분하다고 한 그
  // 조건을 이 판정은 두 배로 넘긴다 — 화면 이름을 골랐다면 나머지 셋이 남의 키를 부른다.
  //
  // | 덩어리 | 무엇 |
  // |---|---|
  // | `launch` | 기동 경로의 실패 — daemon 에 못 닿음 · 키체인 · 알 수 없는 예외 |
  // | `restart` | 재기동 · 앞 세대가 물러나기를 기다리는 중 |
  // | `reissue` | PAT 재발급 — 회전 중과 그 뒤에 남은 일 |
  // | `exit` | 러너가 78 로 죽은 뒤의 **사유 판정**(`exitStateFor78`) |
  // | `stranger` | 장부에 없는데 서버에는 붙어 있는 러너 |
  //
  // ## 러너 실패 사유는 **뭉치면 안 된다** — 사람이 할 일이 갈린다
  //
  // 이 영역에서 가장 중요한 것이 `exit.*` 다. `#473`·`#476` 이 만든 갈림이고,
  // 영어 원본이 그 갈림을 **그대로 져야** 한다:
  //
  // | 사유 | 사람이 할 일 |
  // |---|---|
  // | `exit.notFound` | 하네스를 **설치**한다 (그리고 어디서 받는지까지 말한다) |
  // | `exit.loginRequired` | 그 CLI 로 **로그인**한다 |
  // | `exit.credentialRejected` | murmur 설정에서 PAT 를 **재발급**한다 |
  // | `exit.unknown*` | **아무것도 단정하지 않는다** — 로그를 보여 주고 사람이 판단한다 |
  //
  // 앞 셋을 `Configuration problem` 같은 한 문구로 접으면 사람은 셋 다에 대해 같은
  // 일을 시도하고 두 번은 틀린다. 넷째를 앞 셋 중 하나로 접는 것이 정확히 `#473` 이
  // 고친 결함이라, 영어에서도 **"가리지 못했다"가 문장에 남는다.**
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 기동 실패: {reason} | `The runner did not start: {reason}` | `en.ts` 머리말의 `The X was not Yed` 규율 — **결과 상태**로 쓴다. `Launch failed` 는 동작이 실패했다만 말한다 |
  // | daemon 에 닿지 못해 러너를 띄우지 않았다 | `The daemon could not be reached, so no runner was started` | **인과가 한 문장에 있다.** `so` 앞뒤를 자르면 "daemon 이 안 됐다"와 "러너가 안 떴다"가 따로 읽히고, 사람은 둘을 별개 사고로 센다 |
  // | 찾을 수 없다 — 설치하고 PATH 에 있는지 확인하라 | `{what} was not found — install it and make sure it is on PATH` | **무엇을**(이름) + **어떻게**(설치·PATH) 둘 다. `#473` 이 앞을, `#476` 이 뒤를 넣었고 영어가 둘 다 져야 한다 |
  // | 이 에이전트의 하네스({name}) | `this agent's harness ({harness})` | 실행 파일 이름을 모를 때의 대체. **`harness` 는 안 옮긴다**(고유어) |
  // | 알 수 없음 | `unknown` | 하네스 이름조차 없을 때. 지어내지 않는다(`#368`) |
  // | 로그인이 풀렸다 | `is no longer logged in` | `Login required` 는 상태만 말하고 **전에는 됐다**를 안 말한다. 사람은 이것을 첫 설정으로 오해해 엉뚱한 곳을 본다 |
  // | 터미널에서 `{binary}` 를 실행해 다시 로그인하면 살아난다 | `run {binary} in a terminal and log in again` | 한 줄짜리 명령이 실제로 필요한 것이다 |
  // | PAT 가 폐기·회전됐다 — 재발급하면 다시 뜬다 | `The PAT was revoked or rotated — minting a new one brings it back` | **대조군이다**(그 함수 주석) — 문구를 옮기되 뜻을 바꾸지 않는다 |
  // | 설정 문제로 물러났다(78) — 사유를 가리지 못했다 | `It exited over a configuration problem (78) — the reason could not be told apart` | **`78` 을 안 옮긴다**(종료 코드는 숫자다). *"가리지 못했다"* 가 이 갈래의 전부라 영어에서도 남는다 |
  // | 러너 로그 마지막 줄: {excerpt} | `The last lines of the runner log: {excerpt}` | 러너가 한 말을 그대로 보인다(`#368`) — 앱이 다시 설명하지 않는다 |
  // | 키체인을 읽지 못했다 — 돌고 있는 러너를 죽일 수 있어 새로 발급하지 않았다 | `The keychain could not be read — no new PAT was minted, since that could kill a running runner` | **안 한 일과 그 이유**가 요점이다. 이 문장에서 `since` 절을 빼면 사람은 앱이 게으르다고 읽는다 |
  // | 앞 세대 러너가 진행 중인 턴을 끝내고 물러나는 중이다 — 끝나면 새로 띄운다 | `The previous runner is finishing its turn before stepping down — a new one starts when it does` | 2026-09-08 사고가 만든 문장이다. **침묵이 그 사고의 시작**이었으므로(사람이 고장으로 읽고 다시 눌렀다) 지금 무엇이 일어나는지와 **다음에 무엇이 일어나는지**를 둘 다 말한다 |
  // | 러너가 아직 물러나지 않았다 — 진행 중인 턴이 길다 | `The runner has not stepped down yet — the turn in flight is long` | `Timeout` 이 아니다. 상한에 걸린 것은 우리 기다림이지 러너가 아니고, **러너는 정상이다** |
  // | 옛 PAT 는 그대로 살아 있다 | `the old one is still alive` | **아무것도 잃지 않았다**가 이 문장의 값이다 |
  // | 설정에서 손으로 폐기해라 | `revoke it by hand in the settings` | 남은 일을 말한다 |
  // | 그 턴은 답을 남기지 못한다 | `that turn will not leave an answer` | 손으로 끊을 때의 **대가**다. 이것을 빼면 사람은 공짜인 줄 알고 끊는다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`throw new Error(...)` 여섯 자리** — 사람에게 가는 말이 아니다. `tauriInvoke()` 가
  //   `null` 인 것(브라우저 개발)과 daemon 응답이 계약과 다른 것은 **개발자가 보는 계약
  //   위반**이고, 이 문자열들은 그대로 `errText(err)` 에 실려 위 `launch.failed` 의
  //   `{reason}` 안에 들어간다. 사전에 넣으면 번역된 예외 메시지를 로그에서 찾게 된다
  // - **`installHint()`(`packages/shared`)** — **이 파일 밖이다.** `exit.notFound` 뒤에 붙는
  //   설치 안내 한 줄이 아직 한국어인데, 그것은 서버·러너가 함께 쓰는 패키지라
  //   데스크탑 사전이 닿을 수 없다(`Translate` 를 shared 로 내리는 것은 이 PR 의 범위가
  //   아니다). 사이드바 PR 이 지킨 그 경계와 같다
  // - **PAT 라벨(`desktop:<id>#<epoch>`) · 실행 파일 이름(`claude`·`codex`) · 종료 코드 `78`** —
  //   저장·전송용 값이고 사람이 터미널에서 보는 그 글자다
  // - **`errText(err)` 의 내용** — 러너·daemon·OS 가 한 말이다. 앱이 다시 쓰지 않는다(`#368`)
  // ---------------------------------------------------------------------------

  /**
   * 78 로 죽었는데 PAT 가 거절됐다. **대조군이다** — `#473` 이 고친 것은 78 을 전부
   * 이쪽으로 보내던 것이지 이 갈래 자체가 아니라, 뜻을 그대로 옮긴다.
   */
  'runner.exit.credentialRejected': 'The PAT was revoked or rotated — minting a new one brings it back',
  /**
   * 로그인이 풀렸는데 실행 파일 이름을 안다. **한 줄짜리 명령을 준다** — `#476` 이
   * 세운 규율이다(`Login required` 는 어디를 볼지 안 말한다).
   */
  'runner.exit.loginRequired': '{what} is no longer logged in — run {binary} in a terminal and log in again',
  /** 이름을 모를 때. 그때는 명령을 지어내지 않고 **그 CLI** 라고만 말한다(`#368`). */
  'runner.exit.loginRequiredNoBinary': '{what} is no longer logged in — log in again with that CLI',
  /**
   * 실행 파일이 없다. **무엇이 없는지와 어떻게 채우는지를 둘 다** 말한다(`#473`+`#476`).
   * `{hint}` 는 `installHint()` 가 준 한 줄이고, 없으면 아래 `notFoundNoHint` 를 쓴다 —
   * 지어내지 않는다.
   */
  'runner.exit.notFound': '{what} was not found — install it and make sure it is on PATH. {hint}',
  'runner.exit.notFoundNoHint': '{what} was not found — install it and make sure it is on PATH',
  /**
   * 실행 파일 이름을 모를 때 `{what}` 자리에 들어가는 말. `{harness}` 에 하네스 이름이
   * 오고, 그것도 없으면 아래 `subjectHarnessUnknown` 이 그 자리에 들어간다.
   */
  'runner.exit.subjectHarness': "this agent's harness ({harness})",
  'runner.exit.subjectHarnessUnknown': 'unknown',
  /**
   * 78 인데 사유를 못 가렸다. **이 갈래가 `#473` 이 만든 것이다** — 앞 셋 중 하나로
   * 접으면 사람이 틀린 일을 한다. *"가리지 못했다"* 가 영어에도 남아야 하는 이유다.
   */
  'runner.exit.unknown':
    'It exited over a configuration problem (78) — the reason could not be told apart. '
    + 'Check the runner log',
  /** 로그 꼬리가 있을 때. **러너가 한 말을 그대로 보인다** — 앱이 다시 설명하지 않는다. */
  'runner.exit.unknownWithLog':
    'It exited over a configuration problem (78) — the reason could not be told apart. '
    + 'The last lines of the runner log: {excerpt}',

  /**
   * daemon 에 못 닿아 아무것도 안 띄웠다. **인과가 한 문장에 있다** — 자르면 사람은
   * "daemon 이 안 됐다"와 "러너가 안 떴다"를 별개 사고로 센다.
   */
  'runner.launch.daemonUnreachable': 'The daemon could not be reached, so no runner was started: {reason}',
  /** 그 밖의 실패. **결과 상태로 쓴다**(`The X was not Yed` 규율). */
  'runner.launch.failed': 'The runner did not start: {reason}',
  /**
   * 키체인을 못 읽었다. **여기서 발급으로 넘어가지 않는 것이 요점**이라 그 사실을
   * 사람에게도 말한다 — `since` 절을 빼면 사람은 앱이 게으르다고 읽는다.
   */
  'runner.launch.keychainUnreadable':
    'The keychain could not be read — no new PAT was minted, since that could kill a running runner: {reason}',
  /** 계정은 만들어졌다. **그 사실을 먼저 말한다** — 안 그러면 사람은 처음부터 다시 만든다. */
  'runner.launch.patNotStored':
    'The agent was created, but its PAT was not stored in the keychain, so no runner was started: {reason}',

  /** 키체인을 못 읽어 옛 것을 못 지운다. 그래서 **발급도 안 했다**. */
  'runner.reissue.keychainUnreadable':
    'The keychain could not be read, so the old PAT cannot be revoked — nothing was re-minted: {reason}',
  /** 발급 자체가 실패했다. **아무것도 잃지 않았다**가 이 문장의 값이다. */
  'runner.reissue.mintFailed': 'A new PAT was not minted — the old one is still alive: {reason}',
  /**
   * 옛 러너가 아직 그 PAT 로 돌고 있어 폐기를 미뤘다. **왜 미뤘는지와 지금 끊으면
   * 무엇을 잃는지**를 함께 말한다 — 대가를 안 적으면 사람은 공짜인 줄 알고 끊는다.
   */
  'runner.reissue.revokeDeferred':
    'Starting again with the new PAT. The old one ({label}) was not revoked — a runner is still '
    + 'finishing its turn with it (it steps down on its own when done). If you must cut it now, '
    + 'revoke it by hand in the settings — that turn will not leave an answer.',
  /**
   * 재발급했는데 옛 PAT 를 못 지웠다. **남은 일을 말한다** — 폐기되지 않은 PAT 가
   * 남았고 그것은 사람이 알아야 하는 상태다.
   */
  'runner.reissue.revokeFailed':
    'Started again with the new PAT, but the old one ({label}) was not revoked — '
    + 'revoke it by hand in the settings: {reason}',
  /** 회전 중. **기다림을 화면에 적는다** — 그 침묵이 2026-09-08 사고의 시작이었다. */
  'runner.reissue.waiting': 'Got a new PAT — waiting for the old runner to finish its turn and step down',

  /** daemon 에 종료를 못 전했다 — 재기동이 시작조차 안 됐다. */
  'runner.restart.killFailed': 'It could not be restarted — the daemon was not told to stop it: {reason}',
  /** 죽기는 했는데 다시 띄울 상대가 없다. **어디까지 됐는지**를 말한다. */
  'runner.restart.respawnUnreachable':
    'The runner stepped down, but the daemon could not be reached to start it again: {reason}',
  /**
   * 상한에 걸렸다. **`Timeout` 이 아니다** — 상한에 걸린 것은 우리 기다림이고
   * 러너는 정상이다. 그리고 **다음에 무엇이 일어나는지**까지 말한다.
   */
  'runner.restart.stillRunning':
    'The runner has not stepped down yet — the turn in flight is long. The stop request has already '
    + 'gone, so it comes up on the new bundle at the next start.',
  /**
   * 앞 세대가 물러나기를 기다린다. 2026-09-08 사고가 만든 문장이라 **지금 무엇이
   * 일어나는지와 다음에 무엇이 일어나는지**를 둘 다 말한다.
   */
  'runner.restart.waitingForRetirement':
    'The previous runner is finishing its turn before stepping down — a new one starts when it does',

  /**
   * 장부에 없는데 서버에는 붙어 있다. **실패가 아니다** — 러너는 떴고 상태는 `running`
   * 이다. 이 문장이 붙는 이유는 *"이 계정으로 내가 모르는 러너가 하나 더 붙어 있을 수
   * 있다"* 가 사람이 알아야 할 사실이기 때문이다(`#430` 이 기록한 오독).
   */
  'runner.stranger.attached':
    "A runner for this account is attached to the server but is not in this daemon's ledger — "
    + 'a new one was started for this app',

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
  // | `menu` | 채널 행 우클릭 메뉴 |
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

  // ---------------------------------------------------------------------------
  // find — 사이드바 맨 위의 찾기 줄(`components/SidebarFind.tsx`).
  //
  // **새 영역을 열지 않았다.** 그 컴포넌트는 파일만 갈렸을 뿐 `Sidebar.tsx` 가 자기
  // 껍데기 안에서 그리는 한 줄이고(그 파일 주석: *"이 줄은 `Sidebar` 의 공용 껍데기에
  // 산다"*), 위 머리말의 *"한 화면 = 한 영역"* 이 그대로 걸린다. `sidebarFind` 를 따로
  // 열면 같은 화면이 두 영역으로 갈려, 다음 사람이 사이드바의 말을 찾을 때 두 곳을 본다.
  //
  // ## 종류 글자 셋 중 **둘은 새로 안 만들었다**
  //
  // `KIND_LABEL` 이 `채널`·`사람`·`에이전트` 셋을 낸다. 뒤의 둘은 `sidebar.members
  // .kindHuman`·`kindAgent` 가 **이미 같은 화면에서 같은 뜻으로** 쓰고 있다 — 이름 옆에
  // 붙어 *"이것이 사람인가 에이전트인가"* 에 답하는 꼬리표다. 승격 기준(위 머리말)이
  // *"글자가 같다"* 가 아니라 *"뜻이 하나다"* 인데 여기는 뜻도 하나라, 새 키를 만들면
  // 한 화면이 같은 말을 두 벌 들고 그중 하나만 고쳐지는 날이 온다.
  //
  // 그래서 **`kindChannel` 하나만** 이 덩어리에 선다. `common` 으로 올리지 않은 이유는
  // 머리말의 그 규칙이다 — 부르는 화면이 아직 사이드바 하나다.
  // ---------------------------------------------------------------------------

  /** 이 줄이 못 하는 일(보관·생성순·아직 안 들어간 채널)로 가는 다음 걸음. */
  'sidebar.find.allChannels': 'Search all channels',
  /** 종류 꼬리표 중 채널. 나머지 둘은 `sidebar.members.kind*` 를 그대로 쓴다(위 머리말). */
  'sidebar.find.kindChannel': 'Channel',
  /** 입력칸의 접근 이름. 무엇이 걸리는지는 아래 placeholder 가 말한다. */
  'sidebar.find.label': 'Search',
  /**
   * **아무것도 안 걸렸다.** `No results` 로 두지 않는 이유는 이 줄이 서는 순간이 사람이
   * 글자를 이미 친 뒤라서다 — 그때 답해야 하는 것은 "결과가 0이다"라는 집계가 아니라
   * **"그런 것이 없다"** 는 사실이다(`grid.search.noMatch` 와 같은 축).
   */
  'sidebar.find.none': 'Nothing matches',
  /**
   * **무엇이 걸리는지를 placeholder 가 말한다** — 그 컴포넌트 주석이 이것을 유일한
   * 자리로 지목했다: 안 적으면 이 칸은 채널만 걸리던 옛 돋보기로 읽힌다.
   */
  'sidebar.find.placeholder': 'Channels · people · agents',

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
  // message — **메시지 행 하나에 매달린 말**(`components/MessageItem.tsx` 와 그 행이
  // 품는 `Attachments`·`NotifiedGapRow`, 그리고 대화가 흐르는 자리의 입력 중 줄).
  //
  // **#624 가 세 마디로 열었고 이 PR 이 나머지를 채웠다.** 그 머리말이 적어 둔
  // *"새로 생기는 말만 사전을 지나게 한다"* 는 유예가 끝났다는 뜻이다.
  //
  // ## 왜 `speech` 와 갈리나 — **행 자신의 말 / 그 안에 든 말**
  //
  // 이 묶음에서 가장 갈리기 쉬운 자리라 먼저 적는다. 아래 `speech.*` 는 **여덟 가지
  // 말 자신의 어휘**(카드가 스스로 하는 말)이고, 여기 `message.*` 는 **그 카드를
  // 얹고 있는 행의 살림**(수신자 배지 · 답글 요약 · 첨부 · 부름의 결과)이다.
  //
  // 가르는 이유가 하나 더 있다: `speech.*` 는 갤러리가 기준자로 다시 그리는 어휘라
  // 화면 넷이 부르고, `message.*` 는 이 행 말고는 그릴 자리가 없다. 한 영역으로
  // 묶으면 갤러리가 행의 살림까지 부르게 되고 그 경계가 흐려진다.
  //
  // **덩어리는 행의 실제 구획을 따른다.**
  //
  // | 덩어리 | 그 구획 |
  // |---|---|
  // | (없음) | 이름줄 옆 · 본문 아래 한 마디짜리들(`channelEcho`·`recentReplies`·…) |
  // | `audience` | 수신자 배지 — `→ 나` / `→ forge` |
  // | `attachment` | 첨부 칩 · 확대 보기 |
  // | `model` | 이름줄의 모델 툴팁과 어긋남 경고 |
  // | `notified` | 집합·팀을 불렀는데 덜 깬 줄(`NotifiedGapRow`) |
  // | `summary` | 답글 요약 — 수 · 마지막 시각 · 접근 라벨 |
  // | `typing` | 입력 중 줄(`TypingLine`) |
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 채널에도 전송됨 | `Also sent to the channel` | 상태(과거)다. `Send to channel` 은 동작이라 누를 것처럼 보인다 — 이것은 배지이지 버튼이 아니다 |
  // | 스레드에 댓글 남김 | `Replied in a thread` | `In thread` 는 자리만 말하고 **무슨 일이 있었나**가 빠진다. 이 사본은 답글이므로 동작이 주어다 |
  // | 최근 댓글 보기 | `View recent replies` | `View in thread`(옛 문구)는 목적지를 말했다. 새 목적지는 스레드 머리가 아니라 **이 말 뒤의 댓글**이라 그것을 말한다 |
  // | → 나 | `→ you` | **화면이 사람에게 말한다**(2인칭). `→ me` 는 화면이 자기를 가리키는 말이 되어, 이 배지가 답하는 질문("이게 내 일인가")과 어긋난다 |
  // | → 사람 | `→ a person` | `AskAudience` 의 `'human'` = 사람 아무나. `common.someone` 을 안 쓴 이유는 **그것이 답한 사람의 이름 자리**라서다(`speech.ask.answeredBy`) — 여기서는 **받을 쪽의 종류**를 말한다 |
  // | 다른 에이전트 | `another agent` | 이름을 모를 때. `unknown` 은 아무것도 안 말하고, `agent` 는 그 계정이 에이전트라는 사실만은 확실하므로 그것을 말한다 |
  // | 스레드에 답글 달기 | `Reply in a thread` | 동작이다(버튼의 `title`·`aria-label`). 위 `threadOrigin` 은 **일어난 일**이라 과거형인 것과 짝을 이룬다 |
  // | 스킬 승인 화면 열기 | `Open the skill approval screen` | **목적지를 말한다.** `Approve` 는 이 버튼이 승인 자체를 한다고 읽히는데, 실제로는 설정을 열 뿐이다 |
  // | {n}명을 불렀는데 {m}명만 깼다 | `{called} were called, {woke} woke up` | 수가 둘인 한 문장이다. **조각으로 쪼개지 않는다** — 한국어는 `불렀는데`(역접 연결어미)가 두 수를 잇고 영어는 쉼표가 잇는데, 그 이음매의 자리가 언어마다 다르다 |
  // | 확대 보기 닫기 | `Close the enlarged view` | `Close` 만 두면 스크린리더 목록에서 이 행의 다른 닫기들과 구별되지 않는다 |
  // | (미리보기 실패) · (불러오기 실패) | `(preview failed)` · `(could not load)` | **둘을 안 합친다** — 앞은 "원래 미리보기가 없는 것"과 가르는 표시이고 뒤는 파일 자체를 못 받은 것이다(그 파일 주석의 실측) |
  // | {n}명이 입력 중… | `{count} people are typing…` | 복수형이 실제로 갈린다. 이름을 늘어놓는 갈래(`typing.names`)와 수만 말하는 갈래(`typing.count`)를 **사전에서도 갈라 둔다** — 그 갈림이 화면의 판단(`MAX_NAMES`)이지 언어의 것이 아니어서, 한 키로 묶으면 번역자가 왜 둘인지 모른다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`Save`·`Cancel`·`Delete message?`·`Delete`·`More actions`·`message toolbar`** —
  //   **이미 영어다.** `en.ts` 머리말의 남은 것 표가 *"키만 씌우면 된다"* 로 따로 잡아 둔
  //   묶음이고, 그중 `Save`·`Cancel` 은 `common` 승격 판단이 아직 안 끝났다(같은 머리말의
  //   *"`common` 이 아직 비어 있는 이유"*). 이 PR 이 한국어를 옮기면서 그 판단을 앞당기지 않는다
  // - **`⋯`·`↩`·`×`·`📎`·`⚠️`·`#↵`·`↔`·`+N`** — 글자가 아니라 **기호**다. 어느 언어에서도 같다
  // - **파일 이름 · 첨부 크기(`1.2 KB`)** — 데이터이고, 크기는 `Intl` 이 아니라 바이트 계산이 낸다
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // composer — **화면 이름이다.** `components/Composer.tsx` 가 그리는 말이고, 이 말들을
  // 내는 판정이 `lib/` 에 없다: 작성창이 스스로 쓰는 라벨·오류·안내다.
  //
  // 영역 이름이 `channel.composer` 가 아닌 이유는 `agents` 머리말의 *"한 화면 = 한 영역"*
  // 그대로다 — 작성창은 채널·스레드·DM 어디에나 서는 **자기 완결된 화면**이고, 채널
  // 영역을 만들어 그 아래 넣으면 셋째 칸을 작성창의 구획이 다 먹는다.
  //
  // | 덩어리 | 그 구획 |
  // |---|---|
  // | `attach` | 첨부 — 끌어다 놓기 · 업로드 실패 |
  // | `mention` | 멘션 칩 · 「부를 상대」 줄 |
  // | `schedule` | 예약 발송 — 겹창 · 목록 · 취소 |
  // | `send` | 전송 · 보냄 취소(대기 줄) |
  //
  // 덩어리 안은 **키 이름 알파벳순**이다(근거는 `sidebar` 머리말과 같다 — 리베이스).
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 여기에 놓으면 첨부된다 | `Drop to attach` | 원래 문장은 조건절이지만 이것은 **끌고 있는 1초 동안만 뜨는 글자**다. 영어에서 조건절(`If you drop it here…`)은 그 순간에 읽히지 않는다 — 명령형이 곧 그 자리가 무엇을 받는지를 말한다 |
  // | 자동 | `Auto` | 칩 안의 배지다. `sidebar.members.autoMentionBadge` 가 **이미 같은 말을 같은 뜻으로** 쓰고 있다 — 아래 `common` 판단 참고 |
  // | 부를 상대 | `Reaching` | `Recipients` 는 이미 보낸 것의 명단으로 읽힌다. 이 줄은 **아직 안 보낸 본문**이 지금 부르고 있는 것이라, 진행형이 그 미완을 진다 |
  // | 보내는 중… | `Sending…` | |
  // | 보냄 취소 | `Undo` | 원래 `aria-label` 이 이미 `Undo send` 였다 — 보이는 글자를 그 이름과 어긋나게 두지 않는다. 버튼이 대기 줄 안에 서므로 `send` 는 문맥이 이미 말한다 |
  // | 보내지 못함 | `Not sent` | `Failed` 는 동작을 탓하고, 이 줄이 말하는 것은 **그 글이 지금 안 나갔다**는 상태다(`en.ts` 머리말의 `The X was not Yed` 와 같은 축) |
  // | 나중에 보내기 | `Send later` | |
  // | 예약 발송 | `Schedule this message` | 겹창 제목이다. `Schedule` 한 낱말은 명사(일정표)로도 읽혀 무엇을 예약하는지가 빠진다 |
  // | 예약 {n}건 | `{count} scheduled` | 수량이라 복수형이 갈릴 것 같지만 **안 갈린다** — `scheduled` 는 여기서 형용사이고 셀 수 있는 명사가 아니다(`1 scheduled` · `2 scheduled` 둘 다 맞다) |
  // | 첨부 {n}개 | `{count} attachment(s)` | **여기는 갈린다** — 명사를 세기 때문이다. 그래서 복수형 묶음이다 |
  // | ({n}명) | `({count})` | **숫자만 남긴다.** 한국어의 `명`은 사람 세는 단위인데 집합에는 에이전트도 든다 — 원래 문구가 이미 부정확했고, 영어에서 `people` 로 옮기면 그 부정확이 굳는다. 괄호 안의 수가 `@release` 옆에 서면 그것이 구성원 수라는 것은 자리가 말한다 |
  // | (채널 전체) | `(everyone here)` | `(whole channel)` 은 채널이라는 **그릇**을 가리키고, 이 줄이 세는 것은 그 안의 **사람들**이다. 위 `({count})` 와 같은 축에 서야 한다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`m.failedReason`** — 서버가 준 사유다. `sidebar.runner.launchFailed` 가 `{reason}` 을
  //   감싸기만 하는 것과 같은 경계다
  // - **`placeholder` prop** — 이 화면이 짓는 말이 아니라 **호출자가 넘기는 값**이다
  //   (`ChannelPane` 의 `Message {target}` · `ThreadPanel` 의 `Reply…`). 둘 다 이미 영어이고,
  //   옮기는 것은 그 화면들의 몫이다
  // - **`@` · `📎` · `🕐` · `×` · `▼` · `▶`** — 글자가 아니라 기호다. 접근 이름은 이미 영어였다
  // ---------------------------------------------------------------------------

  /** 끌고 있는 동안만 뜬다 — 그래서 조건절이 아니라 명령형이다(위 표). */
  'composer.attach.drop': 'Drop to attach',
  /**
   * 업로드 실패. **크기를 단정하지 않는다** — 화면은 서버가 왜 거절했는지 모르고
   * (413 인지 다른 이유인지), 원래 한국어도 `~일 수 있다`로 그 모름을 지고 있었다.
   * 그 모름을 지우면 사람은 파일을 줄여 다시 시도하다가 진짜 이유를 못 찾는다.
   */
  'composer.attach.uploadFailed': '{filename} was not uploaded — it may be over the size limit',

  'composer.mention.autoBadge': 'Auto',
  /**
   * 자동 멘션 칩의 `title`. **`sidebar.members.autoMentionNote` 와 한 쌍이다** — 그쪽이
   * *"작성창의 칩 × 로 한 번만 뺀다"* 고 약속했으므로, 이 칩은 자기가 **채널이 건 것**임을
   * 말해야 그 약속의 대상임이 읽힌다. `Auto-mentioned` 만 두면 누가 걸었는지가 빠진다.
   */
  'composer.mention.autoTitle': 'This channel mentions it automatically',
  /** 채널 전체를 부르는 이름 옆. **그릇이 아니라 사람들을 센다**(위 표). */
  'composer.mention.channelAll': '(everyone here)',
  /**
   * 집합·팀의 구성원 수. **단위를 안 적는다** — 그 집합에는 사람도 에이전트도 들고,
   * 한국어의 `명`은 앞엣것만 세는 말이라 원래 문구가 이미 부정확했다(위 표).
   */
  'composer.mention.groupCount': '({count})',
  'composer.mention.reaching': 'Reaching',
  /** 위 줄의 접근 이름. 보이는 글자와 같은 말이라 한 키로 두지 않는 이유가 없다. */
  'composer.mention.reachingLabel': 'Reaching',

  /** 붙여넣은 퍼머링크 줄. 이동은 옆 버튼을 누를 때만 일어난다. */
  // 붙여넣기가 부르는 이름(2단계). `composer.link.*` 와 같은 자리에 서는 제안 줄이라
  // 이름도 그 옆에 둔다 — 두 줄은 "컴포저가 지금 무엇을 들고 있는가"를 말한다.
  'composer.paste.calls': 'Pasted text calls {handles}',
  'composer.paste.quote': 'Quote it instead',
  'composer.paste.keep': 'Leave it as it is',
  'composer.paste.confirmTitle': 'Call {count} names?',
  'composer.paste.confirmDetail': 'This message calls {handles}. Each one starts its own turn.',
  'composer.paste.confirmSend': 'Send',
  'composer.paste.confirmCancel': 'Keep editing',
  /**
   * 긴 글을 붙여넣었을 때 서는 줄. **몇 자인지 말하는 것이 요점이다** — "길다"만으로는
   * 사람이 파일로 옮길 만한지 판단할 수 없다. 무엇이 문제인지도 함께 적는다: 상한을 넘긴
   * 것이 아니라 **읽는 사람의 화면이 밀리는** 것이 이 줄이 서는 이유다.
   */
  'composer.paste.long': '{chars} characters — pasting this inline buries the conversation',
  'composer.paste.asFile': 'Attach as a file',
  'composer.paste.moving': 'Attaching…',
  'composer.link.pasted': 'Pasted a message link',
  'composer.link.open': 'Go to that message',

  'composer.schedule.cancel': 'Cancel',
  /** 예약 하나를 무르는 `×` 의 접근 이름. 위 `cancel`(겹창을 닫는 것)과 **다른 일이다.** */
  'composer.schedule.cancelOne': 'Cancel this scheduled message',
  'composer.schedule.cancelFailed': 'The scheduled message was not cancelled',
  /**
   * 첨부가 붙으면 예약할 수 없다. **막는 사실과 빠져나갈 길을 함께 준다** — 앞만 적으면
   * 사람은 첨부를 떼야 하는지 지금 보내야 하는지를 스스로 알아내야 한다.
   */
  'composer.schedule.hasAttachments':
    'A message with attachments cannot be scheduled — remove the attachments, or send it now',
  'composer.schedule.failed': 'The message was not scheduled',
  /** 실패한 예약의 사유 앞. **`{reason}` 은 서버 것이라 사전이 안 진다**(위 '안 넣은 것'). */
  'composer.schedule.notSent': 'Not sent: {reason}',
  /** 목록 조회 실패. **빈 목록과 갈라야 한다**(design.md §4) — 그래서 `did not arrive` 다. */
  'composer.schedule.listFailed': 'The scheduled list did not arrive',
  'composer.schedule.later': 'Send later',
  /** 겹창을 여는 것이 아니라 **거는 것**이다. 눌린 뒤 글자가 바뀐다. */
  'composer.schedule.submit': 'Schedule',
  'composer.schedule.submitting': 'Scheduling…',
  /** **셀 수 있는 명사가 아니다** — `1 scheduled` 도 `2 scheduled` 도 맞다(위 표). */
  'composer.schedule.summary': '{count} scheduled',
  /** 그중 실패한 것. 앞의 요약 뒤에 이어 붙는다. */
  'composer.schedule.summaryFailed': ' · {count} failed',
  'composer.schedule.timeLabel': 'Send at',
  'composer.schedule.title': 'Schedule this message',

  /** 첨부만 있고 글이 없을 때 대기 줄이 무엇을 보내는지 말한다. **여기는 복수형이 갈린다.** */
  'composer.send.attachmentsOnly': {
    one: '{count} attachment',
    other: '{count} attachments',
  },
  /**
   * 전송이 실패한 사유의 **기본 문구**. 서버가 사유를 주면 그것을 보이므로(`ApiError.message`)
   * 이 문구가 서는 것은 사유를 못 받았을 때뿐이다 — 연결이 끊겼거나 응답이 오류 봉투가
   * 아닐 때다. 그래서 원인을 단정하지 않는다.
   */
  'composer.send.failed': 'The message was not sent — check your connection and try again',
  /** 상한을 넘긴 채 누른 사람에게. 무엇을 하면 되는지까지 말한다. */
  'composer.send.tooLong': 'Too long by {over} characters — the limit is {max}',
  /** 글자 수 표시. 상한을 넘긴 쪽. */
  'composer.send.over': '{over} over',
  /** 글자 수 표시. 아직 여유가 있는 쪽. */
  'composer.send.remaining': '{remaining} left',
  'composer.send.sending': 'Sending…',
  'composer.send.submit': 'Send',
  /** 보이는 글자. 접근 이름이 이미 `Undo send` 였으므로 그와 어긋나지 않게 둔다(위 표). */
  'composer.send.undo': 'Undo',

  // ---------------------------------------------------------------------------
  // grid — **에이전트 격자다.** `settings/AgentGrid.tsx` 가 그리고, 이 컴포넌트는
  // **두 자리에 선다**(`AgentGridPlace`: 설정의 격자 · 사이드바의 에이전트 칸).
  //
  // ## 왜 `agents.grid.*` 에 안 붙였나 — `en.ts` 의 '남은 것' 표가 그렇게 적었는데
  //
  // 그 표는 *"`AgentGrid` … **`agents.*` 에 붙는다** — 같은 화면의 격자이고"* 라고
  // 적어 뒀다. **실측하니 그 전제가 틀렸다**: `AgentGrid` 는 `AgentsSettings` 의 일부가
  // 아니라 **두 화면이 공유하는 컴포넌트**다(`AgentGridPlace` 주석이 그 계약을 못 박고
  // 있다 — 사이드바가 같은 카드를 쓴다). `agents` 영역에 넣으면 사이드바가 그리는 카드가
  // **남의 화면 이름으로 된 키**를 부르게 되고, 그것은 `waitChain` 머리말이 이미 경계한
  // 그 결함이다(*"같은 판정을 두 화면이 그리면 화면 이름을 쓴 순간 둘 중 하나가 남의
  // 키를 부른다"*). 그래서 **그리는 것의 이름**으로 영역을 연다 — 격자다.
  //
  // 기존 `agents.grid.*` 넷(`heading`·`note`·`tabAgents`·`tabTeams`·`listFailed`)은
  // **그대로 둔다**: 그것들은 이 컴포넌트가 아니라 `AgentsSettings` 가 격자 **위에**
  // 그리는 머리띠이고, 사이드바는 그 문구를 안 쓴다.
  //
  // | 덩어리 | 그 구획 |
  // |---|---|
  // | `card` | 카드 안 정보 세 줄 · 진행 중 상태 글자 |
  // | `runner` | 격자 아래 러너 사유 줄 셋(실패 · 하네스 없음 · 생사 모름) |
  // | `search` | 검색줄 · 개수 · 빈 결과 |
  // | `version` | 러너 버전 칩 3종 |
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 뒤처짐 · 버전 모름 | `Outdated` · `Version unknown` | **`en.ts` 머리말 표가 이미 정했다**(그 표의 아래 셋) — 다음 PR 이 어휘를 다시 정하지 않도록 남겨 둔 그 판단이고, 이 PR 이 그 다음 PR 이다 |
  // | 멈추는 중 · 러너가 아직 못 봤다 | `Stopping — the runner has not seen it yet` | `Stopping` 도 그 표가 정한 낱말이다. 뒤 절반이 요점이다: 요청이 **실패한 것이 아니라 아직 안 읽힌 것**이라, 그것을 자르면 사람은 다시 누른다 |
  // | 물러나는 중 · 진행 중인 턴을 끝내고 있다 | `Stepping down — finishing the turn it is on` | `Stopping` 과 **갈려야 한다**: 앞엣것은 요청이 아직 안 닿은 것이고 이것은 러너가 받아들여 물러나는 중이다. `agents.stop.noteFinish` 가 이미 `finishing the turn it is on` 으로 그 사실을 적었으므로 같은 말을 쓴다 |
  // | 기동 실패 | `Did not start` | `sidebar.runner.launchFailed`·`agents.detail.launchFailed` 가 이미 그 낱말이다 — 같은 사실을 세 화면이 다른 말로 하지 않는다 |
  // | 새 에이전트 | `New agent` | `+` 칸의 이름이다. `Add agent`(`agents.detail.titleNew`)는 **그 화면의 제목**이라 이 칸의 이름과 뜻이 겹치지 않는다 — 여기는 문을 가리키고 저기는 그 안에 선 화면이다 |
  // | 서버와 끊겨 … 생사를 알 수 없다 | `Disconnected — …` | `agents.detail.disconnected`·`sidebar.brand.disconnected` 와 같은 규율이다: **`Disconnected` 한 단어로 끝내지 않는다** |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`runnerStates[id].message`** — `lib/runnerLauncher.ts` 가 내는 사유다. **이 파일
  //   밖이고**, `agents` 머리말이 세운 경계 그대로다(*"이 화면은 그 값을 감싸는 틀만
  //   사전으로 옮긴다"*). 아래 `runner.harnessMissing` 이 그 값이 **없을 때만** 쓰는
  //   기본 문구인 이유도 그것이다 — 있으면 러너의 말이 이긴다
  // - **`↻` · `▶` · `■` · `+` · `⌕`** — 기호다. 접근 이름은 아래 키들이 진다
  // - **`{handle}` · `{version}`** — 사람이 지은 이름과 러너가 보고한 값이다
  // ---------------------------------------------------------------------------

  'grid.card.harness': 'Harness',
  /** 모델이 `null` 일 때. **'모른다'가 아니라 '하네스가 고른다'다**(`AgentConfig.model`). */
  'grid.card.harnessDefault': 'harness default',
  'grid.card.lastTurn': 'Activity',
  /** 카드 왼쪽 라벨. 값은 `VersionChip` 이 낸다. */
  'grid.card.runner': 'Runner',
  /**
   * 러너가 받아들여 물러나는 중. **아래 `stopping` 과 갈린다** — 그쪽은 요청이 아직 안
   * 닿은 것이고 이것은 닿아서 마무리하는 중이다. 한 문구로 뭉치면 사람은 두 번 누른다.
   */
  'grid.card.retiring': 'Stepping down — finishing the turn it is on',
  /**
   * 종료를 요청했는데 러너가 아직 못 읽었다. **`Stopped` 가 아니다**(`agents.stop.requested`
   * 와 같은 규율) — 읽어 가지 않았으면 아무 일도 일어나지 않았다.
   */
  'grid.card.stopping': 'Stopping — the runner has not seen it yet',

  /**
   * 하네스가 없어 물러난 러너(`#476`). **러너가 사유를 주면 그것을 쓴다** — 이 문구는
   * 그 값이 없을 때만 서는 기본값이다(위 '안 넣은 것').
   */
  'grid.runner.harnessMissing': 'The harness could not be found',
  'grid.runner.launchFailed': 'Did not start',
  /** 사유가 붙을 때. **사유 문구는 러너 것이라 사전이 안 진다.** */
  'grid.runner.launchFailedReason': 'Did not start — {reason}',
  /**
   * 서버와 끊긴 동안. **한 줄로 묶는다** — 끊기면 남의 러너가 전부 이 상태가 되고,
   * 40줄이 깔리면 그것이 곧 소음이다(원래 주석이 적어 둔 그 판단이다).
   *
   * **`Offline` 이라고 하지 않는다**: 마지막으로 본 상태이지 지금 상태가 아니라는 것이
   * 이 줄 전체의 요점이다. 복수형이 갈린다.
   */
  'grid.runner.presenceUnknown': {
    one: 'Disconnected — whether {count} agent is alive cannot be known. This is the last state '
      + 'seen, not the state now. It refreshes when the connection is back.',
    other: 'Disconnected — whether {count} agents are alive cannot be known. This is the last '
      + 'state seen, not the state now. It refreshes when the connection is back.',
  },

  /** `+` 칸. **`Add agent` 와 갈린다** — 이것은 문의 이름이고 그것은 그 안 화면의 제목이다. */
  'grid.search.create': 'New agent',
  /** 목록이 비었다 — **못 찾은 것과 다른 사실이다**(아래 `noMatch`). */
  'grid.search.empty': 'No agents yet',
  'grid.search.label': 'Search agents',
  /** 검색으로 못 찾았을 때. 무엇으로 찾았는지를 되비춘다 — 오타가 그 자리에서 보인다. */
  'grid.search.noMatch': 'No agent matches “{query}”',
  'grid.search.placeholder': 'Find by name',
  /**
   * 검색창 안의 개수. **몇 개를 뒤지고 있는지가 찾기 전에 보여야 한다**(원래 주석).
   * 한국어는 `{count}개` 로 단위를 붙이지만 영어는 숫자만 선다 — 옆에 `Search agents`
   * 라는 이름이 이미 있어 무엇을 세는지는 자리가 말한다.
   */
  'grid.search.count': '{count}',

  /** 앱과 같은 번들. **회색으로 조용히 적는다** — 값 자체가 글자다. */
  'grid.version.current': '{version}',
  /**
   * 뒤처진 러너. `en.ts` 머리말이 정한 `Outdated` 다. 칩이 눌리는 자리라 **접근 이름이
   * 따로 있다**(아래) — 색은 스크린리더에 아무 말도 하지 않는다(`#443`).
   */
  /**
   * 재기동을 걸어 둔 러너. **버전을 안 싣는다** — 지금 보고된 값은 나가는 중인 옛 러너의
   * 것이라, 그것을 적으면 방금 누른 조작이 아무 일도 안 한 것처럼 읽힌다.
   */
  'grid.version.restarting': 'Restarting…',
  'grid.version.stale': '{version} · Outdated',
  /**
   * 그 칩의 접근 이름. **무엇을 하는 버튼인지와 왜인지를 함께 진다** — 칩 글자가 `↻` 로
   * 끝나므로 그것이 무슨 일인지는 이름만이 말할 수 있다.
   */
  'grid.version.staleAction': 'Restart the runner of {handle} — {version} is behind the app',
  /**
   * 버전을 모르는 러너. **칩을 안 그리는 것이 아니라 모른다고 적는다** — 안 그리면
   * "러너가 없다"와 구분되지 않는다(원래 주석이 이 칩을 만든 이유가 그것이다).
   */
  'grid.version.unknown': 'Version unknown',

  /** 격자의 `▶`·`↻` 접근 이름. 하는 일이 갈리므로 **두 낱말이 따로 있다.** */
  'grid.card.relaunch': 'Start {handle}',
  'grid.card.relaunchFailed': 'Start {handle} again',
  'grid.card.stop': 'Stop {handle}',

  // ── 상태 칩 (`AgentGrid.StateChip`) ────────────────────────────────────────
  //
  // 카드가 도는지 멈췄는지를 **글자로** 말하는 자리다. 이 키들이 생기기 전에는 그 사실이
  // 얼굴의 회색조에만 실려 있었다 — 색에만 실린 정보는 처음 온 사람도, 색을 못 가르는
  // 사람도 못 읽는다. 짧아야 하는 이유는 138px 상자에 들어가야 하기 때문이고, 누구의
  // 상태인지는 **바로 위 이름**이 이미 말한다.
  //
  // | 한국어 | 영어 | 판단 |
  // |---|---|---|
  // | 도는 중 | `Running` | 러너가 살아 있다. `RunnerStatus` 가 같은 사실에 이미 쓰는 말이다 |
  // | 멈춤 | `Stopped` | 꺼졌다. `멈추는 중`(`Stopping`)과 **한 글자로 갈린다** — 진행형이 아니다 |
  // | 실패 | `Failed` | 스스로 죽었다. 사유는 카드의 `agent-runner-failed-*` 줄이 따로 말한다 |
  // | 모름 | `Unknown` | 릴레이가 끊겨 서버가 모른다. **`멈춤`으로 쓰지 않는다**(`#443`) |
  // | 물러나는 중 | `Stepping down` | `grid.card.retiring` 의 긴 문장을 칩 길이로 줄인 것 |
  // | 멈추는 중 | `Stopping` | 종료를 요청했고 러너가 아직 못 봤다 |
  'grid.chip.ok': 'Running',
  'grid.chip.stopped': 'Stopped',
  'grid.chip.failed': 'Failed',
  'grid.chip.unknown': 'Unknown',
  'grid.chip.retiring': 'Stepping down',
  'grid.chip.stopping': 'Stopping',
  // 칩 **안**의 동작 글자. `grid.card.stop` 과 갈린 이유는 길이다 — 그쪽은 `{handle}` 을
  // 지고 있어 접근 이름과 툴팁으로 가고, 이쪽은 상자에 들어가야 한다.
  'grid.chip.stopShort': 'Stop',
  'grid.chip.startShort': 'Start',
  // 칩 버튼의 **접근 이름**. 보이는 글자는 쉼(상태) → 호버(동작)로 갈리지만 스크린리더는
  // 호버가 없으므로 둘을 함께 싣는다. 동작만 실으면 칩이 되살린 상태를 도로 잃고, 상태만
  // 실으면 눌러서 무슨 일이 나는지를 잃는다.
  'grid.chip.label': '{state} · {action}',

  // ---------------------------------------------------------------------------
  // presence — **판정 이름이다**(`lib/presenceView.ts::presenceView`). 화면 이름이 아니다.
  //
  // `PRESENCE_LABEL` 이 자기 주석에 *"세 자리(사이드바·디렉터리·에이전트 격자)가 같은
  // 말을 쓴다"* 고 이미 적어 뒀다 — `waitChain` 머리말이 둘로 충분하다고 한 그 조건을
  // 넘는다. 화면 이름을 골랐다면 나머지 둘이 남의 키를 부른다.
  //
  // ## 표를 지우지 않고 **값만 키로 바꿨다** (`Sidebar::NOTIFY_LEVEL_KEY` 판례)
  //
  // `runnerStatusLabel` 은 함수로 내렸는데(아래 `runnerState` 머리말) 이쪽은 표로 남겼다.
  // 갈리는 근거는 **자리표시자의 유무**다: 이 셋은 인자를 안 받는 상수 문구 셋이라
  // `Record<PresenceView, MessageKey>` 가 그대로 성립하고, 그러면 *"네 번째 값이 생기면
  // 여기서 컴파일이 막힌다"* 는 성질이 산다(그 판례가 지키려던 것이 그것이다).
  // **키는 언어를 안 지니므로 모듈 상수여도 안전하다** — 굳는 것은 값이지 키가 아니다.
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 온라인 · 오프라인 | `Online` · `Offline` | 서버가 **말한** 사실 둘이다 |
  // | 연결 끊김 — 알 수 없음 | `Disconnected — presence unknown` | `agents.detail.disconnected`·`sidebar.brand.disconnected` 와 같은 규율이다: **`Disconnected` 한 단어로 끝내지 않는다.** 그 모듈 주석이 못 박은 것이 *"'오프라인'이라고 쓰지 않는다 — 그것은 아는 척이다"* 이고, 뒤 절반이 그 아는 척을 막는다. 사람이 할 일이 갈린다: 오프라인이면 러너를 되살리고, 모르면 연결이 돌아오기를 기다린다 |
  // ---------------------------------------------------------------------------

  'presence.offline': 'Offline',
  'presence.online': 'Online',
  /**
   * **`Offline` 이라고 쓰지 않는다** — 그것은 아는 척이다(그 모듈 주석). 뒤 절반이
   * 빠지면 사람은 이것을 '오프라인'으로 읽고 멀쩡한 러너를 되살리려 든다.
   */
  'presence.unknown': 'Disconnected — presence unknown',

  // ---------------------------------------------------------------------------
  // projection — **판정 이름이다**(`lib/projectionBanner.ts::projectionBanner`).
  // 화면 이름이 아니다.
  //
  // 그 판정을 그리는 화면이 **셋이다**: 화면 위쪽 띠(`ProjectionBanner`) · 리스 목록
  // (`LeasePanel`) · 연결 설정(`ConnectionSettings`). 그 파일 머리말이 *"두 자리가 각자
  // 판정하면 반드시 갈라진다"* 며 함수를 하나로 뽑은 그 이유가 키에도 그대로 걸린다.
  //
  // `url` 덩어리만 화면 하나(`settings/ProjectionUrl.tsx`)의 것이다. **그래도 여기 둔다** —
  // 사람에게 그 둘은 한 가지 일이고(투영이 무엇을 바라보고, 지금 도는가), 영역을 가르면
  // 주소를 고치러 온 사람이 띠의 어휘와 다른 말을 읽는다.
  //
  // | 덩어리 | 무엇 |
  // |---|---|
  // | `banner` | 띠가 말하는 사정 넷의 **머리 문장** |
  // | `list` | 같은 사정이 **리스 목록에** 뜻하는 것(`listNote`) |
  // | `url` | avcs 주소를 앱에서 정하는 줄 |
  //
  // ## 네 사정을 뭉개지 않는다 — 영어가 그 갈림을 **그대로** 져야 한다
  //
  // 이 영역에서 가장 중요한 것이 그것이다. 그 파일 머리말의 표를 그대로 옮긴다:
  //
  // | 사정 | 화면이 말하는 것 | 사람이 할 일 |
  // |---|---|---|
  // | `unreadable` | 지금 **못 읽고 있다** | 서버·네트워크를 본다 |
  // | `unknown` | 아직 **모른다**(첫 응답 전) | 기다린다 |
  // | `unconfigured` | **꺼져 있다** | 주소를 넣는다 |
  // | `stalled` | 켜져 있는데 **멈췄다** | 왜 멈췄는지(`lastError`)를 본다 |
  //
  // 넷을 한 문구로 접으면 도그푸딩 중에 투영이 끊긴 것을 **아무도 모른다** — 화면이
  // 평소와 똑같기 때문이다(`docs/design.md` §4). `#267` 이 그것을 회귀선으로 못 박았다.
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 투영 상태를 읽지 못했다 | `The projection status could not be read` | `en.ts` 머리말의 `The X was not Yed` 규율 — **결과 상태**로 쓴다. `Failed to read` 는 동작이 실패했다만 말한다 |
  // | 지금 상태를 못 읽어 이 목록을 믿을 수 없다 | `The status cannot be read right now, so this list cannot be trusted` | **인과가 한 문장에 있다.** `so` 앞뒤를 자르면 "못 읽는다"와 "못 믿는다"가 따로 읽히고, 사람은 둘을 별개 사실로 센다 |
  // | 투영 상태를 확인하는 중… | `Checking the projection status…` | **'없다'가 아니라 '아직 모른다'다**(그 함수 주석). `No status` 는 결측이라 거짓이다 |
  // | 투영이 꺼져 있어 이 목록은 채워지지 않는다 | `Projection is off, so this list will not fill in` | 빈 목록의 **이유**다. 이것을 안 적으면 사람은 "잡힌 작업이 없다"로 읽는다 — 그것이 이 판정이 존재하는 이유다 |
  // | 언제부터인지 알 수 없지만 | `for an unknown stretch` | **한 번도 못 폴링했을 때.** 모르는 것을 숫자로 꾸미지 않는다. 한국어의 `~부터` 는 시각 **뒤**에 붙는 조사이고 영어는 `for {ago}` 로 앞에 서므로, 이 조각을 코드에 두면 한쪽 어순이 굳는다 — 그래서 **통짜 문장 둘**로 나눠 자리표시자를 낀다(`daemonFacts` 가 `waitChain.link` 의 금지를 지킨 그 모양) |
  // | 투영이 {since} 멈춰 있다 | `Projection has been stalled for {ago}` | |
  // | 투영이 {since} 멈춰 이 목록은 지금 사실이 아닐 수 있다 | `Projection has been stalled for {ago}, so this list may not be true right now` | **`may not be` 다** — `is not` 은 단정이고, 멈춘 동안 리스가 안 바뀌었을 수도 있다. 아무도 확인하지 않은 것을 단정하지 않는다 |
  // | 앱에서 설정 | `Set in the app` | 출처 둘을 **사정마다 다른 말**로(그 파일 주석) — 같은 말이면 "env 를 넣었는데 왜 안 먹나"를 화면에서 알 수 없다 |
  // | 아직 정해지지 않았다 | `Not set yet` | **출처가 없다는 것도 사정이다.** `yet` 이 진다 — 빠지면 '정할 수 없다'로 읽힌다 |
  // | 지우면 {url} 로 돌아간다 | `Clearing it falls back to {url}` | 지우기의 **결과**를 미리 말한다. 둘이 갈리는 이유는 env 값의 유무이고, 그것이 사람이 잃는 것을 정한다 |
  // | 지우면 투영이 꺼진다 | `Clearing it turns projection off` | env 도 없을 때. **잃는 것이 다르므로 문장이 갈린다** |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`PROJECTION_UNCONFIGURED_HEADLINE` · `PROJECTION_UNCONFIGURED_DETAIL`** —
  //   **이 패키지 밖이다**(`packages/shared`). 서버·러너가 함께 쓰는 값이라 데스크탑
  //   사전이 닿을 수 없다. `runner` 머리말의 `installHint()` 와 **같은 경계**이고, 같은
  //   미결이다: `Translate` 를 `shared` 로 내릴지, 그 상수가 **키만 내고** 데스크탑이
  //   문구를 씌울지를 먼저 정해야 한다. 그래서 `banner.unconfigured` 키가 여기 없다 —
  //   **안 쓰는 키는 검사할 방법이 없어 조용히 썩는다**(`en.ts` 머리말)
  // - **`AVCS_BASE_URL` · `avcs`** — 환경변수 이름과 제품 이름이다. 옮기면 사람이 터미널·
  //   문서에서 보는 말과 화면의 말이 갈라진다(`admin`·`PAT`·`harness` 와 같은 규율)
  // - **`env`** — `ProjectionUrlSource` 의 **저장·전송용 값**이다. 라벨이 그 값을 그대로
  //   보이는 이유는 서버 응답에도 그 글자가 오기 때문이다
  // - **`http://avcs.example:4000`** — 자리표시다. 번역하면 사람이 **입력해야 하는 값**으로 읽는다
  // - **`status.lastError` · 조회 실패 사유** — 서버가 한 말이다. 앱이 다시 쓰지 않는다(`#368`)
  // - **경과(`10분 전`)** — `lib/time.ts::agoLabel` 이 그 언어로 낸다. **숫자는 `Intl` 이, 뜻은 사전이**
  // ---------------------------------------------------------------------------

  /**
   * 켜져 있는데 멈췄고, **언제부터인지 안다.** `{ago}` 는 `agoLabel` 이 낸 경과다 —
   * 이 사전이 시간을 제 손으로 적지 않는다.
   */
  'projection.banner.stalled': 'Projection has been stalled for {ago}',
  /**
   * 폴링을 **한 번도 못 했다.** 모르는 것을 숫자로 꾸미지 않는다 — 위 문장과 조각을
   * 나눠 쓰지 않고 통짜로 둔 이유는 한국어의 `부터`(조사, 뒤에 붙는다)와 영어의
   * `for`(전치사, 앞에 선다)가 **어순이 반대**여서다.
   */
  'projection.banner.stalledUnknownSince': 'Projection has been stalled for an unknown stretch',
  /** **'없다'가 아니라 '아직 모른다'다.** 첫 응답 전이라 띠로 세우지 않는다(`strip: false`). */
  'projection.banner.unknown': 'Checking the projection status…',
  /** **결과 상태로 쓴다**(`The X was not Yed` 규율). 사유는 `{detail}` 로 따로 선다. */
  'projection.banner.unreadable': 'The projection status could not be read',

  /** 띠 안의 닫기. **사정별로 닫힌다**(그 화면 주석) — 다른 사정이면 다시 선다. */
  'projection.banner.dismiss': 'Dismiss this alert',
  /** 고치는 문. **띠 안에 붙는다**(문서) — 좁은 칸에서는 이 문이 없었다. */
  'projection.banner.openSettings': 'Open settings',

  /**
   * 같은 사정이 **리스 목록에** 뜻하는 것. 띠가 "고장났다"를 말하는 동안 이 줄은
   * *"그래서 이 목록을 어떻게 읽어야 하나"* 를 말한다 — 같은 문구를 두 자리에 세우면
   * 중복이고, 사용자가 화면에서 그것을 먼저 발견했다(실측 2026-09-07).
   */
  'projection.list.stalled': 'Projection has been stalled for {ago}, so this list may not be true right now',
  'projection.list.stalledUnknownSince':
    'Projection has been stalled for an unknown stretch, so this list may not be true right now',
  /** 띠가 **안 서는** 유일한 사정이라 이 줄이 그 사정을 말하는 유일한 자리다. */
  'projection.list.unknown': 'Checking the projection status…',
  'projection.list.unconfigured': 'Projection is off, so this list will not fill in',
  /** **인과가 한 문장에 있다** — 자르면 "못 읽는다"와 "못 믿는다"가 별개 사실로 읽힌다. */
  'projection.list.unreadable': 'The status cannot be read right now, so this list cannot be trusted',

  /** 편집 자리의 필드 이름. **`avcs` 는 안 옮긴다**(제품 이름). */
  'projection.url.field': 'avcs address',
  /** env 값이 있을 때의 안내. **지우면 무엇으로 돌아가는지**를 미리 말한다. */
  'projection.url.hintFallback': 'Clearing it falls back to {url}',
  /** env 도 없을 때. **잃는 것이 다르므로 문장이 갈린다.** */
  'projection.url.hintOff': 'Clearing it turns projection off',
  'projection.url.loadFailed': 'The projection settings did not arrive',
  'projection.url.loading': 'Loading the projection settings…',
  'projection.url.placeholder': 'http://avcs.example:4000',
  'projection.url.saveFailed': 'The projection URL was not saved',
  /** **출처가 없다는 것도 사정이다** — '아직 아무도 정하지 않았다'. */
  'projection.url.sourceNone': 'Not set yet',
  /**
   * 출처를 **사정마다 다른 말**로 적는다(그 파일 주석). `{source}` 에 아래 둘 중
   * 하나가 들어간다.
   */
  'projection.url.sourceOf': 'Source: {source}',
  'projection.url.sourceApp': 'Set in the app',
  /** **`AVCS_BASE_URL` 은 안 옮긴다** — 사람이 셸에 적는 그 글자여야 한다. */
  'projection.url.sourceEnv': 'Environment variable (AVCS_BASE_URL)',

  /** 편집·지우기·저장·취소. **이 화면의 것이다** — `common` 승격은 아래 근거로 미룬다. */
  'projection.url.cancel': 'Cancel',
  'projection.url.clear': 'Clear',
  'projection.url.edit': 'Edit',
  'projection.url.save': 'Save',

  // ---------------------------------------------------------------------------
  // runnerState — **판정 이름이다**(`components/RunnerStatus.tsx::runnerStatusLabel`).
  //
  // ## 왜 `runner.*` 를 재사용하지 않았나 — **둘이 다른 것을 말한다**
  //
  // 먼저 겹치는지 확인했고, **안 겹친다.** `runner.*`(`lib/runnerLauncher.ts`)는
  // `RunnerState.message` 로 올라가는 **사유**이고, 이쪽은 `RunnerState.status` 의
  // **이름**이다. 화면이 그 둘을 **나란히** 그린다(`RunnerStatusLine`:
  // `<상태 이름> — <사유>`) — 한 영역에 넣으면 그 두 종류가 이름으로 안 갈린다.
  //
  // 겹치는 것처럼 보이는 자리가 실제로 하나 있다: `launch.failed`(사유)와
  // `runnerState.failed`(이름)가 둘 다 '기동 실패'다. **그래서 더더욱 갈라야 한다** —
  // 사유 쪽은 `: {reason}` 을 달고 이름 쪽은 안 단다. 한 키로 묶으면 사유가 없는 자리에
  // 빈 콜론이 남거나, 이름 자리에 남의 사유가 딸려 온다.
  //
  // 영역 이름이 `runner` 가 아니라 `runnerState` 인 이유도 그것이다. 이 값들을 그리는
  // 화면이 **셋이다**(`AgentsSettings` 상세 · `Sidebar` DM 줄 · `ChannelPane` 실패 줄) —
  // 화면 이름을 골랐다면 나머지 둘이 남의 키를 부른다(`waitChain` 머리말).
  //
  // ## 모듈 상수를 **함수로 내렸다** (`threadState::THREAD_STATE_LABEL` 판례)
  //
  // 위 `presence` 는 표로 남겼는데 이쪽은 함수다. 갈리는 근거가 둘이다.
  //
  // 1. **이미 함수였다.** `runnerStatusLabel` 은 상수 표가 아니라 `switch` 이고, 그것은
  //    `stopped` 갈래가 `exitCode` 를 읽어 두 문장으로 갈리기 때문이다(`0`·`null` 이면
  //    꺼짐, 아니면 코드를 그대로 보인다). `Record<RunnerStatus, MessageKey>` 로는
  //    그 갈림이 표현되지 않는다 — 한 상태가 두 키를 갖는다.
  // 2. **자리표시자가 있다.** `{code}` 를 받아야 하므로 키만 넘겨서는 문구가 안 된다.
  //
  // 그래서 `t` 를 **필수 인자로 맨 뒤에** 받는다(`i18n/index.ts::Translate` 의 (b) 주입).
  // 기본값을 주면 부르는 화면이 조용히 한 언어로 굳고, 앞에 끼우면 회귀선들이 자리만
  // 어긋난 채 초록으로 틀린 것을 잰다.
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 꺼짐 | `Off` | `Stopped` 가 아니다 — 아래 `stoppedWithCode` 와 갈려야 하고, 이쪽은 **정상**이다(코드 0 이나 신호로 곱게 죽었다). 그 모듈 주석이 *"'꺼짐'과 '78 로 죽었다'를 뭉치지 않는다"* 고 못 박았다 |
  // | 실행 중 | `Running` | |
  // | daemon 이 들고 있음 | `Held by the daemon` | **`#431` 2단계가 `external` 을 없애고 이 이름을 넣었다.** 앞 이름은 "이 앱이 안 띄웠다"는 뜻이었는데 "실행 중"으로 읽혔고 그 오독이 `#430` 이다. `Adopted` 는 우리 내부 낱말(`status: 'adopted'`)이라 화면에 내면 사람이 못 읽는다. **누가 들고 있는지**가 이 이름의 전부다 |
  // | 재기동 대기 (진행 중인 턴을 마치는 중) | `Waiting to restart (finishing the turn it is on)` | 괄호가 요점이다 — SIGTERM 은 graceful 이라 러너는 진행 중인 턴을 마친 뒤에야 죽고 그 시차가 분 단위다. 빼면 사람은 멈춘 줄 알고 다시 누른다. `grid.card.retiring`·`agents.stop.noteFinish` 가 이미 `finishing the turn it is on` 이라 **같은 말을 쓴다** |
  // | 종료 (78: 자격증명 폐기 — 재발급 필요) | `Exited (78: the PAT was revoked — reissue it)` | **`78` 을 안 옮긴다**(종료 코드는 숫자다). 셋이 78 을 나눠 쓰므로 **사람이 할 일이 이름 안에 있어야 한다** — 그것을 뺀 것이 `#473` 이 고친 결함이다 |
  // | 종료 (78: 하네스를 찾을 수 없음 — 설치 필요) | `Exited (78: the harness was not found — install it)` | **`harness` 는 안 옮긴다**(고유어). 어느 실행 파일인지는 여기서 말하지 않는다 — `state.message`(`runner.exit.*`)가 이름을 들고 있고 화면에서 나란히 나온다 |
  // | 종료 (78: 하네스 로그인 만료 — 재로그인 필요) | `Exited (78: the harness login expired — log in again)` | |
  // | 종료 (기타: 코드 {code}) | `Exited (other: code {code})` | **코드를 그대로 보인다** — 앱이 원인을 지어내면 사람은 러너 로그를 볼 이유를 잃는다(그 모듈 주석) |
  // | 기동 실패 | `Did not start` | `grid.runner.launchFailed`·`sidebar.runner.launchFailed`·`agents.detail.launchFailed` 가 이미 그 낱말이다 — 같은 사실을 네 화면이 다른 말로 하지 않는다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`state.message`** — `runner.*` 가 이미 지고 있다(위 「왜 재사용 안 했나」).
  //   `RunnerStatusLine` 은 그 값을 **그대로** 옆에 붙인다
  // - **`78` · `{code}` · `daemon` · `PAT` · `harness` · `SIGTERM`** — 숫자와 고유어다
  // ---------------------------------------------------------------------------

  /**
   * **`#431` 2단계가 만든 이름.** `Adopted` 는 우리 내부 낱말이라 화면에 못 낸다 —
   * daemon 이 `kill(pid, 0)` 으로 확인한 러너라서 **누가 들고 있는지**가 요점이다.
   */
  'runnerState.adopted': 'Held by the daemon',
  /** `runner.launch.failed`(사유)와 **갈린다** — 이쪽은 이름이라 `: {reason}` 이 안 붙는다. */
  'runnerState.failed': 'Did not start',
  /** 78 의 세 갈래. **사람이 할 일이 이름 안에 있다**(`#473`). */
  'runnerState.needsHarness': 'Exited (78: the harness was not found — install it)',
  'runnerState.needsLogin': 'Exited (78: the harness login expired — log in again)',
  'runnerState.needsReissue': 'Exited (78: the PAT was revoked — reissue it)',
  /**
   * **괄호가 요점이다.** SIGTERM 은 graceful 이라 러너는 진행 중인 턴을 마친 뒤에야
   * 죽고 그 시차가 분 단위다 — 빼면 사람은 멈춘 줄 알고 다시 누른다.
   */
  'runnerState.restarting': 'Waiting to restart (finishing the turn it is on)',
  'runnerState.running': 'Running',
  /** **정상이다** — 코드 0 이나 신호로 곱게 죽었다. 아래와 갈려야 한다. */
  'runnerState.stopped': 'Off',
  /** 78 이 아닌 종료. **코드를 그대로 보인다** — 지어내면 러너 로그를 볼 이유가 사라진다. */
  'runnerState.stoppedWithCode': 'Exited (other: code {code})',

  // ---------------------------------------------------------------------------
  // terminal — **화면 이름이다.** `components/TerminalPanel.tsx` 가 그리는 말이고,
  // 이 말들을 내는 판정은 `lib/` 에 없다: 패널이 스스로 쓰는 라벨·오류·안내다.
  //
  // `components/TerminalChip.tsx`(그 패널을 여는 칩)도 여기 든다. **한 벌의 어휘**라
  // 갈라 두면 문을 여는 말과 그 안 화면의 말이 서로 모르게 된다(`speech` 머리말의
  // 세 번째 경우) — 칩이 `Open the terminal` 이라고 하고 패널이 `Console` 이라고 하면
  // 사람은 다른 곳에 온 줄 안다.
  //
  // | 덩어리 | 그 구획 |
  // |---|---|
  // | `chip` | 메시지 줄의 칩 — 이 패널을 여는 문 |
  // | `header` | 머리띠 — 이름 · 어느 스레드 · 상태 칩 · 닫기 |
  // | `session` | 세션 조회·열기 셋(확인 중 · 여는 중 · 실패)과 실패 뒤의 「터미널 열기」 |
  // | `state` | 상태 칩의 값 셋(`AgentSessionState`) |
  // | `writer` | **왜 못 치는가** 넷 + 칠 수 있을 때 한 줄 |
  //
  // ## 못 치는 이유 넷은 **뭉치면 안 된다** — 사람이 할 일이 갈린다
  //
  // 이 영역에서 가장 중요한 것이 `writer.*` 다. `#369` 가 만든 갈림이고, 그 함수 주석이
  // *"'읽기 전용이다'만 적으면 셋 다 막다른 길로 보인다"* 고 적었다:
  //
  // | 사유 | 사람이 할 일 |
  // |---|---|
  // | `observeOnly` | 기다리거나 **이어받는다** (그 자리에 버튼이 선다) |
  // | `otherWriter` | **그 창을 닫는다** |
  // | `runnerOutdated` | **러너를 올린다** |
  // | `unknown` | **아무것도 단정하지 않는다** — 구 서버는 이유를 안 싣는다 |
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 터미널 보기 | `Open the terminal` | 칩의 이름이다. `View` 는 읽기만 한다는 뜻인데 소유자는 **직접 친다**(`#315`) — 그 문이 하는 일은 여는 것이다 |
  // | @{handle} 의 터미널을 연다 — 진행 중인 턴이 있으면 그 화면에 붙는다 | `Open a terminal for {handle} — joins the turn it is on, if any` | 칩의 `title`. 앞 문구(`the terminal {handle} is running`)는 **진행 중**을 졌는데, 그때는 턴이 없으면 패널이 멈춰 섰기 때문이다(2026-09-09에 없어졌다). 지금은 없으면 스스로 띄우므로 앞 절이 **여는 것**을 말하고, 뒤 절이 붙는 경우를 진다 |
  // | 에이전트 터미널 | `Agent terminal` | 패널 자체의 접근 이름 |
  // | 터미널 너비 조절 | `Resize the terminal` | `PaneResizer` 의 이름. 스레드 패널의 같은 자리와 같은 모양이다 |
  // | 닫기 / 터미널 닫기 | `Close` / `Close the terminal` | **보이는 글자와 접근 이름이 갈린다** — 원래 화면이 이미 그랬고 회귀선이 그것을 잡았다(옮기면서 한 키로 접었더니 `getByLabelText('터미널 닫기')` 가 빨개졌다). 머리띠의 꼬리표라 보이는 글자는 짧아야 하는데, 그 짧음이 스크린리더에서는 **무엇을** 닫는지를 잃는다. `grid.version.staleAction` 이 같은 이유로 갈라져 있다 |
  // | 스레드 | `a thread` | 루트 본문을 못 찾았을 때. **스레드라는 사실만 적는다**(그 주석) — 관사가 붙는 이유는 이것이 제목이 아니라 *"어느 스레드"* 자리의 대체값이기 때문이다 |
  // | 세션을 확인하는 중… | `Checking for a session…` | **'없다'가 아니라 '아직 모른다'다**(`docs/design.md` §4) |
  // | 터미널을 여는 중… | `Opening the terminal…` | 위 `checking` 과 **갈린다** — 저쪽은 서버의 세션 목록을 기다리고 이쪽은 러너가 띄우는 PTY 를 기다린다(뒤가 몇 초 더 걸린다). 한 문구로 뭉치면 러너가 늦을 때 「확인 중」이 멈춰 있는 화면이 된다 |
  //
  // 「진행 중인 턴이 없다 — 직접 열거나, …」는 **없어졌다**(2026-09-09). 멘션 턴이 TUI 로
  // 돌게 된 뒤로 「터미널 보기」를 누른 사람에게 물을 것이 없어서, 그 화면이 하던 일(=
  // [터미널 열기] 를 한 번 더 눌리게 하기)을 패널이 스스로 한다. 문구를 남겨 두면 다음
  // 사람이 없는 화면을 번역하게 된다.
  // | 터미널을 열지 못했다: {reason} | `The terminal did not open: {reason}` | `The X was not Yed` 규율 |
  // | 터미널을 붙일 자리가 없다 | `There is nowhere to attach the terminal` | ref 가 비었다 — 개발 중에만 나는 일이지만 **화면에 뜨는 말**이라 사전에 든다 |
  // | 입력 가능 — 마지막으로 연 창이 입력을 가진다. | `You can type — the window opened last holds input.` | **승격도 적는다**(그 주석): 강등만 적으면 두 창을 쓰는 사람이 어느 쪽이 살아 있는지 모른다. 뒤 절반이 **규칙**이라 다음에 무엇이 일어날지 예측할 수 있다 |
  // | 관찰 전용 — 진행 중인 멘션 턴은 프롬프트를 파일로 받으므로 … | `Observing only — a mention turn in flight takes its prompt from a file, so this terminal cannot accept input. To type yourself, open a terminal after the turn ends.` | **원인을 그대로 말한다**(그 함수 주석): "관찰 전용"만 적으면 임의의 제약으로 읽혀 "왜 안 되냐"가 결함으로 다시 올라온다. 그 사실을 아는 사람은 다른 길을 스스로 찾는다 |
  // | 읽기 전용 — 이 러너는 입력을 다룰 줄 모른다(구버전이거나 붙어 있지 않다). | `Read-only — this runner does not know how to handle input (it is outdated, or not attached).` | 괄호가 **두 가능성**을 남긴다. 하나로 단정하면 러너를 올려도 안 낫는 사람이 생긴다 |
  // | 읽기 전용 — 다른 창이 입력 중이다. 이 창에 치면 아무 데도 가지 않는다. | `Read-only — another window is typing. What you type here goes nowhere.` | 뒤 문장이 **대가**를 말한다 — 없으면 사람은 쳐 보고 나서야 안다 |
  // | 읽기 전용 — 이 창의 입력은 러너에 닿지 않는다. | `Read-only — input from this window does not reach the runner.` | 구 서버는 이유를 안 싣는다. **원인을 지어내지 않고** 무엇이 참인지만 적는다(`#368`) |
  // | 이어받기 | `Take over` | `#384` 가 만든 동작이다. `Resume` 은 멈춘 것이 이어진다는 뜻이라 거짓 — 멘션 턴은 **계속 돌고 있고**, 이 버튼이 하는 일은 그 턴이 끝난 뒤 그 대화를 넘겨받는 예약이다 |
  // | 이어받기를 예약했다 — 진행 중인 멘션 턴이 끝나면 엽니다. … | `Take-over is queued — it opens when the mention turn in flight ends. This terminal then picks up that conversation.` | **`#384` 의 정직성 전부다.** 진행 중인 턴을 멈추지 않으므로(운영자 결정 A) 누른 뒤 26초쯤 아무것도 안 바뀐 것처럼 보인다 — 그 침묵을 이 줄이 메운다. **다음에 무엇이 일어나는지**까지 말하는 것이 `runner.restart.waitingForRetirement` 와 같은 규율이다 |
  // | 이어받지 못했다: {reason} | `The take-over did not go through: {reason}` | `The X was not Yed` 규율. 사유는 서버가 쓴 것을 그대로 올린다 |
  // | 진행 중 | `Running` | 상태 칩. `runnerState.running` 과 **같은 글자이나 다른 것을 센다** — 저쪽은 러너 프로세스, 이쪽은 그 PTY 세션이다. 승격하지 않는 이유는 아래에 |
  // | 턴 종료 | `Turn ended` | `Ended` 만 두면 무엇이 끝났는지가 빠진다 — 세션이 아니라 **턴**이 끝난 것이고, 그 세션은 이어받을 수 있다 |
  // | 러너 연결 끊김 | `Runner disconnected` | *"'끝났다'로 쓰지 않는다 — 다른 사실이다"*(그 상수 주석). 턴은 안 끝났고 소켓만 끊겼다 |
  //
  // ## `common` 승격을 미룬 자리 — **글자가 같은데도**
  //
  // `terminal.state.running`(`Running`)과 `runnerState.running`(`Running`)이 같은 글자다.
  // `agents` 머리말이 `Cancel` 에 대해 세운 기준 그대로다: **자격은 "글자가 같다"가
  // 아니라 "뜻이 하나다"** 이고, 이 둘은 아니다 — 하나는 **러너 프로세스가 도는 것**이고
  // 하나는 **그 안 PTY 세션의 턴이 도는 것**이다. 러너는 돌고 있는데 세션은 끝나 있을
  // 수 있고, 실제로 그것이 흔한 상태다. 한 키로 묶는 순간 한쪽을 `In progress` 로
  // 바꾸는 일이 다른 쪽을 함께 바꾼다.
  //
  // `terminal.header.close`(`Close`)도 마찬가지다. 이 패널을 닫는 것이고, 다른 화면의
  // `Close` 가 오면 그때 재면 된다 — **미리 올려 두면 `common` 이 아무도 안 읽는
  // 사전이 된다**(`en.ts` 머리말).
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **서버가 준 오류 문구(`err.message`)** — 러너 오프라인(404)·구버전(409)·codex
  //   거절(409)·타임아웃(504)이 그대로 온다. **서버가 원인을 정확히 안다**(그 주석) —
  //   앱이 다시 쓰지 않는다(`#368`). 위 `session.openFailed` 는 그것을
  //   **감싸는 틀**만 진다
  // - **`#{channel}` · `DM` · 스레드 본문 발췌** — 데이터다. 채널 이름은 사람이 지었고
  //   `DM` 은 이 제품의 고유어이며 발췌는 남의 말이다
  // - **`@{handle}`** — 사람이 지은 이름이다
  // ---------------------------------------------------------------------------

  /** 칩의 접근 이름 겸 `title`. **진행 중**이 진다 — 없으면 새로 띄우는 문으로 읽힌다. */
  /**
   * **여는 문이다**(2026-09-09). 턴이 없으면 패널이 스스로 띄우므로 `is running` 은
   * 칩이 하는 일의 절반만 말한다 — 붙는 것은 **턴이 있을 때만**이라 뒤 절이 그것을 진다.
   */
  'terminal.chip.open': 'Open a terminal for {handle} — joins the turn it is on, if any',
  /** 칩의 보이는 글자. `View` 가 아니다 — 소유자는 **직접 친다**(`#315`). */
  'terminal.chip.label': 'Open the terminal',
  /**
   * `#384` 가 만든 동작. **`Resume` 이 아니다** — 멘션 턴은 계속 돌고 있고, 이 버튼이
   * 하는 일은 그 턴이 끝난 뒤 그 대화를 넘겨받는 **예약**이다.
   */
  /**
   * **`#384` 의 정직성 전부.** 진행 중인 턴을 멈추지 않으므로 누른 뒤 26초쯤은 아무것도
   * 안 바뀐 것처럼 보인다 — 그 침묵을 이 줄이 메운다. **다음에 무엇이 일어나는지**까지
   * 말하는 것이 `runner.restart.waitingForRetirement` 와 같은 규율이다.
   */

  /**
   * 닫기 버튼의 **보이는 글자**. 접근 이름은 아래 `closeAction` 이 따로 진다 —
   * 머리띠의 다른 것들과 나란히 서는 꼬리표라 짧아야 하고, 그 짧음이 스크린리더에서는
   * 무엇을 닫는지를 잃는다. `grid.version.staleAction` 이 같은 이유로 갈라져 있다.
   */
  'terminal.header.close': 'Close',
  /** 그 버튼의 접근 이름. **무엇을 닫는지**를 진다 — 화면에는 이 창만 있는 것이 아니다. */
  'terminal.header.closeAction': 'Close the terminal',
  'terminal.header.resize': 'Resize the terminal',
  /** 루트 본문을 못 찾았을 때. **스레드라는 사실만 적는다** — 이것 하나 때문에 안 받아온다. */
  'terminal.header.thread': 'a thread',
  'terminal.header.title': 'Terminal',
  /** 패널 자체의 접근 이름. 위 `header.title` 은 **보이는 글자**라 짧다. */
  'terminal.header.panel': 'Agent terminal',

  /** ref 가 비었다 — 개발 중에만 나지만 **화면에 뜨는 말**이라 사전에 든다. */
  'terminal.session.noHost': 'There is nowhere to attach the terminal',
  /** **실패 뒤의 다시 열기다**(2026-09-09) — 「턴이 없다」 화면이 없어져 이 버튼만 남았다. */
  'terminal.session.open': 'Open a terminal',
  'terminal.session.openFailed': 'The terminal did not open: {reason}',
  /** **'없다'가 아니라 '아직 모른다'다**(`docs/design.md` §4). */
  'terminal.session.checking': 'Checking for a session…',
  /** 위와 **갈린다**: 저쪽은 서버의 목록을 기다리고 이쪽은 러너가 띄우는 PTY 를 기다린다. */
  'terminal.session.opening': 'Opening the terminal…',

  /** `runnerState.running` 과 **다른 것을 센다** — 저쪽은 러너, 이쪽은 그 PTY 세션의 턴이다. */
  'terminal.state.running': 'Running',
  /** **`Ended` 만 두면 무엇이 끝났는지가 빠진다** — 세션이 아니라 턴이 끝났다. */
  'terminal.state.ended': 'Turn ended',
  /** *"'끝났다'로 쓰지 않는다 — 다른 사실이다"*(그 상수 주석). 턴은 안 끝났고 소켓만 끊겼다. */
  'terminal.state.runnerOffline': 'Runner disconnected',

  /**
   * 칠 수 있을 때. **승격도 적는다** — 강등만 적으면 두 창을 쓰는 사람이 어느 쪽이
   * 살아 있는지 화면에서 알 수 없다. 뒤 절반이 **규칙**이라 다음을 예측할 수 있다.
   */
  'terminal.writer.can': 'You can type — the window opened last holds input.',
  /**
   * 진행 중인 멘션 턴. **원인을 그대로 말한다**(그 함수 주석) — "관찰 전용"만 적으면
   * 임의의 제약으로 읽혀 "왜 안 되냐"가 결함으로 다시 올라온다.
   */
  'terminal.writer.observeOnly':
    'Observing only — a mention turn in flight takes its prompt from a file, so this terminal '
    + 'cannot accept input. To type yourself, open a terminal after the turn ends.',
  /** 뒤 문장이 **대가**를 말한다 — 없으면 사람은 쳐 보고 나서야 안다. */
  'terminal.writer.otherWriter': 'Read-only — another window is typing. What you type here goes nowhere.',
  /** 괄호가 **두 가능성**을 남긴다 — 하나로 단정하면 러너를 올려도 안 낫는 사람이 생긴다. */
  'terminal.writer.runnerOutdated':
    'Read-only — this runner does not know how to handle input (it is outdated, or not attached).',
  /** 구 서버는 이유를 안 싣는다. **원인을 지어내지 않고** 무엇이 참인지만 적는다(`#368`). */
  'terminal.writer.unknown': 'Read-only — input from this window does not reach the runner.',

  // ---------------------------------------------------------------------------
  // inbox — **화면 이름이다.** `components/Inbox.tsx` 가 그리는 말이다.
  //
  // **사슬 구획은 여기 없다** — `waitChain.*` 이 이미 그것을 지고 있고(그 머리말: 판정
  // 이름이지 화면 이름이 아니다), 이 화면은 `WaitChainSection` 을 부르기만 한다.
  // 구획의 `aria-label` 도 `waitChain.sectionTitle` 을 그대로 쓴다 — 같은 말을 두 번
  // 적으면 그중 하나가 낡는다.
  //
  // | 덩어리 | 그 구획 |
  // |---|---|
  // | `drafts` | 「쓰다 만 초안」 구획 |
  // | `entries` | 「나를 부른 것」 구획 — 줄의 꼬리표 · 빈 상태 |
  // | `filter` | 필터 칩 넷 |
  // | `pane` | 자리 자체 — 이름 · 닫기 · 조회 실패 · 대기 |
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 나를 부른 것 | `Called you` | `Mentions` 는 수단(`@`)을 가리키는데 이 구획에는 답글·물음도 든다(`reason` 이 셋이다). 이 목록의 기준은 **나에게 왔는가**이지 어떻게 왔는가가 아니다 |
  // | 나를 막는 것 | `Blocking you` | 규칙 04 가 강조를 주는 그 축이고, `waitChain` 이 이미 `waiting`/`blocked` 어휘를 쓴다 |
  // | 읽을 것 | `To read` | `Unread` 는 바로 옆 칩(`안 읽은 것`)의 이름이라 겹친다 — 이쪽은 rank 축(무엇이 나를 부르나)이고 그쪽은 내 읽음 상태다. **축이 다르다는 것이 이름에서 갈려야 한다** |
  // | 안 읽은 것 · 안 읽음 | `Unread` | 칩과 줄 끝 표시가 같은 말을 한다 — 한 키다 |
  // | 전부 | `Everything` | `sidebar.notify.all` 이 이미 그 낱말이고 뜻도 같다. 아래 `common` 판단 참고 |
  // | 쓰다 만 초안 | `Unfinished drafts` | `Drafts` 만 두면 저장된 초안함으로 읽힌다. 이것은 **쓰다 만 것**이고, 그 미완이 목록에 서는 이유다 |
  // | 초안 | `Draft` | 줄의 꼬리표. 위 구획 이름과 갈라 둔다 — 꼬리표는 그 한 줄이 무엇인지만 말한다 |
  // | 인박스를 불러오지 못했다 | `The inbox did not arrive` | `did not arrive` 규율(`en.ts` 머리말) |
  // | 필터에 맞는 것이 없다 | `Nothing matches the filter` | **`나를 부른 것이 없다` 와 갈린다** — 하나는 목록이 비었고 하나는 걸러 낸 것이다. 원래 화면이 그 둘을 갈라 뒀고 그 구별이 이 목록의 값이다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`row.label` · `o.label`** — `lib/inboxRow.ts` 판정과 서버의 선택지 문구다.
  //   **이 파일 밖이다**(`agents` 머리말의 경계)
  // - **`channelLabel`** — `#general` · handle 이다. 사람이 지은 이름을 번역하지 않는다
  // - **`✕`** — 기호다. 접근 이름은 `pane.close` 가 진다
  // - **`Inbox`(머리글)** — 이미 영어다. 그러나 **키를 씌운다**: 다음 언어가 그 자리를
  //   자기 말로 적을 수 있어야 하고, 지금 영어인 것은 우연이지 계약이 아니다
  // ---------------------------------------------------------------------------

  'inbox.drafts.badge': 'Draft',
  'inbox.drafts.empty': 'No unfinished drafts',
  /**
   * 구획 이름(랜드마크)과 눈에 보이는 머리글을 **가른다** — `waitChain.sectionTitle` /
   * `sectionTitleCount` 가 이미 그 모양이다. 랜드마크는 **자리의 이름**이라 그 안의
   * 개수가 섞이면 목록이 바뀔 때마다 이름이 달라지고, 스크린리더로 자리를 오가는
   * 사람에게는 매번 다른 구획처럼 들린다.
   */
  'inbox.drafts.heading': 'Unfinished drafts',
  'inbox.drafts.headingCount': 'Unfinished drafts ({count})',
  /** 채널을 못 알아낸 스레드 초안. **`scopeKey` 를 그대로 내는 자리의 앞말이다.** */
  'inbox.drafts.thread': 'thread',

  /** 목록이 비었다 — **걸러 낸 것과 다른 사실이다**(아래 `noMatch`). */
  'inbox.entries.empty': 'Nothing has called you',
  /** 위 `drafts.heading` 과 같은 이유로 갈라 둔다 — 랜드마크 이름에 수를 안 섞는다. */
  'inbox.entries.heading': 'Called you',
  'inbox.entries.headingCount': 'Called you ({count})',
  /** 걸러 냈을 때. 칩을 되돌리면 다시 나온다는 것이 이 문장과 빈 목록의 차이다. */
  'inbox.entries.noMatch': 'Nothing matches the filter',
  /** 줄이 스레드에서 왔다. 앞의 `·` 는 화면이 붙인다. */
  'inbox.entries.thread': 'thread',
  /** 줄 끝의 안 읽음 표시. **칩(`filter.unread`)과 같은 말이다** — 한 키로 둔다. */
  'inbox.entries.unread': 'Unread',

  'inbox.filter.all': 'Everything',
  'inbox.filter.blocking': 'Blocking you',
  /** **rank 축이 아니라 읽음 축이다**(원래 주석이 그 어긋남을 알면서 뒀다). */
  'inbox.filter.unread': 'Unread',
  /** rank 축. **위 `unread` 와 이름이 겹치면 안 된다**(위 표). */
  'inbox.filter.reading': 'To read',

  'inbox.pane.close': 'Close the inbox',
  /**
   * 조회 실패. **빈 목록으로 삼키지 않는다** — 실패했는데 빈 목록만 보이면 사람은
   * "아무도 나를 부르지 않았다"로 읽는다(원래 주석). `{reason}` 은 서버 것이다.
   */
  'inbox.pane.loadFailed': 'The inbox did not arrive — {reason}',
  'inbox.pane.loading': 'Loading…',
  'inbox.pane.retry': 'Try again',
  /** 자리의 이름(`aria-label`)이자 머리글. 스크린리더가 이 구획을 찾는 이름이다. */
  'inbox.pane.title': 'Inbox',

  // ---------------------------------------------------------------------------
  // profile — **화면 이름이다.** `components/Profile.tsx` 가 그리는 겹창이고,
  // **사람과 에이전트가 같은 틀을 쓴다**(그 화면 주석: 행 이름만 다르다).
  //
  // | 덩어리 | 그 구획 |
  // |---|---|
  // | `actions` | 아래 버튼 줄 — 설정 · 재기동 · DM |
  // | `rows` | 정의 목록의 행 이름과 값 |
  // | `runner` | 러너 상태 안내 두 줄(뒤처짐 · 재기동 예약) |
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 종류 · 사람 · 에이전트 | `Kind` · `Person` · `Agent` | `sidebar.members.kindHuman`/`kindAgent` 가 **이미 그 두 낱말**이고 뜻도 같다. 아래 `common` 판단 참고 |
  // | 연결 — 알 수 없음 / 온라인 / 응답 없음 | `Presence` — `Unknown` / `Online` / `Not responding` | 행 이름이 `Connection` 이면 소켓 상태로 읽힌다. 이 행이 말하는 것은 **그 에이전트가 지금 답하는가**이고 그 말이 `presence` 다(코드가 이미 `online`·`presence` 로 부른다). `응답 없음` 은 `waitChain.deadlockDeadRunner` 의 `is not responding` 과 같은 사실이라 같은 낱말을 쓴다 |
  // | 비활성 | `Disabled` | `sidebar.members.agentDisabled` 와 같은 말이다 |
  // | 하네스 기본값 — 실제 모델은 발화 이름줄 hover 로 본다 | `harness default — hover a message byline for the model that actually answered` | **뒤 절반이 요점이다**(`#600`): `null` 은 '모델 없음'이 아니라 '이 설정이 정하지 않는다'이고, 그러면 murmur 는 실제 모델을 **모른다**. 어디서 볼 수 있는지를 자르면 사람은 이 행을 "실제로 쓰는 모델"로 읽는다 |
  // | 스레드마다 새로 만든다 | `a fresh directory for each thread` | `agents.permissions.workingDirPlaceholder` 가 이미 `a fresh empty directory for each thread` 로 같은 사실을 적었다 |
  // | 버전을 모른다 — 재기동하면 채워진다 | `Version unknown — restart it once and it fills in` | **원인을 가르지 않는다**(원래 주석): 환경변수를 못 받았든 보고가 없었든 사람이 할 일은 하나다 |
  // | (앱 {v}) | `(app {version})` | **비교 대상이 함께 있어야 한다**(원래 주석) — 러너 버전만 알면 뒤처졌는지를 스스로 확인할 수 없다 |
  // | 뒤처진 번들 | `an outdated bundle` | `Outdated` 는 `en.ts` 머리말이 정한 낱말이다 |
  // | 재기동을 예약했다 | `A restart is queued` | `Restarting` 은 **지금 하고 있다**로 읽히는데, 실제로는 진행 중인 턴이 끝나기를 기다리는 중이다(`#384` 가 이미 고친 그 오해다) |
  // | 새 버전으로 재기동 / 러너 재기동 | `Restart on the new bundle` / `Restart the runner` | **이름이 사실을 약속한다**(원래 주석): 뒤처졌다고 **확인된** 때만 "새 버전으로"라고 쓴다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`agent.harness`** — 값 자체다(`claude-code`). `agents` 머리말이 `harness` 를 고유어로
  //   못 박았고, 그 값은 더더욱 그렇다
  // - **`lastTurnLabel`** — `AgentsSettings` 의 함수이고 `agents.detail.lastTurn`·
  //   `agents.detail.noActivity` 를 이미 지난다. 이 화면은 부르기만 한다
  // - **`admin`** — 고유어다(`agents` 머리말)
  // - **`@handle` · `DM`** — 이름과 이 제품의 말이다
  // ---------------------------------------------------------------------------

  /** 설정으로 가는 문. **`canSeeConfig` 인 사람에게만 선다** — 없는 사람에게는 문이 없다. */
  'profile.actions.agentSettings': 'Agent settings',
  'profile.actions.dm': 'Open a DM',
  /** 예약을 무른다. 러너는 계속 돈다 — 무르는 것은 **예약**이지 러너가 아니다. */
  'profile.actions.restartCancel': 'Cancel the queued restart',
  /** 뒤처졌다고 **확인됐을 때만** 이 이름이다(위 표). */
  'profile.actions.restartStale': 'Restart on the new bundle',
  'profile.actions.restart': 'Restart the runner',

  'profile.rows.harness': 'Harness',
  'profile.rows.kind': 'Kind',
  'profile.rows.kindAgent': 'Agent',
  'profile.rows.kindHuman': 'Person',
  'profile.rows.lastTurn': 'Last activity',
  'profile.rows.model': 'Model',
  /** `null` 은 **'모른다'가 아니라 '하네스가 고른다'다**(`#600`). 뒤 절반이 그 사실을 진다. */
  'profile.rows.modelDefault':
    'harness default — hover a message byline for the model that actually answered',
  'profile.rows.owner': 'Owner',
  /**
   * 러너가 기동 때 읽은 claude 계정 lane(5단계). **행 이름이 "지금 쓰는 계정"이 아니다** —
   * 지금 도는 것은 턴 줄이 말하고, 이 행은 러너가 무엇을 읽고 떴는지다.
   */
  'profile.rows.claudeLane': 'Claude accounts read at startup',
  /** 풀이 비었다. **모른다와 다른 사실이다** — 사람이 계정을 넣어야 하는 상태다. */
  'profile.rows.claudeLaneEmpty': '{pool} is empty — running on the system login',
  /** 순서가 뜻이다(페일오버가 이 순서로 돈다). 화살표는 코드가 잇는다. */
  'profile.rows.claudeLaneOrder': '{pool}: {accounts}',
  /** 풀 지정이 없는 것 — 뿌리 자체를 쓴다. 이름 없는 풀을 빈 문자로 그리지 않는다. */
  'profile.rows.claudeLanePoolRoot': 'the default pool',
  /**
   * 아직 신고가 없다. `runnerVersionUnknown` 과 같은 모양으로 적는다 — 원인이 둘이지만
   * (구 러너 / 아직 폴을 안 보냈다) 사람이 할 일이 하나다.
   */
  'profile.rows.claudeLaneUnknown': 'Not reported — restart the runner once and it fills in',
  'profile.rows.permission': 'Permission',
  'profile.rows.presence': 'Presence',
  'profile.rows.presenceNotResponding': 'Not responding',
  'profile.rows.presenceOnline': 'Online',
  /** **`connected` 가 false 면 '모른다'다** — 오프라인이 아니다(그 화면의 규약). */
  'profile.rows.presenceUnknown': 'Unknown',
  'profile.rows.runnerVersion': 'Runner version',
  /** 앱 버전을 아는 경우. **비교 대상이 함께 서야 뒤처짐을 스스로 확인할 수 있다.** */
  'profile.rows.runnerVersionWithApp': '{version} (app {appVersion})',
  /** 원인 둘을 **가르지 않는다** — 사람이 할 일이 하나다(위 표). */
  'profile.rows.runnerVersionUnknown': 'Version unknown — restart it once and it fills in',
  'profile.rows.state': 'State',
  'profile.rows.stateDisabled': 'Disabled',
  'profile.rows.title': '{handle} profile',
  'profile.rows.workingDir': 'Working directory',
  'profile.rows.workingDirPerThread': 'a fresh directory for each thread',

  /**
   * 재기동 예약. **기다린다는 사실이 화면에 있어야 한다**(`#384`) — SIGTERM 은 graceful
   * 이라 러너는 진행 중인 턴을 마친 뒤에야 죽고, 그동안 표시가 없으면 사람에게는
   * "눌렀는데 아무 일이 없다"다. `{strong…}` 은 굵게 그릴 마디다.
   */
  'profile.runner.restartQueued':
    'A restart is queued — it comes up on the new bundle once {strongTurn} is done. The turn is not cut.',
  'profile.runner.restartQueuedTurn': 'the turn in flight',
  /** 뒤처짐 안내. 누르기 전에 **무엇을 갈아 끼우는지**를 말한다. */
  'profile.runner.stale':
    'This runner is on {strongBundle} — restarting it moves it to the new one.',
  'profile.runner.staleBundle': 'a bundle older than the app',

  'message.channelEcho': 'Also sent to the channel',
  /** 코드 블록의 복사 버튼(#724). 짧게 둔다 — 헤더 줄에 언어 이름과 나란히 선다. */
  'message.code.copy': 'Copy',
  /** 누른 뒤 1.5초. 버튼 자리에서 바뀌므로 "무엇이" 복사됐는지 말할 필요가 없다. */
  'message.code.copied': 'Copied',
  /** 클립보드도 선택도 못 했을 때. 남은 길이 손으로 옮겨 적는 것뿐이라 그것을 말한다. */
  'message.code.copyFailedManual':
    'The clipboard is not available and the code could not be selected — copy it by hand',
  /**
   * 클립보드가 없거나 거부됐을 때. **조용히 실패하지 않는다** — 화면의 그 코드를 선택해
   * 두었으므로 **다음에 할 일**을 말한다. 오류만 적고 끝내면 사람은 다시 드래그로 돌아간다.
   */
  'message.code.copyFailedSelected':
    'The clipboard is not available — the code is selected, so press ⌘C to copy it',
  /**
   * 담아 둔 표식(요청 2026-09-09). `⋯` 메뉴의 `Save for later` 와 **같은 낱말을 쓴다** —
   * 누른 항목과 화면에 남은 표식이 다른 말이면 사람은 그 둘을 잇지 못한다. 시제만
   * 갈린다: 메뉴는 시킬 일(`Save`), 여기는 그 결과(`Saved`)다.
   *
   * 개수·시각을 싣지 않는다. 이 줄이 답하는 것은 하나뿐이고(담겼는가), 언제 담았는지는
   * 담긴 목록(`Saved` 칸)이 답한다.
   */
  'message.savedMark': 'Saved for later',
  /**
   * 지워진 스레드 머리의 자리. **작성자·시각을 넣지 않는다** — 그 둘은 지운 말의
   * 일부다. 문장이 답하는 것은 하나뿐이다: 여기 있던 말이 없어졌고, 아래 답글은 남았다.
   */
  'message.deleted': 'This message was deleted',
  /**
   * 출처 줄의 라벨. **뿌리 본문은 이 문장에 끼우지 않는다** — 화면에서 그 조각만
   * 잘라 접어야 하고(`truncate`), 문장 안에 넣으면 접을 대상을 가리킬 수 없다.
   * 라벨과 본문 사이의 콜론은 화면이 붙인다: 언어마다 갈릴 만한 어순이 여기엔 없다.
   */
  'message.threadOrigin': 'Replied in a thread',
  'message.recentReplies': 'View recent replies',
  'message.replyInThread': 'Reply in a thread',
  // 툴바로 올라온 둘(2026-09-09). 메뉴에서 같은 문구를 쓰던 항목을 그대로 옮겼다 —
  // 사람이 아는 낱말이 바뀌면 옮긴 것이 아니라 새것이 생긴 것으로 읽힌다.
  'message.copyLink': 'Copy link',
  'message.save': 'Save for later',
  'message.unsave': 'Unsave',
  // 연쇄 깊이 상한에 막힌 호출(4단계). 사람이 알아야 하는 사실이고, 할 일은 아니다.
  'message.chainCapped': 'Did not call {handles} — the mention chain hit its depth limit ({limit}). Write a line yourself to continue.',
  'message.openSkillApproval': 'Open the skill approval screen',

  /**
   * 이름줄 버튼의 접근 가능한 이름. **`작성자` 를 앞에 붙이는 이유**가 그 자리 주석에
   * 있다 — 자기 이름을 부르는 말에서 이름줄 버튼과 본문 멘션 칩이 같은 이름을 갖게
   * 되어 스크린리더 사용자가 둘을 못 가른다. 그 사실이 언어를 건너 살아남아야 한다.
   */
  'message.authorLabel': 'Author {name}',

  /**
   * 수신자 배지. **강조는 나에게 온 것에만 간다**(규칙 04) — 그 색 판정은 화면이 하고,
   * 사전은 화살표 뒤의 이름만 진다. 화살표(`→`)를 문구에 넣는 이유는 그것이 **방향**을
   * 말하는 기호이고 이름과 떨어지면 뜻을 잃기 때문이다.
   */
  'message.audience.me': '→ you',
  'message.audience.person': '→ a person',
  'message.audience.agent': '→ {name}',
  /** 그 계정을 아직 못 받았을 때. **에이전트라는 사실만은 확실하다** — 그것만 말한다. */
  'message.audience.unknownAgent': 'another agent',

  /** 이름줄 hover 로만 나온다. **모델 id 는 안 옮긴다** — 설정에 적는 그 글자다. */
  'message.model.tooltip': 'Model {id}',
  /**
   * 설정과 어긋난 모델(#600). **설정값을 안 적는다** — 서버가 그것을 안 싣는다
   * (그 자리 주석). 그래서 "무엇과 다른지"가 아니라 **"무엇으로 했는지"** 를 말한다.
   */
  'message.model.mismatchTooltip': 'A different model family than configured — this was said with {id}',
  'message.model.mismatchLabel': 'Different from the configured model: {id}',

  'message.attachment.previewFailed': '(preview failed)',
  /**
   * 바이트 자체를 못 받았다. 위 `previewFailed` 와 **갈라 둔다** — 앞엣것은 칩 안의
   * 작은 그림이 안 온 것이고 이것은 파일이 안 온 것이다(그 파일 주석의 실측).
   */
  'message.attachment.loadFailed': '(could not load)',
  'message.attachment.zoom': 'View larger: {filename}',
  'message.attachment.closeZoom': 'Close the enlarged view',
  'message.attachment.save': 'Save',

  /** 줄 머리 — 무엇을 불렀나. 셋 다 **부름의 대상**이지 사람 수가 아니다. */
  'message.notified.group': 'Handle group',
  'message.notified.team': 'Team',
  /**
   * 종류를 섞어 불러 아무 쪽도 주장할 수 없다. `Mixed` 한 낱말로 두지 않는 이유:
   * 그것은 **무엇이 섞였는지**를 안 말한다. 이 줄이 답하는 질문은 "무엇을 불렀나"다.
   */
  'message.notified.mixed': 'Who was called',
  /**
   * **두 수가 한 문장에 있다.** 조각으로 쪼개면 한국어의 역접 어미(`불렀는데`)가
   * 갈 자리가 없어진다 — `waitChain.link` 가 어순 때문에 통째로 있는 것과 같은 사정이다.
   */
  'message.notified.counts': '{called} were called, {woke} woke up',
  /**
   * 사유. **종류마다 다르다** — 그 파일의 주석이 실측으로 갈라 뒀고, 한 문장으로
   * 접으면 꺼 둔 에이전트 때문에 뜬 줄이 "채널 멤버로 넣어라"고 말하게 된다(규칙 05 가
   * 막는 헛된 개입). 앞의 `—` 는 화면이 아니라 문구가 진다: 그 자리에서만 다른 색을
   * 받는 조각이 아니라 이 사유 문장의 일부다.
   */
  'message.notified.reasonGroup':
    '— the rest cannot see this channel. Add them as channel members for the call to reach them.',
  'message.notified.reasonTeam':
    '— the rest of the team are disabled or cannot see this channel. Check the team settings and the channel members.',
  /** 어느 쪽인지 못 가린다. **지어내지 않는다** — 닿지 않았다는 사실만 말한다. */
  'message.notified.reasonMixed': '— the call did not reach the rest.',

  /**
   * 답글 요약 버튼의 접근 가능한 이름. **상태를 라벨에도 싣는다**(그 자리 주석) —
   * `aria-label` 이 자식 글자를 덮으므로, 배지가 화면에 보여도 여기 없으면 스크린리더에는
   * 없는 것이다. 상태가 없을 수 있어(옛 서버·답글 행) **틀을 셋으로 가른다**: 한 틀에
   * `{state}` 를 두고 빈 문자열을 넣으면 영어에서 `, 2 replies` 처럼 쉼표가 앞에 남는다.
   */
  'message.summary.label': '{count}',
  'message.summary.labelWithState': '{state}, {count}',
  'message.summary.labelWithTime': '{count}, last reply {time}',
  'message.summary.labelWithStateAndTime': '{state}, {count}, last reply {time}',
  /**
   * **복수형이 실제로 갈리는 자리.** 여기 있던 `replyCount === 1 ? 'reply' : 'replies'`
   * 가 이 PR 이 옮긴 손수 복수형이다 — 영어만 맞는 판정이라(러시아어는 2~4 가 `few` 다)
   * `Intl.PluralRules` 에 넘긴다. 한국어가 한 갈래인 것은 그 언어의 사실이다.
   */
  'message.summary.replies': {
    one: '{count} reply',
    other: '{count} replies',
  },

  /**
   * 입력 중. **두 갈래인 것은 화면의 판단이지 언어의 것이 아니다** — 이름 둘까지는
   * 부르고 그 위로는 수만 센다(`TypingLine::MAX_NAMES`). 그 판단을 사전에서도 두 키로
   * 보이게 두어, 번역자가 `{names}` 와 `{count}` 중 하나를 지우지 않게 한다.
   *
   * 이름을 잇는 쉼표는 화면이 붙인다 — `Intl.ListFormat` 으로 올릴 자리이지만 그것은
   * 이 PR 의 범위가 아니고, 지금 화면이 하던 그대로다.
   */
  'message.typing.names': '{names} typing…',
  'message.typing.count': {
    one: '{count} person is typing…',
    other: '{count} people are typing…',
  },

  // ---------------------------------------------------------------------------
  // speech — **여덟 가지 말 자신의 어휘**(`AskCard`·`FailureCard`·`ReportCard`·
  // `ProgressRow`·`AgentExchange`).
  //
  // **판정 이름도 화면 이름도 아닌 세 번째 경우다** — 이 다섯 컴포넌트가 함께 이루는
  // **어휘 하나**이고, 그것을 그리는 화면이 넷이다(`ChannelPane`·`ThreadPanel`·
  // `MessageItem`·`GallerySettings`). `waitChain` 머리말의 근거가 그대로 걸린다: 화면
  // 이름을 골랐으면 나머지 셋이 남의 키를 부른다.
  //
  // 이름을 `speech` 로 두는 것은 이 저장소가 이미 쓰는 말이다 — 정본 문서의 *"여덟 가지
  // 말"* 이고, 갤러리가 그 구획을 `gallery.speech.*` 로 부른다.
  //
  // ## `gallery.speech.*` 와 섞지 마라 — **설명 / 그 말 자신**
  //
  // 갤러리 사전은 이 칸들을 **설명**한다(`강조를 받는 유일한 카드. 누를 수 있다.`).
  // 여기 있는 것은 카드가 **스스로 하는 말**이다(`골라 줘` · `끝내지 못했다`). 둘이
  // 같은 칸을 가리키지만 하나는 가르치는 글이고 하나는 어휘 자체다 — 합치면 갤러리를
  // 고칠 때 대화 화면의 말이 함께 바뀐다.
  //
  // | 덩어리 | 그 말 |
  // |---|---|
  // | `ask` | 선택 요청 — 누가 답해야 하나 · 누가 골랐나 |
  // | `exchange` | 에이전트끼리의 주고받기 접은 줄 |
  // | `failure` | 실패 카드 |
  // | `progress` | 진행 한 줄 |
  // | `report` | 완료 보고 — 세 구획의 머리 |

  // ---------------------------------------------------------------------------
  // channel — **화면 이름이다.** `components/ChannelPane.tsx` 와 그것이 여는 두
  // 곁창(`ChannelDocPanel`·`ChannelFiles`), 그리고 빈 채널의 안내(`ChannelEmptyState`).
  //
  // ## 곁창 둘을 따로 열지 않은 이유
  //
  // 파일이 넷이지만 사람이 여는 화면은 **채널 하나**다. 문서·파일은 채널 헤더의 버튼이
  // 열고 채널을 옮기면 함께 닫히며(그 파일들의 주석: *"열린 채로 두면 방금 떠난 채널의
  // 것이 잠깐 남는다"*), 채널 밖에는 설 자리가 없다. `composer` 를 `channel.composer`
  // 로 안 넣은 것과 **반대 방향의 같은 판단**이다 — 작성창은 스레드·DM 어디에나 서는
  // 자기 완결된 화면이라 갈렸고, 이 셋은 채널을 떠나면 존재하지 않는다.
  //
  // | 덩어리 | 그 구획 |
  // |---|---|
  // | `doc` | 문서 곁창 — 읽기 · 편집 · 409 충돌 |
  // | `empty` | 메시지가 하나도 없는 채널의 다음 걸음 |
  // | `files` | 파일 곁창 |
  // | `header` | 헤더 — 꼬리표 · 세 버튼 |
  // | `pane` | 본문 — 보관된 채널 · 러너가 응답하지 않는 띠 |
  //
  // 덩어리 안은 **키 이름 알파벳순**이다(근거는 `sidebar` 머리말과 같다 — 리베이스).
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 골라 줘 | `Pick one` | **명령이되 부탁이다.** `Choose an option` 은 폼 안내문이라 이 카드가 사람을 부르는 유일한 말이라는 무게가 사라진다 |
  // | 정해졌다 | `Decided` | 상태(과거)다. 답이 끝난 카드는 기록이므로 **동작을 안 말한다** — `Answered` 는 누가 답했나로 눈을 돌리는데 그것은 옆 칸(`answeredBy`)이 이미 말한다 |
  // | {name} 이(가) 골랐다 | `{name} picked` | 위 `Pick one` 과 **같은 동사**여야 한다. 물음이 `pick` 이면 답도 `picked` 다 — 다른 동사를 쓰면 둘이 같은 사건인지가 안 읽힌다 |
  // | {name} 가 고른다 | `{name} picks` | 현재형이다 — **아직 안 골랐다**. `will pick` 은 미래라 지금 멈춰 있다는 사실이 빠진다 |
  //
  // ### 옮기면서 한국어가 **좋아진 자리** — 조사 둘
  //
  // 이 두 줄은 원래 조사를 손으로 적고 있었고, 둘 다 틀린 모양이었다:
  //
  // | 옛 화면 | 지금 | 왜 좋아졌나 |
  // |---|---|---|
  // | `jaebin 이(가) 골랐다` | `jaebin 가 골랐다` · `민준이 골랐다` | 받침을 모르니 **괄호로 둘 다 적던** 것이다. 조사가 번역기 안으로 들어가면서(`{name:이가}`) 이름을 보고 하나를 고른다 — 대기 사슬이 이미 그 규칙을 쓰고 있었는데 이 카드만 안 쓰고 있었다 |
  // | `forge 가 고른다` | 같음 (한글 이름에서는 `민준이 고른다`) | 문자열 보간으로 **`가` 를 고정**하고 있었다. 영문 이름에서는 우연히 맞았고 한글 이름에서는 틀렸다 |
  //
  // 이것이 조사를 `format.ts` 에 둔 이유의 실증이다: 화면마다 손으로 적으면 **화면마다
  // 다르게 틀린다**. 규칙이 한 자리에 있으면 한 번 고친 것이 모든 화면에 간다.
  // | 사람이 고른다 | `A person picks` | `AskAudience` 의 `'human'`. `Someone picks` 도 뜻은 맞지만 앞줄(`{name} picks`)과 나란히 설 때 **사람인지 에이전트인지**가 갈려야 한다 |
  // | 끝내지 못했다 | `Could not finish it` | `Failed` 는 판정이고 이것은 **에이전트가 하는 말**이다(여덟 가지 말 중 유일하게 에이전트가 먼저 사람을 부른다). 1인칭의 무게가 `could not` 에 있다 |
  // | 다시 부르기 | `Call again` | `Retry` 가 아니다 — 이 버튼은 **작성창을 채울 뿐** 다시 실행하지 않는다(그 자리 주석). `@handle 다시 해 줘` 를 초안으로 놓는 것이라 "부른다"가 맞다 |
  // | @{handle} 다시 해 줘 | `@{handle} please try again` | **초안이지 화면 문구가 아니다** — 사람이 보내기 전에 고칠 수 있는 글이다. 그래서 명령이 아니라 부탁의 말투를 그대로 진다 |
  // | 작업 중 · 작업 | `Working` · `Worked` | **상**[aspect]이 갈린다. 끝난 묶음은 기록이라 과거형이고, 그 갈림이 이 줄의 색 판정과 같은 사실을 말한다(도는 점 / 중립 점) |
  // | {n}줄 펼치기 · 접기 | `Show {count} lines` · `Collapse` | 펼침은 **몇 줄인지**를 말해야 열 이유가 되고(규칙 06 의 결), 접기는 수를 말할 이유가 없다 — 이미 보고 있다 |
  // | 확인한 것 · 바뀐 파일 · 남은 것 | `Checked` · `Files changed` · `Left to do` | **셋이 한 축에 선다** — 무엇을 했나 · 무엇이 바뀌었나 · 무엇이 남았나. `Remaining` 은 명사라 "남은 것이 있다"만 말하고 **누가 할 일인지**가 빠진다 |
  // | 정했다 · 끝냈다 | `Decided` · `Finished` | 접은 줄의 결론 머리. **위 `ask.decided` 와 같은 낱말이다** — 같은 사실을 두 자리가 다르게 부르면 어휘가 늘어난다(그 파일 주석이 한국어로 이미 그렇게 정했다) |
  // | 아직 정해진 것 없음 | `Nothing decided yet` | **`yet` 이 진다** — 빼면 "아무것도 안 정해진다"는 판정이 되는데, 이 구간은 아직 도는 중일 수 있다 |
  // | {n}번 주고받음 | `{count} exchanges` | 복수형이 갈린다. 접힌 줄에서 **결론 뒤에 오는 부수적인 숫자**라 문장이 아니라 명사구다 |
  // | 마지막 {시각} | `last {time}` | 시각은 `toLocaleTimeString` 이 그 언어로 낸다 — 사전은 앞의 낱말만 진다(`lib/time.ts` 의 경계와 같은 규율) |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **선택지의 라벨과 힌트(`AskMeta.options`) · 보고의 항목(`checks`·`files`·
  //   `remaining`) · 다음 제안 칩(`next`) · 실패의 `what`·`reason` · 진행 본문** —
  //   **에이전트가 한 말이지 앱의 말이 아니다.** 갤러리 머리말이 견본을 안 넣은 것과
  //   같은 경계다: 사전에 넣으면 번역자가 남의 말을 옮겨야 할 것으로 읽는다
  // - **소요 시간 · 경과** — `lib/time.ts` 가 낸다(`durationLabel`·`runningLabel`·
  //   `tookLabel`). *"숫자는 `Intl` 이, 뜻은 사전이"*
  // - **`↔`·`·`** — 기호다. 이름을 잇고 조각을 가르는 자리이고 어느 언어에서도 같다
  // ---------------------------------------------------------------------------

  /**
   * 머리글은 **누가 답해야 하는지**를 말한다 — 그것이 이 카드가 답하는 유일한 질문이다.
   * 넷이 한 축에 선다: 내가 · 그 에이전트가 · 사람 아무나 · 이미 끝났다.
   */
  'speech.ask.pickOne': 'Pick one',
  'speech.ask.agentPicks': '{name} picks',
  'speech.ask.personPicks': 'A person picks',
  'speech.ask.decided': 'Decided',
  /**
   * **답하지 않는 길**(2026-09-09). 머리글·행위·행위자 셋이 한 축에 선다.
   *
   * `Decline` 을 쓰지 않은 이유: 선택지 하나를 거절하는 것처럼 읽힌다. 사람이 하는 일은
   * **이 물음을 답 없이 끝내는 것**이고, 그래서 목적어가 물음이다.
   */
  'speech.ask.decline': 'Don\u2019t answer this',
  'speech.ask.declined': 'Closed without an answer',
  'speech.ask.declinedBy': '{name} chose not to answer',
  /**
   * 답한 사람. 이름을 모르면 `common.someone` 이 들어온다 — **그 자리가 이름 자리**라
   * 보통명사가 와도 문장이 서야 하고, 그것이 `common` 에 그 낱말이 있는 이유다.
   */
  'speech.ask.answeredBy': '{name} picked',
  /** 이름을 모르는 에이전트. `message.audience.unknownAgent` 와 같은 값이지만 **뜻이 다르다** — 여기는 고를 쪽, 저기는 받을 쪽이다. */
  'speech.ask.unknownAgent': 'another agent',

  'speech.failure.title': 'Could not finish it',
  'speech.failure.callAgain': 'Call again',
  /**
   * **화면 문구가 아니라 초안이다** — 눌러도 안 보내고 작성창을 채운다(그 자리 주석).
   * 그래서 사람이 보내기 전에 읽고 고칠 글이고, 말투가 부탁이다.
   */
  'speech.failure.retryDraft': '@{handle} please try again',

  /** 도는 중 / 끝난 것. **상**[aspect]이 갈리고, 그 갈림이 점의 색과 같은 사실을 말한다. */
  'speech.progress.working': 'Working',
  'speech.progress.worked': 'Worked',
  /** 접힌 줄 수를 말해야 열 이유가 된다 — 하나뿐이면 화면이 이 버튼을 아예 안 그린다. */
  'speech.progress.expand': {
    one: 'Show {count} line',
    other: 'Show {count} lines',
  },
  'speech.progress.collapse': 'Collapse',

  /** 보고의 세 구획. **한 축에 선다** — 무엇을 했나 · 무엇이 바뀌었나 · 무엇이 남았나. */
  'speech.report.checks': 'Checked',
  'speech.report.files': 'Files changed',
  'speech.report.remaining': 'Left to do',

  /**
   * 접은 줄의 결론 머리. `decided` 는 **위 `ask.decided` 와 같은 낱말이어야 한다** —
   * 같은 사실(선택이 끝났다)을 두 자리가 다르게 부르면 어휘가 하나 늘어난다.
   */
  'speech.exchange.decided': 'Decided',
  'speech.exchange.finished': 'Finished',
  /** **`yet` 이 진다** — 빼면 판정이 되는데, 이 구간은 아직 도는 중일 수 있다. */
  'speech.exchange.undecided': 'Nothing decided yet',
  'speech.exchange.count': {
    one: '{count} exchange',
    other: '{count} exchanges',
  },
  /** 시각은 `toLocaleTimeString` 이 그 언어로 낸다 — 사전은 앞의 낱말만 진다. */
  'speech.exchange.last': 'last {time}',
  'speech.exchange.collapse': 'Collapse',

  // ---------------------------------------------------------------------------
  // thread — **판정 이름이지 화면 이름이 아니다**(`waitChain`·`daemonFacts` 와 같은 근거).
  //
  // 이 다섯 낱말은 `lib/threadState.ts::threadState` 의 판정 결과에 붙는 이름이고,
  // 그리는 화면이 **이미 셋이다**: `ThreadPanel`(머리띠) · `MessageItem`(답글 요약 배지) ·
  // `GallerySettings`(5단 견본). `waitChain` 머리말이 둘로도 충분하다고 한 조건을 넘는다.
  //
  // ## `THREAD_STATE_LABEL` 이 **모듈 상수였다**
  //
  // 이 PR 이 찾은 굳음이다. `Record<ThreadState, string>` 이 파일 맨 위에 서 있어
  // **로드 시점 언어로 굳었고**, 사전을 갈라 놔도 이 다섯은 영원히 한국어였을 것이다.
  // `SkillsSettings` 의 세 칸 이름과 `runnerLauncher` 의 `STRANGER_ATTACHED` 가 같은
  // 모양이었고 같은 방식으로 함수로 내렸다 — `threadStateLabel(state, t)`.
  //
  // ## 5단은 **한 사다리다** — 낱말이 그 순서를 져야 한다
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 내 차례 | `Your turn` | **2인칭이다**(`message.audience.me` 와 같은 규율). `My turn` 은 화면이 자기 차례라고 말하는 꼴이다 |
  // | 막힘 | `Stuck` | `Blocked` 는 **무엇에** 막혔는지를 묻게 하는데, 이 상태는 그 답이 없는 상태다(실패했거나 러너가 죽었다). `Stuck` 은 상태 그 자체의 이름이고 `ThreadState` 의 값 이름과도 같다 |
  // | 남을 기다림 | `Waiting on others` | `Waiting` 만 두면 위의 `Your turn` 과 대비가 안 선다 — 이 사다리에서 중요한 것은 **나냐 남이냐**다. `waitChain.sectionTitle`(`Waiting on`)과 같은 동사를 쓴다 |
  // | 도는 중 | `Running` | 답이 필요 없는 구간. `In progress` 는 `speech.progress.*` 와 겹쳐 어휘가 둘이 된다 |
  // | 끝남 | `Done` | |
  // ---------------------------------------------------------------------------

  'thread.state.myTurn': 'Your turn',
  'thread.state.stuck': 'Stuck',
  'thread.state.waiting': 'Waiting on others',
  'thread.state.running': 'Running',
  'thread.state.done': 'Done',

  /**
   * 채널 요약의 말 슬롯 — **"누가 누구를 기다린다"**. `waitChain.link` 와 **같은 문장**을
   * 다른 재료(`openAskLinks`)에서 내는 자리라, 키를 따로 두지 않고 그것을 부른다.
   *
   * 이 자리가 `subjectParticle` 을 쓰던 **마지막 호출처**였다(`en.ts` 머리말의 남은 것
   * 표). 조사가 번역기 안으로 들어가면서 그 함수와 `lib/particle.ts` 가 함께 사라졌다.
   */

  // ---------------------------------------------------------------------------
  // inbox — **판정 이름이면서 화면 이름이기도 하다** — 두 규칙이 같은 곳에 떨어졌다.
  //
  // 이 여섯 말표는 `lib/inboxRow.ts::inboxRow` 가 `meta` 를 읽어 정하고, 그리는 화면은
  // `Inbox` 하나다. 규칙 2(판정 이름)와 규칙 3(화면 이름)이 **같은 이름을 낸다** —
  // 그래서 어느 쪽으로 읽어도 `inbox` 다.
  //
  // 그럼에도 **판정 쪽으로 읽어 두는 것**이 이 머리말의 요점이다: 이 판정은 인박스 밖에서
  // 불릴 수 있는 모양(순수 함수 + `meta` 만 본다)이고, 실제로 `AgentExchange` 가 그 어휘를
  // 이미 빌려 쓴다(그 파일 주석: *"`inboxRow` 가 보고에 쓰는 `끝냈다` 를 그대로 가져온다"*).
  // 두 번째 화면이 오면 그때 이름을 안 바꾸어도 된다.
  //
  // ## 여섯이 **rank 순으로 읽힌다** — 낱말이 그 순서를 져야 한다
  //
  // 이 파일의 요점은 *"네 줄이 글자 하나까지 똑같다"* 를 고친 것이고, 그래서 여섯이
  // 서로 달라야 한다는 것이 어휘의 제약이다. 그리고 rank(0 나를 막는다 → 1 읽을 것 →
  // 2 배경)가 낱말의 무게로도 읽혀야 한다.
  //
  // | 한국어 | rank | 영어 | 왜 |
  // |---|---|---|---|
  // | 골라 줘 | 0 | `Pick one` | **`speech.ask.pickOne` 과 같은 말이다.** 같은 물음이 카드에서도 인박스에서도 나를 부르므로, 다르게 부르면 사람은 둘을 다른 사건으로 센다. 그래도 **키는 따로 둔다** — 승격 자격은 "글자가 같다"가 아니라 "뜻이 하나다"이고(`en.ts` 머리말), 인박스의 말표는 카드의 머리글과 달리 **한 줄에 서는 말표**라 나중에 짧아질 수 있다 |
  // | 막혔다 | 0 | `Stuck` | `thread.state.stuck` 과 같은 낱말. 실패는 **언제나 사람에게 온다**(`FailureMeta` 에 `to` 가 없는 이유) |
  // | 고르는 중 | 1 | `Being picked` | **남에게 간 물음이다.** `Waiting` 은 내가 기다린다고 읽히는데, 여기서 기다리는 것은 그 물음이다. 진행형이 "아직 안 끝났다"를 진다 |
  // | 끝냈다 | 1 | `Finished` | `speech.exchange.finished` 와 같은 낱말 — 완료 보고를 두 자리가 같은 말로 부른다 |
  // | 불렀다 | 1 | `Called you` | **누가 누구를**이 있어야 한다. `Mention` 은 명사라 그것이 나에게 온 일이라는 사실이 빠지고, 그러면 rank 1 인 이유가 안 읽힌다 |
  // | 답글 | 2 | `Reply` | 배경이다. 명사 한 낱말인 것이 이 rank 의 무게다 — 위 다섯이 문장인데 이것만 명사인 것이 곧 "나에게 온 일이 아니다"를 말한다 |
  //
  // `DM` 은 옮기지 않는다 — **이 제품의 고유어**이고 `waitChain.dm` 이 이미 같은 판단을 했다.
  // ---------------------------------------------------------------------------

  'inbox.label.ask': 'Pick one',
  'inbox.label.askOther': 'Being picked',
  'inbox.label.failure': 'Stuck',
  'inbox.label.report': 'Finished',
  'inbox.label.mention': 'Called you',
  'inbox.label.reply': 'Reply',
  // | 다른 사람이 먼저 고쳤다. 아래 현재 내용을 확인하고 다시 저장하면 내 편집으로 덮어쓴다. | `Someone else saved first. Read what is there now, below — saving again writes your version over it.` | **세 사실을 다 진다**: 무엇이 일어났나 · 어디를 보나 · 다시 누르면 무엇이 되나. 그 셋이 이 기능의 전부다(그 파일 주석 2번: 내 편집을 조용히 버리지 않는 대신 사람이 정한다). `Conflict` 한 낱말로 줄이면 사람은 자기 글이 사라졌는지부터 모른다 |
  // | 서버의 현재 내용 | `What is on the server now` | `Current version` 은 판(version) 이야기라 어느 쪽이 내 것인지 안 갈린다. 이 칸에 있는 것은 **남의 글**이고 `now` 가 내 편집칸과의 시차를 진다 |
  // | 아직 문서가 없다 | `No document yet` | `yet` 이 진다 — 못 읽은 것이 아니라 **아무도 아직 안 썼다**는 사실이고, 조회 실패는 위의 오류가 따로 말한다(그 파일 주석 1번) |
  // | 문서를 불러오지 못했다 | `The document did not arrive` | 머리말의 `The X did not arrive` 그대로다 — 빈 문서와 못 받은 문서를 가르는 이 화면의 규율이 그 문장에 있다 |
  // | (빈 문서) | `(empty)` | 서버에 있는 것이 **빈 문자열**이라는 사실이다. `No content` 는 문장이라 남의 글로 읽힌다 |
  // | 이 채널의 전제를 적어 둔다 | `Write down what this channel assumes` | placeholder 다. 문서가 무엇을 담는 자리인지 말한다 — `Write here` 는 아무것도 안 가르친다 |
  // | 아직 오간 파일이 없다 | `No files have been shared yet` | `yet` 이 같은 일을 한다. `shared` 인 이유: 이 목록이 담는 것은 올린 것이 아니라 **오간 것**이다(첨부 행) |
  // | 더 오래된 파일 | `Older files` | 버튼이다. `Load more` 는 방향을 안 말하는데 이 목록은 최신순이라 방향이 곧 뜻이다 |
  // | 보관된 채널이다 | `This channel is archived` | 작성창 자리에 서는 줄이라 **왜 못 쓰는지**가 답이다 |
  // | @{handle} 는 지금 응답하지 않는다 | `@{handle} is not responding` | 머리말이 이미 정한 낱말이다(`응답이 없다` → `is not responding`) — 주어가 있어야 누가 안 하는지가 온다 |
  // | #{name} 에 아직 메시지가 없다 | `No messages in #{name} yet` | |
  // | @{handle} 처럼 에이전트를 멘션하면 그 에이전트의 inbox 로 들어간다 | `Mention an agent like @{handle} and it lands in that agent's inbox` | **`답한다` 가 아니라 `inbox 로 들어간다`** 인 이유를 그 파일 주석이 적었다: 답이 오는지는 러너가 떠 있는가에 달렸고 이 화면은 그것을 모른다 |
  // | 사이드바에서 이 채널을 우클릭해 '채널 편집'으로 topic 을 정할 수 있다 | `Right-click this channel in the sidebar and set a topic with "Edit channel"` | 가리키는 항목 이름이 `sidebar.menu.edit` 의 값과 **같은 글자**여야 한다 — 안내가 가리킨 자리를 사람이 메뉴에서 못 찾으면 그 안내는 없느니만 못하다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`topic` · `repo` · `inbox`** — 이 제품의 고유어다. `topic` 은 채널 편집 폼의 필드
  //   이름(`sidebar.edit.topicPlaceholder`)이고 그 자리도 안 옮겼다
  // - **`⌘K` · `⋯` · `×` · `#` · `🔒` · `▼` · `▶`** — 기호이자 실제 키다
  // - **채널 이름 · 파일 이름 · `formatSize` 의 숫자** — 데이터다
  // - **`err.message`(서버 사유)** — 이 화면은 그것을 감싸기만 한다(`sidebar.runner
  //   .launchFailed` 와 같은 경계)
  // - **`RunnerStatusLine`(사유·설치 안내)** — 그 줄이 자기 문구를 들고 있고, 띠가 새로
  //   쓰지 않는 것이 그 자리의 규율이다(그 파일 주석)
  // ---------------------------------------------------------------------------

  'channel.doc.cancel': 'Cancel',
  'channel.doc.close': 'Close',
  /**
   * 409. **세 사실을 다 진다** — 무엇이 일어났나 · 어디를 보나 · 다시 누르면 무엇이 되나.
   * 그 셋이 이 기능의 전부다(내 편집은 편집칸에 그대로 있고 사람이 정한다).
   */
  'channel.doc.conflict':
    'Someone else saved first. Read what is there now, below — saving again writes your version over it.',
  'channel.doc.edit': 'Edit',
  'channel.doc.editLabel': 'Edit the document',
  /** 서버에 있는 것이 **빈 문자열**이라는 사실이다 — 남의 글이 아니라 그 상태의 이름이다. */
  'channel.doc.empty': '(empty)',
  'channel.doc.heading': 'Document',
  /** **`yet` 이 진다** — 못 읽은 것이 아니라 아무도 아직 안 썼다. 실패는 아래가 말한다. */
  'channel.doc.noneYet': 'No document yet',
  'channel.doc.loadFailed': 'The document did not arrive: {reason}',
  'channel.doc.loading': 'Loading…',
  'channel.doc.placeholder': 'Write down what this channel assumes',
  'channel.doc.save': 'Save',
  'channel.doc.saveFailed': 'The document was not saved',
  'channel.doc.saving': 'Saving…',
  /** 저장한 사람이 계정 목록에 없을 때. **"없다"가 아니라 "모른다"** 다. */
  'channel.doc.unknownAuthor': 'someone unknown',
  'channel.doc.unknownError': 'unknown error',
  /** 409 뒤에 서는 칸의 제목 — `now` 가 내 편집칸과의 시차를 진다. */
  'channel.doc.theirs': 'What is on the server now',

  'channel.empty.noMessages': 'No messages yet',
  'channel.empty.noMessagesIn': 'No messages in #{name} yet',
  /**
   * **`답한다` 가 아니라 `inbox 로 들어간다`** 다 — 답이 오는지는 러너가 떠 있는가에
   * 달렸고 이 화면은 그것을 모른다(그 파일 주석).
   */
  'channel.empty.tipMention': "Mention an agent like @{handle} and it lands in that agent's inbox.",
  /**
   * `"Edit channel"` 은 `sidebar.menu.edit` 의 값과 **같은 글자여야 한다** — 안내가
   * 가리킨 항목을 사람이 메뉴에서 못 찾으면 그 안내는 없느니만 못하다.
   */
  'channel.empty.tipTopic':
    'Right-click this channel in the sidebar and set a topic with "Edit channel".',

  'channel.files.close': 'Close the file list',
  'channel.files.empty': 'No files have been shared yet',
  'channel.files.heading': 'Files',
  'channel.files.label': 'Channel files',
  'channel.files.loadFailed': 'The file list did not arrive: {reason}',
  'channel.files.loading': 'Loading…',
  /** 방향이 곧 뜻이다 — 이 목록은 최신순이라 `Load more` 로는 어디로 가는지 모른다. */
  'channel.files.more': 'Older files',
  'channel.files.retry': 'Try again',
  'channel.files.unknownError': 'unknown error',

  'channel.header.archived': 'Archived',
  'channel.header.doc': 'Document',
  'channel.header.files': 'Files',
  'channel.header.search': 'Search',
  'channel.header.searchLabel': 'Search this channel',
  /** 두 진입점의 뜻이 다르므로 `title` 이 그 차이를 적는다(그 자리 주석). */
  'channel.header.searchTitle': 'Search this channel (⌘K searches everything)',

  'channel.pane.archived': 'This channel is archived',
  'channel.pane.jumpToBottom': 'Jump to latest',
  /** 계정 목록에 없는 id 일 때의 자리. **"없다"가 아니라 "모른다"** 다. */
  'channel.pane.runnerFailureAgent': 'agent',
  /** 머리말이 정한 낱말이다 — 주어가 있어야 누가 안 하는지가 온다. */
  'channel.pane.runnerFailureLine': '@{handle} is not responding',

  // ---------------------------------------------------------------------------
  // channelDirectory — **화면 이름이다.** `components/ChannelDirectory.tsx` 의 겹창.
  //
  // 위 `channel` 에 안 붙였다: 이것은 채널 **안**의 곁창이 아니라 채널을 **고르는**
  // 겹창이고, 채널을 안 연 상태에서도 뜬다(사이드바 찾기 줄의 「모든 채널에서 찾기」가
  // 여는 것이 이것이다). 담는 물음이 *"이 채널에서 무엇을 하나"* 가 아니라 *"어느 채널로
  // 가나"* 다.
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 채널 찾기 | `Find a channel` | 겹창 제목이다. `Channel directory` 는 우리 내부 이름(`ChannelDirectory`)이라 화면에 내면 사람이 무엇을 하는 곳인지 모른다 — 접근 이름은 그 구조 이름을 그대로 쓴다(아래 `label`) |
  // | 이름순 / 생성순 | `By name` / `By age` | `By date` 가 아니다 — 이 정렬은 **오래된 것부터** 세우고(그 파일의 `compareChannels`), `By date` 는 어느 방향인지 안 말한다. `By age` 는 나이순이라 오래된 것이 먼저라는 것이 이름에 있다 |
  // | 표준 채널이 없다 | `No channels here` | `standard` 는 내부 구분(`ChannelRow.kind`)이라 화면에 내지 않는다 — 사람이 보는 목록은 그냥 채널 목록이다 |
  // | 검색 결과가 없다 | `Nothing matches` | `sidebar.find.none` 과 같은 어휘다. 두 자리가 같은 물음(친 글자에 아무것도 안 걸렸다)에 답하므로 다르게 적을 이유가 없다 |
  // ---------------------------------------------------------------------------

  'channelDirectory.archived': 'Archived ({count})',
  'channelDirectory.close': 'Close the channel directory',
  'channelDirectory.empty': 'No channels here',
  'channelDirectory.heading': 'Find a channel',
  /** 겹창의 접근 이름 — 구조의 이름을 그대로 쓴다(제목은 사람의 말이다). */
  'channelDirectory.label': 'Channel directory',
  'channelDirectory.noMatch': 'Nothing matches',
  /** `sidebar.channel.private` 와 같은 말이지만 **다른 화면이다** — 승격은 아직 아니다. */
  'channelDirectory.private': 'Private channel',
  'channelDirectory.search': 'Search channels by name',
  'channelDirectory.searchPlaceholder': 'Channel name',
  /** **오래된 것부터** 세운다 — `By date` 는 방향을 안 말한다(위 표). */
  'channelDirectory.sortAge': 'By age',
  'channelDirectory.sortName': 'By name',

  // ---------------------------------------------------------------------------
  // search — **화면 이름이다.** `components/SearchPalette.tsx`(⌘K)의 겹창.
  //
  // `sidebar.find` 와 **다른 영역인 것이 요점이다.** 그 파일의 표가 둘을 갈랐다:
  // 이것은 메시지 **본문**을 서버 전문검색으로 뒤지고, 사이드바 줄은 이름을 스토어에서
  // 훑는다. 물음이 다르므로 어휘도 갈린다 — `Nothing matches`(이름이 안 걸렸다)와
  // `No messages matched`(그 말을 한 메시지가 없다)는 다른 사실이다.
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 검색 결과가 없습니다 | `No messages matched` | **무엇을 못 찾았는지** 말한다. 이 팔레트는 메시지만 뒤지므로(채널·사람은 사이드바 줄이 한다) 그 범위를 문장이 지녀야 한다 |
  // | 검색 중... | `Searching…` | |
  // | 검색 실패 | `The search did not go through` | 머리말의 규율이다 — `Search failed` 는 동작을 탓하고, 이 줄이 말할 것은 **결과가 안 왔다**는 상태다 |
  // | 전체에서 찾기 | `Search everything` | `sidebar.notify.all` 이 이미 `Everything` 으로 「전부」의 축을 정했다 |
  // | 이 채널에서 찾기 ({name}) | `Search this channel ({name})` | **`이 채널`을 안 버린다.** `Search in {name}` 으로 줄이면 그 이름이 **지금 보고 있는 곳**이라는 사실이 사라지고, 사람은 그것을 아무 채널의 이름으로 읽는다 — 좁히는 것이 사람의 명시적 선택이라는 이 팔레트의 규약(그 파일 주석 · `#221`)이 그 한 마디에 걸려 있다 |
  // | 이 채널에서만 ({name}) | `Only this channel ({name})` | 같은 이유로 `이 채널`이 남는다. 위 placeholder 와 **다른 낱말**인 것도 그대로다 — 하나는 지금 무엇을 하는지이고 하나는 무엇을 켜는지다 |
  // | 스레드 | `In a thread` | 결과 줄의 꼬리표다. `Thread` 한 낱말은 그 메시지가 스레드 **자체**로 읽힌다 — 이것은 그 메시지가 스레드 안에 있다는 표시다 |
  // | ↑↓ 이동 · Enter 선택 · Esc 닫기 | `↑↓ move` · `Enter open` · `Esc close` | 키 이름은 안 옮긴다(실제 키다). 동사만 옮긴다 — `Enter` 가 하는 일은 고르기가 아니라 **여는 것**이다(그 핸들러가 채널·스레드를 연다) |
  // | 이름 없는 채널 | `unnamed channel` | 이름이 `null` 인 채널이다. **"없다"를 말하는 것**이지 자리표시가 아니다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`DM` · `@{handle}` · `↑↓` · `Enter` · `Esc` · `⌘K`** — 고유어·이름·실제 키다
  // ---------------------------------------------------------------------------

  'search.palette.empty': 'No messages matched',
  'search.palette.failed': 'The search did not go through',
  'search.palette.hintClose': 'Esc close',
  /** **`open` 이다** — 이 키가 하는 일은 고르기가 아니라 그 채널·스레드를 여는 것이다. */
  'search.palette.hintOpen': 'Enter open',
  'search.palette.hintMove': '↑↓ move',
  'search.palette.input': 'Search terms',
  'search.palette.label': 'Search messages',
  'search.palette.loading': 'Searching…',
  'search.palette.more': 'Load more results',
  'search.palette.placeholderAll': 'Search everything',
  'search.palette.placeholderThread': 'Search this thread',
  /** **`this channel` 을 안 버린다** — 그 이름이 지금 보는 곳이라는 사실이 빠지면 안 된다. */
  'search.palette.placeholderScoped': 'Search this channel ({name})',
  'search.palette.results': 'Search results',
  /** 체크박스 라벨 — placeholder 와 **다른 낱말이어야 한다**(위 표). */
  'search.palette.scopeAll': 'Everything',
  'search.palette.scopeGroup': 'Search scope',
  'search.palette.scopeLabel': 'In this channel ({name})',
  'search.palette.scopeThread': 'This thread',
  /** 그 메시지가 스레드 **안에 있다**는 표시다 — 스레드 자체가 아니다. */
  'search.palette.thread': 'In a thread',
  'search.palette.unnamedChannel': 'unnamed channel',

  // ---------------------------------------------------------------------------
  // directory — **화면 이름이다.** `components/Directory.tsx` 의 겹창(사람·에이전트).
  //
  // 위 `channelDirectory` 와 갈린 이유는 그 머리말의 거울상이다 — 하나는 채널을 고르고
  // 이것은 계정을 본다. 한 영역으로 묶으면 셋째 칸을 두 화면의 구획이 나눠 먹는다.
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 이 워크스페이스에 아직 계정이 없다 | `No accounts in this workspace yet` | `yet` 이 진다. 못 받은 것은 위의 오류가 따로 말한다(그 화면이 세 상태를 가르는 이유) |
  // | 계정 목록을 불러오지 못했다 | `The account list did not arrive` | 머리말의 그 문장이다 |
  // | {label} 중 맞는 것이 없다 | `Nothing in {label} matches` | `{label}` 은 `People`·`Agents` 로 **이미 영어**다. 문장이 그것을 받는 자리라 어순이 갈린다 — 한국어는 뒤에, 영어는 앞에 |
  // | 비활성 | `Disabled` | `sidebar.members.agentDisabled` 와 같은 낱말·같은 뜻(계정이 꺼졌다)이다. **키는 나눈다** — 부르는 화면이 다르고, 승격은 세 번째 화면이 올 때다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`People` · `Agents` · `Directory` · `admin`** — 이미 영어다. 구획 제목 둘은
  //   `section()` 이 `aria-label` 로도 쓰므로 옮기면 그 이름도 함께 갈린다
  // - **`a.kind`(`human`/`agent`)** — 서버가 주는 **값**이다(`sidebar.notify` 와 같은 규율)
  // - **`PRESENCE_LABEL`** — `lib/presenceView.ts` 다. **이 파일 밖이라 안 건드렸다** —
  //   사이드바 PR 이 지킨 그 경계이고, 세 화면이 그것을 부르므로 `common` 후보이기도 하다
  //   (`en.ts` 머리말의 '남은 것' 표가 그 자리를 이미 지목했다)
  // ---------------------------------------------------------------------------

  'directory.close': 'Close the directory',
  'directory.disabled': 'Disabled',
  'directory.empty': 'No accounts in this workspace yet',
  'directory.label': 'Directory',
  'directory.listFailed': 'The account list did not arrive — {reason}',
  'directory.loading': 'Loading…',
  /** `{label}` 은 `People`·`Agents` 라 안 옮긴다 — 어순만 언어를 따른다. */
  'directory.sectionNoMatch': 'Nothing in {label} matches',
  'directory.retry': 'Try again',
  'directory.search': 'Search the directory',
  'directory.searchPlaceholder': 'Search by handle or name',

  // ---------------------------------------------------------------------------
  // saved — **화면 이름이다.** `components/SavedMessages.tsx` 의 오버레이(#219).
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 할 것 / 완료 | `To do` / `Done` | **탭 두 칸이 한 축에 선다.** 값 집합은 `open`/`done` 인데 그것을 그대로 쓰면(`Open`/`Done`) `Open` 이 "열려 있다"로도 "열어라"로도 읽힌다 — 이 목록이 담는 것은 상태가 아니라 **내가 미뤄 둔 일**이다 |
  // | 완료로 표시 / 할 것으로 되돌리기 | `Mark as done` / `Put back on the list` | 뒤엣것이 `Mark as to do` 가 아닌 이유: 그 버튼이 하는 일은 표시를 바꾸는 것이 아니라 **완료 탭에서 할 것 탭으로 옮기는 것**이고(서버가 행을 옮긴다), 사람이 보는 결과가 그 이동이다 |
  // | 삭제된 메시지 | `Deleted message` | 자리는 남고 본문은 없다(#219 결정 3) — 그 사실의 이름이다 |
  // | 저장된 메시지가 없다 / 완료된 메시지가 없다 | `Nothing saved yet` / `Nothing done yet` | 탭마다 다른 문장인 것이 요점이다. 하나로 묶으면 완료 탭에서 "저장한 것이 없다"고 말해 거짓이 된다 |
  // | 불러오지 못했다 | `The list did not arrive` | 머리말의 그 문장이다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`Saved` · `just me`** — 이미 영어다
  // - **`#{channel}` · `@{handle}` · 본문 미리보기 · 시각** — 데이터다
  // - **`✓` · `↺` · `✕`** — 기호다. 접근 이름은 아래 둘이 진다
  // ---------------------------------------------------------------------------

  'saved.close': 'Close the panel',
  'saved.deleted': 'Deleted message',
  'saved.emptyDone': 'Nothing done yet',
  'saved.emptyOpen': 'Nothing saved yet',
  'saved.label': 'Saved messages',
  'saved.listFailed': 'The list did not arrive — {reason}',
  'saved.loading': 'Loading…',
  'saved.markDone': 'Mark as done',
  /** **표시가 아니라 이동이다** — 서버가 행을 다른 탭으로 옮기고, 사람이 보는 것이 그것이다. */
  'saved.markOpen': 'Put back on the list',
  'saved.retry': 'Try again',
  'saved.tabDone': 'Done',
  'saved.tabOpen': 'To do',

  // ---------------------------------------------------------------------------
  // status — **판정 이름이 아니라 한 벌의 어휘다**(`speech` 머리말의 세 번째 경우).
  //
  // 이 셋(`available`·`away`·`dnd`)의 이름을 **두 화면이 그린다**: 고르는 자리
  // (`StatusPicker`)와 남의 상태를 읽는 자리(`Identity::StatusMark`). 화면 이름으로
  // 영역을 잡으면 둘 중 하나가 남의 키를 부르게 되고, 그것이 `waitChain` 머리말이 화면
  // 이름을 금지한 조건이다. 값 집합은 `shared` 의 `ACCOUNT_STATUSES` 하나에서 온다 —
  // `sidebar.notify` 가 `shared` 의 `NOTIFY_LEVELS` 때문에 따로 선 것과 같은 사정이다.
  //
  // ## 값과 라벨을 갈랐다 — **`available`·`away`·`dnd` 는 안 옮긴다**
  //
  // 그 셋은 **저장·전송용 값**이다(`setStatus(status)` 로 서버에 가고 `data-status` 로
  // 화면에 남으며 회귀선이 그 속성을 잰다). 사전에 오는 것은 그 값에 씌우는 이름뿐이고,
  // 코드의 표는 **키를 들고 남는다** — `NotifiedGapRow::LABEL` 의 선례다. 표를 없애고
  // 함수로 내리면 *"종류를 추가하면 컴파일이 막힌다"* 는 `Record<AccountStatus, …>` 의
  // 이점이 사라지는데, **키는 언어를 안 지니므로** 상수여도 굳지 않는다.
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 대화 가능 | `Available` | 이 값의 이름이 이미 `available` 이고, 사람이 고르는 것도 그 상태다 |
  // | 자리 비움 | `Away` | |
  // | 방해 금지 | `Do not disturb` | `DND` 는 약자라 처음 보는 사람이 못 읽는다. `Busy` 는 다른 뜻이다 — 이것은 바쁘다는 보고가 아니라 **부르지 말라는 요청**이다 |
  // | 짧은 문구 (최대 80자) | `A short note (80 characters max)` | 한도가 이름에 있어야 사람이 잘리기 전에 안다. `maxLength` 가 조용히 자르므로 화면이 말해야 한다 |
  // | 문구 지우기 | `Clear the note` | **명시적 `null`** 을 보내는 버튼이다(그 자리 주석: 빈 문자열로 지우면 "없다"와 "빈 것이 있다"가 섞인다). `Clear` 만으로는 무엇을 지우는지 안 갈린다 — 옆에 상태 버튼 셋이 있다 |
  // | 상태를 바꾸지 못했다 | `The status was not changed` | 머리말의 그 문장이다 — 실패를 삼키면 사람은 정했다고 믿는데 남들에게는 옛 상태로 보인다 |
  // ---------------------------------------------------------------------------

  /** `{label}` 에 아래 상태 이름이, `{text}` 에 사람이 적은 문구가 든다. */
  'status.mark.withText': '{label}: {text}',
  'status.picker.clear': 'Clear the note',
  'status.picker.close': 'Close',
  'status.picker.failed': 'The status was not changed',
  /** 한도가 이름에 있어야 사람이 잘리기 전에 안다 — `maxLength` 는 조용히 자른다. */
  'status.picker.notePlaceholder': 'A short note (80 characters max)',
  'status.picker.noteLabel': 'Status note',
  'status.picker.save': 'Save',
  'status.value.available': 'Available',
  'status.value.away': 'Away',
  /** **약자를 안 쓴다** — 처음 보는 사람이 못 읽는다. `Busy` 는 다른 뜻이다(위 표). */
  'status.value.dnd': 'Do not disturb',

  // ---------------------------------------------------------------------------
  // rail — **화면 이름이다.** `components/Rail.tsx` 와 `components/CommunityRail.tsx`.
  //
  // 둘을 한 영역에 둔 이유: **같은 자리에 서는 같은 물건**이다. 커뮤니티가 하나면
  // `Rail` 이 마크를 그리고 둘 이상이면 `CommunityRail` 이 그 왼쪽에 서는데, 두 파일이
  // 내는 말이 실제로 **같은 문장**이다(`{label} — 연결됨/연결 끊김`). 영역을 가르면 그
  // 한 문장이 두 곳에 적히고, 두 파일의 주석이 이미 그 중복을 위험으로 적어 뒀다
  // (*"같은 일을 하는 두 번째 표면을 만들면 어느 쪽이 정본인지 알 수 없게 된다"*).
  //
  // 사이드바에 안 붙인 것은 자리 때문이다 — 레일은 `Workspace` 가 사이드바 **밖에**
  // 세우고(그 파일 주석), 사이드바를 접어도 남는다.
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 주 목록 | `Main navigation` | `nav` 의 접근 이름이다. `Main list` 는 목록 하나를 가리키는데 이것은 목록들 사이를 고르는 자리다 |
  // | 연결됨 / 연결 끊김 | `connected` / `disconnected` | 이름 뒤에 붙는 조각이라 소문자다(`{label} — connected`). `sidebar.brand.disconnected` 가 두 마디를 지키는 것과 달리 여기는 **타일 하나에 붙는 꼬리표**라 그 자리에 문장이 설 수 없다 |
  // | 나를 기다리는 것 {n}개 | `{count} waiting for you` | **배지의 숫자를 이름이 진다**(그 파일 주석: 주황 원 하나는 스크린리더에 아무것도 아니다). `unread` 가 아닌 이유는 이 배지가 안 읽음이 아니라 **나를 막는 것**만 세기 때문이다(문서) |
  // | 담아 둔 메시지 {n}개 | `{count} saved` | 배지로 안 그리고 이름에만 싣는 수치다(그 자리 주석) |
  // | 내 계정 메뉴 | `Your account menu` | |
  // | 내 프로필 | `Your profile` | |
  // | 상태 바꾸기 | `Change your status` | 메뉴 항목이라 동사로 선다 — 무엇이 열리는지가 아니라 무엇을 하는지가 답이다 |
  // | 커뮤니티 전환 | `Switch community` | |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **칸 이름 넷(`Home`·`DM`·`Agents`·`Saved`)과 그 접근 이름** — **이미 영어다.**
  //   그리고 `RAIL_CELLS` 표에서 폭을 재어 고른 값이라(그 주석의 실측: `Agents` 가 11px
  //   에서 32.89px), 언어마다 길이가 갈리면 그 계산이 무너진다. 옮기려면 **먼저 그 폭을
  //   다시 재야 한다** — 이 PR 의 일이 아니다
  // - **`Settings` · `Sign out` · `⌘,`** — 이미 영어이고 단축키는 실제 키다
  // - **`{label}`(커뮤니티 이름) · 이니셜** — 데이터다
  // ---------------------------------------------------------------------------

  'rail.community.label': 'Switch community',
  'rail.community.connected': 'connected',
  'rail.community.disconnected': 'disconnected',
  /** `{name}` 은 커뮤니티 이름, `{state}` 에 위 둘 중 하나가 든다. */
  'rail.community.tile': '{name} — {state}',
  'rail.me.menu': 'Your account menu',
  'rail.me.menuFor': '{handle} — your account menu',
  'rail.me.profile': 'Your profile',
  'rail.me.status': 'Change your status',
  'rail.nav.label': 'Main navigation',
  /** 이름 뒤에 붙는 조각 — `{name}` 은 칸 이름(`Home`·`Saved`)이다. */
  'rail.cell.withCount': '{name} — {count}',
  /**
   * **안 읽음이 아니라 나를 막는 것**만 센다(문서).
   *
   * **복수형이 아니다.** `1 waiting for you` 와 `2 waiting for you` 가 같은 글자다 —
   * `waiting` 은 여기서 분사이지 세는 명사가 아니라 영어도 안 갈린다(`composer.schedule
   * .summary` 의 `{count} scheduled` 가 같은 판단이고, 그 옆의 `{count} attachment(s)` 가
   * 갈리는 것은 **명사를 세기 때문**이다).
   */
  'rail.cell.blocking': '{count} waiting for you',
  /** 배지로 안 그리고 이름에만 싣는 수치다. 위와 같은 이유로 복수형이 아니다. */
  'rail.cell.saved': '{count} saved',

  // ---------------------------------------------------------------------------
  // workspace — **화면 이름이다.** `components/Workspace.tsx` 의 맨 위 띠.
  //
  // 넷뿐이라 덩어리를 안 판다(두 칸이 된다 — 머리말의 *"없으면 생략"*).
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 뒤로 / 앞으로 | `Back` / `Forward` | |
  // | 미읽음 훑기 | `Sweep unread` | 버튼 글자다. `Sweep` 이 이 기능의 이름이고(`Sweep.tsx`), 무엇을 훑는지가 붙어야 한다 |
  // | 미읽음을 하나씩 훑는다 | `Go through the unread one at a time` | `title` 이다 — 버튼 이름이 못 하는 말(**하나씩**)을 여기가 한다 |
  // | 사이드바 펼치기 | `Show the sidebar` | 접혀 있을 때만 서는 버튼이라 `Toggle` 이 아니다 |
  //
  // **`앞로 (Cmd+])` 의 오타를 고쳤다** — 옮기면서 발견했다(`앞으로` 여야 한다).
  // 영어 원본에는 그 자리가 `Forward (Cmd+])` 로 서고, 한국어도 바른 글자로 돌아간다.
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`Cmd+[` · `Cmd+]` · `←` · `→`** — 실제 키와 기호다
  // ---------------------------------------------------------------------------

  'workspace.back': 'Back',
  'workspace.backTitle': 'Back (Cmd+[)',
  'workspace.forward': 'Forward',
  'workspace.forwardTitle': 'Forward (Cmd+])',
  'workspace.showSidebar': 'Show the sidebar',
  'workspace.sweep': 'Sweep unread',
  /** 버튼 이름이 못 하는 말(**하나씩**)을 `title` 이 한다. */
  'workspace.sweepTitle': 'Go through the unread one at a time',

  // ---------------------------------------------------------------------------
  // identity — **판정 이름이다.** `components/Identity.tsx` 의 배지 셋이 내는 말이고,
  // 그 컴포넌트는 **거의 모든 화면**이 부른다(사이드바 · 디렉터리 · 메시지 행 · 팀 상세 ·
  // 작성창 …). 화면 이름으로 영역을 잡으면 그중 하나가 남의 키를 부르게 되는 바로 그
  // 조건이다(`waitChain` 머리말).
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 알 수 없는 계정 | `Unknown account` | **"없다"와 "모른다"는 다르다**(그 파일 주석 · design.md §4). `Missing` 은 없어졌다는 뜻이라 거짓이다 — 계정 목록에 아직 안 온 id 다 |
  // | 집합 / 팀 | `Group` / `Team` | `sr-only` 로만 서는 이름이라 배지가 무엇인지 스크린리더에 말한다. `groups.*` 영역이 이미 `group` 으로 정했고(그 머리말), 팀은 `agents.teams` 가 정했다 — 두 어휘를 여기서 다시 정하지 않는다 |
  // | {n}명 | `{count}` | **숫자만 남긴다.** `composer.mention.groupCount` 가 이미 같은 판단을 적었다: 한국어의 `명` 은 사람 세는 단위인데 집합에도 팀에도 에이전트가 든다 — 원래 문구가 이미 부정확했고 영어에서 `people` 로 옮기면 그 부정확이 굳는다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`?` · `👥` · `🤖` · `🌙` · `⛔`** — 글리프다. 이름은 위 `sr-only` 가 진다
  // - **상태 이름 셋** — `status.value.*` 가 진다. 이 파일이 그것을 부르는 것이지 자기 것을
  //   갖지 않는다(그 셋이 두 화면에 서는 한 벌이라는 것이 `status` 머리말의 근거다)
  // ---------------------------------------------------------------------------

  /** **"없다"가 아니라 "모른다"** 다 — 계정 목록에 아직 안 온 id 다. */
  'identity.account.unknown': 'Unknown account',
  /** **숫자만 남긴다** — 집합에도 팀에도 에이전트가 든다(위 표). */
  'identity.badge.count': '{count}',
  'identity.badge.group': 'Group',
  'identity.badge.team': 'Team',

  // ---------------------------------------------------------------------------
  // invite — **화면 이름이다.** `settings/InviteSettings.tsx`.
  //
  // `agents.teams` 에 안 붙였다: 팀은 에이전트를 묶는 일이고 이것은 **사람을 이 서버로
  // 부르는 일**이다. 설정 화면 하나 = 영역 하나라는 그 규칙 그대로다.
  //
  // ## 어투를 `~다` 로 맞췄다
  //
  // 이 화면만 `~습니다`·`~세요` 였다. `profileName` 이 같은 이유로 같은 일을 했고
  // (그 머리말), 한 화면만 높임말이면 같은 앱이 사람을 두 가지로 대한다. **뜻은 그대로
  // 두고 어투만 바꿨다** — 회귀선이 그것을 잰다.
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | 이 화면은 관리자만 볼 수 있습니다 | `Only an admin can see this screen` | `admin` 은 안 옮긴다. 원래 한국어의 `관리자` 가 그 값을 가리키는 말이었고, 이 저장소는 그 자리에 `admin` 을 쓴다(`agents` 머리말) |
  // | 초대 토큰을 만들어 … 한 번 쓰면 소진됩니다 | `Create an invite token to bring someone into this workspace. The token is shown once, right after it is minted, and never again. It is used up the first time someone signs up with it.` | **세 사실을 다 진다**: 무엇을 하나 · 한 번만 보인다 · 한 번 쓰면 끝이다. 셋 다 되돌릴 수 없는 것에 관한 말이라 하나도 못 뺀다 |
  // | 이 토큰은 지금만 보입니다 — 창을 벗어나면 다시 볼 수 없습니다 | `This token is on screen only now — leave this view and it is gone` | **놓치면 되돌릴 수 없다**는 것이 이 줄의 전부다(그 자리 주석이 크기를 안 내린 이유로 적었다) |
  // | 받는 사람이 가입할 때 이 토큰이 필요합니다. 지금 복사해 두세요. | `Whoever you invite needs this token to sign up. Copy it now.` | 뒤 문장이 **지금 할 일**이다 |
  // | 새 토큰 발급 (앞 토큰은 화면에서 사라집니다) | `Mint a new token (the one above disappears)` | 괄호가 **버튼을 누르면 무엇을 잃는지** 말한다(그 자리 주석: 그래서 버튼을 잠그지 않는다) |
  // | 초대 발급에 실패했습니다 | `The token was not minted` | 머리말의 그 문장이다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`Invite`(화면 제목) · `admin`** — 이미 영어이자 고유어다
  // - **토큰 문자열** — 데이터다
  // ---------------------------------------------------------------------------

  'invite.busy': 'Minting…',
  'invite.create': 'Mint an invite token',
  'invite.createAgain': 'Mint a new token (the one above disappears)',
  'invite.failed': 'The token was not minted',
  'invite.notAdmin': 'Only an admin can see this screen',
  /** **세 사실을 다 진다** — 무엇을 하나 · 한 번만 보인다 · 한 번 쓰면 끝이다. */
  'invite.note':
    'Create an invite token to bring someone into this workspace. The token is shown once, right '
    + 'after it is minted, and never again. It is used up the first time someone signs up with it.',
  'invite.tokenNextStep': 'Whoever you invite needs this token to sign up. Copy it now.',
  /** **놓치면 되돌릴 수 없다**는 것이 이 줄의 전부다. */
  'invite.tokenWarning': 'This token is on screen only now — leave this view and it is gone',

  // ---------------------------------------------------------------------------
  // reactions — **누가 달았나.** `components/Reactions.tsx` 의 칩 호버가 이 낱말들로
  // 목록을 짠다(`lib/reactionNames.ts`).
  //
  // 문장이 아니라 **낱말 셋**인 이유: 목록 자체는 계정 이름이라 번역할 것이 없고,
  // 번역이 필요한 것은 그 목록 안의 세 자리뿐이다 — 나 · 모르는 계정 · 접힌 나머지.
  // ---------------------------------------------------------------------------

  /**
   * 목록에서 나를 가리키는 낱말. **내 핸들을 안 적는다** — 자기 핸들을 목록에서 찾아
   * 그것이 자신임을 알아내는 것은 사람이 할 일이 아니고, 칩 테두리가 말하는 "내가
   * 눌렀다"와 같은 사실을 툴팁도 같은 낱말로 말해야 둘이 서로를 확인해 준다.
   */
  'reactions.you': 'you',
  /**
   * 계정을 아직 못 받았다. **지어내지 않는다** — 누군가 누른 것은 확실하므로 그 사실만
   * 말한다. 빈 자리로 두면 `, , ` 처럼 이름이 없는 자리가 목록에 생기고 사람이 그것을
   * 이름으로 읽는다.
   */
  'reactions.unknown': 'someone',
  /**
   * 이름이 상한(`lib/reactionNames.ts::MAX_REACTOR_NAMES`)을 넘었다. **몇 명이 접혔는지
   * 수로 말한다** — `…` 만 두면 사람이 칩의 숫자에서 보이는 이름 수를 빼야 한다.
   *
   * 복수형 갈래를 둘 다 적는 이유: 접히는 것은 정의상 둘 이상이므로 `one` 이 화면에
   * 뜨는 일은 없지만, `en.ts` 가 복수형 키의 정본이고 회귀선(`i18n.test.tsx`)이
   * *"영어의 복수형 항목은 one 과 other 를 다 갖는다"* 를 잰다.
   */
  'reactions.andMore': {
    one: '{names} and {count} more',
    other: '{names} and {count} more',
  },

  // ---------------------------------------------------------------------------
  // boot — **화면 이름이다.** `components/BootNotice.tsx`(`#460`).
  //
  // ## 부팅 시점에 언어를 아는가 — **안다. 문제 없다** (실측 2026-09-08)
  //
  // 이 화면은 세션도 못 읽은 시점에 뜨므로 언어를 물을 곳이 있는지부터 확인했다.
  // `useT` → `usePrefsStore` → `prefsStorage.load()` 이고 그 함수는 `localStorage
  // .getItem` **동기 호출**이다. 스토어가 만들어지는 순간(모듈 로드) 이미 값이 들어 있고,
  // 저장된 것이 없으면 `'system'` → `detectLocale()` 이 브라우저에게 묻는다. 두 경로 다
  // 왕복이 없다 — 키체인을 기다리는 이 화면이 **그 대기 전에** 제 언어로 뜬다.
  //
  // (`Workspace` 도 같은 이유로 안전하다. 그 화면은 애초에 세션을 읽은 뒤에 선다.)
  //
  // ## 두 문구가 `export` 로 남는다 — **값은 사전에서 온다**
  //
  // `KEYCHAIN_WAIT_TITLE`·`KEYCHAIN_WAIT_HINT` 는 회귀선(`keychainWaitNotice.test.tsx`)이
  // import 해서 쓴다. 지우면 그 시험이 문구를 손으로 다시 적게 되고, 그러면 화면과 시험이
  // 갈릴 수 있다. 그래서 **함수로 내린다** — `skills` 의 확인 문구 셋이 같은 처지에서
  // 같은 선례를 세웠다(`lastTurnLabel` 의 그것). 상수로 두면 모듈 로드 시점 언어로 굳는다.
  //
  // ## 영어를 새로 설계한 자리
  //
  // | 한국어 | 영어 | 왜 |
  // |---|---|---|
  // | OS 키체인의 승인을 기다리는 중 | `Waiting for the OS keychain to be approved` | **관측된 사실**이다(그 파일 주석). 진행형이 *"지금 멈춰 있다"* 를 진다 — 머리말이 `is waiting for` 를 고른 그 근거다 |
  // | 시스템 승인 대화상자가 떠 있는지 확인하라 — 다른 창 뒤에 가려져 있을 수 있다. 승인하면 곧바로 이어진다. | `Check whether a system approval dialog is open — it can be hidden behind another window. Approve it and this continues right away.` | **단언하지 않는다**(`#368`): `A dialog is waiting` 이 아니라 `Check whether`. 그리고 **가려질 수 있다**까지 말한다 — 실측에서 대화상자는 떠 있었고 사람이 그것을 못 찾은 것이 36분의 실체였다 |
  //
  // ## 사전에 **안** 넣은 것
  //
  // - **`Connecting…`** — 유예 안에서 서는 줄이고 **이미 영어다.** 그리고 그 줄은
  //   *"아는 것의 전부"* 라 그대로 둔다는 것이 그 파일의 결정이다
  // ---------------------------------------------------------------------------

  /** **관측된 사실**이다 — 진행형이 "지금 멈춰 있다"를 진다. */
  'boot.keychain.title': 'Waiting for the OS keychain to be approved',
  /**
   * 사람이 다음에 할 수 있는 일. **이것이 빠지면 고친 게 아니다**(그 파일 주석) —
   * `Check whether` 로 두는 것이 `#368` 의 요구다: 대화상자가 떠 있다고 **단언하지 않는다**.
   */
  'boot.keychain.hint':
    'Check whether a system approval dialog is open — it can be hidden behind another window. '
    + 'Approve it and this continues right away.',
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
