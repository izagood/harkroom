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
 * 뼈대 PR 이 **대기 사슬** 13개를, 그 다음이 **사이드바** 107개를, 이 PR 이
 * **에이전트 설정**(`AgentsSettings`) 146개를 옮겼다.
 * 남은 것을 무게순으로 적어 둔다 — 각각이 **한 PR** 이다.
 *
 * | 남은 것 | 규모 | 먼저 풀어야 할 것 |
 * |---|---|---|
 * | `AgentGrid` | 99 | 버전 칩 어휘(`뒤처짐`·`버전 모름`·`멈추는 중`)를 위 표에서 가져온다. **`agents.*` 에 붙는다** — 같은 화면의 격자이고, 이미 선 덩어리(`grid`·`stale`)가 그 자리다 |
 * | `TeamDetail` · `TeamGrid` · `TeamMemberPicker` | 8 · 4 · 5 | **`agents.teams.*` 가 이미 서 있다.** 팀 묶음의 격자 머리와 만들기 폼은 이 PR 이 옮겼고, 상세는 그 파일들에 남아 있다 |
 * | `Profile` | 소수 | `lastTurnLabel` 이 **이미 번역기를 받는다**(이 PR 이 그렇게 바꿨다) — 그 화면이 `useT` 를 이미 들고 있으므로 나머지는 키만 씌우면 된다 |
 * | `runnerLauncher.ts` | 118 | **판정 함수다** — `chainSentences` 와 같은 (b) 주입을 쓴다 |
 * | `controller.ts` | 59 | 판정 함수. 위와 같다 |
 * | `MessageItem` | 57 | **손으로 하는 복수형이 여기 있다**(`replyCount === 1 ? 'reply' : 'replies'`) — `waitChain.unblocks` 와 같은 모양으로 사전에 넘긴다. `subjectParticle` 을 아직 쓰는 유일한 자리이기도 하다(그 함수는 그때 지운다) |
 * | `Composer` · `Inbox` | 55 · 49 | |
 * | `daemonFacts.ts` | 38 | 판정 함수. **회귀선이 판정 낱말 7개를 검사한다**(`daemonFacts.test.tsx` 의 제약 2) — 그 축은 문구에 `이상`·`비정상` 이 **없음**을 재므로, 옮긴 뒤에도 문구를 재야 한다(키로는 못 잰다) |
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
