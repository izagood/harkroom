/**
 * 러너가 기동 때 읽은 claude lane 을 **글자로 만드는 곳**. 화면 밖 순수 함수라
 * 번역기를 인자로 받는다(`i18n/index.ts::Translate` 머리말의 그 갈림).
 *
 * ## 세 가지를 가른다
 *
 * | 값 | 뜻 | 왜 갈라야 하나 |
 * |---|---|---|
 * | `null` | **모른다** | 구 러너이거나 아직 폴을 보내지 않았다. "풀이 비었다"로 적으면 화면이 확인한 적 없는 것을 단언한다 |
 * | `accounts: []` | 풀이 비어 시스템 기본 로그인으로 돈다 | 사람이 계정을 넣어야 하는 상태다 — 모르는 것과 할 일이 다르다 |
 * | 계정이 있는 lane | 페일오버가 이 순서로 돈다 | 순서가 뜻이라 정렬하지 않고 그대로 적는다 |
 *
 * #683 이 턴 줄에서 `0` 과 `모름` 을 가른 것과 같은 규율이다.
 *
 * ## 지금 도는 계정은 여기서 말하지 않는다
 *
 * 페일오버는 턴 단위로 머리를 옮기고 그 사실은 러너 메모리에만 있다 — 이 행은 "무엇을
 * 읽고 떴나"까지이고, **지금 무엇으로 도는지는 턴 줄(#694)이 답한다.**
 */
import type { ClaudeLaneView } from '@harkroom/shared';

import type { Translate } from '../i18n';

/** 순서를 화살표로 잇는다 — 사전 문구가 아니라 표기다(어순에 걸리지 않는다). */
const ORDER_SEP = ' → ';

export function claudeLaneLabel(lane: ClaudeLaneView | null, t: Translate): string {
  if (lane === null) return t('profile.rows.claudeLaneUnknown');
  const pool = lane.pool ?? t('profile.rows.claudeLanePoolRoot');
  if (lane.accounts.length === 0) return t('profile.rows.claudeLaneEmpty', { pool });
  return t('profile.rows.claudeLaneOrder', { pool, accounts: lane.accounts.join(ORDER_SEP) });
}

/**
 * 이 행을 그릴 것인가. **claude 하네스에만 그린다** — codex·gemini 에이전트에게 claude
 * 계정 순서를 그리면 그 축과 무관한 사실을 그 에이전트의 것으로 말한다(서버도 같은
 * 이유로 행을 만들지 않는다: `services/claudeLane.ts` 의 harness 게이트).
 */
export function showsClaudeLane(harness: string): boolean {
  return harness === 'claude-code';
}
