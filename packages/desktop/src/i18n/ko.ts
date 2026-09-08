import type { Catalog } from './en';

/**
 * 한국어 — **여러 언어 중 하나다.** 원본은 `en.ts` 이고 이 파일은 그 키 집합을 따른다.
 *
 * `satisfies Catalog` 가 계약이다: 키를 빠뜨리면 **여기서 컴파일이 막힌다.** 그것이
 * 이 구조가 라이브러리 없이도 지키는 것 하나다 — i18next 였다면 빠진 키가 런타임에
 * `waitChain.empty` 라는 글자로 화면에 뜬다.
 *
 * ## 복수형이 한 갈래인 것은 누락이 아니다
 *
 * `waitChain.unblocks` 가 `other` 하나만 갖는다. 한국어는 수에 따라 명사가 안 바뀌므로
 * `Intl.PluralRules('ko')` 가 어느 수에나 `other` 를 낸다 — **그 언어의 사실**이라
 * `one` 을 적으면 그 줄은 영원히 안 쓰인다. `Plural` 타입이 `other` 만 필수인 이유다.
 *
 * ## 조사는 **번역문 안에서** 푼다
 *
 * `{waiter}가` 라고 못 적는다 — 받침에 따라 `이/가` 가 갈리고 handle 은 영문도 한글도
 * 온다(`민수가` 와 `codex 가`). 그래서 이 언어만 쓰는 **후처리 규칙**을 둔다:
 * `{waiter:은는}` 처럼 자리표시자에 조사를 붙이면 번역기가 받침을 보고 고른다
 * (`format.ts::applyParticle`). 영어 원본에는 그런 표기가 없고, 그것이 맞다 —
 * **문법 규칙은 그것을 가진 언어의 파일에만 있어야 한다.**
 */
export const ko = {
  'common.someone': '사람',

  // 조사 표기(`:이가`)가 붙는다 — 위 머리말 참고. 영어 원본에는 이런 표기가 없다.
  'waitChain.link': '{waiter:이가} {blockedBy}의 답을 기다린다',
  'waitChain.linkAnyone': '{waiter:이가} 사람의 답을 기다린다',

  'waitChain.deadlock': '교착',
  'waitChain.deadlockCycle': '{names} 가 서로를 기다린다 — 사람만이 풀 수 있다',
  'waitChain.deadlockDeadRunner': '{waiter} 가 {blockedBy} 를 기다리는데 응답이 없다',

  'waitChain.unblocks': { other: '답하면 {count}개가 풀린다' },

  'waitChain.sectionTitle': '기다리는 것',
  'waitChain.sectionTitleCount': '기다리는 것 ({count})',
  'waitChain.empty': '기다리는 것이 없다',
  'waitChain.unseen': '아직 다 보지 못했다',
  'waitChain.dm': 'DM',
  'waitChain.reasonCycle': '서로를 기다린다',
  'waitChain.reasonDeadRunner': '답할 쪽이 멈췄다',

  'message.channelEcho': '채널에도 전송됨',
  'message.threadOrigin': '스레드에 댓글 남김',
  'message.recentReplies': '최근 댓글 보기',
} satisfies Catalog;
