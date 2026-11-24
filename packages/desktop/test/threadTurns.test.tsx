import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { notifyThreadTurnsChanged, THREAD_TURNS_SIGNAL_MS, useThreadTurns, type AskThreadTurns } from '../src/lib/threadTurns';

function Probe({ ask, rootId }: { ask: AskThreadTurns | null; rootId: string }) {
  const s = useThreadTurns(ask, rootId);
  return <span data-testid="s">{s.kind === 'known' ? `known:${s.turns.length}` : s.kind}</span>;
}
const text = () => screen.getByTestId('s').textContent;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
/** 신호를 묶는 창을 넘긴다 — 신호는 그 창이 지난 뒤 한 번 읽는다. */
const pastSignalWindow = () => act(async () => { await vi.advanceTimersByTimeAsync(THREAD_TURNS_SIGNAL_MS); });

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('useThreadTurns', () => {
  it('처음 한 번 읽고, 신호가 오면 그 스레드만 다시 읽는다', async () => {
    vi.useFakeTimers();
    let n = 1;
    const ask = vi.fn(async () => Array.from({ length: n }, () => ({ agentAccountId: 'a', startedAt: null })));
    render(<Probe ask={ask} rootId="r1" />);
    expect(text()).toBe('checking');
    await flush();
    expect(text()).toBe('known:1');
    n = 2;
    act(() => notifyThreadTurnsChanged('other'));
    await pastSignalWindow();
    expect(ask).toHaveBeenCalledTimes(1);
    act(() => notifyThreadTurnsChanged('r1'));
    await pastSignalWindow();
    expect(text()).toBe('known:2');
  });

  it('줄지어 온 신호는 묶어서 한 번만 읽는다', async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => []);
    render(<Probe ask={ask} rootId="r1" />);
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    act(() => { for (let i = 0; i < 5; i += 1) notifyThreadTurnsChanged('r1'); });
    await flush();
    // 창이 지나기 전에는 읽지 않는다.
    expect(ask).toHaveBeenCalledTimes(1);
    await pastSignalWindow();
    expect(ask).toHaveBeenCalledTimes(2);
    // 창이 닫힌 뒤의 신호는 다음 창을 연다.
    act(() => notifyThreadTurnsChanged('r1'));
    await pastSignalWindow();
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('못 읽으면 모름이고, 읽는 길이 없으면(404) 꺼짐으로 두고 다시 묻지 않는다', async () => {
    const failing = vi.fn(async () => { throw new Error('net'); });
    const { unmount } = render(<Probe ask={failing} rootId="r1" />);
    await flush();
    expect(text()).toBe('unknown');
    unmount();
    const missing = vi.fn(async () => { throw Object.assign(new Error('nf'), { status: 404 }); });
    render(<Probe ask={missing} rootId="r1" />);
    await flush();
    expect(text()).toBe('off');
    vi.useFakeTimers();
    act(() => notifyThreadTurnsChanged('r1'));
    await pastSignalWindow();
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('묻는 길이 없으면(끊김) 묻지 않는다', async () => {
    render(<Probe ask={null} rootId="r1" />);
    await flush();
    expect(text()).toBe('checking');
  });
});
