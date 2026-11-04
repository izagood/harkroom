/** 계획판 버튼·패널(개선 시안 v3 W1~W9·V1~V4) — 끝난 일 펼침·머리 고정·칩 차례·막힌 까닭·닫기. */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ThreadPlanView } from '@harkroom/shared';

const loadThreadPlan = vi.fn(async () => {});
const openThread = vi.fn(async () => {});
const openMessage = vi.fn(async () => {});
const openExternal = vi.fn(async () => {});
const previewPlanStart = vi.fn();
const startPlan = vi.fn();
const setPlanManager = vi.fn(async () => {});
vi.mock('../src/state/controller', () => ({ getController: () => ({ loadThreadPlan, openThread, openMessage, previewPlanStart, startPlan, setPlanManager }) }));
vi.mock('../src/lib/openExternal', () => ({ getExternalOpener: () => ({ open: openExternal }) }));
let plans: Record<string, ThreadPlanView | null> = {};
let meKind = 'human';
let accounts: Record<string, { id: string; handle: string; kind: string }> = {};
vi.mock('../src/state/communities', () => ({
  useActiveStore: (sel: (s: unknown) => unknown) => sel({ threadPlans: plans, accounts, channelMembers: {}, me: { id: 'me', kind: meKind, handle: 'owner' } }),
}));

import { ThreadPlanButton } from '../src/components/ThreadPlanButton';
import { ApiError } from '../src/lib/api';
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
  meKind = 'human';
  previewPlanStart.mockReset(); startPlan.mockReset(); setPlanManager.mockClear();
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

  it('구분점은 조각 사이에만 있다 — 줄 맨 앞이나 링크 글자에 들지 않는다', () => {
    openPanel_();
    for (const sub of screen.getAllByTestId('plan-row-sub')) expect(sub.textContent!.startsWith('·')).toBe(false);
    expect(screen.getAllByTestId('plan-row-go-pr')[0]!.textContent).toBe('PR #7 ↗');
    expect(screen.getByTestId('plan-waiters').textContent!.startsWith('·')).toBe(false);
    expect(document.querySelector('[data-node="s1"] [data-testid="plan-row-sub"]')!.textContent).toBe('Done·@builder·PR #7 ↗·PR #8 ↗');
  });

  it('막힌 줄: 「막힘 · 사유」 는 한 줄로 줄이고 담당·까닭 토글은 그 아래 줄이다. 펴면 글자가 바뀐다', () => {
    openPanel_();
    const row = document.querySelector('[data-node="s3"]')!;
    const reason = row.querySelector('[data-testid="plan-row-reason"]')!;
    expect(reason.textContent).toBe('Blocked·승인 대기');
    expect(reason.querySelector('.truncate')!.className).toContain('min-w-0');
    const sub = row.querySelector('[data-testid="plan-row-sub"]')!;
    expect(sub.textContent).toBe('@builder·Why blocked ›');
    const toggle = within(row as HTMLElement).getByTestId('plan-why-toggle');
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe('Hide why ⌃');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('머리와 목록이 갈려 있어 목록만 스크롤한다', () => {
    const panel = openPanel_();
    expect(within(screen.getByTestId('plan-head')).getByTestId('plan-chips')).toBeTruthy();
    expect(screen.getByTestId('plan-list').className).toContain('overflow-y-auto');
    expect(within(screen.getByTestId('plan-list')).queryByTestId('plan-chips')).toBeNull();
    expect(panel.style.width).toBe('440px');
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

  it('연결 그룹이 막히면 막힘 칩이 켜지고 그 그룹으로 간다', () => {
    const c = rules.cases[2]!.plan;
    plans = { r1: view({ doc: c.doc, derived: c.derived, progress: c.progress, linked: c.linked }) };
    openPanel_();
    const chip = screen.getByTestId('plan-chip-blocked') as HTMLButtonElement;
    expect(chip.disabled).toBe(false);
    fireEvent.click(chip);
    expect(document.querySelector('[data-node="g1"]')!.className).toContain('bg-accent-surface');
    expect(screen.getByTestId('plan-chip-blocked-cycle').textContent).toContain('1/1');
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
    fireEvent.click(screen.getAllByTestId('plan-row-go-pr')[0]!);
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

const manyReady = () => {
  const doc = { goal: 'g', groups: [], steps: [
    { id: 's1', title: '하나', state: 'pending', assigneeId: 'bot', links: [], dependsOn: [] },
    { id: 's2', title: '둘', state: 'pending', links: [], dependsOn: [] },
    { id: 's3', title: '남의 일', state: 'pending', assigneeId: 'other', links: [], dependsOn: [] },
  ] };
  const derived = { s1: { derived: 'ready', waitingOn: [] }, s2: { derived: 'ready', waitingOn: [] }, s3: { derived: 'ready', waitingOn: [] } };
  plans = { r1: view({ doc, derived, progress: { done: 0, total: 3, active: 0, blocked: 0, waiting: 0 }, linked: [] }) };
};
const P_OK = { rev: 3, posts: [{ to: 'bot', via: 'assignee', stepIds: ['s1'], body: '@builder 계획판 단계 「하나」를 시작해 달라' }], selfStepIds: [], skipped: [], managerSkipped: null };
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const s1Row = () => document.querySelector('[data-node="s1"]') as HTMLElement;

describe('▷ 시작', () => {
  it('시작 가능 줄에만 있고, 담당이 다른 사람이면 꺼진다. 사람 글은 미리보기로 보인다', async () => {
    manyReady();
    previewPlanStart.mockResolvedValue(P_OK);
    openPanel_();
    const other = within(document.querySelector('[data-node="s3"]') as HTMLElement).getByTestId('plan-start') as HTMLButtonElement;
    expect(other.disabled).toBe(true);
    expect(other.title).toBe('The assignee starts this');
    fireEvent.click(within(s1Row()).getByTestId('plan-start'));
    await flush();
    expect(previewPlanStart).toHaveBeenCalledWith('r1', [{ id: 's1' }]);
    expect(screen.getByTestId('plan-start-title').textContent).toBe('Hand this step to @builder');
    expect(screen.getByTestId('plan-start-body').textContent).toContain('「하나」');
    expect(startPlan).not.toHaveBeenCalled();
  });

  it('시작하면 미리보기의 rev 를 싣고, 줄에 시작 글 링크가 남는다', async () => {
    manyReady();
    previewPlanStart.mockResolvedValue(P_OK);
    startPlan.mockResolvedValue({ rev: 4, started: [{ id: 's1', via: 'assignee', to: 'bot', messageId: 'm-9' }], skipped: [], failed: [], notNotified: [], managerSkipped: null, plan: plans.r1 });
    openPanel_();
    fireEvent.click(within(s1Row()).getByTestId('plan-start'));
    await flush();
    fireEvent.click(screen.getByTestId('plan-start-go'));
    await flush();
    expect(startPlan).toHaveBeenCalledWith('r1', [{ id: 's1' }], 3);
    expect(screen.queryByTestId('plan-start-box')).toBeNull();
    expect(screen.getByTestId('plan-started-note').textContent).toContain('owner just started this');
    fireEvent.click(screen.getByTestId('plan-started-link'));
    expect(openMessage).toHaveBeenCalledWith('m-9');
  });

  it.each(['plan_changed', 'if_rev_required'])('%s 면 시작하지 않고 미리보기를 다시 받아 새 내용을 보인다', async (code) => {
    manyReady();
    previewPlanStart.mockResolvedValueOnce(P_OK);
    previewPlanStart.mockResolvedValueOnce({ ...P_OK, rev: 5, posts: [{ to: 'lead', via: 'manager', stepIds: ['s1'], body: '@lead 새 글' }] });
    startPlan.mockRejectedValueOnce(new ApiError(409, code, code));
    accounts.lead = { id: 'lead', handle: 'lead', kind: 'agent' };
    openPanel_();
    fireEvent.click(within(s1Row()).getByTestId('plan-start'));
    await flush();
    fireEvent.click(screen.getByTestId('plan-start-go'));
    await flush();
    expect(startPlan).toHaveBeenCalledTimes(1);
    expect(previewPlanStart).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('plan-start-changed')).toBeTruthy();
    expect(screen.getByTestId('plan-start-title').textContent).toBe('Hand off to manager agent @lead');
    expect(screen.getByTestId('plan-start-body').textContent).toBe('@lead 새 글');
    startPlan.mockResolvedValue({ rev: 6, started: [], skipped: [], failed: [], notNotified: [], managerSkipped: null, plan: plans.r1 });
    fireEvent.click(screen.getByTestId('plan-start-go'));
    await flush();
    expect(startPlan).toHaveBeenLastCalledWith('r1', [{ id: 's1' }], 5);
  });

  it('다른 실패는 사유를 한 줄로 보이고 다시 누를 수 있다', async () => {
    manyReady();
    previewPlanStart.mockResolvedValue(P_OK);
    startPlan.mockRejectedValueOnce(new ApiError(409, 'not_invokable', 'x'));
    openPanel_();
    fireEvent.click(within(s1Row()).getByTestId('plan-start'));
    await flush();
    fireEvent.click(screen.getByTestId('plan-start-go'));
    await flush();
    expect(screen.getByTestId('plan-start-error').textContent).toBe('You can’t call that agent');
    expect((screen.getByTestId('plan-start-go') as HTMLButtonElement).disabled).toBe(false);
  });

  it('관리 에이전트를 못 거치면 사유를 한 줄로 보인다', async () => {
    manyReady();
    previewPlanStart.mockResolvedValue({ ...P_OK, managerSkipped: 'manager_not_invokable' });
    openPanel_();
    fireEvent.click(within(s1Row()).getByTestId('plan-start'));
    await flush();
    expect(screen.getByTestId('plan-start-manager-skipped').textContent).toContain('manager agent');
  });

  it('담당이 없으면 고를 때까지 시작이 꺼지고, 고르면 그 에이전트로 다시 미리 본다', async () => {
    manyReady();
    previewPlanStart.mockImplementation(async (_r: string, steps: { id: string; assigneeId?: string }[]) => (steps[0]!.assigneeId
      ? { ...P_OK, posts: [{ to: 'bot', via: 'assignee', stepIds: ['s2'], body: '글' }] }
      : { rev: 3, posts: [], selfStepIds: [], skipped: [{ id: 's2', code: 'no_assignee' }], managerSkipped: null }));
    openPanel_();
    fireEvent.click(within(document.querySelector('[data-node="s2"]') as HTMLElement).getByTestId('plan-start'));
    await flush();
    expect((screen.getByTestId('plan-start-go') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('plan-start-pick'), { target: { value: 'bot' } });
    await flush();
    expect(previewPlanStart).toHaveBeenLastCalledWith('r1', [{ id: 's2', assigneeId: 'bot' }]);
    expect((screen.getByTestId('plan-start-go') as HTMLButtonElement).disabled).toBe(false);
  });

  it('누른 사람이 담당이면 아무도 부르지 않는다고 말한다', async () => {
    manyReady();
    previewPlanStart.mockResolvedValue({ rev: 3, posts: [], selfStepIds: ['s1'], skipped: [], managerSkipped: null });
    openPanel_();
    fireEvent.click(within(s1Row()).getByTestId('plan-start'));
    await flush();
    expect(screen.getByTestId('plan-start-title').textContent).toContain('without calling anyone');
    expect((screen.getByTestId('plan-start-go') as HTMLButtonElement).disabled).toBe(false);
  });

  it('모두 시작: 둘 이상일 때만 있고, 고를 수 없는 줄은 꺼지며, 빼면 다시 미리 본다', async () => {
    manyReady();
    previewPlanStart.mockImplementation(async (_r: string, steps: { id: string }[]) => ({
      rev: 3, selfStepIds: [], managerSkipped: null,
      posts: steps.some((x) => x.id === 's1') ? [{ to: 'bot', via: 'assignee', stepIds: ['s1'], body: '글' }] : [],
      skipped: [{ id: 's2', code: 'no_assignee' }, { id: 's3', code: 'other_human_assignee' }],
    }));
    openPanel_();
    fireEvent.click(screen.getByTestId('plan-start-all'));
    await flush();
    expect(previewPlanStart).toHaveBeenCalledWith('r1', [{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    expect((screen.getByTestId('plan-start-check-s2') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('plan-start-turns').textContent).toContain('1 agent turn');
    expect(screen.getByTestId('plan-start-go').textContent).toBe('▶ Start 1');
    fireEvent.click(screen.getByTestId('plan-start-check-s1'));
    await flush();
    expect((screen.getByTestId('plan-start-go') as HTMLButtonElement).disabled).toBe(true);
  });

  it('모두 시작은 「시작 가능」 칩과 같은 단계만 담고, 줄마다 부를 상대를 적는다', async () => {
    manyReady();
    (plans.r1!.doc.steps[1] as { assigneeId?: string }).assigneeId = 'me';
    previewPlanStart.mockResolvedValue({ rev: 3, selfStepIds: [], managerSkipped: null, skipped: [{ id: 's3', code: 'other_human_assignee' }],
      posts: [{ to: 'bot', via: 'assignee', stepIds: ['s1'], body: '글' }] });
    openPanel_();
    fireEvent.click(screen.getByTestId('plan-start-all'));
    await flush();
    expect(previewPlanStart).toHaveBeenCalledWith('r1', [{ id: 's1' }, { id: 's3' }]);
    expect(screen.queryByTestId('plan-start-check-s2')).toBeNull();
    expect(screen.getByTestId('plan-start-title').textContent).toBe('Start 2 ready steps at once');
    expect(screen.getByTestId('plan-chip-ready').textContent).toContain('2');
    expect(screen.getByTestId('plan-start-to-s1').textContent).toBe('→ @builder');
    expect(screen.queryByTestId('plan-start-to-s3')).toBeNull();
    expect(screen.getByText(/Message calling @builder/)).toBeTruthy();
  });

  it('고른 것을 바꾸면 새 미리보기가 올 때까지 시작하지 못한다', async () => {
    manyReady();
    let answer: (v: unknown) => void = () => {};
    previewPlanStart.mockImplementation((_r: string, steps: { id: string; assigneeId?: string }[]) => (steps[0]!.assigneeId === 'bot2'
      ? new Promise((r) => { answer = r; })
      : Promise.resolve({ ...P_OK, posts: [{ to: 'bot', via: 'assignee', stepIds: ['s2'], body: '글' }], skipped: [{ id: 's2', code: 'no_assignee' }] })));
    accounts = { ...accounts, bot2: { ...accounts.bot!, id: 'bot2', handle: 'second' } };
    openPanel_();
    fireEvent.click(within(document.querySelector('[data-node="s2"]') as HTMLElement).getByTestId('plan-start'));
    await flush();
    fireEvent.change(screen.getByTestId('plan-start-pick'), { target: { value: 'bot2' } });
    await flush();
    expect(screen.getByTestId('plan-start-refreshing')).toBeTruthy();
    const go = screen.getByTestId('plan-start-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(go);
    await flush();
    expect(startPlan).not.toHaveBeenCalled();
    answer({ ...P_OK, posts: [{ to: 'bot2', via: 'assignee', stepIds: ['s2'], body: '글' }], skipped: [{ id: 's2', code: 'no_assignee' }] });
    await flush();
    expect(screen.queryByTestId('plan-start-refreshing')).toBeNull();
    expect(go.disabled).toBe(false);
  });

  it('글 올리기가 실패하면 상자를 닫지 않고 사유를 보이며, 새 판으로 다시 시작한다', async () => {
    manyReady();
    previewPlanStart.mockResolvedValueOnce(P_OK).mockResolvedValue({ ...P_OK, rev: 5 });
    startPlan.mockResolvedValueOnce({ rev: 5, started: [], skipped: [], failed: [{ id: 's1', code: 'post_failed' }], notNotified: [], managerSkipped: null, plan: plans.r1 });
    openPanel_();
    fireEvent.click(within(s1Row()).getByTestId('plan-start'));
    await flush();
    fireEvent.click(screen.getByTestId('plan-start-go'));
    await flush();
    expect(screen.getByTestId('plan-start-box')).toBeTruthy();
    expect(screen.getByTestId('plan-start-result').textContent).toContain('Couldn’t post');
    expect(screen.getByTestId('plan-start-cancel').textContent).toBe('Close');
    startPlan.mockResolvedValueOnce({ rev: 6, started: [], skipped: [], failed: [], notNotified: [], managerSkipped: null, plan: plans.r1 });
    fireEvent.click(screen.getByTestId('plan-start-go'));
    await flush();
    expect(startPlan.mock.calls.at(-1)![2]).toBe(5);
  });

  it('일부만 되면 몇 개인지와 못 한 줄을 보이고, 못 알린 상대를 한 줄로 적는다', async () => {
    manyReady();
    previewPlanStart.mockResolvedValue(P_OK);
    startPlan.mockResolvedValueOnce({ rev: 5, started: [{ id: 's1', via: 'assignee', to: 'bot', messageId: 'm1' }], skipped: [{ id: 's3', code: 'already_started' }], failed: [], notNotified: ['bot'], managerSkipped: null, plan: plans.r1 });
    openPanel_();
    fireEvent.click(screen.getByTestId('plan-start-all'));
    await flush();
    fireEvent.click(screen.getByTestId('plan-start-go'));
    await flush();
    const r = screen.getByTestId('plan-start-result').textContent!;
    expect(r).toContain('1 started · 1 not started');
    expect(r).toContain('남의 일 · Already started');
    expect(screen.getByTestId('plan-start-not-notified').textContent).toContain('@builder');
  });

  it('에이전트가 보는 화면에는 시작이 없다', () => {
    manyReady();
    meKind = 'agent';
    openPanel_();
    expect(screen.queryByTestId('plan-start')).toBeNull();
    expect(screen.queryByTestId('plan-start-all')).toBeNull();
    expect(screen.queryByTestId('plan-manager-edit')).toBeNull();
  });
});

describe('줄 누르기', () => {
  it('연결이 있는 줄은 줄 전체가 그리로 간다. 줄 안 버튼은 따로 돈다', () => {
    openPanel_();
    const r = within(document.querySelector('[data-node="s2"]') as HTMLElement).getByTestId('plan-row');
    expect(r.getAttribute('role')).toBe('button');
    const done = within(document.querySelector('[data-node="s1"]') as HTMLElement);
    fireEvent.click(done.getAllByTestId('plan-row-go-pr')[0]!);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openMessage).not.toHaveBeenCalled();
    fireEvent.click(r);
    expect(openMessage).toHaveBeenCalledWith('m-1');
    expect(screen.queryByTestId('plan-panel')).toBeNull();
  });

  it('Enter 로도 간다', () => {
    openPanel_();
    const r = within(document.querySelector('[data-node="s2"]') as HTMLElement).getByTestId('plan-row');
    fireEvent.keyDown(r, { key: 'Enter' });
    expect(openMessage).toHaveBeenCalledWith('m-1');
  });

  it('막힌 줄은 까닭을 편다', () => {
    openPanel_();
    fireEvent.click(within(document.querySelector('[data-node="s3"]') as HTMLElement).getByTestId('plan-row'));
    expect(screen.getByTestId('plan-why-reason').textContent).toBe('승인 대기');
  });

  it('연결이 없는 줄은 누르는 모양이 없고, 내 차례면 「연결 없음」을 쓴다', () => {
    openPanel_();
    const mine = within(document.querySelector('[data-node="s4"]') as HTMLElement);
    expect(mine.getByTestId('plan-row').getAttribute('role')).toBeNull();
    expect(mine.getByTestId('plan-row-nolink').textContent).toBe('Nothing linked');
    const other = within(document.querySelector('[data-node="s6"]') as HTMLElement);
    expect(other.queryByTestId('plan-row-nolink')).toBeNull();
  });
});

/** jsdom 의 PointerEvent 는 좌표를 싣지 않는다 — 같은 이름의 MouseEvent 로 민다. */
const drag = (testId: string, from: [number, number], to: [number, number]) => {
  const at = (type: string, [clientX, clientY]: [number, number]) => new MouseEvent(type, { bubbles: true, clientX, clientY });
  act(() => {
    screen.getByTestId(testId).dispatchEvent(at('pointerdown', from));
    window.dispatchEvent(at('pointermove', to));
    window.dispatchEvent(at('pointerup', to));
  });
};

describe('크기·관리 에이전트', () => {
  it('왼쪽 위를 끌면 커지고 기기에 하나만 기억한다. 두 번 누르면 기본', () => {
    const panel = openPanel_();
    expect(panel.style.width).toBe('440px');
    drag('plan-resize-corner', [500, 500], [400, 450]);
    expect(panel.style.width).toBe('540px');
    expect(panel.style.height).toBe('650px');
    expect(JSON.parse(localStorage.getItem('harkroom.threadPlan.size')!)).toEqual({ w: 540, h: 650 });
    fireEvent.doubleClick(screen.getByTestId('plan-resize-corner'));
    expect(panel.style.width).toBe('440px');
    expect(localStorage.getItem('harkroom.threadPlan.size')).toBeNull();
  });

  it('왼쪽 가장자리는 폭만, 위 가장자리는 높이만', () => {
    const panel = openPanel_();
    drag('plan-resize-left', [500, 500], [450, 100]);
    expect([panel.style.width, panel.style.height]).toEqual(['490px', '600px']);
    drag('plan-resize-top', [500, 500], [100, 450]);
    expect([panel.style.width, panel.style.height]).toEqual(['490px', '650px']);
  });

  it('넓게/기본 버튼', () => {
    const panel = openPanel_();
    fireEvent.click(screen.getByTestId('plan-size-toggle'));
    expect(panel.style.width).not.toBe('440px');
    expect(screen.getByTestId('plan-size-toggle').textContent).toBe('⤡ Default');
    fireEvent.click(screen.getByTestId('plan-size-toggle'));
    expect(panel.style.width).toBe('440px');
  });

  it('관리 에이전트를 보이고 바꾸거나 비운다', async () => {
    accounts.lead = { id: 'lead', handle: 'lead', kind: 'agent' };
    plans = { r1: view({ doc: { ...base.doc, managerId: 'lead' } }) };
    openPanel_();
    expect(screen.getByTestId('plan-manager').textContent).toContain('@lead');
    fireEvent.click(screen.getByTestId('plan-manager-edit'));
    fireEvent.change(screen.getByTestId('plan-manager-select'), { target: { value: 'bot' } });
    expect(setPlanManager).toHaveBeenCalledWith('r1', 'bot');
    await flush();
    fireEvent.click(screen.getByTestId('plan-manager-edit'));
    fireEvent.change(screen.getByTestId('plan-manager-select'), { target: { value: '' } });
    expect(setPlanManager).toHaveBeenLastCalledWith('r1', null);
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
