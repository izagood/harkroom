import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController } from '../src/state/controller';
import { Composer } from '../src/components/Composer';
import { acc, grp, fakeApi, fakeWsFactory, accountsResult } from './helpers/fakeApi';

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me', 'human', true),
    accounts: {
      u1: acc('u1', 'me', 'human', true),
      u2: acc('u2', 'alice', 'human'),
      a1: acc('a1', 'fizz', 'agent'),
    },
    groups: [grp('g1', 'oncall', 'On-call'), grp('g2', 'release', 'Release')],
  });
  const api = fakeApi();
  const c = new Controller(api, fakeWsFactory().makeWs);
  setController(c);
});
afterEach(() => { cleanup(); setController(null as unknown as Controller); });

describe('핸들 집합 자동완성 (#285)', () => {
  it('후보에 집합이 나오고 다른 표시가진다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@o' } });

    const oncall = screen.getByText('@oncall');
    expect(oncall).toBeTruthy();

    const badge = screen.getByText('집합');
    expect(badge).toBeTruthy();
    expect(badge.parentElement?.getAttribute('data-kind')).toBe('group');
  });

  it('고르면 본문에 @집합핸들 이 들어간다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@o' } });

    const option = screen.getByRole('option', { name: /@oncall/ });
    fireEvent.click(option);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('@oncall ');
  });

  it('집합이 없으면 후보 목록이 그대로다 (회귀 없음)', () => {
    useAppStore.getState().set({ groups: [] });
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@a' } });

    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.queryByText('집합')).toBeNull();
  });

  it('집합과 계정이 함께 표시된다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@o' } });

    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('@oncall')).toBeTruthy();
  });
});