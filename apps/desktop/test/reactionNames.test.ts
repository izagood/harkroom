// **누가 달았나를 이름으로 말한다**(2026-09-09).
//
// 칩에 이모지와 수만 있던 동안 화면에는 그 수가 누구인지 알 방법이 아예 없었다.
// 이 파일은 그 목록을 만드는 규칙을 잰다 — **문구로** 잰다(키가 아니라), 이 저장소의
// 판정 시험이 지키는 것이 "사람이 무엇을 읽나"이기 때문이다(`i18n/index.ts::Translate`).
import { describe, it, expect } from 'vitest';
import { translator } from '../src/i18n';
import { reactorNames, MAX_REACTOR_NAMES } from '../src/lib/reactionNames';

const en = translator('en');
const ko = translator('ko');

/** 이름표. 여기 없는 id 는 **아직 못 받은 계정**이다 — `null` 로 답한다. */
const NAMES: Record<string, string> = { u1: 'me', u2: 'alpha', u3: 'bravo', u4: 'charlie' };
const nameOf = (id: string) => NAMES[id] ?? null;

describe('누른 사람 목록', () => {
  it('서버가 준 순서를 그대로 지킨다 — 누른 순서가 그것이다', () => {
    expect(reactorNames(['u3', 'u2', 'u4'], nameOf, null, en)).toBe('bravo, alpha, charlie');
    // 순서가 바뀌면 목록도 바뀐다. 여기서 정렬해 버리면 "누가 먼저 눌렀나"가 사라진다.
    expect(reactorNames(['u4', 'u2', 'u3'], nameOf, null, en)).toBe('charlie, alpha, bravo');
  });

  it('나는 이름 대신 낱말로 적힌다 — 두 언어 모두', () => {
    expect(reactorNames(['u2', 'u1'], nameOf, 'u1', en)).toBe('alpha, you');
    expect(reactorNames(['u2', 'u1'], nameOf, 'u1', ko)).toBe('alpha, 나');
  });

  /**
   * 나를 **자리에서 옮기지 않는다.** 앞으로 끌어오면 목록이 더는 누른 순서가 아니고,
   * 그러면 `👀` 이 언제 읽혔는지를 이 줄에서 읽을 수 없다.
   */
  it('나를 앞으로 끌어오지 않는다', () => {
    expect(reactorNames(['u2', 'u3', 'u1'], nameOf, 'u1', en)).toBe('alpha, bravo, you');
  });

  it('아직 못 받은 계정은 낱말로 메운다 — 빈 자리를 남기지 않는다', () => {
    // 빈 문자열로 두면 `alpha, , bravo` 가 되고 사람이 그 자리를 이름으로 읽는다.
    expect(reactorNames(['u2', 'u-gone', 'u3'], nameOf, null, en)).toBe('alpha, someone, bravo');
    expect(reactorNames(['u-gone'], nameOf, null, ko)).toBe('누군가');
  });

  it('아무도 없으면 빈 문자열이다 — 칩 자체가 그때 안 그려진다', () => {
    expect(reactorNames([], nameOf, 'u1', en)).toBe('');
  });

  it('한 명이면 이름 하나뿐이다 — 구분자가 붙지 않는다', () => {
    expect(reactorNames(['u2'], nameOf, null, en)).toBe('alpha');
  });
});

describe('사람이 많으면 접는다', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `x${i}`);
  const numbered = (id: string) => `p${id.slice(1)}`;

  it('상한까지는 그대로 다 적는다', () => {
    const ids = many(MAX_REACTOR_NAMES);
    const out = reactorNames(ids, numbered, null, en);
    expect(out).not.toMatch(/more/);
    expect(out.split(', ')).toHaveLength(MAX_REACTOR_NAMES);
  });

  /**
   * **몇 명이 접혔는지 수로 말한다.** `…` 만 두면 사람이 칩의 숫자에서 보이는 이름
   * 수를 빼야 한다 — 그 계산은 화면이 할 일이다.
   */
  it('상한을 넘으면 나머지를 수로 접는다', () => {
    const out = reactorNames(many(MAX_REACTOR_NAMES + 3), numbered, null, en);
    expect(out).toContain('and 3 more');
    expect(out).toContain('p0');
    // 접힌 것은 이름이 아니라 수로만 나온다.
    expect(out).not.toContain(`p${MAX_REACTOR_NAMES + 2}`);
  });

  it('한국어도 같은 수를 말한다', () => {
    expect(reactorNames(many(MAX_REACTOR_NAMES + 2), numbered, null, ko)).toContain('외 2명');
  });

  /** 상한은 인자로도 받는다 — 자리마다 다른 폭을 줄 수 있어야 한다. */
  it('상한을 호출자가 정할 수 있다', () => {
    expect(reactorNames(['u2', 'u3', 'u4'], nameOf, null, en, 2)).toBe('alpha, bravo and 1 more');
  });
});
