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
 * 이 PR 은 **뼈대와 한 화면**(대기 사슬)만 했다. 실측 ~277개 중 여기서 옮긴 것은 13개다.
 * 남은 것을 무게순으로 적어 둔다 — 각각이 **한 PR** 이다.
 *
 * | 남은 것 | 규모 | 먼저 풀어야 할 것 |
 * |---|---|---|
 * | `AgentsSettings` · `AgentGrid` | 214 · 99 | 버전 칩 어휘(`뒤처짐`·`버전 모름`·`멈추는 중`)를 위 표에서 가져온다 |
 * | `Sidebar` | 197 | |
 * | `runnerLauncher.ts` | 118 | **판정 함수다** — `chainSentences` 와 같은 (b) 주입을 쓴다 |
 * | `controller.ts` | 59 | 판정 함수. 위와 같다 |
 * | `MessageItem` | 57 | **손으로 하는 복수형이 여기 있다**(`replyCount === 1 ? 'reply' : 'replies'`) — `waitChain.unblocks` 와 같은 모양으로 사전에 넘긴다. `subjectParticle` 을 아직 쓰는 유일한 자리이기도 하다(그 함수는 그때 지운다) |
 * | `Composer` · `Inbox` | 55 · 49 | |
 * | `daemonFacts.ts` | 38 | 판정 함수. **회귀선이 판정 낱말 7개를 검사한다**(`daemonFacts.test.tsx` 의 제약 2) — 그 축은 문구에 `이상`·`비정상` 이 **없음**을 재므로, 옮긴 뒤에도 문구를 재야 한다(키로는 못 잰다) |
 * | `minutesAgo.ts` · `progressGroup.ts::elapsedLabel` · `day.ts` | 소수 | **시간 표기.** 셋이 각자 `분 전`·`분째`·`오늘` 을 만든다. 이것들은 `Intl.RelativeTimeFormat` 이 이미 아는 것이라, 사전에 넣기 전에 **그쪽으로 옮길지 먼저 정해야 한다** |
 * | 설정 목차 14개 · `Save`·`Cancel`·`Invite` 등 | 소수 | 이미 영어다 — **키만 씌우면 된다.** 둘 이상이 쓰므로 `common.*` 로 간다 |
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
