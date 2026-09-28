import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { Composer } from '../src/components/Composer';
import { acc, grp, fakeApi, fakeWsFactory } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';

/**
 * **언어를 한국어로 고정한다.** 이 파일이 재는 것은 언어가 아니라 **그 언어로 표현된
 * 규율**이다 — 문구가 사전을 지나게 된 뒤(i18n 이전)에도 그 규율은 그대로여야 하므로,
 * 한국어 문구를 재는 줄을 지우는 대신 언어를 못 박는다. `gallery.test.tsx`·
 * `skillsSettings.test.tsx`·`agentGrid.test.tsx`·`accountAvatar.test.tsx` 가 세운 선례다.
 */
beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => usePrefsStore.getState().setLocale('system'));

/**
 * 핸들 집합이 멘션 후보에 섞이는 것(#285).
 *
 * 여기서 지키는 것은 셋이다: 집합이 **보인다**(구성원 수와 함께), 사람·에이전트와 **구분된다**,
 * 그리고 집합이 없는 워크스페이스의 후보 목록은 **한 글자도 달라지지 않는다**.
 */
beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me', 'human', true),
    accounts: {
      u1: acc('u1', 'me', 'human', true),
      u2: acc('u2', 'alice', 'human'),
      a1: acc('a1', 'oncall-bot', 'agent'),
    },
    groups: [grp('g1', 'oncall', 'On-call', 3), grp('g2', 'release', 'Release', 12)],
  });
  setController(new Controller(fakeApi(), fakeWsFactory().makeWs));
});
afterEach(() => { cleanup(); setController(null as unknown as Controller); });

const type = (value: string) => {
  render(<Composer onSend={vi.fn()} scopeKey="c1" />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value } });
};

const optionFor = (handle: string) =>
  screen.getAllByRole('option').find((o) => o.getAttribute('data-handle') === handle);

describe('핸들 집합 자동완성 (#285)', () => {
  it('3. 후보에 집합이 나오고 구성원 수가 보인다', () => {
    type('@onc');

    const option = optionFor('oncall');
    expect(option).toBeTruthy();
    // 구성원 수가 없으면 `@release` 가 한 사람인지 스무 사람인지 모르는 채로 부르게 된다.
    // **단위(`명`)가 빠졌다**: 이 집합에는 에이전트도 들 수 있어 사람 세는 단위가 틀렸고,
    // 영어로 옮기면 그 부정확이 굳는다(`identity.badge.count`·`composer.mention.groupCount`
    // 가 같은 판단이다). 재는 것은 단위가 아니라 **수가 보이는가** 이므로 수만 잰다.
    expect(option!.textContent).toContain('3');
    // 표시 이름도 함께 — 핸들만으로는 무엇을 묶은 것인지 알 수 없다.
    expect(option!.textContent).toContain('On-call');
  });

  it('3b. 집합은 사람·에이전트와 다른 종류로 표시된다', () => {
    type('@onc');

    // 종류는 문구가 아니라 속성으로 단언한다 — 배지 문구가 바뀌면 문구를 보던 테스트가
    // 깨지고, 그때 깨진 것은 동작이 아니라 테스트다.
    expect(optionFor('oncall')!.getAttribute('data-kind')).toBe('group');
    expect(optionFor('oncall-bot')!.getAttribute('data-kind')).toBe('account');
    // 접근성 이름으로도 구분된다 — 배지가 이모지뿐이면 스크린리더에는 종류가 사라진다.
    expect(optionFor('oncall')!.textContent).toContain('집합');
    expect(optionFor('oncall-bot')!.textContent).not.toContain('집합');
  });

  it('4. 고르면 본문에 `@집합핸들 ` 이 들어간다', () => {
    type('@rel');

    fireEvent.click(optionFor('release')!);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    // 멘션은 본문 문자열이다(docs/design.md) — 뒤의 공백까지가 삽입 결과다.
    expect(textarea.value).toBe('@release ');
  });

  it('4b. 키보드로 골라도 같은 문자열이 들어간다', () => {
    type('@rel');
    const textarea = screen.getByRole('textbox');

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect((textarea as HTMLTextAreaElement).value).toBe('@release ');
  });

  it('5. 집합이 없으면 후보 목록이 그대로다 (회귀 없음)', () => {
    useAppStore.getState().set({ groups: [] });
    type('@');

    const handles = screen.getAllByRole('option').map((o) => o.getAttribute('data-handle'));
    // 자기 자신은 빠지고, 에이전트가 먼저 선다(`rank`). 집합 자리는 아예 없다.
    expect(handles).toEqual(['oncall-bot', 'alice']);
    expect(screen.queryByText('집합')).toBeNull();
  });

  /**
   * 계정이 많아도 **집합은 목록에 선다** — 이것이 예약 자리의 뜻이고, 이 축이 지키는 것이다.
   *
   * 예전에는 여기서 `길이 <= 8`(`MAX_SUGGESTIONS`)도 함께 쟀다. 그 수는 "목록이 화면을
   * 덮지 않을 만큼" 이었는데, 화면을 덮지 않게 하는 일은 목록 상자의 높이가 하고 있었고
   * 이 수는 **아홉째부터를 조용히 지우는** 일만 했다(스크롤도 안 되니 찾을 길이 없다).
   * 그래서 상한을 올렸고, 이 축은 계정 열 개가 다 서면서 집합도 함께 서는 것을 잰다.
   */
  it('5b. 계정이 많아도 집합은 목록에 서고, 계정이 잘리지 않는다', () => {
    const many = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`x${i}`, acc(`x${i}`, `alpha${i}`)]),
    );
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'me', 'human', true), ...many },
      groups: [grp('g1', 'alpha-team', 'Alpha', 4)],
    });
    type('@al');

    const handles = screen.getAllByRole('option').map((o) => o.getAttribute('data-handle'));
    expect(handles).toContain('alpha-team');
    // 계정 열 개 + 집합 하나. 여덟에서 끊기지 않는다.
    expect(handles.length).toBe(11);
  });
});
