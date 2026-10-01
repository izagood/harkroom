import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ChannelSettingsSheet } from '../src/components/ChannelSettingsSheet';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, chan } from './helpers/fakeApi';

/** 채널 설정 시트(UX ⑦b-1). 언어는 한국어로 못 박는다(다른 화면 테스트와 같은 이유). */
beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

const fake = (members: { accountId: string }[] = [{ accountId: 'u1' }, { accountId: 'u2' }]) => {
  const c = {
    archiveChannel: vi.fn(async () => ({})),
    loadChannelMembers: vi.fn(async () => members),
    leaveChannel: vi.fn(async () => {}),
    setChannelNotifyLevel: vi.fn(async () => {}),
  };
  setController(c as unknown as Controller);
  return c;
};

const seed = (isAdmin: boolean) => {
  useAppStore.getState().reset();
  const me = { ...acc('u1', 'me'), isAdmin };
  useAppStore.getState().set({
    me, accounts: { u1: me },
    channels: [{ ...chan('c1', 'general'), topic: '잡담' }],
    channelPrefs: {}, channelSheetId: 'c1',
  });
};

describe('채널 설정 시트 (UX ⑦b-1)', () => {
  it('정보 탭에 주제·공개 범위가 보이고, admin 이 아니면 보관 버튼이 없다', () => {
    fake(); seed(false);
    render(<ChannelSettingsSheet />);
    expect(screen.getByTestId('channel-sheet-info').textContent).toContain('잡담');
    expect(screen.queryByTestId('channel-sheet-archive')).toBeNull();
    // 나가기는 누구나 — 되돌리기 어려운 쪽이라 빨강이다.
    expect(screen.getByTestId('channel-sheet-leave').className).toContain('text-danger');
  });

  it('닫으면 store 의 channelSheetId 가 비고 시트가 사라진다', () => {
    fake(); seed(true);
    render(<ChannelSettingsSheet />);
    fireEvent.click(screen.getByRole('button', { name: '채널 설정 닫기' }));
    expect(useAppStore.getState().channelSheetId).toBeNull();
    expect(screen.queryByTestId('channel-sheet')).toBeNull();
  });

  it('멤버가 여럿이면 나가기는 바로 나가고 시트를 닫는다', async () => {
    const c = fake(); seed(false);
    render(<ChannelSettingsSheet />);
    fireEvent.click(screen.getByTestId('channel-sheet-leave'));
    await waitFor(() => expect(c.leaveChannel).toHaveBeenCalledWith('c1', 'u1'));
    expect(useAppStore.getState().channelSheetId).toBeNull();
  });

  it('마지막 멤버면 한 번 묻고, [그래도 나가기] 를 눌러야 나간다', async () => {
    const c = fake([{ accountId: 'u1' }]); seed(false);
    render(<ChannelSettingsSheet />);
    fireEvent.click(screen.getByTestId('channel-sheet-leave'));
    expect(await screen.findByText(/마지막 멤버다/)).toBeTruthy();
    expect(c.leaveChannel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '그래도 나가기' }));
    await waitFor(() => expect(c.leaveChannel).toHaveBeenCalledWith('c1', 'u1'));
  });

  it('멤버 조회가 실패하면 나가지 않고 실패를 말한다', async () => {
    const c = fake(); seed(false);
    c.loadChannelMembers.mockRejectedValueOnce(new Error('503'));
    render(<ChannelSettingsSheet />);
    fireEvent.click(screen.getByTestId('channel-sheet-leave'));
    expect((await screen.findByRole('alert')).textContent).toContain('503');
    expect(c.leaveChannel).not.toHaveBeenCalled();
  });

  it('받아 온 멤버 목록에 내가 없으면 [채널 나가기] 가 없다 — 사이드바 메뉴와 같은 규칙', () => {
    fake(); seed(false);
    useAppStore.getState().set({ channelMembers: { c1: [{ accountId: 'u2' } as never] } });
    render(<ChannelSettingsSheet />);
    expect(screen.queryByTestId('channel-sheet-leave')).toBeNull();
  });

  it('목록을 아직 못 받았으면 [채널 나가기] 를 둔다 — 모르는 것을 아니라고 단정하지 않는다', () => {
    fake(); seed(false);
    render(<ChannelSettingsSheet />);
    expect(screen.getByTestId('channel-sheet-leave')).toBeTruthy();
  });

  it('나가기 조회가 도는 동안 버튼을 잠근다', async () => {
    let resolve!: (m: { accountId: string }[]) => void;
    const c = fake(); seed(false);
    c.loadChannelMembers.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    render(<ChannelSettingsSheet />);
    fireEvent.click(screen.getByTestId('channel-sheet-leave'));
    expect((screen.getByTestId('channel-sheet-leave') as HTMLButtonElement).disabled).toBe(true);
    resolve([{ accountId: 'u1' }, { accountId: 'u2' }]);
    await waitFor(() => expect(c.leaveChannel).toHaveBeenCalledTimes(1));
  });

  it('알림 탭에서 고르면 그 수준을 저장한다', () => {
    const c = fake(); seed(false);
    render(<ChannelSettingsSheet />);
    fireEvent.click(screen.getByTestId('channel-sheet-tab-notify'));
    fireEvent.click(screen.getByRole('radio', { name: '없음' }));
    expect(c.setChannelNotifyLevel).toHaveBeenCalledWith('c1', 'none');
  });
});
