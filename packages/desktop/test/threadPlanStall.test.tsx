/** 계획판 「멈춤?」 — 서버 추정 표시: 머리 글·칩(0 이면 없음)·줄 꼬리표·「조용한 까닭」 상자·막힘과 겹치면 막힘만. */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ThreadPlanView } from '@harkroom/shared';

const loadThreadPlan = vi.fn(async () => {});
vi.mock('../src/state/controller', () => ({ getController: () => ({ loadThreadPlan }) }));
vi.mock('../src/lib/openExternal', () => ({ getExternalOpener: () => ({ open: vi.fn() }) }));
let accounts: Record<string, { id: string; handle: string; kind: string }> = {};
vi.mock('../src/state/communities', () => ({
  useActiveStore: (sel: (s: unknown) => unknown) => sel({ threadPlans: {}, accounts, channelMembers: {}, planFocus: null, me: { id: 'me', kind: 'human', handle: 'owner' } }),
}));

import { PlanBody } from '../src/components/PlanBody';
import { planStalledIds, quietSpanLabel, stallClockLabel } from '../src/lib/threadPlan';
import rules from './fixtures/planRules.json';

const H = 3_600_000;
const base = rules.cases[0]!.plan;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const view = (over: Record<string, unknown> = {}): ThreadPlanView => ({
  ...(base as unknown as ThreadPlanView), rootId: 'r1', channelId: 'c1', rev: 3, updatedAt: new Date().toISOString(), updatedBy: 'bot', flagged: null, ...over,
} as ThreadPlanView);
const withManager = (p: ThreadPlanView, managerId: string): ThreadPlanView => ({ ...p, doc: { ...p.doc, managerId } });
const row = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement;

beforeEach(() => {
  loadThreadPlan.mockClear();
  accounts = { bot: { id: 'bot', handle: 'builder', kind: 'agent' }, lead: { id: 'lead', handle: 'lead', kind: 'agent' }, other: { id: 'other', handle: 'pat', kind: 'human' }, me: { id: 'me', handle: 'me', kind: 'human' } };
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('멈춤? 판정', () => {
  it('진행으로 그리는 줄만 센다 — 막힘·내 차례·끝·모르는 단계·못 읽는 시각은 뺀다', () => {
    const stalled = {
      s2: { since: ago(7 * H), wokenAt: null }, // 진행(에이전트 담당)
      s3: { since: ago(7 * H), wokenAt: null }, // 막힘 — 막힘만 보인다
      s5: { since: ago(7 * H), wokenAt: null }, // 내 차례
      s1: { since: ago(7 * H), wokenAt: null }, // 끝
      zz: { since: ago(7 * H), wokenAt: null },
    };
    expect(planStalledIds(view({ stalled }), 'me')).toEqual(['s2']);
    expect(planStalledIds(view({ stalled: { s2: { since: 'nope', wokenAt: null } } }), 'me')).toEqual([]);
    expect(planStalledIds(view(), 'me')).toEqual([]);
    expect(planStalledIds(view({ stalled: { constructor: { since: ago(H), wokenAt: null } } }), 'me')).toEqual([]);
  });

  it('조용한 길이는 가장 큰 단위 하나, 시각은 날이 다르면 날짜를 붙인다', () => {
    const now = new Date(2026, 10, 25, 17, 2).getTime();
    expect(quietSpanLabel(now - 7 * H - 5 * 60_000, now, 'ko')).toBe('7시간');
    expect(quietSpanLabel(now - 30 * H, now, 'en')).toBe('1 day');
    expect(quietSpanLabel(now - 20 * 60_000, now, 'en')).toBe('20 minutes');
    expect(quietSpanLabel(now + H, now, 'ko')).toBe('0분');
    expect(stallClockLabel(new Date(2026, 10, 25, 11, 2).getTime(), now, 'en')).toBe('11:02');
    expect(stallClockLabel(new Date(2026, 10, 24, 16, 40).getTime(), now, 'en')).toBe('11/24, 16:40');
  });
});

describe('멈춤? 화면', () => {
  it('멈춘 단계가 없으면 머리 글·칩·꼬리표가 모두 없다', () => {
    render(<PlanBody plan={view()} />);
    expect(screen.queryByTestId('plan-head-stalled')).toBeNull();
    expect(screen.queryByTestId('plan-chip-stalled')).toBeNull();
    expect(screen.queryByTestId('plan-stall-toggle')).toBeNull();
  });

  it('머리 글·진행 칩 바로 뒤의 칩·줄 꼬리표가 서고, 진행 표지와 줄 바탕은 그대로다', () => {
    render(<PlanBody plan={view({ stalled: { s2: { since: ago(7 * H), wokenAt: null }, s3: { since: ago(9 * H), wokenAt: null } } })} />);
    expect(screen.getByTestId('plan-head-stalled').textContent).toBe(' · 1 stalled?');
    const chips = [...screen.getByTestId('plan-chips').children].map((c) => c.getAttribute('data-testid'));
    expect(chips.indexOf('plan-chip-stalled')).toBe(chips.indexOf('plan-chip-active') + 1);
    expect(screen.getByTestId('plan-chip-stalled').textContent).toContain('Stalled? 1');
    const r = row('s2');
    expect(r.getAttribute('data-kind')).toBe('active');
    expect(within(r).getByTestId('plan-mark').getAttribute('data-kind')).toBe('active');
    expect(r.className).not.toContain('bg-danger-surface');
    expect(within(r).getByTestId('plan-stall-toggle').textContent).toContain('Stalled?');
    expect(within(r).getByTestId('plan-stall-toggle').getAttribute('aria-label')).toBe('possibly stalled');
    expect(within(r).getByTestId('plan-stall-quiet').textContent).toBe('No signal for 7 hours');
    // 막힘과 겹치면 막힘만.
    expect(within(row('s3')).queryByTestId('plan-stall-toggle')).toBeNull();
    // 경고 토큰만 쓴다 — 막힘 토큰과 섞지 않는다.
    for (const id of ['plan-chip-stalled', 'plan-stall-toggle']) {
      const cls = screen.getByTestId(id).className;
      expect(cls).toContain('border-dashed');
      expect(cls).toContain('border-warning-border');
      expect(cls).not.toMatch(/state-stuck|danger/);
    }
  });

  it('칩을 누르면 멈춘 단계를 차례로 간다', () => {
    const p = view({ stalled: { s2: { since: ago(7 * H), wokenAt: null } } });
    render(<PlanBody plan={{ ...p, doc: { ...p.doc, steps: p.doc.steps.map((s) => (s.id === 's5' ? { ...s, assigneeId: 'bot' } : s)) }, stalled: { ...p.stalled, s5: { since: ago(30 * H), wokenAt: null } } }} />);
    const chip = screen.getByTestId('plan-chip-stalled');
    fireEvent.click(chip);
    expect(screen.getByTestId('plan-chip-stalled-cycle').textContent).toContain('1/2');
    expect(row('s2').className).toContain('ring-accent');
    fireEvent.click(chip);
    expect(screen.getByTestId('plan-chip-stalled-cycle').textContent).toContain('2/2');
    expect(row('s5').className).toContain('ring-accent');
  });

  it('꼬리표를 누르면 「조용한 까닭」이 펴진다 — 깨움 줄은 깨운 때가 있고 관리자가 에이전트일 때만', () => {
    const stalled = { s2: { since: ago(7 * H), wokenAt: ago(H) } };
    const { unmount } = render(<PlanBody plan={withManager(view({ stalled }), 'lead')} />);
    fireEvent.click(screen.getByTestId('plan-stall-toggle'));
    expect(screen.getByTestId('plan-stall-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('plan-stall-signals').textContent).toMatch(/^No signal since \d\d:\d\d|^No signal since \d+\/\d+, \d\d:\d\d/);
    expect(screen.getByTestId('plan-stall-woke').textContent).toContain('@lead');
    fireEvent.click(screen.getByTestId('plan-stall-toggle'));
    expect(screen.queryByTestId('plan-stall')).toBeNull();
    unmount();

    for (const p of [
      view({ stalled }), // 관리자 없음
      withManager(view({ stalled }), 'other'), // 관리자가 사람
      withManager(view({ stalled: { s2: { since: ago(7 * H), wokenAt: null } } }), 'lead'), // 아직 안 깨움
    ]) {
      const r = render(<PlanBody plan={p} />);
      fireEvent.click(screen.getByTestId('plan-stall-toggle'));
      expect(screen.getByTestId('plan-stall')).toBeTruthy();
      expect(screen.queryByTestId('plan-stall-woke')).toBeNull();
      r.unmount();
    }
  });

  it('표시는 판 번호 없이 바뀌므로 본문이 설 때 한 번, 서 있는 동안 가끔 다시 받는다', () => {
    vi.useFakeTimers();
    const { unmount } = render(<PlanBody plan={view()} />);
    expect(loadThreadPlan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60_000);
    expect(loadThreadPlan).toHaveBeenCalledTimes(2);
    unmount();
    vi.advanceTimersByTime(30 * 60_000);
    expect(loadThreadPlan).toHaveBeenCalledTimes(2);
  });
});
