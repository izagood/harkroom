import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { MessageRow, ReactionRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { pickInline } from '../src/components/Reactions';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const withReactions = (reactions: ReactionRow[]): MessageRow =>
  ({ ...msg('m1', 'c1', 1, '본문', 'u2'), reactions });

const fakeController = () => {
  const c = { toggleReaction: vi.fn(async () => undefined) };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone'), u3: acc('u3', 'third') },
  });
});
afterEach(() => cleanup());

describe('showing reactions', () => {
  it('shows the emoji with how many pressed it', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2', 'u3'] }])} />);

    const chip = screen.getByRole('button', { name: /👀/ });
    expect(chip.textContent).toContain('2');
  });

  // 칩은 없어야 하지만 '추가' 버튼은 트리에 남아야 한다 — 리액션을 시작하는 유일한 경로다.
  // 호버로 숨기더라도 opacity 로 숨겨 키보드·스크린리더가 도달할 수 있어야 한다.
  it('shows no chips when nobody reacted, but keeps a way to add one', () => {
    fakeController();
    render(<MessageItem message={withReactions([])} />);

    expect(screen.queryAllByRole('button', { name: /👀|💬/ })).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Add reaction' })).toBeTruthy();
  });

  // 내가 누른 것과 남만 누른 것이 같아 보이면, 또 누를지 뗄지 알 수 없다.
  it('marks the chips I pressed', () => {
    fakeController();
    render(<MessageItem message={withReactions([
      { emoji: '👀', accountIds: ['u1'] },
      { emoji: '💬', accountIds: ['u2'] },
    ])} />);

    expect(screen.getByRole('button', { name: /👀/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /💬/ }).getAttribute('aria-pressed')).toBe('false');
  });

  // 스크린리더에는 이모지 문자만으로 부족하다 — 몇 명이 눌렀는지 읽혀야 한다.
  it('names who reacted for a screen reader', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2', 'u3'] }])} />);

    expect(screen.getByRole('button', { name: /👀/ }).getAttribute('aria-label'))
      .toMatch(/someone|third/);
  });

  it('keeps the order the server sent', () => {
    fakeController();
    render(<MessageItem message={withReactions([
      { emoji: '💬', accountIds: ['u2'] },
      { emoji: '👀', accountIds: ['u3'] },
    ])} />);

    const chips = screen.getAllByRole('button', { name: /👀|💬/ });
    expect(chips[0]!.textContent).toContain('💬');
  });
});

describe('pressing a reaction', () => {
  it('adds the emoji I clicked from the picker', async () => {
    const c = fakeController();
    render(<MessageItem message={withReactions([])} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }));
    fireEvent.click(screen.getByRole('button', { name: '👀' }));

    await waitFor(() => expect(c.toggleReaction).toHaveBeenCalledWith('c1', 'm1', '👀', true));
  });

  it('takes a click on a chip I already pressed as removing it', async () => {
    const c = fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u1'] }])} />);

    fireEvent.click(screen.getByRole('button', { name: /👀/ }));

    await waitFor(() => expect(c.toggleReaction).toHaveBeenCalledWith('c1', 'm1', '👀', false));
  });

  it('takes a click on someone else’s chip as joining it', async () => {
    const c = fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2'] }])} />);

    fireEvent.click(screen.getByRole('button', { name: /👀/ }));

    await waitFor(() => expect(c.toggleReaction).toHaveBeenCalledWith('c1', 'm1', '👀', true));
  });

  it('closes the picker after a pick', async () => {
    fakeController();
    render(<MessageItem message={withReactions([])} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }));
    fireEvent.click(screen.getByRole('button', { name: '👀' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: '💬' })).toBeNull());
  });

  // 시스템 메시지는 avcs 투영의 산물이다. 리액션 자체는 무해하지만 UI 가 조작 가능한 것처럼
  // 보이면 안 된다 — 여기서는 허용한다(사람이 avcs 이벤트에 반응하는 것은 자연스럽다).
  it('lets me react to a system message', () => {
    fakeController();
    render(<MessageItem message={{ ...withReactions([]), kind: 'system' }} />);

    expect(screen.getByRole('button', { name: 'Add reaction' })).toBeTruthy();
  });
});

describe('#145 인라인 이모지 버튼 토글과 눌린 상태', () => {
  it('인라인 버튼을 누르면 그 이모지가 토글된다', async () => {
    const c = fakeController();
    render(<MessageItem message={withReactions([])} />);

    // 👍 버튼을 찾는다 (첫 번째 인라인 이모지)
    const button = screen.getByRole('button', { name: 'React with 👍' });
    fireEvent.click(button);

    await waitFor(() =>
      expect(c.toggleReaction).toHaveBeenCalledWith('c1', 'm1', '👍', true)
    );
  });

  it('내가 누른 인라인 이모지는 눌린 상태로 보인다', () => {
    fakeController();
    render(
      <MessageItem
        message={withReactions([{ emoji: '👍', accountIds: ['u1'] }])}
      />
    );

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    const button = within(toolbar).getByRole('button', { name: 'React with 👍' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('남이 누른 인라인 이모지는 눌리지 않은 상태로 보인다', () => {
    fakeController();
    render(
      <MessageItem
        message={withReactions([{ emoji: '👍', accountIds: ['u2'] }])}
      />
    );

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    const button = within(toolbar).getByRole('button', { name: 'React with 👍' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('인라인 버튼 토글은 기존 리액션을 덮어쓴다', async () => {
    const c = fakeController();
    render(
      <MessageItem
        message={withReactions([{ emoji: '👍', accountIds: ['u2'] }])}
      />
    );

    // 👍 가 이미 있다. 내 버튼을 누르면 내가 추가한다.
    const button = screen.getByRole('button', { name: 'React with 👍' });
    fireEvent.click(button);

    await waitFor(() =>
      expect(c.toggleReaction).toHaveBeenCalledWith('c1', 'm1', '👍', true)
    );
  });
});

describe('#145 인라인 선정 규칙과 접근성 이름', () => {
  // 인덱스로 자르면 QUICK 순서가 바뀌는 순간 상태 신호가 인라인으로 샌다.
  it('순서가 바뀌어도 상태 신호 이모지는 인라인에 오지 않는다', () => {
    expect(pickInline(['👀', '👍', '💬', '🎉', '✅', '🔥'])).toEqual(['👍', '🎉', '✅']);
    expect(pickInline(['👍', '🎉', '✅', '👀', '💬'])).toEqual(['👍', '🎉', '✅']);
  });

  // 피커를 열면 두 표면의 이모지 버튼이 함께 존재한다. 이름이 같으면 스크린리더도
  // 테스트도 어느 것인지 가리지 못한다 — 이 파일이 이미 한 번 겪은 사고다.
  it('피커를 열어도 같은 접근 가능한 이름이 둘이 되지 않는다', () => {
    fakeController();
    render(<MessageItem message={withReactions([])} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }));

    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    const dupes = names.filter((n, i) => n !== null && names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });
});

/**
 * **누가 달았는지 호버로 보여 준다**(2026-09-09, 요청자 jaebin).
 *
 * 그 전까지 칩에는 이모지와 수만 있었다 — `👀 1` 을 보고도 그 1 이 누구인지 알 방법이
 * 화면에 없었다. `👀`·`💬` 는 에이전트가 상태 신호로 쓰는 것이라 특히 아팠다:
 * **"누가 이 말을 읽었나"가 그 신호의 뜻 전부**인데 화면은 몇 명인지만 말했다.
 */
describe('리액션을 단 사람을 호버로 보여 준다', () => {
  it('단 사람들의 이름이 title 에 들어 있다', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2', 'u3'] }])} />);

    const chip = screen.getByTestId('reaction-👀');
    expect(chip.getAttribute('title')).toBe('someone, third');
  });

  // 서버가 주는 `accountIds` 는 이미 누른 순서다(`services/messages.ts::REACTIONS` 의
  // `array_agg(... order by created_at)`). 화면은 그것을 다시 정렬하지 않는다.
  it('이름은 누른 순서대로 들어간다', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u3', 'u2'] }])} />);

    expect(screen.getByTestId('reaction-👀').getAttribute('title')).toBe('third, someone');
  });

  /** 호버와 스크린리더가 갈라지면 한쪽만 고쳐지고, 그러면 본 것과 읽힌 것이 다르다. */
  it('호버와 스크린리더가 같은 목록을 말한다', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2', 'u3'] }])} />);

    const chip = screen.getByTestId('reaction-👀');
    expect(chip.getAttribute('aria-label')).toContain(chip.getAttribute('title')!);
  });

  it('내가 단 것은 핸들 대신 나 로 적힌다', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2', 'u1'] }])} />);

    // 테스트의 기본 언어는 영어다(`i18n.test.tsx` 의 "화면 — 기본은 영어다").
    expect(screen.getByTestId('reaction-👀').getAttribute('title')).toBe('someone, you');
  });

  /**
   * **자리를 옮기지 않는다.** 나를 앞으로 끌어오면 목록이 더는 누른 순서가 아니고,
   * 그러면 `👀` 이 언제 읽혔는지를 이 줄에서 읽을 수 없다.
   */
  it('나를 앞으로 끌어오지 않는다', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2', 'u3', 'u1'] }])} />);

    expect(screen.getByTestId('reaction-👀').getAttribute('title')).toBe('someone, third, you');
  });

  /**
   * **취소하면 이름이 함께 빠진다.** 목록은 `accountIds` 에서 매번 다시 만들어지므로
   * (`appStore::applyReaction` 이 그 id 를 배열에서 뺀다) 따로 지울 경로가 없다.
   * 그래도 이 자리를 재는 이유: 나중에 이름을 다른 곳에 따로 쌓아 두면 그 순간
   * 취소가 목록에 반영되지 않고, 그 회귀를 여기서 잡는다.
   */
  it('취소한 사람은 목록에서 빠진다', () => {
    fakeController();
    const { rerender } = render(
      <MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2', 'u3'] }])} />,
    );
    expect(screen.getByTestId('reaction-👀').getAttribute('title')).toBe('someone, third');

    rerender(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2'] }])} />);
    expect(screen.getByTestId('reaction-👀').getAttribute('title')).toBe('someone');
  });

  /** 사람이 많아도 툴팁 하나가 화면을 덮지 않는다 — OS 툴팁은 우리가 접을 수 없다. */
  it('사람이 많으면 나머지를 수로 접는다', () => {
    fakeController();
    const ids = Array.from({ length: 12 }, (_, i) => `u-${i}`);
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ids }])} />);

    expect(screen.getByTestId('reaction-👀').getAttribute('title')).toContain('more');
  });
});

/**
 * **내가 단 것은 테두리로도 가른다**(2026-09-09, 요청자 jaebin).
 *
 * 앞판은 면 한 단계(`bg-surface-sunken` vs `bg-surface`)와 굵기로만 갈랐는데, 실사용에서
 * 그 구별이 안 읽혔다 — 내가 눌렀는지 알아보려고 눌러 보게 되고, 누르면 취소된다.
 * 강조 예산(#488 B2)과의 사이는 `accentBudget.test.tsx` 에 적어 뒀다: 색은 **선에만**
 * 가고 채운 면과 글자는 여전히 무채색이다.
 */
describe('내가 단 이모지는 테두리가 강조된다', () => {
  it('내가 단 칩은 다른 선을 입는다', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u1'] }])} />);

    expect(screen.getByTestId('reaction-👀').className).toContain('border-accent-brand');
  });

  it('남만 단 칩은 보통 선이다', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2'] }])} />);

    const chip = screen.getByTestId('reaction-👀');
    expect(chip.className).toContain('border-border');
    expect(chip.className).not.toContain('border-accent-brand');
  });

  // 여러 사람이 단 칩에 **내가 섞여 있으면** 그것도 내가 단 것이다.
  it('여러 사람 중에 내가 섞여 있어도 강조된다', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2', 'u1', 'u3'] }])} />);

    const chip = screen.getByTestId('reaction-👀');
    expect(chip.className).toContain('border-accent-brand');
    expect(chip.dataset.mine).toBe('true');
  });

  /**
   * 색을 유일한 신호로 두지 않는다 — 색을 가리지 못하는 사람에게도 이 사실이 닿아야
   * 한다. 그래서 `aria-pressed` 와 면·굵기는 그대로 남긴다.
   */
  it('색 없이도 내가 단 것을 알 수 있다', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u1'] }])} />);

    const chip = screen.getByTestId('reaction-👀');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.className).toContain('font-medium');
  });
});
