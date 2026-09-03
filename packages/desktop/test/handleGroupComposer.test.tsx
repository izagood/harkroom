import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController } from '../src/state/controller';
import { Composer } from '../src/components/Composer';
import { acc, grp, fakeApi, fakeWsFactory } from './helpers/fakeApi';

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
    expect(option!.textContent).toContain('3명');
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

  it('5b. 집합이 있어도 목록 길이는 MAX_SUGGESTIONS 를 넘지 않는다', () => {
    // 계정이 목록을 꽉 채우는 흔한 경우. 예약 자리가 없으면 집합이 아예 안 보이고,
    // 자리를 떼지 않고 양쪽을 각자 채우면 목록이 두 배가 된다.
    const many = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`x${i}`, acc(`x${i}`, `alpha${i}`)]),
    );
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'me', 'human', true), ...many },
      groups: [grp('g1', 'alpha-team', 'Alpha', 4)],
    });
    type('@al');

    const options = screen.getAllByRole('option');
    expect(options.length).toBeLessThanOrEqual(8);
    expect(options.some((o) => o.getAttribute('data-handle') === 'alpha-team')).toBe(true);
  });
});
