// 묶음 카드(선택 카드 P1, 2026-10-10) — 줄의 상태는 원본 카드에서 읽고, 칩을 누르면 원본에 답이 적힌다.
// 「추천대로」의 결과는 줄마다 보이고, 되돌릴 수 없는 줄이 빠진 까닭을 사람이 읽는다(security 3b ②).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { AskBundleItem, MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const ME = 'u-me';
const PM = 'a-pm';
const SEC = 'a-sec';
const OPTS = [{ id: 'a', label: '줄인다', recommended: true }, { id: 'b', label: '그대로' }];

const item = (rootId: string, over: Partial<AskBundleItem> = {}): AskBundleItem => ({
  rootId, askerId: SEC, channelId: 'c-work', threadRootId: null, prompt: `${rootId} 물음`, options: OPTS, ...over,
});
const root = (id: string, ask: Record<string, unknown> = {}): MessageRow =>
  msg(id, 'c-work', 1, '골라 줘', SEC, { meta: { kind: 'ask', ask: { options: OPTS, to: { kind: 'human' }, ...ask } } });
const bundleMessage = (items: AskBundleItem[]): MessageRow =>
  msg('m-bundle', 'c-task', 5, '정할 것 모음', PM, { meta: { kind: 'askBundle', askBundle: { items } } });

let roots: Record<string, MessageRow | Error>;
let answerBundleItem: ReturnType<typeof vi.fn>;
let acceptRecommendedBundle: ReturnType<typeof vi.fn>;
let openMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  roots = {};
  answerBundleItem = vi.fn().mockResolvedValue(undefined);
  acceptRecommendedBundle = vi.fn().mockResolvedValue([]);
  openMessage = vi.fn().mockResolvedValue(undefined);
  setController({
    api: { message: vi.fn(async (id: string) => { const r = roots[id]; if (!r || r instanceof Error) throw r ?? new Error('404'); return r; }) },
    answerBundleItem, acceptRecommendedBundle, openMessage,
  } as unknown as Controller);
  useAppStore.getState().set({
    me: acc(ME, 'jaebin'),
    accounts: { [ME]: acc(ME, 'jaebin'), [PM]: acc(PM, 'task_manager', 'agent'), [SEC]: acc(SEC, 'security', 'agent') },
  });
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('AskBundleCard', () => {
  it('열린 줄 수를 머리에 세고, 칩을 누르면 그 줄의 원본에 답한다', async () => {
    roots = { r1: root('r1'), r2: root('r2', { answeredWith: 'b', answeredBy: ME }) };
    render(<MessageItem message={bundleMessage([item('r1'), item('r2')])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('open'));
    expect(screen.getByTestId('ask-bundle-head').textContent).toBe('정할 것 1/2 남음');
    expect(screen.getByTestId('ask-bundle-row-r2').dataset.state).toBe('answered');
    expect(screen.getByTestId('ask-bundle-row-r2').textContent).toContain('그대로 · jaebin');
    fireEvent.click(screen.getByTestId('ask-bundle-option-r1-b'));
    expect(answerBundleItem).toHaveBeenCalledWith('m-bundle', 'c-task', 'r1', 'b');
  });

  it('권한 요청·머지 거절 줄은 원 스레드로 가는 링크로만 선다', async () => {
    roots = { r1: root('r1', {}) };
    render(<MessageItem message={bundleMessage([item('r1', { link: true })])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('link'));
    expect(screen.queryByTestId('ask-bundle-option-r1-a')).toBeNull();
    fireEvent.click(screen.getByTestId('ask-bundle-link-r1'));
    expect(openMessage).toHaveBeenCalledWith('r1');
  });

  it('글로 답한 줄의 요지는 누가 요약했는지 밝힌다(security n1)', async () => {
    roots = { r1: root('r1', { closedAt: '2026-10-10T00:00:00Z', closedBy: ME, closedReason: 'replied', replyNote: 'PAT 는 다르게', replyNoteBy: PM }) };
    render(<MessageItem message={bundleMessage([item('r1')])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('replied'));
    expect(screen.getByTestId('ask-bundle-note-r1').textContent).toBe('task_manager 요약: PAT 는 다르게');
    expect(screen.getByTestId('ask-bundle-head').textContent).toBe('1개 모두 정해졌다');
  });

  it('원본을 볼 수 없으면 지어내지 않고 그렇다고 말한다', async () => {
    roots = { r1: new Error('403') };
    render(<MessageItem message={bundleMessage([item('r1')])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('unavailable'));
    expect(screen.getByText('원본 카드를 볼 수 없다')).toBeTruthy();
  });

  it('「추천대로」 뒤 빠진 줄은 까닭과 함께 남는다(security 3b ②)', async () => {
    roots = { r1: root('r1'), r2: root('r2') };
    acceptRecommendedBundle.mockResolvedValue([
      { rootId: 'r1', outcome: 'answered' }, { rootId: 'r2', outcome: 'skipped_irreversible' },
    ]);
    render(<MessageItem message={bundleMessage([item('r1'), item('r2')])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-accept').textContent).toBe('남은 2개 추천대로'));
    fireEvent.click(screen.getByTestId('ask-bundle-accept'));
    await waitFor(() => expect(screen.getByTestId('ask-bundle-skip-r2').dataset.outcome).toBe('skipped_irreversible'));
    expect(screen.getByTestId('ask-bundle-skip-r2').textContent).toContain('되돌릴 수 없는 결정');
    expect(screen.queryByTestId('ask-bundle-skip-r1')).toBeNull();
    expect(acceptRecommendedBundle).toHaveBeenCalledWith('m-bundle', 'c-task');
  });

  it('에이전트 화면에서는 고를 수 없다 — 사람만 고른다', async () => {
    useAppStore.getState().set({ me: acc(PM, 'task_manager', 'agent') });
    roots = { r1: root('r1') };
    render(<MessageItem message={bundleMessage([item('r1')])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('open'));
    expect((screen.getByTestId('ask-bundle-option-r1-a') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('ask-bundle-accept')).toBeNull();
  });
});
