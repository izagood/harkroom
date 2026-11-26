/**
 * 안 A(#2576) 끊김 카드 — 클릭이 필요한 두 장면을 시험으로 잰다(실물 번들에서는 화면 자동 조작을 쓰지 않았다).
 * ① 설정 › 에이전트 격자의 빨간 칩 → 접어 둔 카드가 다시 펴지고 초점을 받는다.
 * ② [지금 다시 시도] 누른 뒤 — 「다시 시도하는 중…」은 거절이 곧바로 와도 최소 1.5초 남는다(designer 실물 지적).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import type { AgentView } from '@harkroom/shared';
import type { ServerLinkState } from '@harkroom/shared/daemonProtocol';
import { usePrefsStore } from '../src/state/prefsStore';
import { useOperatorLinkStore } from '../src/state/operatorLinkStore';
import { AgentGrid } from '../src/components/settings/AgentGrid';

const retryNow = vi.fn<(c?: string | null) => Promise<boolean>>();
vi.mock('../src/lib/operatorLink', async (orig) => ({
  ...(await orig<typeof import('../src/lib/operatorLink')>()),
  retryOperatorLinkNow: (c?: string | null) => retryNow(c),
}));
const { useOperatorLinkCard } = await import('../src/components/OperatorLinkCard');
const { retryUnlockDelayMs, RETRY_MIN_SHOW_MS } = await import('../src/lib/operatorLink');
type View = import('../src/components/OperatorLinkCard').OperatorLinkView;

const T0 = 1_800_000_000_000;
const down = (attempts: number): ServerLinkState => ({
  state: 'down', reason: 'refused', closeCode: null, host: 'one.example.com',
  downSinceMs: T0 - 6 * 60_000, lastUpMs: null, attempts, nextRetryAtMs: null,
});
const view = (link: ServerLinkState, localAgentIds: string[] = []): View => ({
  link, phase: 'long', back: null, localAgentIds, community: 'https://one.example.com', clearBack: () => undefined,
});
function Card({ v }: { v: View }) { return useOperatorLinkCard(v, () => undefined); }

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  retryNow.mockReset();
  useOperatorLinkStore.setState({ phase: 'ok', localAgentIds: [], focusSeq: 0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  usePrefsStore.getState().setLocale('system');
});

describe('retryUnlockDelayMs', () => {
  it('누른 지 50ms 만에 새 상태가 와도 1.5초까지 남은 만큼 기다린다', () => {
    expect(retryUnlockDelayMs(T0, T0 + 50, down(16))).toBe(RETRY_MIN_SHOW_MS - 50);
  });
  it('1.5초가 지났으면 곧바로 푼다', () => {
    expect(retryUnlockDelayMs(T0, T0 + 2_000, down(16))).toBe(0);
  });
  it('다시 붙었으면(up) 기다리지 않는다', () => {
    expect(retryUnlockDelayMs(T0, T0 + 10, { ...down(0), state: 'up' })).toBe(0);
  });
});

describe('[지금 다시 시도] 누른 뒤', () => {
  it('거절이 곧바로 와도 「다시 시도하는 중…」이 1.5초 남고 그 뒤 풀린다', async () => {
    vi.useFakeTimers({ now: T0 });
    retryNow.mockResolvedValue(true);
    const { rerender } = render(<Card v={view(down(15))} />);
    const btn = () => screen.getByTestId('op-link-retry-now') as HTMLButtonElement;
    expect(btn().disabled).toBe(false);
    fireEvent.click(btn());
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toBe('다시 시도하는 중…');
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    rerender(<Card v={view(down(16))} />); // 거절이 수십 ms 안에 왔다
    await act(async () => { await vi.advanceTimersByTimeAsync(1_300); });
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toBe('다시 시도하는 중…');
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(btn().disabled).toBe(false);
    expect(btn().textContent).toBe('지금 다시 시도');
  });

  it('새 상태가 안 오면 5초에 푼다', async () => {
    vi.useFakeTimers({ now: T0 });
    retryNow.mockResolvedValue(true);
    render(<Card v={view(down(15))} />);
    fireEvent.click(screen.getByTestId('op-link-retry-now'));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_900); });
    expect((screen.getByTestId('op-link-retry-now') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect((screen.getByTestId('op-link-retry-now') as HTMLButtonElement).disabled).toBe(false);
  });

  it('retried:false(이미 붙었거나 표면 없음)면 곧바로 푼다', async () => {
    retryNow.mockResolvedValue(false);
    render(<Card v={view(down(15))} />);
    fireEvent.click(screen.getByTestId('op-link-retry-now'));
    await waitFor(() => expect((screen.getByTestId('op-link-retry-now') as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('설정 › 에이전트 격자의 빨간 칩 → 카드', () => {
  const agent: AgentView = {
    id: 'id-alpha', handle: 'alpha', displayName: 'alpha', kind: 'agent', isAdmin: false, role: 'member', assignment: null,
    invokeScope: 'community', credentialScope: 'none', invokers: [], delegates: [], mcpServers: [], instructions: '',
    harness: 'claude-code', model: null, effort: null, workingDir: null, mentionPermission: 'auto', ownerAccountId: null,
    disabled: false, deleted: false, runnerVersion: null, stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
    status: 'available', statusText: null, avatarAttachmentId: null,
  } as AgentView;

  it('[나중에]로 접은 카드가 칩을 누르면 다시 펴지고 초점을 받는다', async () => {
    useOperatorLinkStore.setState({ phase: 'long', localAgentIds: ['id-alpha'] });
    render(
      <>
        <Card v={view(down(15), ['id-alpha'])} />
        <AgentGrid agents={[agent]} selectedId={null} runnerStates={{}} online={[]} connected
          onPick={vi.fn()} onCreate={vi.fn()} canCreate />
      </>,
    );
    fireEvent.click(screen.getByTestId('op-link-later'));
    expect(screen.queryByTestId('op-link-long')).toBeNull();
    const chip = screen.getByTestId('agent-link-alpha');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.textContent).toBe('멈춤 · 연결 끊김');
    fireEvent.click(chip);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('op-link-long')));
  });
});
