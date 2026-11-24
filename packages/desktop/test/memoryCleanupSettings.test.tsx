/** 「매일 기억 정리」 설정 — 워크스페이스 묶음과 에이전트 「자동 정리」 카드. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { ApiError } from '../src/lib/api';
import { AgentMemoryCleanup } from '../src/components/settings/AgentMemoryCleanup';
import { WorkspaceMemoryCleanup } from '../src/components/settings/WorkspaceMemoryCleanup';
import { nextWindow, pausedKinds, validTime, validTz, windowText, type AgentBackground, type BackgroundRun } from '../src/lib/memoryCleanupSettings';

const ws = { enabled: true, time: '03:00', tz: 'Asia/Seoul' };
const run = (over: Partial<BackgroundRun> = {}): BackgroundRun => ({
  id: 'r1', kind: 'cleanup', status: 'done', summary: '합침', error: null, changes: 2,
  createdAt: '2026-11-20T18:00:00Z', finishedAt: '2026-11-20T18:05:00Z', revertedAt: null, ...over,
});
const bg = (over: Partial<AgentBackground> = {}): AgentBackground => ({ enabled: false, paused: [], serverEnabled: true, runs: [run()], ...over });
const fake = (over: Record<string, unknown> = {}) => {
  const c = {
    memoryCleanupSchedule: vi.fn(async () => ws),
    setMemoryCleanupSchedule: vi.fn(async (s: typeof ws) => s),
    agentMemoryCleanup: vi.fn(async () => ({ enabled: true, workspace: ws })),
    setAgentMemoryCleanup: vi.fn(async () => ({ ok: true, enabled: false })),
    agentBackground: vi.fn(async () => bg()),
    setAgentBackground: vi.fn(async () => ({ ok: true, enabled: true })),
    agentBackgroundRun: vi.fn(async () => [{ slug: 'mem/sample/tone', ops: ['merge'] }]),
    revertAgentBackgroundRun: vi.fn(async () => ({ reverted: ['a'], skipped: [{ slug: 'mem/sample/x', reason: 'changed_since' }] })),
    ...over,
  };
  setController(c as unknown as Controller);
  return c;
};
const card = (over: Partial<Parameters<typeof AgentMemoryCleanup>[0]> = {}) => render(
  <AgentMemoryCleanup agentId="a1" harness="claude-code" apiKey={false} archived={0} onReverted={vi.fn()} {...over} />);

beforeEach(() => { usePrefsStore.getState().setLocale('ko'); });
afterEach(() => { cleanup(); setController(null as unknown as Controller); });

describe('판정', () => {
  it('시각·시간대', () => {
    expect(['00:00', '23:59'].every(validTime)).toBe(true);
    expect(['24:00', '3:00', '03:60', ''].some(validTime)).toBe(false);
    expect(['Asia/Seoul', 'UTC', 'Asia/Kolkata'].every(validTz)).toBe(true);
    expect(['Asia/Seol', '+09:00', ''].some(validTz)).toBe(false);
    expect(windowText('23:00')).toBe('23:00–01:00');
  });
  it('다음 창 — 창 안이면 오늘, 지났으면 내일, 보는 사람 시각', () => {
    const at = (iso: string) => nextWindow(ws, Date.parse(iso), 'Asia/Seoul')!;
    expect(new Date(at('2026-11-24T19:30:00Z').day).toISOString().slice(0, 10)).toBe('2026-11-25');
    expect(new Date(at('2026-11-24T20:30:00Z').day).toISOString().slice(0, 10)).toBe('2026-11-26');
    expect(at('2026-11-24T19:30:00Z').local).toBeNull();
    expect(nextWindow(ws, Date.parse('2026-11-24T10:00:00Z'), 'UTC')!.local).toBe('18:00–20:00');
  });
  it('멈춤은 매일 정리를 뺀다', () => {
    expect(pausedKinds(['cleanup', 'organize'])).toEqual(['organize']);
  });
});

describe('워크스페이스', () => {
  it('admin 이 아니면 묻지 않고 그 사실을 말한다', () => {
    const c = fake();
    render(<WorkspaceMemoryCleanup isAdmin={false} />);
    expect(screen.getByText('매일 기억 정리 시각은 워크스페이스 관리자만 바꿉니다.')).toBeTruthy();
    expect(c.memoryCleanupSchedule).not.toHaveBeenCalled();
  });
  it('스위치는 저장된 시각으로 바로, 잘못된 시간대는 저장 단추를 막는다', async () => {
    const c = fake();
    render(<WorkspaceMemoryCleanup isAdmin />);
    fireEvent.change(await screen.findByDisplayValue('Asia/Seoul'), { target: { value: 'Asia/Seol' } });
    expect((screen.getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('ws-memory-cleanup'));
    await waitFor(() => expect(c.setMemoryCleanupSchedule).toHaveBeenCalledWith({ ...ws, enabled: false }));
  });
  it('서버가 시간대를 거절하면 그 칸에 표시한다', async () => {
    fake({ setMemoryCleanupSchedule: vi.fn(async () => { throw new ApiError(400, 'bad_tz', 'x'); }) });
    render(<WorkspaceMemoryCleanup isAdmin />);
    const tz = await screen.findByDisplayValue('Asia/Seoul');
    fireEvent.change(tz, { target: { value: 'Asia/Tokyo' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect((await screen.findByRole('alert')).textContent).toContain('서버가 이 시각·시간대를');
    expect(tz.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByDisplayValue('03:00').getAttribute('aria-invalid')).toBe('false');
  });
  it('옛 서버(404)에서는 그리지 않는다', async () => {
    const c = fake({ memoryCleanupSchedule: vi.fn(async () => { throw new ApiError(404, 'not_found', 'x'); }) });
    const { container } = render(<WorkspaceMemoryCleanup isAdmin />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
    expect(c.setMemoryCleanupSchedule).not.toHaveBeenCalled();
  });
});

describe('에이전트 카드', () => {
  it('옛 서버(404)에서는 그리지 않고, 다른 실패는 다시 불러오기를 준다', async () => {
    fake({ agentMemoryCleanup: vi.fn(async () => { throw new ApiError(404, 'not_found', 'x'); }) });
    const { container } = card();
    await waitFor(() => expect(container.innerHTML).toBe(''));
    cleanup();
    fake({ agentBackground: vi.fn(async () => { throw new ApiError(500, 'internal', 'x'); }) });
    card();
    expect((await screen.findByRole('alert')).textContent).toBe('자동 정리 설정을 불러오지 못했습니다.');
    expect(screen.getByRole('button', { name: '다시 불러오기' })).toBeTruthy();
  });
  it('workspace 칸이 없는 서버에서는 그 줄만 빠진다', async () => {
    fake({ agentMemoryCleanup: vi.fn(async () => ({ enabled: true })) });
    card();
    await screen.findByTestId('agent-memory-cleanup');
    expect(screen.queryByText(/^워크스페이스: 매일/)).toBeNull();
  });
  it('보관 270 은 줄 없음, 271 은 줄 있음', async () => {
    fake();
    const { rerender } = card({ archived: 270 });
    await screen.findByTestId('agent-memory-cleanup');
    expect(screen.queryByTestId('memory-archive-near')).toBeNull();
    rerender(<AgentMemoryCleanup agentId="a1" harness="claude-code" apiKey={false} archived={271} onReverted={vi.fn()} />);
    expect(screen.getByTestId('memory-archive-near').textContent).toBe('보관 271/300 · 곧 오래된 것부터 지워집니다');
  });
  it('저장이 실패하면 스위치를 되돌린다', async () => {
    fake({ setAgentMemoryCleanup: vi.fn(async () => { throw new Error('x'); }) });
    card();
    const sw = await screen.findByTestId('agent-memory-cleanup') as HTMLInputElement;
    fireEvent.click(sw);
    expect((await screen.findByRole('alert')).textContent).toContain('원래대로');
    expect(sw.checked).toBe(true);
  });
  it('대상이 아닌 에이전트는 두 스위치가 잠긴다', async () => {
    fake();
    card({ apiKey: true });
    expect((await screen.findByTestId('agent-memory-cleanup') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('agent-background') as HTMLInputElement).disabled).toBe(true);
  });
  it('서버에서 꺼짐은 증류 쪽만 잠근다', async () => {
    fake({ agentBackground: vi.fn(async () => bg({ serverEnabled: false, enabled: true, paused: ['cleanup'] })) });
    card();
    expect((await screen.findByTestId('agent-background') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('agent-memory-cleanup') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText(/3번 연속 실패/)).toBeNull();
  });
  it('되돌리기는 확인 뒤에 부르고 건너뛴 까닭을 말한다', async () => {
    const c = fake();
    const onReverted = vi.fn();
    card({ onReverted });
    fireEvent.click(await screen.findByRole('button', { name: '되돌리기' }));
    expect(c.revertAgentBackgroundRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: '되돌리기' }).at(-1)!);
    expect(await screen.findByText('그 뒤 다시 고침')).toBeTruthy();
    expect(screen.getByText('되돌림 · 1개 되돌림 · 1개 건너뜀')).toBeTruthy();
    expect(onReverted).toHaveBeenCalledOnce();
  });
  it('도는 회차는 되돌리기가 잠기고, 이미 되돌린 회차는 단추가 없다', async () => {
    fake({ agentBackground: vi.fn(async () => bg({ runs: [run({ status: 'running', finishedAt: null }), run({ id: 'r2', revertedAt: '2026-11-21T00:00:00Z' })] })) });
    card();
    const buttons = await screen.findAllByRole('button', { name: '되돌리기' }) as HTMLButtonElement[];
    expect(buttons.map((b) => b.disabled)).toEqual([true]);
    expect(screen.getByText('되돌림')).toBeTruthy();
  });
});
