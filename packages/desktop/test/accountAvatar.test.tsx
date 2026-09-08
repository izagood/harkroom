import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Identity, resetAvatarCache } from '../src/components/Identity';
import { MessageItem } from '../src/components/MessageItem';
import { ProfileSettings } from '../src/components/settings/ProfileSettings';
import { acc, msg } from './helpers/fakeApi';
import { ApiError } from '../src/lib/api';

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

// #365 로 사람의 `badge` 는 아무것도 그리지 않는다. 아래에서 **아바타 자체**를 재는
// 자리들은 `variant="avatar"` 를 명시한다 — 기본값(`badge`)으로 두면 이 테스트들이
// 재는 대상이 사라져 무엇도 지키지 않는다. 아바타가 사는 자리가 옮겨진 것이지
// #159 의 보증(사진·이니셜 폴백·왕복 한 번)이 약해진 것은 아니다.
describe('#159 아바타 표시', () => {
  it('아바타가 있으면 Identity 가 사진을 그린다', async () => {
    const c = fakeController();
    render(<Identity account={withPhoto('u2', 'alice')} variant="avatar" />);

    const img = await screen.findByTestId('identity-avatar');
    // blob 이어야 한다 — 라우트를 직접 가리키면 헤더를 못 붙여 토큰이 URL 로 샌다.
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(c.fetchAvatar).toHaveBeenCalledWith('u2');
    // 사진이 접근성 이름을 바꾸지 않는다 — 이름은 여전히 핸들이다.
    expect(screen.getByText('alice')).toBeTruthy();
  });

  it('아바타가 없으면 기존 이니셜 폴백이 그대로 나온다', async () => {
    const c = fakeController();
    render(<Identity account={acc('u2', 'alice')} variant="avatar" />);

    expect(screen.queryByTestId('identity-avatar')).toBeNull();
    expect(screen.getByText('A')).toBeTruthy();
    // 걸린 사진이 없으면 **바이트를 받지도 않는다** — 없는 것을 받으러 가면 계정 수만큼 404 다.
    expect(c.fetchAvatar).not.toHaveBeenCalled();
  });

  /**
   * Task 15-4 로 소유자가 에이전트에 사진을 걸 수 있게 됐다. 쓰기 경로(라우트·api·컨트롤러·
   * 설정 화면)만 생기고 **읽는 자리**가 사람으로 좁혀진 채 남아, 올린 사진이 DB 에만 있고
   * 화면에는 영영 안 나왔다. 회귀선을 여기 둔다 — 걸린 자리는 `Identity` 한 곳이다.
   */
  it('에이전트도 사진을 걸면 사진을 그린다', async () => {
    const c = fakeController();
    render(<Identity account={acc('u3', 'bot', 'agent', false, { avatarAttachmentId: 'att-9' })} variant="avatar" />);

    const img = await screen.findByTestId('identity-avatar');
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(c.fetchAvatar).toHaveBeenCalledWith('u3');
  });

  it('사진이 없는 에이전트는 이니셜 폴백 그대로다', async () => {
    const c = fakeController();
    render(<Identity account={acc('u3', 'bot', 'agent')} variant="avatar" />);

    expect(screen.queryByTestId('identity-avatar')).toBeNull();
    expect(screen.getByText('B')).toBeTruthy();
    expect(c.fetchAvatar).not.toHaveBeenCalled();
  });

  it('badge 자리는 아무것도 그리지 않고 바이트도 받지 않는다', async () => {
    // 사진이 서는 자리는 `avatar` 다. 이 자리는 이제 **아무것도** 그리지 않으므로(#455)
    // 받아 봐야 그릴 곳이 없다 — 목록 하나가 계정 수만큼 왕복을 내는 것을 막는다.
    const c = fakeController();
    const { container } = render(<Identity account={acc('u3', 'bot', 'agent', false, { avatarAttachmentId: 'att-9' })} />);

    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('identity-avatar')).toBeNull();
    expect(c.fetchAvatar).not.toHaveBeenCalled();
  });

  it('모르는 계정은 물음표 폴백 그대로다', async () => {
    fakeController();
    render(<Identity account={undefined} variant="avatar" />);
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
    render(<div><Identity account={alice} variant="avatar" /><Identity account={alice} variant="avatar" /><Identity account={alice} variant="avatar" /></div>);

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

    // 진행률 콜백이 2번째 인자로 함께 간다 — 그것이 막대가 차오르는 근거다.
    await waitFor(() => expect(c.setAvatar).toHaveBeenCalledWith(file, expect.any(Function)));
  });

  it('지우기는 명시적 null 로 간다', async () => {
    // `undefined` 로 지우면 JSON.stringify 가 키를 버려 조작이 조용히 무시된다.
    const c = fakeController();
    useAppStore.getState().set({ me: withPhoto('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByRole('button', { name: '정말 지우기' }));
    await waitFor(() => expect(c.setAvatar).toHaveBeenCalledWith(null, undefined));
  });

  /**
   * 지우기는 **되돌릴 수 없다**(원본 바이트가 남지 않는다). 그런데 한 걸음이었다 —
   * 스친 클릭 하나로 사진이 사라졌고, 사라진 뒤에도 아무 말이 없어 눌린 것인지조차
   * 알 수 없었다. 회귀선을 여기 둔다: **첫 클릭은 아무것도 지우지 않는다.**
   */
  it('첫 클릭은 확인만 묻는다 — 사진을 지우지 않는다', async () => {
    const c = fakeController();
    useAppStore.getState().set({ me: withPhoto('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(await screen.findByRole('button', { name: '정말 지우기' })).toBeTruthy();
    expect(c.setAvatar).not.toHaveBeenCalled();

    // 취소하면 원래 자리로 돌아간다 — 확인 버튼이 남아 있으면 다음 클릭이 지운다.
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('button', { name: '정말 지우기' })).toBeNull();
    expect(c.setAvatar).not.toHaveBeenCalled();
  });

  it('지운 뒤에는 지웠다고 말한다', async () => {
    const c = fakeController();
    useAppStore.getState().set({ me: withPhoto('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByRole('button', { name: '정말 지우기' }));

    await waitFor(() => expect(c.setAvatar).toHaveBeenCalled());
    expect((await screen.findByTestId('avatar-done')).textContent).toMatch(/지웠습니다/);
  });

  /**
   * 진행률이 이 고침의 요점이다. 전에는 사진을 고른 뒤 화면에 생기는 변화가 **버튼이
   * 흐려지는 것 하나**였고, 큰 파일에서는 사람이 그것을 오류로 읽었다("올라가지 않는다").
   * 실제로는 가는 중이었다.
   */
  it('올리는 동안 막대가 차오르고, 끝나면 바꿨다고 말한다', async () => {
    let report: ((f: number) => void) | undefined;
    let finish: (() => void) | undefined;
    const setAvatar = vi.fn((_f: File | null, onProgress?: (f: number) => void) => {
      report = onProgress;
      return new Promise<void>((res) => { finish = () => res(); });
    });
    fakeController({ setAvatar: setAvatar as unknown as Controller['setAvatar'] });
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);

    const file = new File(['png-bytes'], 'me.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [file] } });

    // 아직 한 바이트도 안 갔다 — 비율을 모르는 구간이다. 0% 라고 쓰면 거짓이 된다.
    const bar = await screen.findByTestId('avatar-progress');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();

    await act(async () => { report?.(0.4); });
    expect(screen.getByTestId('avatar-progress').getAttribute('aria-valuenow')).toBe('40');
    expect(screen.getByTestId('avatar-uploading').textContent).toMatch(/40%/);

    // 바이트가 다 갔지만 서버가 아직 저장 중이다. 100% 에서 멈춘 막대는 실패로 보이므로
    // **문구가 바뀌어야** 한다.
    await act(async () => { report?.(1); });
    expect(screen.getByTestId('avatar-uploading').textContent).toMatch(/적용 중/);

    await act(async () => { finish?.(); });
    expect((await screen.findByTestId('avatar-done')).textContent).toMatch(/바꿨습니다/);
    // 끝난 뒤 막대를 남겨 두면 다음 조작 옆에서 '지금 올리는 중'으로 읽힌다.
    expect(screen.queryByTestId('avatar-progress')).toBeNull();
  });

  it('사진이 없으면 지우기 버튼이 없다', () => {
    fakeController();
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  /**
   * 서버가 거절하면(이미지가 아닌 파일은 400 이다) 그 사실이 **눈에 보여야** 한다.
   * `sr-only` 로만 내면 스크린리더가 아닌 사람에게는 '아무 일도 일어나지 않은 것'과
   * 구분되지 않는다 — 버튼이 잠깐 눌렸다 풀리고 사진은 그대로다.
   */
  it('서버가 거절하면 보이는 오류를 낸다 — 무엇을 고를 수 있는지까지 말한다', async () => {
    fakeController({
      setAvatar: vi.fn(async () => { throw new ApiError(400, 'not_an_image', 'nope'); }),
    });
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);

    const file = new File(['<html>'], 'evil.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [file] } });

    const alert = await screen.findByRole('alert');
    // "안 된다"만 말하고 끝나면 사람은 다음에 무엇을 고를지 모른 채 같은 실패를 반복한다.
    expect(alert.textContent).toMatch(/PNG/);
    expect(alert.textContent).toMatch(/SVG/);
    // 화면에서 감춰 두면 낸 것이 아니다.
    expect(alert.className).not.toMatch(/sr-only/);
  });

  it('연결이 끊긴 것을 파일 탓으로 말하지 않는다', async () => {
    // 예전에는 무엇이 실패했든 "이미지 파일만 쓸 수 있습니다" 하나였다 — 서버가 죽어 있어도
    // 사람은 자기 파일을 의심하며 다른 파일로 몇 번을 다시 시도하게 된다.
    fakeController({ setAvatar: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) });
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);

    const file = new File(['png-bytes'], 'me.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [file] } });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/연결/);
    expect(alert.textContent).not.toMatch(/PNG/);
  });

  it('SVG 를 파일 창에서 고를 수 있다', async () => {
    // 화면이 서버보다 좁으면 SVG 는 파일 창에서 회색으로 죽고, **고를 수 없는 파일은 오류
    // 메시지도 못 낸다** — 사람에게는 버튼을 눌렀는데 아무 일도 없는 것으로 보인다.
    const c = fakeController();
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);

    expect(screen.getByTestId('avatar-file').getAttribute('accept')).toContain('image/svg+xml');

    const file = new File(['<svg/>'], 'me.svg', { type: 'image/svg+xml' });
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [file] } });
    await waitFor(() => expect(c.setAvatar).toHaveBeenCalledWith(file, expect.any(Function)));
  });

  it('읽기 전용 안내가 사진은 바꿀 수 있다고 말한다', () => {
    // 문구가 "아무것도 못 바꾼다"로 남으면, 바로 위에 있는 Upload 버튼과 어긋난다.
    fakeController();
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);
    expect(screen.getByTestId('profile-readonly-note').textContent).toMatch(/profile photo/i);
  });
});
