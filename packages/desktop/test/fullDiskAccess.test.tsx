// 전체 디스크 접근 안내(소유자 결정 2026-10-29 · security S1·S2): 한 번만 묻기 · 같은 무게 두 버튼 · 숨기지 않는 문구 ·
// 다시 시작 띠는 「켜졌는데 이 프로세스가 아직 막혔을 때」만.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FullDiskAccessDialog } from '../src/components/FullDiskAccessDialog';
import { FullDiskAccessHost } from '../src/components/FullDiskAccessHost';
import { fdaPromptStorage, setFdaSurface, shouldPrompt, type FdaStatus, type FdaSurface } from '../src/lib/fullDiskAccess';
import { en } from '../src/i18n/en';
import { ko } from '../src/i18n/ko';
import { ThisOperatorSettings } from '../src/components/settings/ThisOperatorSettings';
import { setController, type Controller } from '../src/state/controller';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { acc } from './helpers/fakeApi';

function fakeSurface(initial: FdaStatus): FdaSurface & { set(s: FdaStatus): void } {
  let now = initial;
  return {
    set(s) { now = s; },
    status: vi.fn(async () => now),
    openSettings: vi.fn(async () => {}),
    revealApp: vi.fn(async () => {}),
    relaunch: vi.fn(async () => {}),
  };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); setFdaSurface(null); });

describe('shouldPrompt', () => {
  it('없다고 확인됐고 이 기기에서 처음일 때만 묻는다 — 모르면 권하지 않는다', () => {
    expect(shouldPrompt('off', false)).toBe(true);
    expect(shouldPrompt('off', true)).toBe(false);
    for (const s of ['on', 'restart', 'unknown', 'unsupported'] as const) expect(shouldPrompt(s, false)).toBe(false);
  });
});

describe('FullDiskAccessDialog', () => {
  it('두 버튼은 같은 모양이고 처음 포커스는 [지금은 안 함]이다 (S2)', () => {
    setFdaSurface(fakeSurface('off'));
    render(<FullDiskAccessDialog status="off" onClose={() => {}} />);
    const notNow = screen.getByTestId('fda-not-now');
    const open = screen.getByTestId('fda-open-settings');
    expect(notNow.className).toBe(open.className);
    expect(open.className).not.toContain('bg-accent');
    expect(document.activeElement).toBe(notNow);
  });

  it('경고 상자는 읽고 바꿀 수 있음·다른 멤버의 턴을 숨기지 않고, 끌 수 있음·없어도 작동함을 적는다 (S1)', () => {
    for (const cat of [ko, en]) {
      expect(cat['fda.risk']).toMatch(/읽고 바꿀|read and change/);
      expect(cat['fda.members']).toMatch(/다른 멤버|other members/);
      expect(cat['fda.later']).toMatch(/언제든 끌|turn it off any time/);
      expect(cat['fda.later']).toMatch(/그대로 작동|works without it/);
      expect(`${cat['fda.title']}${cat['fda.openSettings']}`).not.toMatch(/권장|필수|recommend|required/i);
    }
    setFdaSurface(fakeSurface('off'));
    render(<FullDiskAccessDialog status="off" onClose={() => {}} />);
    const box = screen.getByTestId('fda-risk');
    expect(box.textContent).toContain(en['fda.risk']);
    expect(box.textContent).toContain(en['fda.members']);
  });

  it('[시스템 설정 열기] 뒤 창을 닫지 않고 기다림으로 바뀐다', async () => {
    const surface = fakeSurface('off');
    setFdaSurface(surface);
    render(<FullDiskAccessDialog status="off" onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('fda-open-settings'));
    await waitFor(() => expect(screen.getByTestId('fda-dialog').dataset.phase).toBe('waiting'));
    expect(surface.openSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('fda-reveal-app'));
    await waitFor(() => expect(surface.revealApp).toHaveBeenCalledTimes(1));
  });

  it('켜짐이면 [확인] 하나, 켜졌는데 다시 시작해야 하면 그때만 다시 시작 버튼', () => {
    setFdaSurface(fakeSurface('on'));
    const { rerender } = render(<FullDiskAccessDialog status="on" onClose={() => {}} />);
    expect(screen.getByTestId('fda-done')).toBeTruthy();
    expect(screen.queryByTestId('fda-restart-now')).toBeNull();
    rerender(<FullDiskAccessDialog status="restart" onClose={() => {}} />);
    expect(screen.getByTestId('fda-restart-note')).toBeTruthy();
    expect(screen.getByTestId('fda-restart-now')).toBeTruthy();
  });
});

describe('FullDiskAccessDialog 포커스·넘침 (designer #1695)', () => {
  it('단계가 바뀌면 물러서는 쪽 버튼에 포커스를 다시 준다', async () => {
    setFdaSurface(fakeSurface('off'));
    const { rerender } = render(<FullDiskAccessDialog status="off" onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('fda-open-settings'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('fda-close')));
    rerender(<FullDiskAccessDialog status="restart" onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByTestId('fda-restart-later'));
    rerender(<FullDiskAccessDialog status="on" onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByTestId('fda-done'));
  });

  it('본문이 창보다 길면 안에서 스크롤된다 — 버튼 줄이 잘리지 않게', () => {
    setFdaSurface(fakeSurface('off'));
    render(<FullDiskAccessDialog status="off" onClose={() => {}} />);
    const body = screen.getByTestId('fda-dialog');
    expect(body.className).toContain('min-h-0');
    expect(body.className).toContain('overflow-y-auto');
  });
});

describe('FullDiskAccessHost', () => {
  it('권한이 없으면 한 번 띄우고, 다음 실행에는 띄우지 않는다', async () => {
    setFdaSurface(fakeSurface('off'));
    render(<FullDiskAccessHost />);
    await waitFor(() => expect(screen.getByTestId('fda-dialog')).toBeTruthy());
    expect(fdaPromptStorage.wasShown()).toBe(true);
    fireEvent.click(screen.getByTestId('fda-not-now'));
    expect(screen.queryByTestId('fda-dialog')).toBeNull();
    cleanup();
    render(<FullDiskAccessHost />);
    await act(async () => {});
    expect(screen.queryByTestId('fda-dialog')).toBeNull();
  });

  it('켜져 있거나 모르면 묻지 않는다', async () => {
    for (const s of ['on', 'unknown', 'unsupported'] as const) {
      setFdaSurface(fakeSurface(s));
      render(<FullDiskAccessHost />);
      await act(async () => {});
      expect(screen.queryByTestId('fda-dialog')).toBeNull();
      expect(screen.queryByTestId('fda-restart-band')).toBeNull();
      cleanup();
    }
    expect(fdaPromptStorage.wasShown()).toBe(false);
  });

  it('다시 시작 띠는 restart 일 때만 서고, 포커스로 켜짐이 읽히면 내려간다', async () => {
    fdaPromptStorage.markShown();
    const surface = fakeSurface('restart');
    setFdaSurface(surface);
    render(<FullDiskAccessHost />);
    await waitFor(() => expect(screen.getByTestId('fda-restart-band')).toBeTruthy());
    fireEvent.click(screen.getByTestId('fda-band-restart'));
    await waitFor(() => expect(surface.relaunch).toHaveBeenCalledTimes(1));
    surface.set('on');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.queryByTestId('fda-restart-band')).toBeNull());
  });

  it('[나중에]는 띠만 접는다', async () => {
    fdaPromptStorage.markShown();
    setFdaSurface(fakeSurface('restart'));
    render(<FullDiskAccessHost />);
    await waitFor(() => expect(screen.getByTestId('fda-restart-band')).toBeTruthy());
    fireEvent.click(screen.getByTestId('fda-band-later'));
    expect(screen.queryByTestId('fda-restart-band')).toBeNull();
  });
});

describe('설정 › 이 머신의 오퍼레이터 「macOS 권한」 줄', () => {
  beforeEach(() => {
    setController({ api: { baseUrl: 'https://example.com' }, operators: vi.fn(async () => []) } as unknown as Controller);
    useAppStore.getState().reset();
    useAppStore.getState().set({ me: acc('u1', 'me') });
  });

  it('꺼짐이면 [켜는 법 보기]로 같은 안내 창을 다시 연다 — 다시 묻는 길은 여기 하나', async () => {
    setFdaSurface(fakeSurface('off'));
    render(<ThisOperatorSettings />);
    const row = await screen.findByTestId('fda-row');
    expect(row.dataset.state).toBe('off');
    fireEvent.click(screen.getByTestId('fda-how-to'));
    expect(screen.getByTestId('fda-dialog').dataset.phase).toBe('intro');
  });

  it('켜짐·다시 시작 필요는 칩과 둘째 줄로 말하고, 지원하지 않는 곳은 묶음째 숨긴다', async () => {
    setFdaSurface(fakeSurface('on'));
    const { unmount } = render(<ThisOperatorSettings />);
    expect((await screen.findByTestId('fda-row')).textContent).toContain(en['fda.row.on']);
    expect(screen.getByTestId('fda-turn-off')).toBeTruthy();
    unmount();
    const surface = fakeSurface('restart');
    setFdaSurface(surface);
    const second = render(<ThisOperatorSettings />);
    fireEvent.click(await screen.findByTestId('fda-row-restart'));
    await waitFor(() => expect(surface.relaunch).toHaveBeenCalledTimes(1));
    second.unmount();
    setFdaSurface(fakeSurface('unsupported'));
    render(<ThisOperatorSettings />);
    await act(async () => {});
    expect(screen.queryByTestId('fda-row')).toBeNull();
  });
});
