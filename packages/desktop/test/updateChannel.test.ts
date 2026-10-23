import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createAppUpdater, setAppUpdater, type AppUpdater } from '../src/lib/appUpdater';
import { setUpdateChannel, useUpdateCheck } from '../src/lib/useUpdateCheck';
import { updateChannelStorage } from '../src/lib/updateChannel';

/**
 * 업데이트 채널(Stable / Ludicrous)의 **JS 쪽 계약**. 엔드포인트는 Rust(`update_channel.rs`)가
 * 정하고 그 시험은 거기 있다 — 여기서 재는 것은 "어느 채널에 물었나 / 채널을 바꾼 뒤 앞 채널의
 * 답이 화면에 서지 않나 / 설치한 채널을 기억하나" 다.
 */

type Win = { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };

beforeEach(() => {
  localStorage.clear();
  (window as unknown as Win).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  setAppUpdater(null);
  delete (window as unknown as Win).__TAURI_INTERNALS__;
  localStorage.clear();
});

function stub(check: AppUpdater['check']): AppUpdater {
  return { check: vi.fn(check), downloadAndInstall: vi.fn(async () => {}) };
}

describe('채널 저장본', () => {
  it('기본은 Stable 이고, 모르는 값도 Stable 로 읽는다', () => {
    expect(updateChannelStorage.load()).toBe('stable');
    localStorage.setItem('harkroom.updateChannel', 'nightly');
    expect(updateChannelStorage.load()).toBe('stable');
    updateChannelStorage.save('ludicrous');
    expect(updateChannelStorage.load()).toBe('ludicrous');
  });

  it('설치한 채널은 설치하기 전까지 없다', () => {
    expect(updateChannelStorage.loadInstalled()).toBeNull();
    updateChannelStorage.saveInstalled('ludicrous');
    expect(updateChannelStorage.loadInstalled()).toBe('ludicrous');
  });
});

describe('useUpdateCheck 의 채널', () => {
  it('고른 채널로 묻고, 답한 채널을 적는다', async () => {
    updateChannelStorage.save('ludicrous');
    const u = stub(async () => ({ version: '0.4.171' }));
    setAppUpdater(u);
    const { result } = renderHook(() => useUpdateCheck());
    await waitFor(() => expect(result.current.status).toEqual({ kind: 'available', version: '0.4.171' }));
    expect(u.check).toHaveBeenCalledWith('ludicrous');
    expect(result.current.channel).toBe('ludicrous');
    expect(result.current.answeredChannel).toBe('ludicrous');
  });

  it('채널을 바꾸면 저장하고, 앞 채널의 늦은 답은 버리고, 새 채널로 다시 묻는다', async () => {
    let releaseLudicrous!: (v: { version: string }) => void;
    const u = stub((channel) => channel === 'ludicrous'
      ? new Promise((r) => { releaseLudicrous = r; })
      : Promise.resolve(null));
    updateChannelStorage.save('ludicrous');
    setAppUpdater(u);
    const { result } = renderHook(() => useUpdateCheck());
    await waitFor(() => expect(u.check).toHaveBeenCalledWith('ludicrous'));

    act(() => { expect(setUpdateChannel('stable')).toBe(true); });
    expect(updateChannelStorage.load()).toBe('stable');
    await waitFor(() => expect(result.current.status).toEqual({ kind: 'uptodate' }));
    expect(result.current.answeredChannel).toBe('stable');

    // 바꾸기 전에 나간 Ludicrous 물음이 이제야 "있다" 고 답한다 — Stable 화면에 서면 안 된다.
    await act(async () => { releaseLudicrous({ version: '0.4.171' }); await Promise.resolve(); });
    expect(result.current.status).toEqual({ kind: 'uptodate' });
    expect(result.current.answeredChannel).toBe('stable');
  });

  it('설치하는 중에는 채널을 바꾸지 않는다', async () => {
    const u: AppUpdater = {
      check: vi.fn(async () => ({ version: '0.4.171' })),
      downloadAndInstall: vi.fn(() => new Promise<void>(() => {})),
    };
    setAppUpdater(u);
    const { result } = renderHook(() => useUpdateCheck());
    await waitFor(() => expect(result.current.status.kind).toBe('available'));
    act(() => { void result.current.install('0.4.171'); });
    await waitFor(() => expect(result.current.status.kind).toBe('installing'));
    let changed = true;
    act(() => { changed = setUpdateChannel('ludicrous'); });
    expect(changed).toBe(false);
    expect(updateChannelStorage.load()).toBe('stable');
  });
});

describe('실제 표면(createAppUpdater)', () => {
  it('Rust 명령에 채널 이름만 넘기고, 설치에 성공하면 그 채널을 기억한다', async () => {
    const invoke = vi.fn(async (cmd: string) => (cmd === 'app_update_check' ? { version: '0.4.171' } : null));
    (window as unknown as Win).__TAURI_INTERNALS__ = { invoke };
    const updater = createAppUpdater();
    await expect(updater.check('ludicrous')).resolves.toEqual({ version: '0.4.171' });
    expect(invoke).toHaveBeenCalledWith('app_update_check', { channel: 'ludicrous' });

    // relaunch 는 plugin-process 를 부른다 — 여기서는 그 앞까지(설치 성공 → 채널 기록)를 잰다.
    await updater.downloadAndInstall('ludicrous', '0.4.171').catch(() => {});
    expect(invoke).toHaveBeenCalledWith('app_update_install', { channel: 'ludicrous', version: '0.4.171' });
    expect(updateChannelStorage.loadInstalled()).toBe('ludicrous');
  });

  it('Rust 가 설치를 거절하면(쥔 판이 본 판과 다르다) 채널을 기록하지 않는다', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'app_update_install') throw new Error('the update found for this channel is no longer 0.4.164 — check for updates again');
      return null;
    });
    (window as unknown as Win).__TAURI_INTERNALS__ = { invoke };
    const updater = createAppUpdater();
    await expect(updater.downloadAndInstall('stable', '0.4.164')).rejects.toThrow(/check for updates again/);
    expect(updateChannelStorage.loadInstalled()).toBeNull();
  });
});

describe('보안 검토 F1 — 늦은 앞 채널 답 뒤의 설치', () => {
  it('Stable 로 바꾼 뒤 늦은 Ludicrous 답이 와도, 설치는 화면이 본 Stable 판으로 간다', async () => {
    let releaseLudicrous!: (v: { version: string }) => void;
    const u = stub((channel) => channel === 'ludicrous'
      ? new Promise((r) => { releaseLudicrous = r; })
      : Promise.resolve({ version: '0.4.164' }));
    updateChannelStorage.save('ludicrous');
    setAppUpdater(u);
    const { result } = renderHook(() => useUpdateCheck());
    await waitFor(() => expect(u.check).toHaveBeenCalledWith('ludicrous'));

    act(() => { setUpdateChannel('stable'); });
    await waitFor(() => expect(result.current.status).toEqual({ kind: 'available', version: '0.4.164' }));
    await act(async () => { releaseLudicrous({ version: '0.4.171' }); await Promise.resolve(); });

    await act(async () => { await result.current.install('0.4.164'); });
    expect(u.downloadAndInstall).toHaveBeenCalledWith('stable', '0.4.164');
  });

  it('채널을 막 바꿔 답이 없으면 설치하지 않는다', async () => {
    const u = stub(() => new Promise(() => {}));
    setAppUpdater(u);
    const { result } = renderHook(() => useUpdateCheck());
    await act(async () => { await result.current.install('0.4.164'); });
    expect(u.downloadAndInstall).not.toHaveBeenCalled();
    expect(result.current.status.kind).toBe('failed');
  });
});
