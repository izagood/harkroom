// 팀 카드의 겹침 순서(`docs/desktop-agent-cards.html` 4단계).
//
// `teamGrid.test.tsx` 가 **화면에 그려진 순서**를 재고, 이 파일은 **판정 자체**를 잰다.
// 두 벌인 이유가 그 모듈 주석에 있다: 카드에 넷이 섰다는 것까지는 화면으로 재도 *"다섯 중
// 어느 넷인지"* 는 눈으로 확인해야 하고, 그것이 정확히 문서가 경고한 결함이다. 함수로
// 떼어 두면 이 파일이 순서를 직접 잰다 — 특히 화면에 안 서는 다섯째·여섯째의 상대 순서까지.
import { describe, it, expect } from 'vitest';
import type { FaceState } from '../src/lib/faceState';
import { TEAM_FACE_SLOTS, sortTeamFaces } from '../src/lib/teamFaces';

/** 얼굴 상태를 `handle` 에 실어 넘긴다 — 시험이 러너 상태를 흉내낼 필요가 없다. */
const m = (handle: string, face: FaceState) => ({ handle, face });
const sorted = (xs: { handle: string; face: FaceState }[]) =>
  sortTeamFaces(xs, (x) => x.face).map((x) => x.handle);

describe('sortTeamFaces — 고장난 것부터 왼쪽이다', () => {
  /**
   * 문서가 적은 셋(*"실패 → 멈춤 → 도는 중"*)과 그 뒤에 생긴 둘(`retiring`·`unknown`)의
   * 자리를 함께 잰다. 뒤 둘의 근거는 그 모듈의 순위표에 있다 — 축은 *"지금 이 팀을 부르면
   * 깨는가"* 이고, **확실한 나쁜 소식이 불확실한 것보다 왼쪽**이다.
   *
   * 되돌려 RED: `RANK` 의 어느 두 값을 바꿔도 이 배열이 어긋난다.
   */
  it('다섯 얼굴의 순위가 실패 · 멈춤 · 물러남 · 모름 · 정상이다', () => {
    expect(sorted([
      m('e', 'ok'), m('d', 'unknown'), m('c', 'retiring'), m('b', 'stopped'), m('a', 'failed'),
    ])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  /**
   * **같은 등급 안에서는 이름순이다.** 격자가 가나다 고정인 것과 같은 이유이고(`AgentGrid`
   * 의 `shown` 주석: *"상태순으로 정렬하면 켜지고 꺼질 때마다 카드가 자리를 옮겨 위치로
   * 기억하는 것이 불가능해진다"*), 그 규칙이 뒤집히지 않고 두 번째 키로 남는다.
   *
   * 되돌려 RED: `localeCompare` 를 `0` 으로 바꾸면 입력 순서가 그대로 남아 빨개진다.
   * 그러면 러너가 켜지고 꺼질 때마다 멀쩡한 팀의 얼굴 순서가 흔들린다.
   */
  it('등급이 같으면 이름순이다 — 상태가 없는 얼굴들의 자리가 흔들리지 않는다', () => {
    expect(sorted([
      m('zeta', 'ok'), m('alpha', 'ok'), m('mid', 'ok'),
    ])).toEqual(['alpha', 'mid', 'zeta']);

    // 등급이 섞여 있어도 두 키가 함께 선다.
    expect(sorted([
      m('z-ok', 'ok'), m('a-ok', 'ok'), m('z-bad', 'failed'), m('a-bad', 'failed'),
    ])).toEqual(['a-bad', 'z-bad', 'a-ok', 'z-ok']);
  });

  /**
   * **원본을 바꾸지 않는다.** `sort` 는 제자리 정렬이고, 넘어온 명단은 카드 밖에서도
   * 쓰인다(상세의 팀원 줄이 같은 배열을 받는다) — 거기서 순서가 조용히 바뀌면 명단이
   * 상태순으로 서고, 그것은 아무도 요구하지 않은 변화다.
   *
   * 되돌려 RED: `[...members].sort` 의 전개를 지우면 빨개진다.
   */
  it('원본 배열을 바꾸지 않는다', () => {
    const input = [m('z', 'ok'), m('a', 'failed')];
    sortTeamFaces(input, (x) => x.face);
    expect(input.map((x) => x.handle)).toEqual(['z', 'a']);
  });

  /**
   * **잘리는 것이 멀쩡한 얼굴이다** — 문서가 이 순서를 정한 이유 전부다. 상한을 넘긴
   * 명단에서 앞 넷을 잘라 그것을 직접 확인한다(화면이 하는 그 일이다).
   */
  it('상한을 넘기면 잘리는 것이 정상 얼굴이다', () => {
    const six = [
      m('a1', 'ok'), m('a2', 'ok'), m('a3', 'ok'), m('a4', 'ok'), m('a5', 'ok'),
      m('zz', 'failed'),
    ];
    const shown = sortTeamFaces(six, (x) => x.face).slice(0, TEAM_FACE_SLOTS);
    // 이름이 마지막인 유일한 고장이 **살아남는다.** 이름순이면 `+2` 안으로 사라졌다.
    expect(shown.map((x) => x.handle)).toContain('zz');
    expect(shown[0]!.handle).toBe('zz');
    expect(shown.length).toBe(TEAM_FACE_SLOTS);
  });

  it('빈 명단과 하나짜리도 그대로 통과한다', () => {
    expect(sorted([])).toEqual([]);
    expect(sorted([m('solo', 'stopped')])).toEqual(['solo']);
  });
});
