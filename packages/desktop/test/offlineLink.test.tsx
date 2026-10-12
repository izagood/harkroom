// **끊긴 동안의 화면** (A3, designer 시안 ①·③·⑤, jaebin D1·D2·D4 「추천대로」, 2026-10-12).
//
// 이 파일이 재는 것: (1) 컨트롤러의 연결 국면(`link`) — 끊긴 지 3초 뒤에만 `offline`, 짧은 끊김은
// 조용히, 다시 붙으면 맞추기가 끝날 때까지 `resyncing`, 실패하면 `resyncFailed` 와 [다시]
// (2) 그 국면을 그리는 띠 (3) 끊긴 동안 작성창은 쓰기는 그대로·보내기만 잠긴다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore, resetCommunityRegistry } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { ConnectionBanner } from '../src/components/ConnectionBanner';
import { Composer } from '../src/components/Composer';
import { undoSendStorage } from '../src/lib/prefs';
import { acc, fakeApi, fakeWsFactory } from './helpers/fakeApi';

beforeEach(() => {
  resetCommunityRegistry();
  useAppStore.getState().reset();
  usePrefsStore.getState().setLocale('ko');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  usePrefsStore.getState().setLocale('system');
});

async function boot(over: Parameters<typeof fakeApi>[0] = {}) {
  const { makeWs, callbacks } = fakeWsFactory();
  const c = new Controller(fakeApi(over), makeWs);
  await c.start();
  return { c, ws: () => callbacks.current! };
}
const link = () => useAppStore.getState().link;

describe('연결 국면(link)', () => {
  it('붙은 적 없는 기동 중의 끊김은 띠가 아니다', async () => {
    vi.useFakeTimers();
    const { ws } = await boot();
    ws().onDown('network');
    await vi.advanceTimersByTimeAsync(Controller.OFFLINE_DELAY_MS + 100);
    expect(link()).toBe('online');
  });

  it('끊긴 지 3초가 지나야 offline 이다 — 짧은 끊김은 조용하다', async () => {
    vi.useFakeTimers();
    const { ws } = await boot();
    ws().onOpen();
    ws().onDown('network');
    await vi.advanceTimersByTimeAsync(Controller.OFFLINE_DELAY_MS - 1);
    expect(link()).toBe('online');
    // 3초 안에 다시 붙으면 초록 띠도 세우지 않는다.
    ws().onOpen();
    await vi.advanceTimersByTimeAsync(Controller.OFFLINE_DELAY_MS);
    expect(link()).toBe('online');
    ws().onDown('network');
    await vi.advanceTimersByTimeAsync(Controller.OFFLINE_DELAY_MS);
    expect(link()).toBe('offline');
  });

  it('다시 붙으면 맞추기가 끝날 때까지 resyncing, 끝나면 online', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const leases = vi.fn(async () => []);
    const { ws } = await boot({ leases });
    ws().onOpen();
    ws().onDown('network');
    await vi.advanceTimersByTimeAsync(Controller.OFFLINE_DELAY_MS);
    leases.mockImplementation(async () => { await gate; return []; });
    ws().onOpen();
    expect(link()).toBe('resyncing');
    await vi.advanceTimersByTimeAsync(10);
    expect(link()).toBe('resyncing');
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(link()).toBe('online');
  });

  it('맞추기가 실패하면 resyncFailed 로 남고, [다시]가 성공하면 online', async () => {
    vi.useFakeTimers();
    const leases = vi.fn(async () => []);
    const { c, ws } = await boot({ leases });
    ws().onOpen();
    ws().onDown('network');
    await vi.advanceTimersByTimeAsync(Controller.OFFLINE_DELAY_MS);
    leases.mockRejectedValueOnce(new Error('boom'));
    ws().onOpen();
    await vi.advanceTimersByTimeAsync(10);
    expect(link()).toBe('resyncFailed');
    c.retryResync();
    expect(link()).toBe('resyncing');
    await vi.advanceTimersByTimeAsync(10);
    expect(link()).toBe('online');
  });

  it('띠가 선 뒤 맞추는 도중 다시 끊기면 기다리지 않고 offline 으로 돌아간다', async () => {
    vi.useFakeTimers();
    const leases = vi.fn(async () => []);
    const { ws } = await boot({ leases });
    ws().onOpen();
    ws().onDown('network');
    await vi.advanceTimersByTimeAsync(Controller.OFFLINE_DELAY_MS);
    leases.mockImplementation(() => new Promise(() => {}));
    ws().onOpen();
    expect(link()).toBe('resyncing');
    ws().onDown('network');
    expect(link()).toBe('offline');
  });
});

describe('끊김 띠', () => {
  const show = (l: 'online' | 'offline' | 'resyncing' | 'resyncFailed') => {
    useAppStore.getState().set({ link: l });
    return render(<ConnectionBanner />);
  };
  it('online 이면 아무것도 없다', () => {
    show('online');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('offline — 주의색 띠, 닫기 없음', () => {
    show('offline');
    const strip = screen.getByTestId('strip-link-offline');
    expect(strip.textContent).toContain('서버와 끊겼다');
    expect(strip.textContent).toContain('받아 둔 내용만 보인다');
    expect(strip.textContent).toContain('다시 연결하는 중');
    expect(strip.querySelector('button')).toBeNull();
  });
  it('resyncing — 초록 띠, 새 글 수는 쓰지 않는다', () => {
    show('resyncing');
    const strip = screen.getByTestId('strip-link-resyncing');
    expect(strip.textContent).toContain('다시 연결됐다');
    expect(strip.textContent).not.toMatch(/\d/);
  });
  it('resyncFailed — [다시]가 맞추기를 다시 부른다', () => {
    const retryResync = vi.fn();
    setController({ retryResync } as unknown as Controller);
    show('resyncFailed');
    fireEvent.click(screen.getByTestId('link-resync-retry'));
    expect(retryResync).toHaveBeenCalled();
  });
});

describe('끊긴 동안 작성창', () => {
  beforeEach(() => {
    undoSendStorage.saveWindowMs(0);
    useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') }, activeChannelId: 'c1' });
    setController({ notifyTyping: vi.fn(), send: vi.fn(async () => undefined) } as unknown as Controller);
  });
  const type = (text: string) => {
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: text, selectionStart: text.length } });
    return box;
  };

  it('쓰기는 그대로, 보내기만 잠그고 사유를 아래에 적는다 — Enter 도 보내지 않는다', () => {
    useAppStore.getState().set({ link: 'offline' });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" />);
    const box = type('끊긴 동안 적어 둔 글');
    expect((box as HTMLTextAreaElement).value).toBe('끊긴 동안 적어 둔 글');
    expect((screen.getByRole('button', { name: /보내기|send/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('composer-offline-hint').textContent).toBe('끊겨 있어 보낼 수 없다 — 쓴 글은 그대로 둔다');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe('끊긴 동안 적어 둔 글');
  });

  it('다시 붙어 맞추는 중(resyncing)에는 보낼 수 있다 — 소켓은 붙어 있다', () => {
    useAppStore.getState().set({ link: 'resyncing' });
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    type('글');
    expect(screen.queryByTestId('composer-offline-hint')).toBeNull();
    expect((screen.getByRole('button', { name: /보내기|send/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('붙으면 잠금이 풀린다', () => {
    useAppStore.getState().set({ link: 'offline' });
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    type('글');
    act(() => { useAppStore.getState().set({ link: 'online' }); });
    expect(screen.queryByTestId('composer-offline-hint')).toBeNull();
    expect((screen.getByRole('button', { name: /보내기|send/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
