/** 스레드 계획판 띠·패널 렌더(P4) — 띠·알약·펼침·「⏳ 앞」·연결 스레드 열기. */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ThreadPlanView } from '@harkroom/shared';

const loadThreadPlan = vi.fn(async () => {});
const openThread = vi.fn(async () => {});
vi.mock('../src/state/controller', () => ({ getController: () => ({ loadThreadPlan, openThread }) }));
let plans: Record<string, ThreadPlanView | null> = {};
vi.mock('../src/state/communities', () => ({
  useActiveStore: (sel: (s: { threadPlans: typeof plans }) => unknown) => sel({ threadPlans: plans }),
}));

import { ThreadPlanBand } from '../src/components/ThreadPlanBand';

const P = (done: number, total: number, blocked = 0) => ({ done, total, active: 0, blocked, waiting: total - done - blocked });
const view = (updatedAt = new Date().toISOString()): ThreadPlanView => ({
  rootId: 'r1', channelId: 'c1', rev: 3, updatedAt, updatedBy: null, flagged: null,
  doc: {
    goal: '계획판 1차', next: 'P3', blocked: null,
    groups: [
      { id: 'g1', title: '서버', dependsOn: [] }, { id: 'g2', title: '도구', dependsOn: [] },
      { id: 'g3', title: '화면', dependsOn: ['g1'] },
      { id: 'g4', title: '하위 작업', linkedRootId: 'r2', dependsOn: [] },
    ],
    steps: [
      { id: 's1', title: 'P1 저장', state: 'done', groupId: 'g1', links: [], dependsOn: [] },
      { id: 's2', title: 'P2 도구', state: 'blocked', groupId: 'g2', blockedReason: 'CI', links: [], dependsOn: [] },
      { id: 's3', title: 'P4 띠', state: 'pending', groupId: 'g3', links: [], dependsOn: ['s2'] },
      { id: 's4', title: '문서', state: 'pending', links: [], dependsOn: ['s1'] },
    ],
  } as unknown as ThreadPlanView['doc'],
  derived: {
    g1: { derived: 'done', waitingOn: [] }, g2: { derived: 'blocked', waitingOn: [] },
    g3: { derived: 'waiting', waitingOn: [] }, g4: { derived: 'active', waitingOn: [] },
    s1: { derived: 'done', waitingOn: [] }, s2: { derived: 'blocked', waitingOn: [] },
    s3: { derived: 'waiting', waitingOn: ['s2'] },
    s4: { derived: 'ready', waitingOn: [] },
  } as unknown as ThreadPlanView['derived'],
  progress: P(1, 4, 1),
  linked: [{ groupId: 'g4', rootId: 'r2', hidden: false, channelId: 'c2', progress: P(1, 2) }],
});

beforeEach(() => { localStorage.clear(); loadThreadPlan.mockClear(); openThread.mockClear(); });
afterEach(() => { cleanup(); plans = {}; });

describe('ThreadPlanBand', () => {
  it('진행률이 없으면 그리지도 받지도 않는다', () => {
    render(<ThreadPlanBand rootId="r1" progress={null} />);
    expect(screen.queryByTestId('plan-band')).toBeNull();
    expect(loadThreadPlan).not.toHaveBeenCalled();
  });

  it('판이 없으면 받으러 가고, rev 가 같으면 다시 받지 않는다', () => {
    const { rerender } = render(<ThreadPlanBand rootId="r1" progress={{ ...P(1, 4, 1), rev: 3 }} />);
    expect(loadThreadPlan).toHaveBeenCalledTimes(1);
    plans = { r1: view() };
    rerender(<ThreadPlanBand rootId="r1" progress={{ ...P(1, 4, 1), rev: 3 }} />);
    expect(loadThreadPlan).toHaveBeenCalledTimes(1);
    rerender(<ThreadPlanBand rootId="r1" progress={{ ...P(2, 4, 0), rev: 4 }} />);
    expect(loadThreadPlan).toHaveBeenCalledTimes(2);
  });

  it('띠: 그룹 넷 이상이면 개수 요약, 셋 이하면 상태 알약(막힘 먼저) — 처음엔 접힘', () => {
    plans = { r1: view() };
    render(<ThreadPlanBand rootId="r1" progress={{ ...P(1, 4, 1), rev: 3 }} />);
    expect(screen.getByTestId('plan-summary').textContent).toBe('4 groups · 1 in progress · 1 blocked (도구)');
    expect(screen.queryByTestId('plan-panel')).toBeNull();
    expect(screen.queryByTestId('plan-stale')).toBeNull();
    cleanup();
    const v = view(); v.doc = { ...v.doc, groups: v.doc.groups.slice(0, 3) };
    plans = { r1: v };
    render(<ThreadPlanBand rootId="r1" progress={{ ...P(1, 4, 1), rev: 3 }} />);
    const pills = screen.getAllByTestId('plan-pill');
    expect(pills.map((p) => p.textContent)).toEqual(['도구 blocked 0/1', '화면 waiting', '서버✓']);
    // 좁은 폭에서도 첫 알약(막힘)은 남고 나머지는 +n 으로 접힌다(designer 1).
    expect(pills[0]!.className).not.toContain('hidden');
    expect(pills[1]!.className).toContain('hidden md:inline-flex');
    expect(screen.getByTestId('plan-more-narrow').textContent).toBe('+2');
  });

  it('R2: 띠 칩은 판을 받은 뒤 개인 진행률(GET)을 쓴다 — 루트 행 값(청중)이 달라도', () => {
    plans = { r1: view() };
    render(<ThreadPlanBand rootId="r1" progress={{ ...P(0, 4, 1), rev: 3 }} />);
    expect(screen.getByTestId('plan-chip').textContent).toContain('1/4');
  });

  it('펼치면 의존 층 흐름·그룹 진행 수·그룹을 넘는 「앞: 그룹 · 단계」·「시작 가능」 줄', () => {
    plans = { r1: view() };
    render(<ThreadPlanBand rootId="r1" progress={{ ...P(1, 4, 1), rev: 3 }} />);
    fireEvent.click(screen.getByTestId('plan-band-toggle'));
    expect(screen.getAllByTestId('plan-flow-layer').map((l) => l.textContent)).toEqual([
      '서버✓·도구 blocked 0/1·하위 작업 1/2in parallel', '⟶화면 waiting',
    ]);
    expect(screen.getAllByTestId('plan-group-count').map((c) => c.textContent)).toEqual(['1/1', '0/1', '0/1']);
    expect(screen.getByTestId('plan-waiting').textContent).toContain('도구 · P2 도구');
    expect(screen.getByTestId('plan-ready').textContent).toBe('Earlier steps done · ready to start');
  });

  it('펼치면 흐름·「⏳ 앞」이 보이고, 펼침을 스레드별로 기억한다', () => {
    plans = { r1: view() };
    render(<ThreadPlanBand rootId="r1" progress={{ ...P(1, 4, 1), rev: 3 }} />);
    fireEvent.click(screen.getByTestId('plan-band-toggle'));
    expect(screen.getByTestId('plan-flow')).toBeTruthy();
    expect(screen.getByTestId('plan-waiting').textContent).toContain('P2 도구');
    cleanup();
    render(<ThreadPlanBand rootId="r1" progress={{ ...P(1, 4, 1), rev: 3 }} />);
    expect(screen.getByTestId('plan-panel')).toBeTruthy();
  });

  it('연결 그룹은 그 스레드를 그 채널에서 연다 — hidden 이면 링크가 없다', () => {
    plans = { r1: view() };
    render(<ThreadPlanBand rootId="r1" progress={{ ...P(1, 4, 1), rev: 3 }} />);
    fireEvent.click(screen.getByTestId('plan-band-toggle'));
    fireEvent.click(screen.getByTestId('plan-open-linked'));
    expect(openThread).toHaveBeenCalledWith('r2', { channelId: 'c2' });
    cleanup();
    const v = view(); v.linked = [{ groupId: 'g4', rootId: 'r2', hidden: true, channelId: null, progress: null }];
    plans = { r1: v };
    render(<ThreadPlanBand rootId="r1" progress={{ ...P(1, 4, 1), rev: 3 }} />);
    expect(screen.queryByTestId('plan-open-linked')).toBeNull();
  });

  it('24시간 넘게 안 바뀐 판은 「낡았을 수 있음」', () => {
    plans = { r1: view(new Date(Date.now() - 25 * 3600_000).toISOString()) };
    render(<ThreadPlanBand rootId="r1" progress={{ ...P(1, 4, 1), rev: 3 }} />);
    expect(screen.getByTestId('plan-stale')).toBeTruthy();
  });
});
