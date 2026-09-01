import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const fakeController = () => {
  const c = {
    openThread: vi.fn(),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

const seed = (me: ReturnType<typeof acc>) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me,
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    activeChannelId: 'c1',
  });
};

beforeEach(() => seed(acc('u1', 'admin')));
afterEach(() => cleanup());

describe('MessageItem edit and delete', () => {
  it('offers edit and delete on my own message', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'mine', 'u1')} />);

    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  // 남의 발언을 고칠 수 있으면 기록이 증거가 못 된다. 서버도 작성자만 허용하므로,
  // UI 가 버튼을 내주면 눌러도 403 이 나는 죽은 버튼이 된다.
  it('never offers edit on someone else message', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'theirs', 'u2')} />);

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  // 삭제는 작성자 또는 admin — 내용을 바꾸는 게 아니라 치우는 것이므로 치울 사람이 있어야 한다.
  it('offers delete on another account message when I am an admin', () => {
    fakeController();
    seed({ ...acc('u1', 'admin'), isAdmin: true });
    render(<MessageItem message={msg('m1', 'c1', 1, 'theirs', 'u2')} />);

    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('does not offer delete on another account message when I am not an admin', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'theirs', 'u2')} />);

    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  // 투영된 system 메시지는 avcs 로그의 사본이다. 사람이 고칠 대상이 아니다.
  it('offers neither on a system message', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'projected', 'u1', { kind: 'system' })} />);

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('submits the edited body and leaves edit mode', async () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'befor', 'u1')} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByDisplayValue('befor');
    fireEvent.change(input, { target: { value: 'before' } });
    fireEvent.submit(input);

    await waitFor(() => expect(c.editMessage).toHaveBeenCalledWith('m1', 'before'));
    await waitFor(() => expect(screen.queryByDisplayValue('before')).toBeNull());
  });

  it('abandons the edit on Escape without calling the api', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'untouched', 'u1')} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.keyDown(screen.getByDisplayValue('untouched'), { key: 'Escape' });

    expect(c.editMessage).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue('untouched')).toBeNull();
    expect(screen.getByText('untouched')).toBeTruthy();
  });

  it('marks an edited message so readers know the text changed', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'fixed', 'u1', { editedAt: new Date().toISOString() })} />);

    expect(screen.getByText('(edited)')).toBeTruthy();
  });

  // 삭제는 되돌릴 수 없다. 한 번의 오클릭으로 대화가 사라지면 안 된다.
  it('requires a confirmation step before deleting', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'doomed', 'u1')} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(c.deleteMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(c.deleteMessage).toHaveBeenCalledWith('m1');
  });
});
