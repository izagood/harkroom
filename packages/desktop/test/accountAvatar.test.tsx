import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { Identity, resetAvatarCache } from '../src/components/Identity';
import { MessageItem } from '../src/components/MessageItem';
import { ProfileSettings } from '../src/components/settings/ProfileSettings';
import { acc, msg } from './helpers/fakeApi';

const fakeController = (over: Partial<Controller> = {}) => {
  const c = {
    fetchAvatar: vi.fn(async () => new Blob(['png-bytes'])),
    setAvatar: vi.fn(async () => undefined),
    fetchAttachment: vi.fn(async () => new Blob(['bytes'])),
    toggleReaction: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    ...over,
  };
  setController(c as unknown as Controller);
  return c;
};

/** 사진을 건 사람. 아바타는 첨부 id 로만 실려 오고, 바이트는 화면이 따로 받아 온다. */
const withPhoto = (id: string, handle: string, attachmentId = 'att-1') =>
  acc(id, handle, 'human', false, { avatarAttachmentId: attachmentId });

beforeEach(() => {
  useAppStore.getState().reset();
  // 캐시는 모듈 수준이라 테스트 사이에 새어 나간다 — 앱에서는 세션 하나가 통째로 산다.
  resetAvatarCache();
});
afterEach(() => cleanup());

describe('#159 아바타 표시', () => {
  it('아바타가 있으면 Identity 가 사진을 그린다', async () => {
    const c = fakeController();
    render(<Identity account={withPhoto('u2', 'alice')} />);

    const img = await screen.findByTestId('identity-avatar');
    // blob 이어야 한다 — 라우트를 직접 가리키면 헤더를 못 붙여 토큰이 URL 로 샌다.
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(c.fetchAvatar).toHaveBeenCalledWith('u2');
    // 사진이 접근성 이름을 바꾸지 않는다 — 이름은 여전히 핸들이다.
    expect(screen.getByText('alice')).toBeTruthy();
  });

  it('아바타가 없으면 기존 이니셜 폴백이 그대로 나온다', async () => {
    const c = fakeController();
    render(<Identity account={acc('u2', 'alice')} />);

    expect(screen.queryByTestId('identity-avatar')).toBeNull();
    expect(screen.getByText('A')).toBeTruthy();
    // 걸린 사진이 없으면 **바이트를 받지도 않는다** — 없는 것을 받으러 가면 계정 수만큼 404 다.
    expect(c.fetchAvatar).not.toHaveBeenCalled();
  });

  it('에이전트는 사진을 받지 않고 글리프 폴백 그대로다', async () => {
    // 에이전트는 스스로 올릴 수단이 없다(#159 범위 밖). 그 자리는 #146 의 글리프가 지킨다.
    const c = fakeController();
    render(<Identity account={acc('u3', 'bot', 'agent', false, { avatarAttachmentId: 'att-9' })} />);

    expect(screen.queryByTestId('identity-avatar')).toBeNull();
    expect(screen.getByText('에이전트')).toBeTruthy();
    expect(c.fetchAvatar).not.toHaveBeenCalled();
  });

  it('모르는 계정은 물음표 폴백 그대로다', async () => {
    fakeController();
    render(<Identity account={undefined} />);
    expect(screen.queryByTestId('identity-avatar')).toBeNull();
    expect(screen.getByText('알 수 없는 계정')).toBeTruthy();
  });

  /**
   * 요구 7. 아바타 마크업이 자리마다 복제되는 것을 막는 테스트다 — `MessageItem` 이 자기
   * `<img>` 를 그리기 시작하면 여기서 잡힌다. "Identity 를 통과했는가"는 눈으로 못 보므로
   * 낸 쪽에 표식을 두고 **화면의 모든 img 가 그 표식을 갖는지**를 본다.
   */
  it('메시지에 뜨는 아바타 img 는 전부 Identity 가 낸 것이다', async () => {
    fakeController();
    useAppStore.getState().set({
      me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me'), u2: withPhoto('u2', 'alice') },
      activeChannelId: 'c1',
    });
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u2')} />);

    await waitFor(() => expect(screen.getAllByTestId('identity-avatar').length).toBeGreaterThan(0));
    const all = document.querySelectorAll('img');
    const fromIdentity = document.querySelectorAll('img[data-testid="identity-avatar"]');
    expect(all.length).toBe(fromIdentity.length);
  });

  it('같은 아바타를 여러 자리에 그려도 바이트는 한 번만 받는다', async () => {
    // 캐시가 `Identity` 안에 있어야 하는 이유다 — 메시지 목록은 같은 얼굴을 수십 번 그린다.
    const c = fakeController();
    const alice = withPhoto('u2', 'alice');
    render(<div><Identity account={alice} /><Identity account={alice} /><Identity account={alice} /></div>);

    await waitFor(() => expect(screen.getAllByTestId('identity-avatar')).toHaveLength(3));
    expect(c.fetchAvatar).toHaveBeenCalledTimes(1);
  });
});

describe('#159 프로필 화면의 쓰기 경로', () => {
  it('파일을 고르면 그 파일로 아바타를 정한다', async () => {
    const c = fakeController();
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);

    const file = new File(['png-bytes'], 'me.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [file] } });

    await waitFor(() => expect(c.setAvatar).toHaveBeenCalledWith(file));
  });

  it('지우기는 명시적 null 로 간다', async () => {
    // `undefined` 로 지우면 JSON.stringify 가 키를 버려 조작이 조용히 무시된다.
    const c = fakeController();
    useAppStore.getState().set({ me: withPhoto('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(c.setAvatar).toHaveBeenCalledWith(null));
  });

  it('사진이 없으면 지우기 버튼이 없다', () => {
    fakeController();
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('읽기 전용 안내가 사진은 바꿀 수 있다고 말한다', () => {
    // 문구가 "아무것도 못 바꾼다"로 남으면, 바로 위에 있는 Upload 버튼과 어긋난다.
    fakeController();
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);
    expect(screen.getByTestId('profile-readonly-note').textContent).toMatch(/profile photo/i);
  });
});
