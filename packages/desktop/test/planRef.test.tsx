/** 계획판 단계 묻기(시안 v6 Z1~Z9, Q-C) — 칩의 상태·받는 이·보낼 글·글당 스레드 상한. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ThreadPlanView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { ApiError } from '../src/lib/api';
import { splitLinks } from '../src/lib/link';
import { clipPlanTitle, planRefRoots, PLAN_REF_ROOTS_MAX, swapAskMention, withAskLink } from '../src/lib/planRef';
import { PlanAskBar, PlanRefChip } from '../src/components/PlanRefChip';
import { MessageBody } from '../src/components/MessageBody';
import { PlanBody } from '../src/components/PlanBody';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { undoSendStorage } from '../src/lib/prefs';
import { resetAppWindowsForTest, setWindowOpener, openAppWindow } from '../src/lib/appWindows';
import { acc, chan, fakeApi, msg, scheduledApiStub } from './helpers/fakeApi';
import { en } from '../src/i18n/en';

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const uuid = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const step = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `Title ${id}`, state: 'pending', links: [], dependsOn: [], ...over });
const plan = (over: Record<string, unknown> = {}, steps: unknown[] = [step('s1'), step('s2', { assigneeId: 'bot' }), step('s3', { assigneeId: 'pat' })]): ThreadPlanView => ({
  rootId: R1, channelId: 'c1', rev: 3, updatedAt: '2026-11-05T00:00:00.000Z', updatedBy: null, flagged: null,
  doc: { goal: 'g', groups: [], steps, ...over }, derived: {}, progress: { done: 0, total: 3, active: 0, blocked: 0, waiting: 0 }, linked: [],
} as unknown as ThreadPlanView);
const body = (text: string) => render(<MessageBody body={text} messageId="m1" />);

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('me', 'me'),
    accounts: { me: acc('me', 'me'), mgr: acc('mgr', 'manager', 'agent'), bot: acc('bot', 'builder', 'agent'), pat: acc('pat', 'pat') },
    activeChannelId: 'c1',
    threadPlans: { [R1]: plan() },
  });
  setController(new Controller(fakeApi()));
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); setController(null); resetAppWindowsForTest(); });

describe('글자 다루기', () => {
  it('단계 링크는 제목까지 한 조각이고, 앞뒤 주소는 그대로 링크다', () => {
    const parts = splitLinks([{ kind: 'text', text: `see https://a.io harkroom://plan/${R1}/s1 「Title」 and https://b.io` }]);
    expect(parts.map((p) => p.kind)).toEqual(['text', 'link', 'text', 'planRef', 'text', 'link']);
    expect(parts.find((p) => p.kind === 'planRef')).toMatchObject({ ref: { rootId: R1, stepId: 's1', title: 'Title' } });
  });

  it(`글 하나가 칩으로 그리는 스레드는 ${PLAN_REF_ROOTS_MAX}개까지다`, () => {
    const text = [1, 2, 3, 4, 5].map((n) => `harkroom://plan/${uuid(n)}/s1`).join(' ');
    expect(planRefRoots(text).size).toBe(PLAN_REF_ROOTS_MAX);
    expect(planRefRoots(text).has(uuid(4))).toBe(false);
  });

  it('제목은 그릴 때 자른다', () => {
    expect(Array.from(clipPlanTitle('가'.repeat(200))).length).toBe(81);
    expect(clipPlanTitle('a\n  b')).toBe('a b');
  });

  it('받는 이 글자만 바꾸고, 사람이 고친 앞 글자는 건드리지 않는다', () => {
    expect(swapAskMention('@a hello', '@a ', '@b ')).toBe('@b hello');
    expect(swapAskMention('@a hello', '@a ', '')).toBe('hello');
    expect(swapAskMention('hello', '@a ', '@b ')).toBe('@b hello');
    expect(swapAskMention('@b hello', '', '@b ')).toBe('@b hello');
  });

  it('단계 링크는 맨 앞 멘션 바로 뒤에 들어가고, 제목의 @ 는 부르지 않는다', () => {
    const out = withAskLink('@manager how big?', R1, 's1', 'cache @pat');
    expect(out).toBe(`@manager harkroom://plan/${R1}/s1 「cache ＠pat」 how big?`);
    expect(withAskLink('how big?', R1, 's1', 'x')).toBe(`harkroom://plan/${R1}/s1 「x」 how big?`);
  });
});

describe('글 안 칩', () => {
  it('지금 상태와 지금 제목을 그린다', () => {
    useAppStore.getState().set({ threadPlans: { [R1]: plan({}, [step('s1', { title: '새 제목', state: 'active', links: [{ kind: 'pr', repo: 'a/b', number: 7 }] })]) } });
    body(`q harkroom://plan/${R1}/s1 「새 제목」`);
    const chip = screen.getByTestId('plan-ref-chip');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.textContent).toContain('s1 새 제목');
    expect(chip.textContent).toContain('#7');
    expect(screen.queryByTestId('plan-ref-changed')).toBeNull();
  });

  it('번호를 다시 써 제목이 달라졌으면 「제목 바뀜」을 붙인다', () => {
    body(`harkroom://plan/${R1}/s1 「옛 제목」`);
    expect(screen.getByTestId('plan-ref-changed').textContent).toContain(en['plan.ref.titleChanged']);
  });

  it('지워진 단계는 취소선이고 누를 수 없다', () => {
    body(`harkroom://plan/${R1}/s9 「옛 제목」`);
    const gone = screen.getByTestId('plan-ref-gone');
    expect(gone.tagName).toBe('SPAN');
    expect(gone.textContent).toContain(en['plan.ref.deleted']);
    expect(screen.queryByTestId('plan-ref-chip')).toBeNull();
  });

  it('볼 수 없는 스레드면 적힌 제목까지 감춘다', async () => {
    const threadPlan = vi.fn(async () => { throw new ApiError(404, 'not_found', 'not_found'); });
    setController(new Controller(fakeApi({ threadPlan } as never)));
    body(`harkroom://plan/${R2}/s1 「비밀 제목」`);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('plan-ref-hidden').textContent).toContain(en['plan.ref.hidden']);
    expect(document.body.textContent).not.toContain('비밀 제목');
  });

  it('다른 오류면 감추지 않고 적힌 글자로 둔다. 같은 스레드는 한 번만 묻는다', async () => {
    const threadPlan = vi.fn(async () => { throw new ApiError(500, 'boom', 'boom'); });
    setController(new Controller(fakeApi({ threadPlan } as never)));
    body(`harkroom://plan/${R2}/s1 「제목」 harkroom://plan/${R2}/s2 「둘」`);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getAllByTestId('plan-ref-pending')).toHaveLength(2);
    expect(threadPlan).toHaveBeenCalledTimes(1);
  });

  it('상한을 넘은 스레드의 링크는 글자로 남고 판을 묻지 않는다', async () => {
    const threadPlan = vi.fn(async () => null);
    setController(new Controller(fakeApi({ threadPlan } as never)));
    useAppStore.getState().set({ threadPlans: {} });
    const text = [1, 2, 3, 4].map((n) => `harkroom://plan/${uuid(n)}/s1`).join(' ');
    body(text);
    await act(async () => { await Promise.resolve(); });
    expect(threadPlan).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain(`harkroom://plan/${uuid(4)}/s1`);
  });

  it('제목은 글자로만 그린다', () => {
    useAppStore.getState().set({ threadPlans: { [R1]: plan({}, [step('s1', { title: '<img src=x onerror=alert(1)>' })]) } });
    render(<PlanRefChip planRef={{ rootId: R1, stepId: 's1', title: null }} />);
    expect(screen.getByTestId('plan-ref-chip').querySelector('img')).toBeNull();
    expect(screen.getByTestId('plan-ref-chip').textContent).toContain('<img');
  });

  it('누르면 그 단계로 갈 차례를 적는다. 계획 창이 있으면 그 창을 앞으로 가져온다', async () => {
    const focus = vi.fn();
    const win = { focus, closed: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), document: document.implementation.createHTMLDocument('p') } as unknown as Window;
    setWindowOpener({ open: () => win } as never);
    openAppWindow({ kind: 'plan', channelId: 'c1', rootId: R1 });
    focus.mockClear();
    render(<PlanRefChip planRef={{ rootId: R1, stepId: 's2', title: null }} />);
    await act(async () => { fireEvent.click(screen.getByTestId('plan-ref-chip')); });
    expect(focus).toHaveBeenCalled();
    expect(useAppStore.getState().planFocus).toMatchObject({ rootId: R1, stepId: 's2' });
  });
});

describe('💬 와 띠', () => {
  const start = (id: string) => (useAppStore.getState(), new Controller(fakeApi())).startPlanAsk(R1, id);
  const draft = () => useAppStore.getState().drafts[`thread:${R1}`] ?? '';
  const ask = () => useAppStore.getState().planAsks[R1];

  it('받는 이: 관리 에이전트 → 담당 에이전트 → 사람이면 없음', () => {
    useAppStore.getState().set({ threadPlans: { [R1]: plan({ managerId: 'mgr' }) } });
    start('s2');
    expect(draft()).toBe('@manager ');
    expect(ask()).toMatchObject({ reason: 'manager', to: 'mgr' });

    useAppStore.getState().set({ threadPlans: { [R1]: plan() }, planAsks: {}, drafts: {} });
    start('s2');
    expect(draft()).toBe('@builder ');
    expect(ask()?.reason).toBe('assignee');

    useAppStore.getState().set({ planAsks: {}, drafts: {} });
    start('s3');
    expect(draft()).toBe('');
    expect(ask()).toMatchObject({ reason: 'human_assignee', to: null });
  });

  it('다른 단계를 누르면 칩과 받는 이를 바꾸고 쓴 글은 둔다. 포커스 요청이 는다', () => {
    start('s2');
    useAppStore.getState().setDraft(`thread:${R1}`, '@builder 질문');
    const before = ask()!.focus;
    start('s3');
    expect(draft()).toBe('질문');
    expect(ask()).toMatchObject({ stepId: 's3' });
    expect(ask()!.focus).toBe(before + 1);
  });

  it('띠: 까닭을 보이고, ▾로 고르면 멘션이 바뀌고 까닭이 사라진다. ✕ 는 멘션도 거둔다', () => {
    const c = new Controller(fakeApi());
    setController(c);
    c.startPlanAsk(R1, 's2');
    render(<PlanAskBar rootId={R1} />);
    expect(screen.getByTestId('plan-ask-reason').textContent).toBe(en['plan.ask.reason.assignee']);
    expect(within(screen.getByTestId('plan-ask-bar')).getByTestId('plan-ref-chip').tagName).toBe('SPAN');
    fireEvent.change(screen.getByTestId('plan-ask-to'), { target: { value: 'mgr' } });
    expect(draft()).toBe('@manager ');
    expect(screen.queryByTestId('plan-ask-reason')).toBeNull();
    fireEvent.click(screen.getByTestId('plan-ask-close'));
    expect(draft()).toBe('');
    expect(ask()).toBeUndefined();
    expect(screen.queryByTestId('plan-ask-bar')).toBeNull();
  });

  it('단계 줄의 💬: 글자·설명이 있고, 눌러도 줄 이동이 일어나지 않으며, 틀에 알린다. 그룹 머리에는 없다', () => {
    const c = new Controller(fakeApi());
    setController(c);
    const onAsked = vi.fn();
    const go = vi.fn();
    c.openMessage = go as never;
    render(<PlanBody plan={plan({ groups: [{ id: 'g1', title: 'G', dependsOn: [] }] }, [step('s2', { groupId: 'g1', assigneeId: 'bot', links: [{ kind: 'message', id: R2 }] })])} onAsked={onAsked} />);
    const btn = screen.getByTestId('plan-ask-s2');
    expect(btn.getAttribute('title')).toBe(en['plan.ask.button']);
    expect(btn.className).toContain('group-hover:opacity-100');
    expect(btn.className).toContain('focus-visible:opacity-100');
    fireEvent.click(btn);
    expect(ask()?.stepId).toBe('s2');
    expect(onAsked).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
    expect(screen.queryByTestId('plan-ask-g1')).toBeNull();
  });

  it('도움말은 처음 한 번만 보인다', () => {
    const p = plan();
    const first = render(<PlanBody plan={p} />);
    expect(screen.getByTestId('plan-ask-help').textContent).toBe(en['plan.ask.help']);
    first.unmount();
    render(<PlanBody plan={p} />);
    expect(screen.queryByTestId('plan-ask-help')).toBeNull();
  });

  it('보내면 맨 앞 멘션 뒤에 단계 링크가 붙고 띠가 사라진다. 실패하면 띠가 남는다', async () => {
    undoSendStorage.saveWindowMs(0);
    let fail = true;
    const reply = vi.fn(async () => { if (fail) throw new Error('no'); });
    const real = new Controller(fakeApi());
    const c = { reply, openThread: vi.fn(), closeThread: vi.fn(), loadOlder: vi.fn(async () => undefined), api: scheduledApiStub(),
      startPlanAsk: real.startPlanAsk.bind(real), clearPlanAsk: real.clearPlanAsk.bind(real), loadThreadPlan: vi.fn(async () => null) };
    setController(c as unknown as Controller);
    useAppStore.getState().set({
      channels: [chan('c1', 'general', 'main-repo')], threadRootId: R1,
      messages: { c1: [msg(R1, 'c1', 1, 'root', 'me')] },
    });
    render(<ThreadPanel />);
    act(() => { real.startPlanAsk(R1, 's2'); });
    expect(screen.getByTestId('plan-ask-bar')).toBeTruthy();
    const box = screen.getByPlaceholderText(en['plan.ask.hint']) as HTMLTextAreaElement;
    // 채운 받는 이 뒤에서 쓰기 시작한다. 앞에 놓이면 질문이 멘션 앞으로 들어간다.
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)); });
    expect(box.value).toBe('@builder ');
    expect(box.selectionStart).toBe(box.value.length);
    fireEvent.change(box, { target: { value: '@builder how big?' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); await Promise.resolve(); await Promise.resolve(); });
    expect(reply).toHaveBeenCalledWith(`@builder harkroom://plan/${R1}/s2 「Title s2」 how big?`, [], 'c1', R1, false);
    expect(screen.getByTestId('plan-ask-bar')).toBeTruthy();
    fail = false;
    fireEvent.change(box, { target: { value: '@builder again' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(reply).toHaveBeenLastCalledWith(`@builder harkroom://plan/${R1}/s2 「Title s2」 again`, [], 'c1', R1, false);
    expect(screen.queryByTestId('plan-ask-bar')).toBeNull();
  });

  it('칩이 가리킨 단계로 스크롤하고, 막힌 단계면 까닭을 편다', () => {
    const p = plan({}, [step('s1', { state: 'blocked', blockedReason: '키 없음' })]);
    useAppStore.getState().set({ threadPlans: { [R1]: p }, planFocus: { rootId: R1, stepId: 's1', at: 1 } });
    render(<PlanBody plan={p} />);
    expect(document.querySelector('[data-node="s1"]')?.className).toContain('ring-2');
    expect(useAppStore.getState().planFocus).toBeNull();
  });
});
