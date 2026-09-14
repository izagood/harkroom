import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { usePrefsStore } from '../src/state/prefsStore';
import { ApiError } from '../src/lib/api';
import { acc, chan } from './helpers/fakeApi';

/**
 * 채널 편집 폼의 이름 칸.
 *
 * 이 파일이 지키는 것은 "칸이 있다"가 아니라 **안 바꾼 값이 실려 나가지 않는 것**이다.
 * `submitEdit` 은 세 필드를 하나의 patch 로 모으는데, 이름을 늘 싣는 구현으로 돌아가면
 * topic 만 고친 저장이 매번 유니크 검사와 감사 항목을 만든다(서버 쪽 회귀선은
 * `channelRename.test.ts` 에 있다).
 *
 * 충돌 안내를 따로 재는 이유: 409 는 사용자가 **고칠 수 있는 유일한 실패**다. 그것이
 * "편집에 실패했다" 로 뭉개지면 다른 이름을 쓰면 된다는 사실이 화면에서 사라진다.
 */
const fakeController = (updateChannel = vi.fn(async () => undefined)) => {
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel, archiveChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(), send: vi.fn(),
    openThread: vi.fn(), loadOlder: vi.fn(), markChannelUnread: vi.fn(),
    loadChannelMembers: vi.fn(async () => []),
    loadChannelAutoMentions: vi.fn(async () => []),
  };
  setController(c as unknown as Controller);
  return c;
};

const seed = () => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: { ...acc('u1', 'me'), isAdmin: true },
    accounts: { u1: acc('u1', 'me') },
    channels: [chan('c1', 'general')],
    dms: [], connected: true,
  });
};

const sidebar = () => render(
  <Sidebar panel="home" onOpenDirectory={vi.fn()} onOpenChannelDirectory={vi.fn()} onOpenInbox={vi.fn()} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />,
);

const openEdit = (): void => {
  fireEvent.contextMenu(screen.getByRole('button', { name: /# general\b/ }));
  fireEvent.click(screen.getByText('채널 편집'));
};

const nameBox = () => screen.getByTestId('channel-edit-name') as HTMLInputElement;
const save = () => fireEvent.click(screen.getByText('저장'));

beforeEach(() => { vi.clearAllMocks(); seed(); usePrefsStore.getState().setLocale('ko'); });
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('채널 이름 바꾸기 UI', () => {
  it('폼을 열면 이름 칸이 현재 이름으로 차 있다', () => {
    fakeController();
    sidebar();
    openEdit();
    expect(nameBox().value).toBe('general');
  });

  it('이름을 바꾸고 저장하면 name 만 실린다', () => {
    const c = fakeController();
    sidebar();
    openEdit();
    fireEvent.change(nameBox(), { target: { value: 'renamed' } });
    save();
    expect(c.updateChannel).toHaveBeenCalledWith('c1', { name: 'renamed' });
  });

  it('이름을 안 바꾸면 patch 에 name 키가 아예 없다', () => {
    const c = fakeController();
    sidebar();
    openEdit();
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: '새 topic' } });
    save();
    expect(c.updateChannel).toHaveBeenCalledWith('c1', { topic: '새 topic' });
  });

  it('규칙에 안 맞는 이름은 서버까지 가지 않고 안내한다', () => {
    const c = fakeController();
    sidebar();
    openEdit();
    fireEvent.change(nameBox(), { target: { value: 'Has Upper' } });
    save();
    expect(c.updateChannel).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('영문 소문자');
  });

  it('이미 쓰는 이름이면 그 사유를 그대로 말한다', async () => {
    const c = fakeController(vi.fn(async () => {
      throw new ApiError(409, 'channel_name_taken', 'this channel name is already taken');
    }));
    sidebar();
    openEdit();
    fireEvent.change(nameBox(), { target: { value: 'taken' } });
    save();
    await vi.waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('같은 이름을 쓰는 채널이 이미 있다');
    });
    expect(c.updateChannel).toHaveBeenCalled();
    // 실패했으므로 폼은 열려 있어야 한다 — 닫으면 사용자가 친 이름이 사라진다.
    expect(nameBox().value).toBe('taken');
  });
});
