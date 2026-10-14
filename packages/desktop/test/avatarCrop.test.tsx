import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, renderHook, act, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { resetAvatarCache } from '../src/components/Identity';
import { ProfileSettings } from '../src/components/settings/ProfileSettings';
import { parseAvatarSource } from '../src/lib/api';
import { useAvatarEdit } from '../src/components/settings/avatarEdit';
import {
  ZOOM_MAX, clampView, renderCrop, cropToView, fitView, panBy, viewToCrop, viewToRect, zoomAround,
} from '../src/lib/avatarCrop';
import { acc } from './helpers/fakeApi';

vi.mock('../src/lib/avatarCrop', async (orig) => ({
  ...(await orig<typeof import('../src/lib/avatarCrop')>()),
  renderCrop: vi.fn(async () => new Blob(['cropped'], { type: 'image/webp' })),
}));

/** 인물이 오른쪽에 치우친 가로 사진 — 시안의 예시와 같은 모양. */
const LANDSCAPE = { width: 900, height: 600 };

describe('사진 맞추기 셈', () => {
  it('초기 모양은 가운데·짧은 변이 원에 꼭 맞는 크기다(지금 앱이 자르던 모양)', () => {
    expect(viewToRect(LANDSCAPE, fitView(LANDSCAPE))).toEqual({ x: 150, y: 0, size: 600 });
  });

  it('원 안에 빈 곳이 생기지 않게 묶는다 — 어느 쪽으로 끌어도 정사각형은 원본 안에 있다', () => {
    const far = panBy(LANDSCAPE, fitView(LANDSCAPE), -10_000, 10_000, 236);
    const r = viewToRect(LANDSCAPE, far);
    expect(r.x + r.size).toBeCloseTo(900);
    expect(r.y).toBe(0);
    // 1배 아래로는 줄지 않고 4배 위로는 커지지 않는다.
    expect(clampView(LANDSCAPE, { cx: 450, cy: 300, zoom: 0.2 }).zoom).toBe(1);
    expect(clampView(LANDSCAPE, { cx: 450, cy: 300, zoom: 99 }).zoom).toBe(ZOOM_MAX);
  });

  it('비율로 남기고 비율에서 같은 자리로 돌아온다', () => {
    const v = clampView(LANDSCAPE, { cx: 640, cy: 250, zoom: 2.5 });
    const back = cropToView(LANDSCAPE, viewToCrop(LANDSCAPE, v));
    expect(back.cx).toBeCloseTo(v.cx, 3);
    expect(back.cy).toBeCloseTo(v.cy, 3);
    expect(back.zoom).toBeCloseTo(v.zoom, 3);
    expect(cropToView(LANDSCAPE, null)).toEqual(fitView(LANDSCAPE));
  });

  it('휠·핀치는 커서 자리를 고정한 채 확대한다', () => {
    const v0 = clampView(LANDSCAPE, { cx: 450, cy: 300, zoom: 2 });
    const dx = 60; const dy = -40; const px = 236;
    const before = { x: v0.cx + dx / (px / (600 / v0.zoom)), y: v0.cy + dy / (px / (600 / v0.zoom)) };
    const v1 = zoomAround(LANDSCAPE, v0, 3, dx, dy, px);
    const after = { x: v1.cx + dx / (px / (600 / v1.zoom)), y: v1.cy + dy / (px / (600 / v1.zoom)) };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('원본 헤더를 읽는다 — id 가 없으면 원본 없음, 자리만 틀리면 처음 모양', () => {
    expect(parseAvatarSource('{"attachmentId":"a1","crop":{"x":0.1,"y":0,"size":0.5}}'))
      .toEqual({ attachmentId: 'a1', crop: { x: 0.1, y: 0, size: 0.5 } });
    expect(parseAvatarSource('{"attachmentId":"a1","crop":{"x":2,"y":0,"size":0.5}}')).toEqual({ attachmentId: 'a1', crop: null });
    expect(parseAvatarSource('{"crop":null}')).toBeNull();
    expect(parseAvatarSource('nope')).toBeNull();
    expect(parseAvatarSource(null)).toBeNull();
  });
});

const fakeController = (over: Partial<Record<string, unknown>> = {}) => {
  const c = {
    fetchAvatar: vi.fn(async () => new Blob(['current'], { type: 'image/png' })),
    fetchAvatarSource: vi.fn(async () => null),
    setAvatar: vi.fn(async () => undefined),
    ...over,
  };
  setController(c as unknown as Controller);
  return c;
};

/** 창이 그림을 다 쟀다고 친다(jsdom 은 그림을 풀지 않는다). */
const loaded = async () => {
  const dialog = await screen.findByTestId('avatar-crop');
  fireEvent.load(dialog.querySelector('img.hidden')!);
  return dialog;
};

describe('「사진 맞추기」 모달 (designer 시안 A)', () => {
  beforeEach(() => {
    usePrefsStore.getState().setLocale('ko');
    useAppStore.getState().reset();
    resetAvatarCache();
  });
  afterEach(() => {
    cleanup();
    usePrefsStore.getState().setLocale('system');
  });

  it('고르기만으로는 올리지 않는다 — 취소하면 아무것도 안 바뀐다', async () => {
    const c = fakeController();
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);

    fireEvent.change(screen.getByTestId('avatar-file'), {
      target: { files: [new File(['x'], 'me.gif', { type: 'image/gif' })] },
    });
    const dialog = await loaded();
    // 움직이는 GIF 는 첫 장만 남는다고 미리 말한다.
    expect(within(dialog).getByText('움직이는 GIF는 첫 장만 남는다.')).toBeTruthy();
    // 미리보기 첫 칸은 이 창을 연 화면(내 프로필 40)의 크기다 — 다른 화면의 크기를 거짓 칸으로 세우지 않는다(designer nit).
    expect(within(dialog).getByText('40 설정')).toBeTruthy();
    expect(within(dialog).queryByText('48 설정')).toBeNull();
    expect(within(dialog).getByText('32 메시지')).toBeTruthy();
    expect(c.setAvatar).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(screen.queryByTestId('avatar-crop')).toBeNull();
    expect(c.setAvatar).not.toHaveBeenCalled();
  });

  it('Esc 는 취소다', async () => {
    const c = fakeController();
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await loaded();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('avatar-crop')).toBeNull());
    expect(c.setAvatar).not.toHaveBeenCalled();
  });

  it('키보드로 옮기고 확대하고 0 으로 되돌리고 Enter 로 저장한다', async () => {
    const c = fakeController();
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await loaded();
    const stage = screen.getByTestId('avatar-crop-stage');
    // 열리면 편집 칸에 포커스가 간다.
    await waitFor(() => expect(document.activeElement).toBe(stage));
    const crop = () => JSON.parse(stage.getAttribute('data-crop')!) as { x: number; y: number; size: number };

    expect(crop()).toEqual({ x: 0, y: 0, size: 1 });
    fireEvent.keyDown(stage, { key: '+' });
    expect(crop().size).toBeLessThan(1);
    const zoomed = crop();
    fireEvent.keyDown(stage, { key: 'ArrowRight', shiftKey: true });
    expect(crop().x).toBeGreaterThan(zoomed.x);
    fireEvent.keyDown(stage, { key: '0' });
    expect(crop()).toEqual({ x: 0, y: 0, size: 1 });
    fireEvent.keyDown(stage, { key: '+' });
    const chosen = crop();

    fireEvent.keyDown(stage, { key: 'Enter' });
    await waitFor(() => expect(c.setAvatar).toHaveBeenCalledWith(
      expect.objectContaining({ crop: chosen, source: expect.objectContaining({ kind: 'file' }) }),
      expect.any(Function),
    ));
    expect(screen.queryByTestId('avatar-crop')).toBeNull();
  });

  it('걸린 사진은 아바타·Adjust 로 다시 열고, 원본과 지난 자리로 시작해 같은 원본을 가리킨다', async () => {
    const c = fakeController({
      fetchAvatarSource: vi.fn(async () => ({
        blob: new Blob(['orig'], { type: 'image/png' }),
        meta: { attachmentId: 'src-1', crop: { x: 0.25, y: 0.25, size: 0.5 } },
      })),
    });
    useAppStore.getState().set({ me: acc('u1', 'me', 'human', false, { avatarAttachmentId: 'att-1' }) });
    render(<ProfileSettings onSignOut={() => {}} />);

    fireEvent.click(screen.getByTestId('avatar-adjust-photo'));
    await loaded();
    expect(c.fetchAvatarSource).toHaveBeenCalledWith('u1');
    expect(JSON.parse(screen.getByTestId('avatar-crop-stage').getAttribute('data-crop')!))
      .toEqual({ x: 0.25, y: 0.25, size: 0.5 });

    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(c.setAvatar).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'attached', attachmentId: 'src-1' } }),
      expect.any(Function),
    ));
  });

  it('원본이 없는 옛 사진은 걸린 그림을 원본으로 연다', async () => {
    const c = fakeController();
    useAppStore.getState().set({ me: acc('u1', 'me', 'human', false, { avatarAttachmentId: 'att-old' }) });
    render(<ProfileSettings onSignOut={() => {}} />);

    fireEvent.click(screen.getByTestId('avatar-adjust'));
    await loaded();
    expect(c.fetchAvatar).toHaveBeenCalledWith('u1');
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(c.setAvatar).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'attached', attachmentId: 'att-old' } }),
      expect.any(Function),
    ));
  });

  it('잘라 내기가 실패하면 저장 버튼 옆에 말하고 올리지 않는다(designer s2)', async () => {
    const c = fakeController();
    vi.mocked(renderCrop).mockRejectedValueOnce(new Error('webp encode failed'));
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    const dialog = await loaded();
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    expect(await within(dialog).findByTestId('avatar-crop-save-failed')).toBeTruthy();
    expect(c.setAvatar).not.toHaveBeenCalled();
    // 다시 누르면 된다.
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(c.setAvatar).toHaveBeenCalled());
  });

  it('다시 맞추려고 원본을 받는 동안 「여는 중」을 보인다(designer n2)', async () => {
    let release: (v: null) => void = () => {};
    fakeController({ fetchAvatarSource: vi.fn(() => new Promise<null>((r) => { release = r; })) });
    useAppStore.getState().set({ me: acc('u1', 'me', 'human', false, { avatarAttachmentId: 'att-1' }) });
    render(<ProfileSettings onSignOut={() => {}} />);
    fireEvent.click(screen.getByTestId('avatar-adjust'));
    expect(await screen.findByTestId('avatar-opening')).toBeTruthy();
    release(null);
    await screen.findByTestId('avatar-crop');
    expect(screen.queryByTestId('avatar-opening')).toBeNull();
  });

  it('창이 열린 사이 대상이 바뀌면 창을 닫는다 — 저장이 새로 고른 에이전트에 걸리지 않게(security n3)', async () => {
    const apply = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useAvatarEdit(apply, { accountId: id, avatarAttachmentId: null }),
      { initialProps: { id: 'agent-a' } },
    );
    act(() => {
      result.current.onPicked({ target: { files: [new File(['x'], 'a.png', { type: 'image/png' })], value: '' } } as unknown as React.ChangeEvent<HTMLInputElement>);
    });
    expect(result.current.crop?.accountId).toBe('agent-a');
    rerender({ id: 'agent-b' });
    expect(result.current.crop).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it('원본을 받는 사이 대상이 바뀌면 창을 열지 않는다(security n3)', async () => {
    let release: (v: null) => void = () => {};
    fakeController({ fetchAvatarSource: vi.fn(() => new Promise<null>((r) => { release = r; })) });
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useAvatarEdit(vi.fn(async () => undefined), { accountId: id, avatarAttachmentId: 'att-1' }),
      { initialProps: { id: 'agent-a' } },
    );
    act(() => { result.current.openAdjust(); });
    rerender({ id: 'agent-b' });
    await act(async () => { release(null); await new Promise((r) => setTimeout(r, 20)); });
    expect(result.current.crop).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it('사진이 없으면 다시 맞출 곳이 없다', () => {
    fakeController();
    useAppStore.getState().set({ me: acc('u1', 'me') });
    render(<ProfileSettings onSignOut={() => {}} />);
    expect(screen.queryByTestId('avatar-adjust')).toBeNull();
    expect(screen.queryByTestId('avatar-adjust-photo')).toBeNull();
  });
});
