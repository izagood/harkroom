import { describe, it, expect } from 'vitest';
import { headMentionRunEnd, splitMentionCalls } from '../src/index.js';

/**
 * **부름과 지칭을 가르는 판정**(2026-09-09).
 *
 * 사고의 모양: 에이전트가 보고 한가운데서 동료를 이름으로 가리켰을 뿐인데(`구현은 @forge
 * 것이고`) 그 한 글자가 상대의 턴을 띄웠고, 상대의 답이 다시 이쪽을 가리켜 5분에 네 턴이
 * 오갔다. 지칭할 문법이 없던 것이 원인이다.
 *
 * 여기서 지키는 것은 **자리**다: 머리 런 안이면 부름, 밖이면 지칭. 그리고 그 규칙이
 * **사람에게 새지 않는 것** — 사람이 이름을 부르면 어디에 써도 부름이다.
 */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const H = '33333333-3333-4333-8333-333333333333';

/** 에이전트가 쓴 글에서, A·B 는 에이전트이고 H 는 사람이다. */
const byAgent = { authorIsAgent: true, isAgent: (id: string) => id === A || id === B };
const byHuman = { authorIsAgent: false, isAgent: (id: string) => id === A || id === B };

describe('머리 멘션 런', () => {
  it('맨 앞에서 멘션과 공백으로 이어지는 구간까지다', () => {
    expect(headMentionRunEnd(`<@${A}> <@${B}> 둘 다 봐`)).toBe(`<@${A}> <@${B}>`.length);
  });

  it('줄바꿈으로 나눠 부른 것도 런이다 — 이름을 줄로 나누는 것은 부르는 방식이다', () => {
    expect(headMentionRunEnd(`<@${A}>\n<@${B}>\n둘 다 봐`)).toBe(`<@${A}>\n<@${B}>`.length);
  });

  it('멘션이 아닌 글자가 하나라도 끼면 거기서 끝난다', () => {
    expect(headMentionRunEnd(`<@${A}> 어쩌고 <@${B}> 것이다`)).toBe(`<@${A}>`.length);
  });

  it('`@handle` 형식도 같은 규칙이다 — 정규화 전 본문과 화면용 본문이 같은 함수를 지난다', () => {
    expect(headMentionRunEnd('@ada @bob 둘 다 봐')).toBe('@ada @bob'.length);
  });

  it('멘션으로 시작하지 않으면 런이 없다(0)', () => {
    expect(headMentionRunEnd(`보고: <@${A}> 것이다`)).toBe(0);
    // 코드·인용으로 시작하면 첫 글자에서 이미 끝난다 — 예외 처리가 아니라 문법의 결과다.
    expect(headMentionRunEnd(`> <@${A}> 인용`)).toBe(0);
    expect(headMentionRunEnd('`@ada` 코드')).toBe(0);
  });
});

describe('부름과 지칭', () => {
  it('에이전트가 본문 한가운데서 동료를 가리킨 것은 지칭이다 — 이 사고의 본체', () => {
    const { call, ref } = splitMentionCalls(`<@${H}> 구현은 <@${A}> 것이다`, byAgent);
    expect(ref).toEqual([A]);
    // 사람은 자리와 무관하게 언제나 부름이다.
    expect(call).toEqual([H]);
  });

  it('머리 런 안이면 부름이다 — 일을 넘기는 길은 막히지 않는다', () => {
    const { call, ref } = splitMentionCalls(`<@${A}> <@${B}> 이어서 해 줘`, byAgent);
    expect(call.sort()).toEqual([A, B].sort());
    expect(ref).toEqual([]);
  });

  it('한 번이라도 부르면 부름이다 — 다시 언급했다고 호출이 취소되지 않는다', () => {
    const { call, ref } = splitMentionCalls(`<@${A}> 이어서. 앞은 <@${A}> 가 했다`, byAgent);
    expect(call).toEqual([A]);
    expect(ref).toEqual([]);
  });

  it('**사람이 쓴 것은 자리와 무관하게 전부 부름이다** — 규칙이 사람에게 새면 안 된다', () => {
    const { call, ref } = splitMentionCalls(`이거 <@${A}> 가 봐 줘`, byHuman);
    expect(call).toEqual([A]);
    expect(ref).toEqual([]);
  });

  it('에이전트 → 사람은 어디에 써도 부름이다 — 사람을 부르는 것은 막을 이유가 없다', () => {
    const { call, ref } = splitMentionCalls(`정리하면 <@${H}> 판단이 필요하다`, byAgent);
    expect(call).toEqual([H]);
    expect(ref).toEqual([]);
  });

  it('코드·인용 안의 토큰은 부름도 지칭도 아니다 — 없던 이름을 만들지 않는다(#298·#592)', () => {
    const quoted = splitMentionCalls(`> 앞에서 <@${A}> 라고 했다`, byAgent);
    expect(quoted).toEqual({ call: [], ref: [] });
    const coded = splitMentionCalls(`\`<@${A}>\` 라고 쓰면 된다`, byAgent);
    expect(coded).toEqual({ call: [], ref: [] });
  });

  it('모르는 계정은 사람으로 본다 — 막는 쪽이 아니라 부르는 쪽으로 기운다', () => {
    const unknown = '44444444-4444-4444-8444-444444444444';
    const { call } = splitMentionCalls(`한가운데 <@${unknown}> 이름`, byAgent);
    expect(call).toEqual([unknown]);
  });
});
