/** 계획판 컨트롤러(architect R1·R3) — 이벤트는 판을 받지 않는다 · 지우면 들고 있던 판을 버린다 · 옛 응답은 updatedAt 으로 버린다. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ThreadPlanView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi, msg } from './helpers/fakeApi';

const feed = (c: Controller, e: unknown) => (c as unknown as { handleEvent: (e: unknown) => void }).handleEvent(e);
const P = { done: 1, total: 2, active: 0, blocked: 0, waiting: 0 };
const plan = (rev: number, updatedAt: string, goal = 'g'): ThreadPlanView => ({
  rootId: 'r1', channelId: 'c1', rev, updatedAt, updatedBy: null, flagged: null,
  doc: { goal, groups: [], steps: [] }, derived: {}, progress: P, linked: [],
} as unknown as ThreadPlanView);

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') }, activeChannelId: 'c1' });
  useAppStore.getState().upsertMessages('c1', [msg('r1', 'c1', 1, '부탁', 'u1', { planProgress: { ...P, rev: 5 } })]);
});
afterEach(() => setController(null));

describe('계획판 컨트롤러', () => {
  it('R1: thread.plan.changed 는 칩만 바꾸고 판을 받지 않는다', () => {
    const threadPlan = vi.fn(async () => plan(6, '2026-11-03T01:00:00.000Z'));
    const c = new Controller(fakeApi({ threadPlan } as never));
    useAppStore.getState().set({ threadPlans: { r1: plan(5, '2026-11-03T00:00:00.000Z') } });
    feed(c, { type: 'thread.plan.changed', channelId: 'c1', rootId: 'r1', rev: 6, progress: { ...P, done: 2 }, audience: 'all' });
    expect(threadPlan).not.toHaveBeenCalled();
    expect(useAppStore.getState().messages['c1']![0]!.planProgress).toEqual({ ...P, done: 2, rev: 6 });
  });

  it('R3: 지우기(rev null)가 오면 들고 있던 판을 버린다 — 다시 세운 rev 1 판을 옛 판이 가리지 않게', () => {
    const c = new Controller(fakeApi());
    useAppStore.getState().set({ threadPlans: { r1: plan(5, '2026-11-03T00:00:00.000Z') } });
    feed(c, { type: 'thread.plan.changed', channelId: 'c1', rootId: 'r1', rev: null, progress: null, audience: 'all' });
    expect(useAppStore.getState().threadPlans.r1).toBeUndefined();
    expect(useAppStore.getState().messages['c1']![0]!.planProgress).toBeNull();
  });

  it('R3: 옛 응답은 updatedAt 으로 버린다 — 다시 세운 판(rev 1, 더 늦음)은 받고, 늦게 온 옛 판은 버린다', async () => {
    const reborn = plan(1, '2026-11-03T02:00:00.000Z', '다시 세움');
    const c = new Controller(fakeApi({ threadPlan: vi.fn(async () => reborn) } as never));
    useAppStore.getState().set({ threadPlans: { r1: plan(5, '2026-11-03T00:00:00.000Z') } });
    await c.loadThreadPlan('r1');
    expect(useAppStore.getState().threadPlans.r1?.doc.goal).toBe('다시 세움');
    const late = new Controller(fakeApi({ threadPlan: vi.fn(async () => plan(5, '2026-11-03T00:00:00.000Z', '옛')) } as never));
    await late.loadThreadPlan('r1');
    expect(useAppStore.getState().threadPlans.r1?.doc.goal).toBe('다시 세움');
  });
});
