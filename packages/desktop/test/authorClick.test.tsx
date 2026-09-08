import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, fakeApi, msg } from './helpers/fakeApi';

/**
 * 이름줄·거터 아바타를 누르면 **`@멘션` 을 누른 것과 같은 곳**으로 간다.
 *
 * 이 파일이 지키는 것은 좌표가 아니라 **한 사람을 가리키는 세 자리가 같은 곳으로 간다**는
 * 사실이다. 판정은 `lib/accountOpen` 한 곳에 있고(멘션 칩도 그것을 지난다), 여기서는
 * 이름줄·아바타가 실제로 그 함수를 지나 배선까지 닿는지를 잰다 — `mentionClick.test.tsx`
 * 가 "배선이 끊긴 채로 눌러도 아무 일이 없는 컨트롤"을 잡아 온 것과 같은 이유다.
 */

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me', 'human', true),
    accounts: {
      u1: acc('u1', 'me', 'human', true),
      u2: acc('u2', 'someone', 'human', false),
      a1: acc('a1', 'fizz', 'agent', false, { ownerAccountId: 'u1' }),
    },
  });
  setController({ api: fakeApi() } as unknown as Controller);
});
afterEach(() => { cleanup(); setController(null as unknown as Controller); });

describe('이름·아바타 클릭', () => {
  let onOpenDirectory: ReturnType<typeof vi.fn>;
  let onOpenSettings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onOpenDirectory = vi.fn();
    onOpenSettings = vi.fn();
  });

  const show = (authorId: string) =>
    render(
      <MessageItem
        message={msg('m1', 'c1', 1, '안녕', authorId)}
        onOpenDirectory={onOpenDirectory}
        onOpenSettings={onOpenSettings}
      />,
    );

  it('사람 작성자의 이름을 누르면 디렉터리가 그 계정으로 열린다', () => {
    show('u2');

    const name = screen.getByTestId('author-name');
    expect(name.tagName).toBe('BUTTON');
    fireEvent.click(name);

    expect(onOpenDirectory).toHaveBeenCalledWith('u2');
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('아바타 거터를 눌러도 이름과 같은 곳으로 간다', () => {
    show('u2');

    fireEvent.click(screen.getByTestId('author-gutter'));

    expect(onOpenDirectory).toHaveBeenCalledWith('u2');
  });

  /** 멘션 칩과 **같은 규칙**을 지난다(#299): admin·소유자는 설정으로 간다. */
  it('에이전트 작성자는 admin 에게 설정으로 열린다 — 멘션과 같은 곳이다', () => {
    show('a1');

    fireEvent.click(screen.getByTestId('author-name'));
    expect(onOpenSettings).toHaveBeenCalledWith('agents', 'a1');
    expect(onOpenDirectory).not.toHaveBeenCalled();

    onOpenSettings.mockClear();
    fireEvent.click(screen.getByTestId('author-gutter'));
    expect(onOpenSettings).toHaveBeenCalledWith('agents', 'a1');
  });

  it('admin·소유자가 아니면 에이전트도 디렉터리로 간다', () => {
    useAppStore.getState().set({
      me: acc('u3', 'stranger', 'human', false),
      accounts: {
        u3: acc('u3', 'stranger', 'human', false),
        a1: acc('a1', 'fizz', 'agent', false, { ownerAccountId: 'u1' }),
      },
    });
    show('a1');

    fireEvent.click(screen.getByTestId('author-name'));
    expect(onOpenDirectory).toHaveBeenCalledWith('a1');
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  /** 접근 가능한 이름은 `@handle` 이 아니라 **무엇을 하는지**다 — 멘션 칩과 한 문장에서 나온다. */
  it('이름줄 버튼이 실제로 열리는 곳을 말한다', () => {
    show('u2');
    expect(screen.getByRole('button', { name: '작성자 someone 프로필 열기' })).toBeTruthy();
    cleanup();

    show('a1');
    expect(screen.getByRole('button', { name: '작성자 fizz 에이전트 설정 열기' })).toBeTruthy();
  });

  /**
   * 거터는 **같은 곳으로 가는 두 번째 문**이라 보조기술에는 내지 않는다. 내면 메시지마다
   * 같은 이름의 버튼이 둘씩 서서 탭 순서와 버튼 목록이 두 배가 된다.
   */
  it('거터는 탭 순서·보조기술에 두 번 서지 않는다', () => {
    show('u2');

    expect(screen.getAllByRole('button', { name: '작성자 someone 프로필 열기' })).toHaveLength(1);
    const gutter = screen.getByTestId('author-gutter');
    expect(gutter.getAttribute('aria-hidden')).toBe('true');
    expect(gutter.getAttribute('tabindex')).toBe('-1');
  });

  /**
   * 갈 곳이 없으면 **버튼이 아니다.** 신호를 넘기지 않는 자리(단위 테스트·문서 패널)에서
   * 눌러도 아무 일이 없는 컨트롤을 남기지 않는다 — `MessageBody` 의 같은 계약이다.
   */
  it('신호가 없으면 이름도 거터도 버튼이 아니다', () => {
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u2')} />);

    expect(screen.getByTestId('author-name').tagName).toBe('SPAN');
    expect(screen.getByTestId('author-gutter').tagName).toBe('DIV');
  });

  /** 모델 툴팁(#600)은 이름줄에 붙어 있다 — 버튼이 되어도 그 자리를 잃지 않는다. */
  it('버튼이 되어도 이름은 그대로 이름이다', () => {
    show('u2');
    expect(screen.getByTestId('author-name').textContent).toBe('someone');
  });
});
