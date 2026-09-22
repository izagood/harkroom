import { describe, it, expect } from 'vitest';
import {
  denormalizeMentions, headMentionRunEnd, mentionedIds, mentionedTargets, mentionTargetKey,
  normalizeMentions, renderMentions, splitMentionCalls,
} from '../src/index.js';

/**
 * 집합·팀 멘션의 정본 토큰(#845).
 *
 * #271 은 계정에 대해 *"이름이 바뀌어도 본문을 다시 쓰지 않는다"* 를 세웠지만 바꾼 것은
 * 계정뿐이었다. 같은 이름공간을 나눠 쓰는 집합·팀은 글자로 남았고, **팀은 이름이 바뀐다**.
 *
 * 이 파일이 지키는 것은 둘이다:
 *  - 새 토큰이 **되돌아온다**(그리기·MCP·머리 런).
 *  - 새 토큰이 **판정에 새지 않는다** — `mentionedIds`·`splitMentionCalls` 는 계정 id 만
 *    내놓는 약속이고, 팀 id 가 섞이면 `isAgent(id)`·`accounts[id]` 가 조용히 false 가 된다.
 *    이쪽이 더 중요하다: 되돌리기가 틀리면 글자가 이상하고, 판정이 틀리면 알림이 틀린다.
 */
const TEAM = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const ACCT = '33333333-3333-4333-8333-333333333333';

describe('집합·팀 멘션 토큰 (#845)', () => {
  it('지도의 값에 접두를 실으면 normalizeMentions 가 그대로 토큰을 만든다', () => {
    const map = new Map([
      ['ops', mentionTargetKey('team', TEAM)],
      ['devs', mentionTargetKey('group', GROUP)],
      ['fizz', ACCT],
    ]);
    expect(normalizeMentions('@ops @devs @fizz 가자', map))
      .toBe(`<@team:${TEAM}> <@group:${GROUP}> <@${ACCT}> 가자`);
  });

  it('mentionedTargets 는 종류와 id 를 가려 준다 — 계정은 안 센다', () => {
    const body = `<@team:${TEAM}> <@group:${GROUP}> <@${ACCT}>`;
    expect(mentionedTargets(body)).toEqual([
      { kind: 'team', id: TEAM },
      { kind: 'group', id: GROUP },
    ]);
  });

  /** 같은 팀을 두 번 적어도 한 번이다 — 팬아웃이 이 목록을 그대로 돈다. */
  it('mentionedTargets 는 중복을 없앤다', () => {
    expect(mentionedTargets(`<@team:${TEAM}> 그리고 <@team:${TEAM}>`)).toHaveLength(1);
  });

  /**
   * **이 줄이 이 파일의 핵심이다.** 접두 있는 토큰이 계정 패턴에 걸리면 팀 id 가 알림
   * 판정으로 흘러든다 — `accounts[teamId]` 는 undefined 라 조용히 아무 일도 안 일어나고,
   * 사람은 부른 팀이 왜 안 깨는지 알 수 없다.
   */
  it('mentionedIds 는 팀·집합 토큰을 계정으로 오해하지 않는다', () => {
    expect(mentionedIds(`<@team:${TEAM}> <@group:${GROUP}>`)).toEqual([]);
    expect(mentionedIds(`<@team:${TEAM}> <@${ACCT}>`)).toEqual([ACCT]);
  });

  it('splitMentionCalls 도 계정만 본다', () => {
    const { call, ref } = splitMentionCalls(
      `<@team:${TEAM}> <@${ACCT}> 어쩌고`,
      { authorIsAgent: true, isAgent: () => false },
    );
    expect(call).toEqual([ACCT]);
    expect(ref).toEqual([]);
  });

  it('renderMentions 가 지금 이름으로 되돌린다 — 이름이 바뀌어도 본문은 그대로다', () => {
    const body = `<@team:${TEAM}> 배포하자`;
    expect(renderMentions(body, new Map([[mentionTargetKey('team', TEAM), 'release']])))
      .toBe('@release 배포하자');
    // 같은 본문, 바뀐 이름.
    expect(renderMentions(body, new Map([[mentionTargetKey('team', TEAM), 'shipit']])))
      .toBe('@shipit 배포하자');
  });

  it('모르는 토큰은 화면에서 라벨, MCP 에서는 원문이다', () => {
    const body = `<@team:${TEAM}> 어쩌고`;
    expect(renderMentions(body, new Map(), '알 수 없음')).toBe('@알 수 없음 어쩌고');
    // 에이전트에게는 그대로 남긴다 — 표시 문구를 주면 되받아 써서 본문에 박힌다(#271).
    expect(denormalizeMentions(body, new Map())).toBe(body);
  });

  /**
   * 머리 런에 들어야 한다. 안 들면 `@팀 @사람 …` 로 시작한 발화에서 런이 첫 글자에서
   * 끊기고, 에이전트가 쓴 `@사람` 이 부름이 아니라 지칭으로 갈린다(#598).
   */
  it('팀 토큰도 머리 멘션 런에 든다', () => {
    const body = `<@team:${TEAM}> <@${ACCT}> 일을 나눠라`;
    expect(headMentionRunEnd(body)).toBe(`<@team:${TEAM}> <@${ACCT}>`.length);
  });

  /** 계정 토큰의 모양은 그대로다 — 저장된 본문 전부가 그 모양이라 바꿀 수 없다. */
  it('계정 토큰은 접두 없이 그대로다', () => {
    expect(normalizeMentions('@fizz', new Map([['fizz', ACCT]]))).toBe(`<@${ACCT}>`);
  });
});
