import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, chan, fakeApi, fakeWsFactory, msg, accountsResult, grp } from './helpers/fakeApi';

const show = (body: string) =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, 'u2')} />);

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me', 'human', true),
    accounts: {
      u1: acc('u1', 'me', 'human', true),
      u2: acc('u2', 'someone', 'human', false),
      a1: acc('a1', 'fizz', 'agent', false, { ownerAccountId: 'u1' }),
      a2: acc('a2', 'buzz', 'agent', false, { ownerAccountId: 'u2' }),
      a3: acc('a3', 'disabled-agent', 'agent', false, { ownerAccountId: null, disabled: true }),
    },
    groups: [grp('g1', 'oncall', 'On-call')],
  });
});
afterEach(() => { cleanup(); setController(null as unknown as Controller); });

describe('멘션 클릭 (#279)', () => {
  let onOpenDirectory: ReturnType<typeof vi.fn>;
  let onOpenSettings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onOpenDirectory = vi.fn();
    onOpenSettings = vi.fn();
  });

  const showWithCallbacks = (body: string) =>
    render(<MessageItem message={msg('m1', 'c1', 1, body, 'u2')} onOpenDirectory={onOpenDirectory} onOpenSettings={onOpenSettings} />);

  it('존재하는 사람 멘션이 버튼이고 누르면 디렉터리가 그 계정으로 열린다', () => {
    showWithCallbacks('@someone 안녕');

    const mention = screen.getByTestId('mention-someone');
    expect(mention.tagName).toBe('BUTTON');
    fireEvent.click(mention);

    expect(onOpenDirectory).toHaveBeenCalledWith('u2');
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('존재하지 않는 handle 은 버튼이 아니다', () => {
    showWithCallbacks('@notexist 안녕');

    expect(screen.queryByTestId('mention-notexist')).toBeNull();
  });

  it('에이전트 멘션을 admin 이 누르면 설정이 그 에이전트로 열린다', () => {
    showWithCallbacks('@fizz 이거 봐줘');

    const mention = screen.getByTestId('mention-fizz');
    expect(mention.tagName).toBe('BUTTON');
    fireEvent.click(mention);

    expect(onOpenSettings).toHaveBeenCalledWith('agents', 'a1');
    expect(onOpenDirectory).not.toHaveBeenCalled();
  });

  it('에이전트 멘션을 소유자가 누르면 설정이 그 에이전트로 열린다', () => {
    useAppStore.getState().set({
      me: acc('u2', 'me', 'human', false),
      accounts: {
        u1: acc('u1', 'admin', 'human', true),
        u2: acc('u2', 'me', 'human', false),
        a1: acc('a1', 'fizz', 'agent', false, { ownerAccountId: 'u2' }),
      },
    });

    showWithCallbacks('@fizz 이거 봐줘');

    const mention = screen.getByTestId('mention-fizz');
    fireEvent.click(mention);

    expect(onOpenSettings).toHaveBeenCalledWith('agents', 'a1');
    expect(onOpenDirectory).not.toHaveBeenCalled();
  });

  it('소유자도 admin 도 아니면 디렉터리로 열린다', () => {
    useAppStore.getState().set({
      me: acc('u3', 'stranger', 'human', false),
      accounts: {
        u1: acc('u1', 'admin', 'human', true),
        u2: acc('u2', 'someone', 'human', false),
        a1: acc('a1', 'fizz', 'agent', false, { ownerAccountId: 'u1' }),
      },
    });

    showWithCallbacks('@fizz 이거 봐줘');

    const mention = screen.getByTestId('mention-fizz');
    fireEvent.click(mention);

    expect(onOpenDirectory).toHaveBeenCalledWith('a1');
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('접근 가능한 이름이 동작을 말한다(@handle 만이 아니다)', () => {
    showWithCallbacks('@someone 안녕');

    const mention = screen.getByTestId('mention-someone');
    expect(mention.getAttribute('aria-label')).toBe('someone 프로필 열기');
  });

  it('에이전트 멘션의 접근 가능한 이름이 설정 열기를 나타낸다', () => {
    showWithCallbacks('@fizz 안녕');

    const mention = screen.getByTestId('mention-fizz');
    expect(mention.getAttribute('aria-label')).toBe('fizz 에이전트 설정 열기');
  });

  it('집합 멘션은 버튼이 아니다', () => {
    showWithCallbacks('@oncall 안녕');

    const mention = screen.getByTestId('mention-oncall');
    expect(mention.tagName).toBe('SPAN');
  });

  it('키보드(Tab→Enter)로 실행된다', () => {
    showWithCallbacks('@someone 안녕');

    const mention = screen.getByTestId('mention-someone');
    expect(mention.tagName).toBe('BUTTON');

    fireEvent.click(mention);
    expect(onOpenDirectory).toHaveBeenCalledWith('u2');
  });
});