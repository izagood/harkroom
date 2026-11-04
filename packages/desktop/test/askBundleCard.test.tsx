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
let decideCheck: ReturnType<typeof vi.fn>;
let apiAnswerBundleItem: ReturnType<typeof vi.fn>;
let closeAsk: ReturnType<typeof vi.fn>;
let acceptRecommendedBundle: ReturnType<typeof vi.fn>;
let openMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  roots = {};
  decideCheck = vi.fn(async () => ({ viewerCanDecide: true, asOwner: true, decideScope: 'owner', ownerAccountId: ME }));
  apiAnswerBundleItem = vi.fn(async () => bundleMessage([]));
  closeAsk = vi.fn(async () => root('r1'));
  answerBundleItem = vi.fn().mockResolvedValue(null);
  acceptRecommendedBundle = vi.fn().mockResolvedValue([]);
  openMessage = vi.fn().mockResolvedValue(undefined);
  setController({
    api: {
      message: vi.fn(async (id: string) => { const r = roots[id]; if (!r || r instanceof Error) throw r ?? new Error('404'); return r; }),
      decideCheck, answerBundleItem: apiAnswerBundleItem, closeAsk,
    },
    answerBundleItem, acceptRecommendedBundle, openMessage,
    getMergeAccounts: vi.fn(async () => ({ report: null })),
  } as unknown as Controller);
  useAppStore.getState().set({
    me: acc(ME, 'alice'),
    accounts: { [ME]: acc(ME, 'alice'), [PM]: acc(PM, 'task_manager', 'agent'), [SEC]: acc(SEC, 'security', 'agent') },
  });
});
const SHA = 'a'.repeat(40);
const LINE = { cap: 'tool', scope: 'Bash(kubectl logs:*)', limits: { approve_new_mandate: { untilMs: 604_800_000 } } };
/** 권한 카드 원본. 요청 채널은 묶음 채널(c-task)과 다르다. */
const permRoot = (id: string, pr: Record<string, unknown> = {}, ask: Record<string, unknown> = {}, body = '권한 요청 · @security\n명령 허용 `Bash(kubectl logs:*)`\n이유: 로그를 봐야 한다'): MessageRow =>
  msg(id, 'c-work', 1, body, SEC, {
    meta: {
      kind: 'ask',
      ask: { options: [{ id: 'approve_new_mandate', label: 'x' }, { id: 'deny', label: 'y' }], to: { kind: 'human' }, ...ask },
      permissionRequest: { requestId: 'q1', agentId: SEC, ownerAccountId: ME, channelId: 'c-work', kind: 'tool', status: 'pending', bodyTargetLine: '명령 허용 `Bash(kubectl logs:*)`', line: LINE, ...pr },
    },
  });
const newServer = () => useAppStore.getState().set({ serverVersion: { version: '9.9.9' } } as never);

afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('AskBundleCard', () => {
  it('열린 줄 수를 머리에 세고, 칩을 누르면 그 줄의 원본에 답한다', async () => {
    roots = { r1: root('r1'), r2: root('r2', { answeredWith: 'b', answeredBy: ME }) };
    render(<MessageItem message={bundleMessage([item('r1'), item('r2')])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('open'));
    expect(screen.getByTestId('ask-bundle-head').textContent).toBe('정할 것 1/2 남음');
    expect(screen.getByTestId('ask-bundle-row-r2').dataset.state).toBe('answered');
    // 조사 없이 「그대로 · alice」 — 2b 카드 머리와 같은 꼴(#1288 designer n1).
    expect(screen.getByTestId('ask-bundle-row-r2').textContent).toContain('그대로 · alice');
    expect(screen.getByTestId('ask-bundle-row-r2').textContent).not.toContain('골랐다');
    fireEvent.click(screen.getByTestId('ask-bundle-option-r1-b'));
    expect(answerBundleItem).toHaveBeenCalledWith('m-bundle', 'c-task', 'r1', 'b');
  });

  it('권한 줄: 원본의 대상·이유·버튼을 펼쳐 그 자리에서 정한다. 원 스레드 링크는 보조, 일괄에는 안 든다', async () => {
    newServer();
    roots = { r1: permRoot('r1') };
    render(<MessageItem message={bundleMessage([item('r1', { link: true })])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('decide'));
    expect(screen.getByTestId('ask-bundle-head').textContent).toBe('정할 것 1/1 남음');
    expect(screen.getByTestId('mandate-line-scope').textContent).toBe('Bash(kubectl logs:*)');
    expect(screen.getByTestId('mandate-context').textContent).toBe('이유: 로그를 봐야 한다');
    expect(screen.queryByTestId('ask-bundle-accept')).toBeNull();
    const main = await screen.findByTestId('ask-option-approve_new_mandate');
    expect(main.textContent).toBe('원 스레드로 위임장 만들고 더하기');
    // 결정권은 묶음 채널이 아니라 요청 채널로 묻는다(R3).
    expect(decideCheck).toHaveBeenCalledWith(SEC, 'c-work');
    fireEvent.click(main);
    expect(answerBundleItem).toHaveBeenCalledWith('m-bundle', 'c-task', 'r1', 'approve_new_mandate');
    fireEvent.click(screen.getByTestId('ask-bundle-original-r1'));
    expect(openMessage).toHaveBeenCalledWith('r1');
  });

  it('권한 줄: 결정권이 없으면 버튼·링크 없이 기다리는 줄만 선다', async () => {
    newServer();
    decideCheck.mockResolvedValue({ viewerCanDecide: false, asOwner: false, decideScope: 'owner', ownerAccountId: SEC });
    roots = { r1: permRoot('r1', { ownerAccountId: SEC }) };
    render(<MessageItem message={bundleMessage([item('r1', { link: true })])} />);
    await screen.findByTestId('mandate-owner-only');
    expect(screen.queryByTestId('ask-option-approve_new_mandate')).toBeNull();
    expect(screen.queryByTestId('ask-bundle-original-r1')).toBeNull();
  });

  it('권한 줄: 실패하면 그 줄 안에 이유가 선다', async () => {
    newServer();
    answerBundleItem.mockResolvedValue({ status: 403, code: 'forbidden', message: 'no' });
    roots = { r1: permRoot('r1') };
    render(<MessageItem message={bundleMessage([item('r1', { link: true })])} />);
    fireEvent.click(await screen.findByTestId('ask-option-approve_new_mandate'));
    expect((await screen.findByTestId('mandate-answer-error')).textContent).toBeTruthy();
  });

  const merge = { kind: 'merge', target: 'example-org/svc', once: { number: 7, headSha: SHA, reason: 'cause_not_human' }, line: { cap: 'merge', scope: 'example-org/svc', limits: { approve_once: { pr: 7, head: SHA, uses: 1 } } } };
  const onceOptions = [{ id: 'approve_once', label: 'x' }, { id: 'deny', label: 'y' }];

  it('머지 줄의 [이번 한 번]: 소유자는 계정 칸을 보고 묶음 길로 보낸다', async () => {
    newServer();
    const options = onceOptions;
    roots = { r1: permRoot('r1', merge, { options }) };
    render(<MessageItem message={bundleMessage([item('r1', { link: true })])} />);
    const press = await screen.findByTestId('ask-option-approve_once');
    await screen.findByTestId('merge-once-account-row');
    fireEvent.click(press);
    await waitFor(() => expect(apiAnswerBundleItem).toHaveBeenCalledWith('c-task', 'm-bundle', 'r1', 'approve_once', { relaxChecks: false, number: 7, headSha: SHA }));
  });

  it('머지 줄의 [이번 한 번]: 소유자가 아니면 계정 칸 없이 오퍼레이터가 고른다고 쓴다', async () => {
    newServer();
    decideCheck.mockResolvedValue({ viewerCanDecide: true, asOwner: false, decideScope: 'community', ownerAccountId: SEC });
    roots = { r2: permRoot('r2', { ...merge, ownerAccountId: SEC }, { options: onceOptions }) };
    render(<MessageItem message={bundleMessage([item('r2', { link: true })])} />);
    expect(await screen.findByTestId('merge-once-operator-picks')).toBeTruthy();
    expect(screen.queryByTestId('merge-once-account-row')).toBeNull();
    expect(screen.queryByTestId('merge-once-change-account')).toBeNull();
  });

  it('권한 줄이 끝나면 한 줄로 접히고 어느 스레드의 위임장인지·대상 앞부분을 남긴다', async () => {
    newServer();
    roots = { r1: permRoot('r1', { status: 'granted' }, { answeredWith: 'approve_new_mandate', answeredBy: ME }) };
    render(<MessageItem message={bundleMessage([item('r1', { link: true })])} />);
    const got = await screen.findByTestId('ask-bundle-result');
    expect(got.textContent).toContain('원 스레드에 위임장을 만들고 더함 · alice');
    expect(got.textContent).toContain('tool Bash(kubectl logs:*)');
    expect(screen.queryByTestId('ask-option-approve_new_mandate')).toBeNull();
  });

  it('새 서버에서 원본을 못 보면 링크 없이 말한다. 시한 지난 권한 줄은 버튼을 그리지 않는다', async () => {
    newServer();
    roots = { r2: permRoot('r2', { expiresAt: '2020-01-01T00:00:00Z' }) };
    render(<MessageItem message={bundleMessage([item('r1', { link: true }), item('r2', { link: true })])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('unavailable'));
    expect(screen.getByTestId('ask-bundle-row-r1').textContent).toContain('원본 카드를 볼 수 없다');
    expect(screen.queryByTestId('ask-bundle-link-r1')).toBeNull();
    expect(screen.getByTestId('ask-bundle-row-r2').dataset.state).toBe('expired');
  });

  it('접힌 줄: 위임장 줄 없이 7일 허락으로 끝났으면 위임장에 더했다고 말하지 않고 기한을 쓴다(원 카드와 같다)', async () => {
    newServer();
    const options = [{ id: 'approve_mandate', label: 'x' }, { id: 'deny', label: 'y' }];
    roots = {
      r1: permRoot('r1', { status: 'granted', grantExpiresAt: '2099-11-09T00:00:00.000Z' }, { options, answeredWith: 'approve_mandate', answeredBy: ME }),
      r2: permRoot('r2', { status: 'granted', grantExpiresAt: '2020-11-09T00:00:00.000Z' }, { options, answeredWith: 'approve_mandate', answeredBy: ME }),
    };
    render(<MessageItem message={bundleMessage([item('r1', { link: true }), item('r2', { link: true })])} />);
    await screen.findAllByTestId('ask-bundle-result');
    expect(screen.getByTestId('ask-bundle-row-r1').textContent).toMatch(/\d\d\/\d\d까지 허락함 · alice/);
    expect(screen.getByTestId('ask-bundle-row-r1').textContent).not.toContain('위임장에 더함');
    expect(screen.getByTestId('ask-bundle-row-r2').textContent).toContain('7일 허락 끝남 · alice');
  });

  it('권한 줄은 위에서 3개만 펼친다. 나머지는 대상 한 줄에 버튼 없이 서고, 눌러야 펼쳐지며, 앞 줄이 끝나면 다음 줄이 펼쳐진다', async () => {
    newServer();
    roots = Object.fromEntries(['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => [id, permRoot(id)]));
    const rows = Object.keys(roots).map((id) => item(id, { link: true }));
    const { rerender } = render(<MessageItem message={bundleMessage(rows)} />);
    await screen.findByTestId('ask-bundle-decide-r3');
    expect(screen.getByTestId('ask-bundle-head').textContent).toBe('정할 것 5/5 남음');
    expect(screen.queryByTestId('ask-bundle-decide-r4')).toBeNull();
    expect(screen.getByTestId('ask-bundle-target-r4').textContent).toContain('tool Bash(kubectl logs:*)');
    expect(screen.queryByTestId('ask-bundle-row-r4')!.querySelector('[data-testid^="ask-option-"]')).toBeNull();
    fireEvent.click(screen.getByTestId('ask-bundle-expand-r5'));
    await screen.findByTestId('ask-bundle-decide-r5');
    expect(screen.queryByTestId('ask-bundle-decide-r4')).toBeNull();
    // r1 이 끝나면 r4 가 3개 안으로 들어온다.
    roots = { ...roots, r1: permRoot('r1', { status: 'denied' }, { answeredWith: 'deny', answeredBy: ME }) };
    rerender(<MessageItem message={{ ...bundleMessage(rows), seq: 6 }} />);
    await screen.findByTestId('ask-bundle-decide-r4');
    expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('answered');
  });

  it('보통 줄의 「답하지 않기」는 원본을 닫는다', async () => {
    roots = { r1: root('r1') };
    render(<MessageItem message={bundleMessage([item('r1')])} />);
    fireEvent.click(await screen.findByTestId('ask-bundle-decline-r1'));
    await waitFor(() => expect(closeAsk).toHaveBeenCalledWith('c-work', 'r1'));
  });

  it('옛 서버·줄 없는 카드의 권한 줄은 원 스레드로 가는 링크로만 선다', async () => {
    roots = { r1: root('r1', {}) };
    render(<MessageItem message={bundleMessage([item('r1', { link: true })])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('link'));
    expect(screen.queryByTestId('ask-bundle-option-r1-a')).toBeNull();
    fireEvent.click(screen.getByTestId('ask-bundle-link-r1'));
    expect(openMessage).toHaveBeenCalledWith('r1');
  });

  // 스레드 65f3b26e(designer s1): 만료로 닫힌 권한 줄을 「답 없이 닫힘」으로 말하지 않는다.
  it('권한 요청이 만료돼 닫힌 줄은 「만료됨」 이다', async () => {
    roots = { r1: root('r1', { closedAt: new Date().toISOString(), closedReason: 'expired' }) };
    render(<MessageItem message={bundleMessage([item('r1', { link: true })])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('expired'));
    expect(screen.getByTestId('ask-bundle-row-r1').textContent).toContain('만료됨 · 에이전트가 다시 청해야 한다');
    expect(screen.getByTestId('ask-bundle-row-r1').textContent).not.toContain('답 없이');
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
    answerBundleItem.mockResolvedValue({ status: 500, code: 'failed', message: 'boom' });
    acceptRecommendedBundle.mockResolvedValue(null);
    render(<MessageItem message={bundleMessage([item('r1')])} />);
    await waitFor(() => expect(screen.getByTestId('ask-bundle-row-r1').dataset.state).toBe('open'));
    await act(async () => { fireEvent.click(screen.getByTestId('ask-bundle-option-r1-b')); });
    // 어느 줄이 왜 실패했는지는 그 줄 안에 선다(designer b).
    expect((await screen.findByTestId('ask-bundle-error-r1')).textContent).toContain('boom');
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
