import { NOTIFIED_COUNT_HEADER, NOTIFIED_HEADER, NOTIFIED_HEADER_MAX_IDS } from '@murmur/shared';
import type { HandleGroupRow } from '@murmur/shared';
import type { BodyRecipient } from './mention';

/**
 * **집합 호출의 결과** — 정본 문서 `docs/desktop-design-directions.html`.
 *
 * 진단: *"집합 호출의 결과가 안 보인다. 셋을 불러 둘만 깨어나도 화면은 아무 말도 하지
 * 않는다."* 처방: *"보내기 전엔 몇 명인지, 보낸 뒤엔 누가 깼는지. 셋을 불렀는데 둘만 깨어난
 * 것은 **조용한 실패**이고, 지금 화면은 그것을 말할 자리가 없다."*
 *
 * 이 파일이 하는 일은 **셈을 한 자리에 모으는 것**이다. 서버는 두 헤더로 사실만 준다
 * (누가 깼는지 · 총 몇 명이 깼는지). 그것을 "몇 명을 불렀는지"와 견주어 조용한 실패인지
 * 판정하는 규칙은 화면 여러 곳에 흩어지면 안 된다 — 흩어지면 채널과 스레드가 같은 발화를
 * 두고 다른 수를 말한다.
 */

/**
 * 서버가 이 요청에 대해 말해 준 부름의 결과.
 *
 * **`null` 은 '모른다'다** — `0` 이 아니다. 서버는 재생(idempotency 재시도)일 때 헤더를
 * 아예 싣지 않는다(`messageRoutes.ts`): 그 요청이 새로 부른 사람이 없다는 뜻이지 아무도
 * 안 불렸다는 뜻이 아니고(첫 요청이 이미 불렀다), 옛 서버도 헤더를 안 싣는다. 둘을 한 값에
 * 뭉치면 화면이 모르는 것을 **아는 척**한다 — 재시도한 발화마다 "아무도 안 깼다"고 말한다.
 */
export type NotifiedResult = {
  /** 깬 사람의 총수. 명단이 잘려도 이 수는 정확하다. */
  count: number;
  /**
   * 깬 사람의 id. **총수보다 짧을 수 있다** — 헤더 크기 한도 때문에 서버가
   * `NOTIFIED_HEADER_MAX_IDS` 개에서 자른다(`NOTIFIED_HEADER` 주석). 그래서 이 배열의
   * 길이로 수를 말해서는 안 된다: `count` 가 수의 정본이다.
   */
  ids: string[];
  /** 명단이 잘렸는가. `ids.length < count` 와 같은 말이지만, 이름으로 두면 읽는 쪽이 헷갈리지 않는다. */
  truncated: boolean;
} | null;

/**
 * 두 헤더를 읽는다. 헤더가 없으면 `null`('모른다').
 *
 * **수 헤더가 판정의 기준이다** — 명단 헤더만 보면 "아무도 안 불렀다"(수는 `0`, 명단은
 * 아예 없음)와 "모른다"(둘 다 없음)가 구분되지 않는다. 서버 테스트가 이 계약을 지킨다
 * (`threadStateFacts.test.ts`: *"아무도 안 불렀으면 수는 0 이고 명단 헤더는 없다"*).
 *
 * 빈 문자열을 나누지 않는다: `''.split(',')` 은 `['']` 라 없는 사람이 하나 생긴다.
 */
export function readNotifiedHeaders(headers: Headers): NotifiedResult {
  const raw = headers.get(NOTIFIED_COUNT_HEADER);
  if (raw === null) return null;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 0) return null;
  const list = headers.get(NOTIFIED_HEADER);
  const ids = list ? list.split(',').filter((s) => s.length > 0) : [];
  return { count, ids, truncated: ids.length < count };
}

/**
 * 한 번의 발화가 부른 집합. **`memberCount` 를 쓴다** — 그것이 이 수의 유일한 출처다
 * (`HandleGroupRow.memberCount` 주석: *"자동완성 후보가 `@release` 를 부르기 직전에 그것이
 * 한 사람인지 스무 사람인지 보여야 하는 유일한 자리"*).
 */
export interface CalledGroup {
  handle: string;
  /** 저장된 명단의 크기. 부른 사람 자신이 그 안에 있을 수 있다 — `expectedWakes` 가 그것을 뺀다. */
  memberCount: number;
  /** 부른 사람 자신이 이 집합의 구성원인가. 모르면 `false` 로 둔다(아래 `calledGroups` 주석). */
  includesMe: boolean;
}

/**
 * 본문이 부른 **집합만** 골라 낸다. 계정 멘션·`@channel` 은 여기 들지 않는다.
 *
 * **왜 집합만인가.** 조용한 실패를 판정하려면 "몇 명을 불렀는가"를 알아야 하고, 그 수를
 * 화면이 아는 것은 집합뿐이다:
 * - 계정 멘션(`@forge`)은 한 명이고, 그 한 명이 안 깨는 경우는 그 사람이 채널을 볼 수 없는
 *   때뿐이다 — 그러면 부르는 사람이 자동완성 후보에서 이미 못 골랐거나, private 채널의
 *   비멤버라 그 사실 자체가 비밀이다(`fanOutMention` ①). 수를 견줄 자리가 아니다.
 * - `@channel` 은 **상한이 없다** — "그 채널을 볼 수 있는 계정 전부"이고 화면은 그 수를
 *   모른다(`channelMembers` 는 멤버 목록이지 가시성 판정이 아니다). 모르는 수와 견주면
 *   화면이 아는 척하게 된다.
 *
 * `bodyRecipients` 를 그대로 통과시킨다 — 새 정규식을 쓰지 않는 것이 그 함수의 존재
 * 이유이고(*"보내기 전 목록과 보낸 뒤 강조가 서로 다른 규칙을 쓰면 이 기능이 막으려는
 * 착각을 오히려 만든다"*), 같은 이유가 여기에도 그대로 적용된다.
 *
 * **`includesMe` 를 화면이 알 수 없다.** 구성원 명단은 `GET /handle-groups/:id` 에만 있고
 * 그 라우트는 `requireAdmin` 이다(실측: `handleGroupRoutes.ts:61`) — 부른 사람이 admin 이
 * 아니면 404 가 아니라 403 을 받는다. 그래서 `false` 로 둔다. 그 방향으로 틀리는 것이
 * 안전하다: 내가 구성원인 집합을 부르면 기대치가 1 만큼 높게 잡혀 조용한 실패를 한 번
 * **더** 말하고, 반대로 두면 진짜 실패를 삼킨다. 문서의 규칙 06("없는 문은 그리지 않는다")
 * 은 없는 것을 그리지 말라는 것이고, 있는 실패를 숨기라는 것이 아니다.
 */
export function calledGroups(
  recipients: BodyRecipient[], groups: HandleGroupRow[],
): CalledGroup[] {
  const byHandle = new Map(groups.map((g) => [g.handle.toLowerCase(), g]));
  const out: CalledGroup[] = [];
  for (const r of recipients) {
    if (r.kind !== 'group') continue;
    const group = byHandle.get(r.handle.toLowerCase());
    // 후보에 없는 집합 handle 은 셈에 넣지 않는다 — 수를 모르는 것을 0 으로 세면
    // 모든 부름이 조용한 실패로 보인다.
    if (!group) continue;
    out.push({ handle: group.handle, memberCount: group.memberCount, includesMe: false });
  }
  return out;
}

/**
 * 한 발화가 부른 집합 전부에서 **깨어야 하는 사람 수**.
 *
 * `null` 은 "집합을 부르지 않았다"다 — 견줄 기준이 없으므로 화면은 아무 말도 하지 않는다.
 *
 * 집합 둘을 함께 부르면 수를 더한다. 겹치는 구성원은 **두 번 세진다** — 화면은 명단을
 * 받지 못하므로 겹침을 알 수 없다. 그 방향으로 틀리는 것은 위 `includesMe` 와 같은 판단이다:
 * 기대치가 높게 잡혀 있지 않은 실패를 말할 수 있지만, 낮게 잡으면 있는 실패를 삼킨다.
 * 다만 그 거짓 경고를 줄이려고 **집합이 둘 이상이면 이름을 나열하지 않고 수만 말한다**
 * (`notifiedSummary`).
 */
export function expectedWakes(called: CalledGroup[]): number | null {
  if (called.length === 0) return null;
  return called.reduce((n, g) => n + Math.max(0, g.memberCount - (g.includesMe ? 1 : 0)), 0);
}

/** 화면이 그릴 한 줄. `null` 이면 그릴 것이 없다 — **조용한 실패가 아니면 조용하다**. */
export interface NotifiedSummary {
  /** 부른 사람 수(집합의 구성원 수 합). */
  called: number;
  /** 깬 사람 수. */
  woke: number;
  /** 이름을 말할 수 있는 집합 하나. 집합을 둘 이상 불렀으면 `null` 이라 수만 말한다. */
  groupHandle: string | null;
}

/**
 * 이 발화에 대해 화면이 **말해야 하는가**, 말한다면 무엇을.
 *
 * **셋을 불러 셋이 깨면 `null` 을 준다 — 화면은 조용하다.** 이것이 이 함수의 요점이다.
 * 문서: *"셋을 불렀는데 둘만 깨어난 것은 조용한 실패이고, 지금 화면은 그것을 말할 자리가
 * 없다."* 실패만 자리를 받는다. 성공까지 한 줄을 받으면 모든 집합 호출이 줄을 하나씩 달고,
 * 그러면 정작 덜 깬 발화의 줄이 나머지와 구별되지 않는다 — 규칙 06("없는 문은 그리지
 * 않는다")을 결과 쪽에 적용한 것이고, `0 replies` 를 지운 것과 같은 결이다.
 *
 * **모르면 말하지 않는다**(`notified === null`): 재생·옛 서버는 헤더를 안 싣고, 그때
 * 화면이 "아무도 안 깼다"고 말하면 그것은 거짓이다.
 *
 * **깬 사람이 더 많아도 말하지 않는다.** `notified.count` 는 집합의 결과만이 아니다 —
 * 서버는 스레드 루트 작성자(`thread_reply`)와 DM 상대(`dm`)도 같은 집합에 담는다
 * (실측: `services/messages.ts::postMessage`). 그래서 `woke > called` 는 흔한 정상이고,
 * 그 방향은 실패가 아니다. 반대로 이 사실은 **`woke < called` 를 보수적으로 만든다**:
 * 다른 사유로 깬 사람이 부족한 수를 메워 실패를 가릴 수 있으므로, 이 줄이 뜨면 실패는
 * 확실히 있다(가리는 쪽으로만 틀린다).
 */
export function notifiedSummary(
  notified: NotifiedResult, called: CalledGroup[],
): NotifiedSummary | null {
  if (notified === null) return null;
  const expected = expectedWakes(called);
  if (expected === null || expected === 0) return null;
  if (notified.count >= expected) return null;
  return {
    called: expected,
    woke: notified.count,
    // 집합 하나면 이름을 말한다 — "release 3명 중 2명" 이 "3명 중 2명" 보다 무엇을 다시
    // 부를지 정하는 데 쓸모가 있다. 둘 이상이면 어느 집합에서 빠졌는지 모르므로 수만 말한다.
    groupHandle: called.length === 1 ? called[0]!.handle : null,
  };
}

// 서버가 명단을 자르는 상한. 화면이 이 수를 직접 쓰지는 않지만, 이 모듈이 그 계약을 알고
// 있다는 것을 타입 검사가 지키게 한다 — 상수가 사라지면 여기서 컴파일이 깨진다.
export const NOTIFIED_LIST_LIMIT = NOTIFIED_HEADER_MAX_IDS;
