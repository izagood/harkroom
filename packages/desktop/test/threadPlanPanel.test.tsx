/** 계획판 버튼·패널(개선 시안 v3 W1~W9·V1~V4) — 끝난 일 펼침·머리 고정·칩 차례·막힌 까닭·닫기. */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ThreadPlanView } from '@harkroom/shared';

const loadThreadPlan = vi.fn(async () => {});
const openThread = vi.fn(async () => {});
const openMessage = vi.fn(async () => {});
const openExternal = vi.fn(async () => {});
vi.mock('../src/state/controller', () => ({ getController: () => ({ loadThreadPlan, openThread, openMessage }) }));
vi.mock('../src/lib/openExternal', () => ({ getExternalOpener: () => ({ open: openExternal }) }));
let plans: Record<string, ThreadPlanView | null> = {};
let accounts: Record<string, { id: string; handle: string; kind: string }> = {};
vi.mock('../src/state/communities', () => ({
  useActiveStore: (sel: (s: unknown) => unknown) => sel({ threadPlans: plans, accounts, me: { id: 'me' } }),
}));

import { ThreadPlanButton } from '../src/components/ThreadPlanButton';
import { JumpToLatestPill } from '../src/components/JumpToLatestPill';
import rules from './fixtures/planRules.json';

const base = rules.cases[0]!.plan;
const view = (over: Record<string, unknown> = {}): ThreadPlanView => ({
  ...(base as unknown as ThreadPlanView), rootId: 'r1', channelId: 'c1', rev: 3, updatedAt: new Date().toISOString(), updatedBy: 'bot', flagged: null, ...over,
} as ThreadPlanView);
const row = { done: 2, total: 10, active: 2, blocked: 2, waiting: 2, rev: 3 };
const button = () => screen.getByTestId('plan-button');
const openPanel = () => { fireEvent.click(button()); return screen.getByTestId('plan-panel'); };

beforeEach(() => {
  localStorage.clear(); loadThreadPlan.mockClear(); openThread.mockClear(); openMessage.mockClear(); openExternal.mockClear();
  accounts = { bot: { id: 'bot', handle: 'builder', kind: 'agent' }, other: { id: 'other', handle: 'pat', kind: 'human' }, me: { id: 'me', handle: 'me', kind: 'human' } };
  plans = { r1: view() };
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
});
afterEach(() => { cleanup(); plans = {}; accounts = {}; vi.unstubAllGlobals(); });

describe('버튼', () => {
  it('진행률이 없거나 단계가 0개면 그리지도 받지도 않는다', () => {
    plans = {};
    const { rerender } = render(<ThreadPlanButton rootId="r1" progress={null} />);
    expect(screen.queryByTestId('plan-button')).toBeNull();
    rerender(<ThreadPlanButton rootId="r1" progress={{ ...row, done: 0, total: 0, rev: 1 }} />);
    expect(screen.queryByTestId('plan-button')).toBeNull();
    expect(loadThreadPlan).toHaveBeenCalledTimes(0);
  });

  it('닫힌 채로 막힘이 보이고, 판을 못 받아도 행 값으로 선다', () => {
    plans = {};
    render(<ThreadPlanButton rootId="r1" progress={row} />);
    expect(button().textContent).toContain('Plan 2/10');
    expect(screen.getByTestId('plan-button-blocked').textContent).toBe('· 2 blocked');
    expect(within(button()).getByTestId('plan-mark').getAttribute('data-kind')).toBe('blocked');
    expect(loadThreadPlan).toHaveBeenCalledTimes(1);
  });

  it('rev 가 같으면 다시 받지 않고, 다르면 받는다', () => {
    const { rerender } = render(<ThreadPlanButton rootId="r1" progress={row} />);
    expect(loadThreadPlan).toHaveBeenCalledTimes(0);
    rerender(<ThreadPlanButton rootId="r1" progress={{ ...row, rev: 1 }} />);
    expect(loadThreadPlan).toHaveBeenCalledTimes(1);
  });

  it('펼침을 스레드별로 기억하고, ✕·버튼·Esc 로 닫는다. 부모에게 알린다', () => {
    const onOpenChange = vi.fn();
    const { unmount } = render(<ThreadPlanButton rootId="r1" progress={row} onOpenChange={onOpenChange} />);
    expect(screen.queryByTestId('plan-panel')).toBeNull();
    openPanel();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTestId('plan-panel-close'));
    expect(screen.queryByTestId('plan-panel')).toBeNull();
    fireEvent.click(button());
    fireEvent.click(button());
    expect(screen.queryByTestId('plan-panel')).toBeNull();
    fireEvent.keyDown(openPanel(), { key: 'Escape' });
    expect(screen.queryByTestId('plan-panel')).toBeNull();
    openPanel();
    expect(document.activeElement).not.toBe(screen.getByTestId('plan-panel'));
    fireEvent.keyDown(button(), { key: 'Escape' });
    expect(screen.queryByTestId('plan-panel')).toBeNull();
    fireEvent.click(button());
    unmount();
    render(<ThreadPlanButton rootId="r1" progress={row} />);
    expect(screen.getByTestId('plan-panel')).toBeTruthy();
  });
});

describe('패널', () => {
  it('끝난 일을 접지 않고 문서 순서로 둔다. 끝은 흐리게 하지 않는다', () => {
    const panel = openPanel_();
    const ids = [...panel.querySelectorAll('[data-kind][data-node^="s"]')].map((e) => e.getAttribute('data-node'));
    expect(ids).toEqual(rules.cases[0]!.expect.order);
    const done = panel.querySelector('[data-node="s1"]')!;
    expect(done.querySelector('.line-through')).toBeNull();
    expect(done.textContent).toContain('Done');
    expect(done.textContent).toContain('PR #7 ↗');
  });

  it('머리와 목록이 갈려 있어 목록만 스크롤한다', () => {
    const panel = openPanel_();
    expect(within(screen.getByTestId('plan-head')).getByTestId('plan-chips')).toBeTruthy();
    expect(screen.getByTestId('plan-list').className).toContain('overflow-y-auto');
    expect(within(screen.getByTestId('plan-list')).queryByTestId('plan-chips')).toBeNull();
    expect(panel.className).toContain('w-[440px]');
  });

  it('진행은 글자로도 말한다, 내 차례·사람 꼬리표', () => {
    const panel = openPanel_();
    expect(panel.querySelector('[data-node="s2"]')!.textContent).toContain('In progress');
    expect(panel.querySelector('[data-node="s2"]')!.textContent).toContain('@builder');
    expect(panel.querySelector('[data-node="s4"]')!.textContent).toContain('Your turn');
    expect(panel.querySelector('[data-node="s6"]')!.textContent).toContain('Person');
    expect(screen.getByTestId('plan-chip-mine').textContent).toContain('Your turn 2');
  });

  it('상태 칩을 거듭 누르면 차례로 가고, 막힘이면 까닭을 편다. 0 이면 누를 수 없다', () => {
    openPanel_();
    fireEvent.click(screen.getByTestId('plan-chip-blocked'));
    expect(screen.getByTestId('plan-chip-blocked-cycle').textContent).toContain('1/2');
    expect(screen.getAllByTestId('plan-why')).toHaveLength(1);
    expect(screen.getByTestId('plan-why-reason').textContent).toBe('승인 대기');
    fireEvent.click(screen.getByTestId('plan-chip-blocked'));
    expect(screen.getByTestId('plan-chip-blocked-cycle').textContent).toContain('2/2');
    expect(screen.getAllByTestId('plan-why')).toHaveLength(2);
    cleanup();
    localStorage.clear();
    plans = { r1: view({ doc: rules.cases[1]!.plan.doc, derived: rules.cases[1]!.plan.derived }) };
    openPanel_();
    expect((screen.getByTestId('plan-chip-blocked') as HTMLButtonElement).disabled).toBe(true);
  });

  it('접힌 그룹도 칩이 편다', () => {
    openPanel_();
    fireEvent.click(screen.getByText('배포'));
    expect(document.querySelector('[data-node="s3"]')).toBeNull();
    fireEvent.click(screen.getByTestId('plan-chip-blocked'));
    expect(document.querySelector('[data-node="s3"]')).not.toBeNull();
  });

  it('막힌 까닭: 앞 단계로 가고, 글로 가면 패널을 접고, 연결이 없으면 그렇게 말한다', () => {
    openPanel_();
    fireEvent.click(screen.getAllByTestId('plan-why-toggle')[0]!);
    fireEvent.click(screen.getAllByTestId('plan-why-dep')[0]!);
    expect(document.querySelector('[data-node="s4"]')!.className).toContain('ring-2');
    fireEvent.click(screen.getAllByTestId('plan-why-toggle')[1]!);
    expect(screen.getByTestId('plan-why-none').textContent).toBe('Nothing linked');
    fireEvent.click(screen.getByTestId('plan-why-goto'));
    expect(openMessage).toHaveBeenCalledWith('c-1');
    expect(screen.queryByTestId('plan-panel')).toBeNull();
  });

  it('내 차례 줄의 「막힌 n건」은 그 막힌 단계의 까닭을 편다', () => {
    openPanel_();
    fireEvent.click(screen.getByTestId('plan-waiters'));
    expect(screen.getByTestId('plan-why-reason').textContent).toBe('승인 대기');
  });

  it('PR 은 꼴이 맞을 때만 밖으로 연다', () => {
    openPanel_();
    fireEvent.click(screen.getByTestId('plan-row-pr'));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/app/pull/7');
    fireEvent.click(screen.getAllByTestId('plan-why-toggle')[0]!);
    expect(screen.queryByTestId('plan-why-pr')).toBeNull();
  });

  it('남이 쓴 글은 글자 그대로다', () => {
    const doc = { ...base.doc, goal: '<img src=x onerror=1> **굵게**', steps: base.doc.steps.map((s) => (s.id === 's3' ? { ...s, blockedReason: '[링크](https://evil.example)' } : s)) };
    plans = { r1: view({ doc }) };
    openPanel_();
    expect(screen.getByTestId('plan-goal').textContent).toBe('<img src=x onerror=1> **굵게**');
    expect(document.querySelector('[data-testid="plan-panel"] img')).toBeNull();
    fireEvent.click(screen.getAllByTestId('plan-why-toggle')[0]!);
    expect(screen.getByTestId('plan-why-reason').textContent).toBe('[링크](https://evil.example)');
    expect(screen.getByTestId('plan-why-reason').querySelector('a')).toBeNull();
  });

  it('연결은 그 스레드를 열고, 볼 수 없으면 누를 수 없다', () => {
    const linked = [...base.linked, { groupId: 'g5', rootId: 'x', hidden: true }];
    plans = { r1: view({ linked }) };
    openPanel_();
    fireEvent.click(screen.getByTestId('plan-open-linked'));
    expect(openThread).toHaveBeenCalledWith('child', { channelId: 'c2' });
    expect(screen.getByTestId('plan-linked-hidden').tagName).toBe('DIV');
  });

  it('모르는 담당은 그리지 않는다', () => {
    accounts = { me: accounts.me! };
    openPanel_();
    expect(screen.queryByText('@builder')).toBeNull();
  });
});

describe('최신 답글 알약', () => {
  it('계획판 버튼 자리를 비킨다', () => {
    const p = { label: 'l', newLabel: (c: string) => c, ariaLabel: 'a', ariaNewLabel: (n: number) => String(n), count: 0, onClick: () => {}, testId: 'jump' };
    render(<JumpToLatestPill {...p} placement="abovePlan" />);
    expect(screen.getByTestId('jump').className).toContain('bottom-14');
    cleanup();
    render(<JumpToLatestPill {...p} placement="besidePlan" />);
    expect(screen.getByTestId('jump').className).toContain('right-56');
    cleanup();
    render(<JumpToLatestPill {...p} />);
    expect(screen.getByTestId('jump').className).toContain('bottom-3 right-4');
  });
});

function openPanel_() {
  render(<ThreadPlanButton rootId="r1" progress={row} />);
  return openPanel();
}
