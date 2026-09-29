import type { Translate } from '../i18n';

/**
 * **리액션 칩에 누가 눌렀는지 이름으로 적는다.**
 *
 * 이 함수가 있기 전 칩은 이모지와 숫자뿐이었다 — `👀 1` 을 보고도 그 1 이 누구인지 알
 * 방법이 화면에 없었다. 에이전트가 상태 신호로 쓰는 `👀`·`💬`(`Reactions.tsx` 의
 * `STATUS_SIGNAL_EMOJI`)에서 특히 아팠다: **"누가 이 말을 읽었나"가 그 신호의 뜻 전부**인데
 * 화면은 몇 명인지만 말했다.
 *
 * `lib/` 에 두고 `t` 를 인자로 받는 이유는 이 저장소의 판정 함수 규약 그대로다
 * (`i18n/index.ts::Translate` 주석) — 순수함을 지키면서 회귀선이 **키가 아니라 문구**를
 * 잰다.
 *
 * ## 순서는 서버가 정한 것을 그대로 쓴다
 *
 * `accountIds` 는 이미 **누른 순서**다 — `server/services/messages.ts::REACTIONS` 가
 * `array_agg(account_id order by created_at)` 로 모으고, 화면의 낙관적 갱신
 * (`appStore::applyReaction`)도 새 사람을 뒤에 붙인다. 그래서 여기서 다시 정렬하지
 * 않는다. 취소도 같은 경로다: `applyReaction` 이 그 id 를 배열에서 빼므로 이 목록에서
 * 이름이 저절로 빠진다 — 이 함수가 따로 알 것이 없다.
 */

/**
 * 이름을 몇 개까지 적나. 넘으면 나머지는 수로 접는다.
 *
 * 상한이 필요한 이유: 한 이모지에 눌릴 수 있는 사람 수에는 제한이 없다
 * (`server/services/reactions.ts::MAX_REACTIONS_PER_ACTOR` 는 **한 사람이 다는 이모지
 * 수**를 막는 것이고 그 반대 축이 아니다). 채널 인원이 다 누르면 툴팁 하나가 화면
 * 절반을 덮는다 — OS 툴팁은 우리가 줄일 수 없다.
 */
export const MAX_REACTOR_NAMES = 8;

/**
 * 누른 사람들을 사람이 읽는 한 줄로 만든다.
 *
 * @param accountIds 누른 순서대로 온 계정 id. 빈 배열이면 빈 문자열이다 — 칩 자체가
 *   그때 그려지지 않으므로(`applyReaction` 이 0 인 칩을 지운다) 호출자가 분기할 필요는 없다.
 * @param nameOf 계정 id 를 이름으로. **모르는 계정에 `null` 을 돌려준다** — 빈 문자열을
 *   돌려주면 `, , ` 처럼 이름이 없는 자리가 목록에 생겨 사람이 그것을 이름으로 읽는다.
 * @param myId 나. `null` 은 아직 계정을 못 받은 것이다.
 */
export function reactorNames(
  accountIds: string[],
  nameOf: (id: string) => string | null,
  myId: string | null,
  t: Translate,
  max: number = MAX_REACTOR_NAMES,
): string {
  // **나를 이름 대신 `나` 로 적는다.** 자기 핸들을 목록에서 찾아 그것이 자신임을 알아내는
  // 것은 사람이 할 일이 아니다 — 칩 테두리가 말하는 "내가 눌렀다"와 같은 사실을 툴팁도
  // 같은 낱말로 말해야 둘이 서로를 확인해 준다.
  const names = accountIds.map((id) =>
    id === myId ? t('reactions.you') : (nameOf(id) ?? t('reactions.unknown')),
  );

  if (names.length <= max) return names.join(', ');

  // 접는 자리에서 **몇 명이 접혔는지**를 말한다. `…` 만 두면 사람이 그 칩의 숫자에서
  // 이름 수를 빼야 한다.
  const shown = names.slice(0, max);
  return t('reactions.andMore', { names: shown.join(', '), count: names.length - max });
}

/**
 * **호버 말풍선의 문장** — `"(click to remove) alpha, you reacted with 👍"`(2026-09-29,
 * Slack 리액션 툴팁을 본으로 한 요청).
 *
 * 앞 판의 칩은 OS `title` 에 이름 목록만 실었다. 그 판단(“이모지는 칩에 이미 있다”)은 OS
 * 툴팁이 작은 평문이라 맞았지만, 말풍선을 우리가 그리게 되면서 이모지를 크게 다시 보여 주는
 * 것이 오히려 “이 목록이 **어느** 칩 것인가”를 답한다 — 칩 여럿이 붙어 있으면 커서 아래가
 * 어느 것인지 헷갈린다.
 *
 * 이름 목록은 `reactorNames` 를 그대로 쓴다 — 나를 `you` 로, 모르는 계정을 `someone` 으로,
 * 8명 넘으면 `외 N명` 으로 접는 규칙이 스크린리더 이름(`aria-label`)과 **같아야** 한다.
 *
 * 내가 누른 칩에만 “눌러서 떼기” 안내를 앞에 붙인다: 누르면 **취소**된다는 것이 칩 모양만으로는
 * 드러나지 않는 유일한 동작이다(남의 칩을 누르면 같이 다는 것은 짐작대로라 말하지 않는다).
 */
export function reactionSentence(
  emoji: string,
  accountIds: string[],
  nameOf: (id: string) => string | null,
  myId: string | null,
  t: Translate,
): { hint: string | null; sentence: string } {
  const names = reactorNames(accountIds, nameOf, myId, t);
  const raw = t('reactions.tooltip.reacted', { names, emoji });
  // 영어는 `you` 가 문장 맨 앞에 올 수 있다 — 그때만 첫 글자를 올린다(한글에는 대소문자가 없다).
  // 남의 이름은 건드리지 않는다: `jaebin` 을 `Jaebin` 으로 적으면 그 사람의 이름이 아니다.
  const sentence = accountIds[0] === myId ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw;
  const mine = myId !== null && accountIds.includes(myId);
  return { hint: mine ? t('reactions.tooltip.clickToRemove') : null, sentence };
}
