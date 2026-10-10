// 묶음 카드(선택 카드 P1, 2026-10-10) — 줄의 상태는 원본 카드에서 읽고, 칩을 누르면 원본에 답이 적힌다.
// 「추천대로」의 결과는 줄마다 보이고, 되돌릴 수 없는 줄이 빠진 까닭을 사람이 읽는다(security 3b ②).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
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
  answerBundleItem = vi.fn().mockResolvedValue(true);
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
    // 조사 없이 「그대로 · jaebin」 — 2b 카드 머리와 같은 꼴(#1288 designer n1).
    expect(screen.getByTestId('ask-bundle-row-r2').textContent).toContain('그대로 · jaebin');
    expect(screen.getByTestId('ask-bundle-row-r2').textContent).not.toContain('골랐다');
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

  /**
   * 5초 기다림을 건너뛴다. `waitFor` 는 가짜 타이머 아래에서 돌지 않으므로 **이 구간만** 가짜로 두고 끝나면 되돌린다.
   * 효과가 한 번에 한 틱씩 세므로 1초씩 다섯 번, 끝에 보내기(약속)를 비운다.
   */
  const pressAcceptAndWait = async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(screen.getByTestId('ask-bundle-accept'));
      for (let i = 0; i < 5; i += 1) await act(async () => { vi.advanceTimersByTime(1000); });
    } finally {
      vi.useRealTimers();
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };

  it('「추천대로」는 5초 뒤에 보내고, 그 안에 취소하면 아무것도 보내지 않는다(designer s2)', async () => {
    roots = { r1: root('r1'), r2: root('r2') };
    render(<MessageItem message={bundleMessage([item('r1'), item('r2')])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-accept').textContent).toBe('남은 2개 추천대로'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(screen.getByTestId('ask-bundle-accept'));
      expect(screen.getByTestId('ask-bundle-pending').textContent).toContain('2개를 추천대로 고른다 · 5');
      // 기다리는 동안은 칩도 잠근다 — 일괄과 낱개가 엇갈리지 않게.
      expect((screen.getByTestId('ask-bundle-option-r1-a') as HTMLButtonElement).disabled).toBe(true);
      for (let i = 0; i < 2; i += 1) await act(async () => { vi.advanceTimersByTime(1000); });
      expect(screen.getByTestId('ask-bundle-pending').textContent).toContain('· 3');
      fireEvent.click(screen.getByTestId('ask-bundle-cancel'));
      expect(screen.queryByTestId('ask-bundle-pending')).toBeNull();
      for (let i = 0; i < 6; i += 1) await act(async () => { vi.advanceTimersByTime(1000); });
    } finally {
      vi.useRealTimers();
    }
    expect(acceptRecommendedBundle).not.toHaveBeenCalled();

    await pressAcceptAndWait();
    expect(acceptRecommendedBundle).toHaveBeenCalledTimes(1);
    expect(acceptRecommendedBundle).toHaveBeenCalledWith('m-bundle', 'c-task');
  });

  it('「추천대로」 뒤 빠진 줄은 까닭이 남고, n 에서 빠진다(security 3b ②·designer s1)', async () => {
    roots = { r1: root('r1'), r2: root('r2'), r3: root('r3') };
    acceptRecommendedBundle.mockResolvedValue([
      { rootId: 'r1', outcome: 'skipped_irreversible' }, { rootId: 'r2', outcome: 'skipped_link' },
      { rootId: 'r3', outcome: 'skipped_no_recommendation' },
    ]);
    render(<MessageItem message={bundleMessage([item('r1'), item('r2'), item('r3')])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-accept').textContent).toBe('남은 3개 추천대로'));
    await pressAcceptAndWait();
    await waitFor(() => expect(screen.getByTestId('ask-bundle-skip-r1').dataset.outcome).toBe('skipped_irreversible'));
    expect(screen.getByTestId('ask-bundle-skip-r1').textContent).toContain('되돌릴 수 없는 결정');
    // 언제나 빠지는 둘(되돌릴 수 없음·링크)은 n 에서 뺀다. 추천이 없던 줄은 원본에 추천이 생기면 다시 셀 수 있어 남긴다.
    expect(screen.getByTestId('ask-bundle-accept').textContent).toBe('남은 1개 추천대로');
  });

  it('다시 눌러도 같은 줄만 남으면 버튼이 숨는다(designer s1)', async () => {
    roots = { r1: root('r1') };
    acceptRecommendedBundle.mockResolvedValue([{ rootId: 'r1', outcome: 'skipped_irreversible' }]);
    render(<MessageItem message={bundleMessage([item('r1')])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-accept')).toBeTruthy());
    await pressAcceptAndWait();
    await waitFor(() => expect(screen.getByTestId('ask-bundle-skip-r1')).toBeTruthy());
    expect(screen.queryByTestId('ask-bundle-accept')).toBeNull();
  });

  it('줄 답·일괄이 실패하면 알린다(designer n2·security n2)', async () => {
    roots = { r1: root('r1') };
    answerBundleItem.mockResolvedValue(false);
    acceptRecommendedBundle.mockResolvedValue(null);
    render(<MessageItem message={bundleMessage([item('r1')])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('open'));
    await act(async () => { fireEvent.click(screen.getByTestId('ask-bundle-option-r1-b')); });
    await waitFor(() => expect(useAppStore.getState().notices.map((n) => n.text)).toContain('고르지 못했다 — 다시 시도해 줘'));
    await pressAcceptAndWait();
    await waitFor(() => expect(useAppStore.getState().notices.map((n) => n.text)).toContain('추천대로 고르지 못했다 — 다시 시도해 줘'));
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
