import { describe, expect, it } from 'vitest';
import { mentionedHandles, normalizeMentions, splitMentionCalls } from '../src/index.js';

/**
 * **주소 안의 이름은 부름이 아니다**(2026-09-10, jaebin 신고: "내가 호출하지 않은 에이전트가
 * 링크에 포함된 `@` 를 기반으로 호출된 것 같아").
 *
 * 고치기 전 실측: `https://x.com/@forge/status/1` 한 줄에 두 가지가 일어났다 —
 * ① forge 의 inbox 에 `mention` 이 생겨 턴이 떴다, ② 저장된 본문이
 * `https://x.com/<@11111111-…>/status/1` 이 되어 **주소가 깨졌다**. ②가 눈에 안 보인 것은
 * `renderMentions` 가 화면에서 다시 handle 로 되돌려 주기 때문이다.
 *
 * 이 회귀선의 절반은 **좁은 것**을 지키는 데 쓴다. 주소가 아닌 곳의 `@handle` 은 하나도
 * 바뀌지 않아야 한다 — 여기가 새면 이 변경은 사람의 부름을 삼키는 버그가 된다.
 */
const FORGE = '11111111-1111-1111-1111-111111111111';
const ADA = '22222222-2222-2222-2222-222222222222';
const accounts = new Map([['forge', FORGE], ['ada', ADA]]);

const norm = (body: string) => normalizeMentions(body, accounts);
const callsOf = (body: string) =>
  splitMentionCalls(norm(body), { authorIsAgent: false, isAgent: () => true }).call;

describe('링크 안의 @handle', () => {
  it('사람이 붙여넣은 주소 안의 이름은 부르지 않는다', () => {
    expect(mentionedHandles('이거 봐 https://x.com/@forge/status/1')).toEqual([]);
    expect(callsOf('이거 봐 https://x.com/@forge/status/1')).toEqual([]);
  });

  it('주소를 다시 쓰지 않는다 — 저장된 본문에 주소가 그대로 남는다', () => {
    const body = '이거 봐 https://x.com/@forge/status/1 그리고 packages/@ada/shared';
    // 경로(`packages/@ada/…`)는 스킴이 없어 주소가 아니다 → 규칙대로 부름으로 남는다.
    expect(norm(body)).toBe(`이거 봐 https://x.com/@forge/status/1 그리고 packages/<@${ADA}>/shared`);
  });

  it('마크다운 링크는 주소만 걷어낸다 — 이름표는 글자로 남으므로 부름이다', () => {
    expect(callsOf('[@forge](https://x.com/@ada)')).toEqual([FORGE]);
  });

  it('열 수 없는 스킴은 주소가 아니다 — `cc:@forge` 를 삼키지 않는다', () => {
    // `URL_CANDIDATE_SOURCE` 는 `://` 를 요구하지 않으므로 이 글자도 URL 후보로 잡힌다.
    // 스킴 허용 목록이 판정의 중심인 이유가 이 한 줄이다.
    expect(callsOf('cc:@forge 확인 부탁')).toEqual([FORGE]);
    expect(callsOf('javascript:@forge')).toEqual([FORGE]);
  });

  it('주소 뒤의 문장부호 밖은 여전히 부름이다', () => {
    expect(callsOf('https://x.com/a, @forge 봐 줘')).toEqual([FORGE]);
  });

  it('`harkroom://` 는 uuid 까지 맞아야 주소다 — 그리는 쪽과 같은 판정이다', () => {
    // `parseMessagePermalink` 는 형식까지 본다. 화면도 이것을 링크로 칠하지 않으므로
    // 여기서도 평문이고, 그래서 이름은 부름으로 남는다.
    expect(callsOf('harkroom://message/@forge')).toEqual([FORGE]);
    expect(callsOf('harkroom://message/4021ad85-3a2f-41dc-8f39-a8a0bff0687d 봐 @forge')).toEqual([FORGE]);
  });
});
