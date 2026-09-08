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
 * **에이전트 설정**(`AgentsSettings`) 146개를, 이 PR 이 **러너 판정 둘**
 * (`runnerLauncher.ts` 35 · `daemonFacts.ts` 18)을 옮겼다.
 * 남은 것을 무게순으로 적어 둔다 — 각각이 **한 PR** 이다.
 *
 * | 남은 것 | 규모 | 먼저 풀어야 할 것 |
 * |---|---|---|
 * | `AgentGrid` | 99 | 버전 칩 어휘(`뒤처짐`·`버전 모름`·`멈추는 중`)를 위 표에서 가져온다. **`agents.*` 에 붙는다** — 같은 화면의 격자이고, 이미 선 덩어리(`grid`·`stale`)가 그 자리다 |
 * | `TeamDetail` · `TeamGrid` · `TeamMemberPicker` | 8 · 4 · 5 | **`agents.teams.*` 가 이미 서 있다.** 팀 묶음의 격자 머리와 만들기 폼은 이 PR 이 옮겼고, 상세는 그 파일들에 남아 있다 |
 * | `Profile` | 소수 | `lastTurnLabel` 이 **이미 번역기를 받는다**(이 PR 이 그렇게 바꿨다) — 그 화면이 `useT` 를 이미 들고 있으므로 나머지는 키만 씌우면 된다 |
 * | ~~`runnerLauncher.ts`~~ | — | **끝났다**(아래 `runner.*`). 남은 일곱은 `throw new Error(...)` 라 **사람에게 가는 말이 아니다** — 그 영역 머리말이 안 넣은 이유를 적었다 |
 * | `controller.ts` | 59 | 판정 함수. **번역기를 넘기는 배선은 이 PR 이 이미 깔았다**(`RunnerLauncher` 생성자의 마지막 인자) — 그 자리를 그대로 쓰면 된다 |
 * | `packages/shared::installHint` | 3 | **이 저장소의 다른 패키지다.** `runner.exit.notFound` 뒤에 붙는 설치 안내 한 줄이 아직 한국어인데, 서버·러너가 함께 쓰는 패키지라 데스크탑 사전이 닿을 수 없다. 먼저 정할 것: `Translate` 를 `shared` 로 내릴지, 아니면 그 판정이 **키만 내고** 데스크탑이 문구를 씌울지 |
 * | `MessageItem` | 57 | **손으로 하는 복수형이 여기 있다**(`replyCount === 1 ? 'reply' : 'replies'`) — `waitChain.unblocks` 와 같은 모양으로 사전에 넘긴다. `subjectParticle` 을 아직 쓰는 유일한 자리이기도 하다(그 함수는 그때 지운다) |
 * | `Composer` · `Inbox` | 55 · 49 | |
 * | ~~`daemonFacts.ts`~~ | — | **끝났다**(아래 `daemonFacts.*`). 그 표가 경고한 대로 회귀선을 **키가 아니라 문구로** 남겼다 — `i18n.test.tsx` 가 제약 1(주어)·제약 2(판정 낱말 없음)를 **두 언어로** 다시 잰다 |
 * | ~~시간 표기~~ | — | **끝났다** — 아래 `time.*` 과 `lib/time.ts` 를 보라 |
 * | 설정 목차 14개 · `Save`·`Cancel`·`Invite` 등 | 소수 | 이미 영어다 — **키만 씌우면 된다.** 둘 이상이 쓰므로 `common.*` 로 간다 |
 * | 나머지 설정 화면들(`Gallery`·`Skills`·`HandleGroups`·`AgentDefaults` 등) | 42 · 19 · 16 · 11 | 각각 자기 영역(`gallery`·`skills`·…)을 연다. 영역 이름을 `settings.*` 로 묶지 않는 근거는 아래 `agents` 머리말에 있다 |
 * | `RunnerStatus.tsx::runnerStatusLabel` · `lib/presenceView.ts::PRESENCE_LABEL` | 소수 | **사이드바가 이미 부르고 있다**(`sidebar.runner.state` 가 그 값을 감싼다). 둘 다 세 화면 이상이 쓰므로 옮길 때 `common.*` 후보다 |
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
  'common.someone': 'someone',

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
  'agents.stale.restartFailed': 'The runners were not restarted: {reason}',
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

  'agents.teams.cancel': 'Cancel',
  'agents.teams.create': 'Create',
  'agents.teams.createFailed': 'The team was not created',
  'agents.teams.heading': 'Teams',
  /** 팀 이름도 handle 문법이다 — 서버가 같은 상수로 검사한다(`HANDLE_PATTERN`). */
  'agents.teams.invalidName':
    'Names take letters, digits, hyphens and underscores — 2 to 32 characters',
  'agents.teams.listFailed': 'The team list did not arrive',
  'agents.teams.nameLabel': 'New team name',
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
