import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { Composer } from '../src/components/Composer';
import { MessageBody } from '../src/components/MessageBody';
import { acc, grp, tm, fakeApi, fakeWsFactory } from './helpers/fakeApi';

/**
 * **에이전트 팀을 한 이름으로 부른다**(#172). 집합(#285)이 이미 뚫어 둔 길을 팀이 그대로
 * 쓴다 — 이 파일은 그 "그대로" 가 실제로 지켜지는지를 잰다.
 *
 * 여기서 지키는 것:
 * 1. 팀이 후보에 **보인다**(팀원 수와 함께). 부를 수 있는 이름이 후보에 없으면 사람은
 *    그것을 못 배운다 — 그것이 이 작업의 절반이다.
 * 2. 집합·계정과 **구분된다**. 셋이 한 목록에 섞여 서므로 종류가 읽혀야 한다.
 * 3. "부를 상대" 줄이 팀원 수를 말한다 — *"보내기 전엔 몇 명인지"*(정본 문서).
 * 4. 본문의 팀 멘션이 **강조된다**. 서버는 팀을 펼쳐 알림을 보내는데 화면이 평범한 글자로
 *    그리면, `lib/mention.ts` 머리의 경계가 깨진다: *"강조되지 않은 것이 몰래 알림을 보낸다"*.
 * 5. 팀이 없는 워크스페이스의 후보 목록은 **한 글자도 달라지지 않는다**.
 */
// **언어를 한국어로 고정한다.** 이 파일의 축들은 이 화면의 한국어 문구로 쓰여 있고,
// 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(`#619`·사이드바 PR 이
// 세운 방식과 같다). 영어가 원본이라 기본값이 영어이므로, 한국어를 재려면 한국어라고
// 말해야 한다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me', 'human', true),
    accounts: {
      u1: acc('u1', 'me', 'human', true),
      u2: acc('u2', 'alice', 'human'),
      a1: acc('a1', 'releaser', 'agent'),
    },
    groups: [grp('g1', 'oncall', 'On-call', 3)],
    teams: [tm('t1', 'release', 4), tm('t2', 'infra', 2)],
  });
  setController(new Controller(fakeApi(), fakeWsFactory().makeWs));
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); setController(null as unknown as Controller); });

const type = (value: string) => {
  render(<Composer onSend={vi.fn()} scopeKey="c1" />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value } });
};

const optionFor = (handle: string) =>
  screen.getAllByRole('option').find((o) => o.getAttribute('data-handle') === handle);

describe('팀 자동완성 (#172)', () => {
  it('1. 후보에 팀이 나오고 팀원 수가 보인다', () => {
    type('@rel');

    const option = optionFor('release');
    expect(option).toBeTruthy();
    // 수가 없으면 `@release` 가 하나인지 다섯인지 모르는 채로 부르게 된다
    // (`AgentTeamRow.memberCount` 가 이 자리를 이름으로 지목한다).
    // 단위(`명`)가 빠진 근거는 `identity.badge.count` 에 있다 — 팀원은 전부 에이전트다.
    expect(option!.textContent).toContain('4');
  });

  it('2. 팀은 계정·집합과 다른 종류로 표시된다', () => {
    type('@');

    // 종류는 문구가 아니라 속성으로 단언한다 — 배지 문구가 바뀌면 문구를 보던 테스트가
    // 깨지고, 그때 깨진 것은 동작이 아니라 테스트다.
    expect(optionFor('release')!.getAttribute('data-kind')).toBe('team');
    expect(optionFor('oncall')!.getAttribute('data-kind')).toBe('group');
    expect(optionFor('releaser')!.getAttribute('data-kind')).toBe('account');
    // 접근성 이름으로도 구분된다 — 배지가 이모지뿐이면 스크린리더에는 종류가 사라진다.
    expect(optionFor('release')!.textContent).toContain('팀');
    expect(optionFor('oncall')!.textContent).toContain('집합');
    expect(optionFor('oncall')!.textContent).not.toContain('팀');
  });

  it('3. 고르면 본문에 `@팀이름 ` 이 들어간다', () => {
    type('@rel');

    fireEvent.click(optionFor('release')!);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('@release ');
  });

  /**
   * **"부를 상대" 줄이 팀원 수를 말한다** — 정본 문서가 요구한 *"보내기 전엔 몇 명인지"*
   * 의 팀 쪽 절반이다. 수를 안 말하면 사람은 다섯을 깨우는 발화를 한 명 부르는 것처럼
   * 보내고, 이 기능이 막으려는 착각을 오히려 만든다.
   */
  it('4. "부를 상대" 줄에 팀이 서고 수를 말한다', () => {
    type('@release 배포해라');

    const item = screen.getByTestId('body-mentions')
      .querySelector('[data-handle="release"]');
    expect(item).toBeTruthy();
    expect(item!.getAttribute('data-kind')).toBe('group');
    // **단위(`명`)가 빠졌다** — 그 말은 사람만 세는데 집합·팀에는 에이전트도 든다
    // (`en.ts` 의 composer 머리말). 수를 말한다는 이 축의 뜻은 그대로다.
    expect(item!.textContent).toContain('(4)');
  });

  /**
   * 팀이 없으면 **후보 목록이 그대로다.** 팀을 쓰지 않는 워크스페이스에 이 기능이
   * 흔적을 남기지 않는다는 것이 `MAX_GROUP_SUGGESTIONS` 주석의 약속이다.
   */
  it('5. 팀이 없으면 후보 목록이 그대로다 (회귀 없음)', () => {
    useAppStore.getState().set({ teams: [], groups: [] });
    type('@');

    const handles = screen.getAllByRole('option').map((o) => o.getAttribute('data-handle'));
    // 자기 자신은 빠지고, 에이전트가 먼저 선다(`rank`).
    expect(handles).toEqual(['releaser', 'alice']);
    expect(screen.queryByText('팀')).toBeNull();
  });

  /**
   * **집합과 팀의 이름이 겹치면 팀이 후보에서 빠진다.** 세 네임스페이스가 배타가 아니고
   * (서버 테스트 `teamMention.test.ts` 가 고정했다) 겹친 이름을 부르면 서버는 집합을
   * 펼친다(`services/messages.ts` 의 해석 순서). 그때 후보에 팀이 서면 그것을 골라 보낸
   * 사람은 자기가 부른 것과 다른 명단이 깨는 것을 본다.
   */
  it('6. 이름이 집합과 겹친 팀은 후보에 서지 않는다', () => {
    useAppStore.getState().set({
      groups: [grp('g9', 'release', 'Release 사람들', 2)],
      teams: [tm('t1', 'release', 4)],
    });
    type('@rel');

    const option = optionFor('release');
    expect(option!.getAttribute('data-kind')).toBe('group');
    // 같은 이름이 두 번 서지 않는다 — 어느 쪽을 고른 것인지 알 수 없게 된다.
    expect(screen.getAllByRole('option').filter((o) => o.getAttribute('data-handle') === 'release'))
      .toHaveLength(1);
  });

  /**
   * **@ 버튼으로 여는 목록에도 팀이 선다.** 그 목록은 첫 줄을 보내기 **전에** 상대를
   * 정하는 자리이고, 팀이 여기 없으면 그 이름을 이미 아는 사람만 손으로 칠 수 있다.
   */
  it('7. @ 버튼 목록에도 팀이 선다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    fireEvent.click(screen.getByLabelText('Add mention'));

    expect(optionFor('release')!.getAttribute('data-kind')).toBe('team');
  });
});

describe('본문의 팀 멘션은 강조된다 (#172)', () => {
  /**
   * 강조하지 않으면 `lib/mention.ts` 머리의 경계가 깨진다: *"강조되지 않은 것이 몰래
   * 알림을 보낸다"*. 서버는 `@release` 를 팀으로 펼쳐 넷을 깨우는데 화면이 평범한 글자로
   * 그리면, 읽는 사람은 그 발화가 아무도 부르지 않았다고 읽는다.
   */
  it('팀 이름이 여럿을 부르는 멘션으로 그려진다', () => {
    render(<MessageBody body="@release 배포해라" messageId="m1" />);

    const mention = screen.getByTestId('mention-release');
    expect(mention).toBeTruthy();
    // `data-group` 은 "한 사람이 아니다" 를 뜻한다 — 팀에도 그것이 맞다.
    expect(mention!.getAttribute('data-group')).toBe('true');
  });

  it('없는 이름은 여전히 그냥 글자다', () => {
    render(<MessageBody body="@nosuchteam 있나" messageId="m1" />);
    expect(screen.queryByTestId('mention-nosuchteam')).toBeNull();
  });
});
