import type { FaceState } from './faceState';

/**
 * 팀 카드의 얼굴 줄이 차지하는 **칸 수 — `+N` 칸까지 포함한다**
 * (`docs/desktop-agent-cards.html` 4단계: *"얼굴 넷까지 겹쳐 세우고 나머지는 `+N`"*).
 *
 * 앞 판은 얼굴 넷을 세우고 그 뒤에 `+N` 을 **다섯째 칸**으로 붙였다. 그리고 얼굴 크기가
 * `h-11` 이라 `--spacing`(×1.111)을 따라 49px 로 커졌다 — 고정 164px 카드(안쪽 ≈135px)에
 * 다섯 칸 ≈227px 가 들어가 줄이 좌우로 45px 씩 옆 카드 위로 넘쳤다(10-25 신고).
 *
 * 그래서 이제 칸은 **넷이 상한이고 `+N` 도 한 칸**이다: 넷 이하면 전부 얼굴, 넘으면 얼굴
 * 셋 + `+N`. 칸 크기·겹침은 `TEAM_FACE_PX`·`TEAM_FACE_OVERLAP_PX` 고정 px 라 척도와 무관하다.
 * 넷 칸 폭 = 40 + 30×3 = 130px(+링 2px) ≤ 카드 안쪽이다 — `teamFaces.test.ts` 가 그 산수를 잰다.
 *
 * `MessageItem` 의 `FACE_SLOTS`(셋)와 값이 다른 것은 자리가 다르기 때문이다 — 그쪽은
 * 답장 줄의 16px 얼굴이고 이쪽은 카드의 얼굴 자리다. 같은 이름을 공유하지 않는 이유가
 * 그것이다: 한 상수로 묶으면 한쪽 자리의 폭이 바뀔 때 다른 쪽이 함께 끌려간다.
 */
export const TEAM_FACE_SLOTS = 4;

/** 겹친 얼굴 한 칸의 지름(px). `--spacing` 배수가 아니라 고정값이다 — 카드 폭이 고정이라서다. */
export const TEAM_FACE_PX = 40;

/** 이웃 칸과 겹치는 폭(px). */
export const TEAM_FACE_OVERLAP_PX = 10;

/**
 * 얼굴 줄을 **몇 개 세우고 몇을 `+N` 으로 접는가**.
 *
 * `total` 은 팀의 `memberCount` 다 — 카드 아래 `팀 · N명` 과 같은 출처라, 세운 얼굴 수와
 * `+N` 을 더하면 언제나 그 줄의 수와 맞는다. 명단이 수보다 짧게 와도(왕복 사이 변경)
 * `+N` 이 차이를 받는다.
 */
export function splitTeamFaces<T>(ordered: T[], total = ordered.length): { shown: T[]; rest: number } {
  const count = Math.max(total, ordered.length);
  const room = count > TEAM_FACE_SLOTS ? TEAM_FACE_SLOTS - 1 : TEAM_FACE_SLOTS;
  const shown = ordered.slice(0, room);
  return { shown, rest: count - shown.length };
}

/**
 * **겹치는 순서 — 고장난 것부터**(`docs/desktop-agent-cards.html` 4단계).
 *
 * 문서가 이 순서에 값을 매긴 문장이 그대로 이 함수의 존재 이유다:
 *
 * > *"이름순으로 겹치면 붉은 테가 옆 얼굴에 잘려 사라지고, 다섯 중 하나가 죽은 팀이
 * > 멀쩡한 팀과 같아 보인다."*
 *
 * 겹침에는 **위아래가 있다**. `-space-x-1` 로 겹친 원들은 뒤에 오는 것이 앞을 덮으므로
 * (DOM 순서가 곧 z 순서다) 왼쪽이 위로 오게 하려면 앞 원소가 위에 서야 한다 — 그 일은
 * 화면 쪽에서 `z-index` 를 역순으로 주어 한다(`TeamGrid` 의 그 자리 주석). 이 함수가
 * 정하는 것은 **누가 왼쪽에 서는가**뿐이다.
 *
 * ## 왜 정렬이 `lib/` 에 있나
 *
 * `faceState`·`isFaceGreyed`·`faceTakesRelaunch` 와 **같은 규율**이다(그 파일 주석:
 * *"순수 판정은 컴포넌트 밖에 둔다"*). 그리고 이 판정은 특히 시험이 필요하다 — 카드에
 * 그려진 결과만 보면 넷이 섰다는 것까지는 재도 **다섯 중 어느 넷인지**는 눈으로 확인해야
 * 하고, 그것이 정확히 위 인용문이 경고한 결함이다. 함수로 떼어 두면 회귀선이 순서 자체를
 * 잰다.
 *
 * ## 순위표
 *
 * | 등급 | `FaceState` | 근거 |
 * |---|---|---|
 * | 0 | `failed` | **실패** — 붉은 테가 잘리면 안 되는 유일한 얼굴이다 |
 * | 1 | `stopped` | **멈춤** — 이 팀을 부르면 이 하나는 안 깬다 |
 * | 2 | `retiring` | 물러나는 중 — 지금은 돌지만 곧 안 돈다 |
 * | 3 | `unknown` | 모른다 — 나쁜 소식이 아니라 **소식이 없는 것**이다 |
 * | 4 | `ok` | 멀쩡하다. 잘려도 잃는 것이 없다 |
 *
 * 문서가 적은 순서는 *"실패 → 멈춤 → 도는 중"* 셋이고, 나머지 둘(`retiring`·`unknown`)은
 * 그 문장이 쓰인 뒤에 생긴 얼굴이라 이 표가 자리를 정해 준다. 근거는 `isFaceGreyed` 가
 * 셋을 한 회색으로 묶은 그 판단과 같은 축이다 — **"지금 이 팀을 부르면 깨는가"**:
 * `stopped` 는 확실히 안 깨고, `retiring` 은 부르는 시점에 따라 갈리고, `unknown` 은
 * 아무도 확인하지 않았다. 확실한 나쁜 소식이 불확실한 것보다 왼쪽이다.
 *
 * `unknown` 을 `ok` 보다 왼쪽에 두는 이유: 끊긴 동안에는 **남의 러너가 전부** 이 값이 되고
 * (`faceState` 의 그 주석), 그때 이 정렬이 하는 일은 "전부 왼쪽"이라 아무 순서도 아니다.
 * 그 상황에서 `ok`(내 daemon 이 직접 본 것)를 뒤로 밀어도 잃는 것이 없고, 반대로 두면
 * 실제로 죽은 것이 `unknown` 무리에 밀려 잘릴 수 있다.
 *
 * ## 같은 등급 안에서는 이름순이다
 *
 * 격자 자체가 가나다 고정인 것과 같은 이유다(`AgentGrid` 의 `shown` 주석: *"상태순으로
 * 정렬하면 켜지고 꺼질 때마다 카드가 자리를 옮겨 위치로 기억하는 것이 불가능해진다"*).
 * 그 규칙이 여기서 **뒤집히지 않고 두 번째 키로 남는다** — 등급이 같은 얼굴들은 서로
 * 구별할 상태가 없으므로 이름이 자리를 정하고, 그래야 멀쩡한 팀의 얼굴 순서가 러너가
 * 켜지고 꺼질 때마다 흔들리지 않는다.
 */
const RANK: Record<FaceState, number> = {
  failed: 0,
  stopped: 1,
  retiring: 2,
  unknown: 3,
  ok: 4,
};

/**
 * 팀원들을 **겹칠 순서대로** 세운다. 원본 배열을 바꾸지 않는다(`AgentGrid` 의 `shown` 이
 * `[...matched].sort()` 로 같은 규율을 지킨다 — `sort` 는 제자리 정렬이고, 넘어온 명단이
 * 화면 밖에서 다시 쓰이면 그 순서가 조용히 바뀐다).
 *
 * @param members 팀원. 얼굴 판정에 필요한 것과 이름뿐이다 — `AgentTeamMemberRow` 를
 *   요구하지 않는 이유는 `isStopping` 이 `AgentView` 를 요구하지 않은 것과 같다: 이
 *   판정에 필요한 필드만 받으면 시험이 화면을 끌고 오지 않는다.
 */
export function sortTeamFaces<T extends { handle: string }>(
  members: T[],
  faceOf: (member: T) => FaceState,
): T[] {
  return [...members].sort((a, b) => {
    const d = RANK[faceOf(a)] - RANK[faceOf(b)];
    return d !== 0 ? d : a.handle.localeCompare(b.handle);
  });
}
