/** W4 위임장 줄 카드(designer 시안 v1) — 선택지 묶음·거울(진짜/중립)·이름 없는 칩·끝난 상태·글로 답함 표시. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { MessageRow } from '@harkroom/shared';
import { AskCard } from '../src/components/AskCard';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';

const ME = 'owner-1';
const ROOT = '11111111-2222-4333-8444-555555555555';
const M2 = '22222222-3333-4444-8555-666666666666';
const CHAT = '33333333-4444-4555-8666-777777777777';
const MANDATE = { id: 'md1', name: 'M2.7 전환', ownerId: ME, startedAt: '2026-10-21T03:00:00Z' };
const LINE = { cap: 'merge', scope: 'repo:example-org/svc', limits: { approve_mandate: { untilMs: 7 * 86_400_000 }, approve_once: { pr: 404, head: '7b7dd25abc', uses: 1 } } };
function card(opts: { options?: string[]; pr?: Record<string, unknown>; ask?: Record<string, unknown>; mirror?: Record<string, unknown> } = {}): MessageRow {
  const options = (opts.options ?? ['approve_mandate', 'deny']).map((id) => ({ id, label: id }));
  return {
    id: 'm1', seq: 1, channelId: 'c1', threadRootId: 't1', authorId: 'agent-1', body: 'card', kind: 'user', createdAt: '', editedAt: null, reactions: [], attachments: [],
    meta: {
      kind: 'ask', ask: { options, to: { kind: 'human' }, ...opts.ask },
      ...(opts.mirror ? { permissionMirror: opts.mirror } : {
        permissionRequest: { requestId: 'r1', agentId: 'agent-1', ownerAccountId: ME, kind: 'tool', target: 'Bash(psql:*)', status: 'pending', mandate: MANDATE, line: { cap: 'tool', scope: 'Bash(psql:*)', limits: { approve_mandate: { untilMs: 7 * 86_400_000 } } }, ...opts.pr },
      }),
    },
  } as unknown as MessageRow;
}
let answerAsk: ReturnType<typeof vi.fn>;
beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({ me: acc(ME, 'alice'), accounts: { [ME]: acc(ME, 'alice'), 'agent-1': acc('agent-1', 'rcms', 'agent', false, { ownerAccountId: ME }), other: acc('other', 'carol') } });
  answerAsk = vi.fn(async () => {});
  setController({ answerAsk, closeAsk: vi.fn() } as unknown as Controller);
});
afterEach(cleanup);

describe('W4 mandate line card', () => {
  it('open tool card: chip, line box, primary + underlined deny, no option list', () => {
    render(<AskCard message={card()} />);
    expect(screen.getByTestId('mandate-chip').textContent).toContain('M2.7 전환 · alice · 10-21 시작');
    expect(screen.getByTestId('mandate-line-cap').textContent).toBe('tool');
    expect(screen.getByTestId('mandate-line-scope').textContent).toBe('Bash(psql:*)');
    expect(screen.getByTestId('mandate-line-limits').textContent).toContain('7일');
    expect(screen.getByTestId('ask-option-approve_mandate').textContent).toBe('이 위임장 동안');
    expect(screen.queryByTestId('ask-option-approve_once')).toBeNull();
    expect(screen.getByTestId('ask-option-deny').getAttribute('aria-label')).toBe('이 요청 거절');
    expect(screen.queryByTestId('ask-decline')).toBeNull();
    fireEvent.click(screen.getByTestId('ask-option-approve_mandate'));
    expect(answerAsk).toHaveBeenCalledWith('m1', 'approve_mandate', 'c1');
  });
  it('no-mandate turn: [이 스레드로 위임장 만들고 더하기] and 「위임장 없음」', () => {
    render(<AskCard message={card({ options: ['approve_new_mandate', 'deny'], pr: { mandate: undefined, line: { cap: 'tool', scope: 'x', limits: { approve_new_mandate: { untilMs: 1 } } } } })} />);
    expect(screen.getByTestId('ask-option-approve_new_mandate').textContent).toBe('이 스레드로 위임장 만들고 더하기');
    expect(screen.getByTestId('mandate-chip').textContent).toContain('위임장 없음');
  });
  it('nameless chip falls back to 위임장 · owner · MM-DD 시작', () => {
    render(<AskCard message={card({ pr: { mandate: { ...MANDATE, name: '' } } })} />);
    expect(screen.getByTestId('mandate-chip').textContent).toBe('🔑 위임장 · alice · 10-21 시작');
    expect(screen.getByTestId('mandate-chip').dataset.nameless).toBe('true');
  });
  it('command card: [이번 한 번] is the primary and answers approve_once', () => {
    render(<AskCard message={card({ options: ['approve_once', 'deny'], pr: { kind: 'command', line: { cap: 'command', scope: 'gh pr edit 1', limits: { approve_once: { untilMs: 3_600_000, uses: 1 } } } } })} />);
    expect(screen.getByTestId('mandate-line-limits').textContent).toContain('1시간');
    fireEvent.click(screen.getByTestId('ask-option-approve_once'));
    expect(answerAsk).toHaveBeenCalledWith('m1', 'approve_once', 'c1');
  });
  it('original merge-refusal card: one card — PR/head inside, [이번 한 번] secondary once, account row inside the card', () => {
    setController({ answerAsk, closeAsk: vi.fn(), approvePermissionOnce: vi.fn(), getMergeAccounts: vi.fn(async () => ({ operatorId: null, report: null })) } as unknown as Controller);
    render(<AskCard message={card({ pr: { kind: 'merge', line: LINE, once: { number: 404, headSha: '7b7dd25abc', reason: 'not_granted' } } })} />);
    expect(screen.getByTestId('ask-option-approve_mandate')).toBeTruthy();
    expect(screen.getAllByTestId('ask-option-approve_once')).toHaveLength(1);
    const body = screen.getByTestId('mandate-body');
    expect(body.contains(screen.getByTestId('merge-once-card'))).toBe(true);
    expect(body.contains(screen.getByTestId('merge-once-head'))).toBe(true);
    expect(body.contains(screen.getByTestId('merge-once-account-row'))).toBe(true);
    expect(screen.getByTestId('merge-once-account-row').textContent).toContain('실행 기기가 고름');
    expect(screen.queryByTestId('merge-once-open')).toBeNull();
    const change = screen.getByTestId('merge-once-change-account');
    expect(change.className).toContain('text-fg-subtle');
    expect(change.className).toContain('decoration-dotted');
  });
  it('CI-override card shows the once button exactly once, labelled 「CI 실패 무시하고 이번 한 번」', async () => {
    const approvePermissionOnce = vi.fn(async () => ({ status: 'approved_once', approvalExpiresAt: '2099-10-11T05:14:00Z', cardMessageId: 'm1' }));
    setController({ answerAsk, closeAsk: vi.fn(), approvePermissionOnce, getMergeAccounts: vi.fn() } as unknown as Controller);
    const ciLine = { cap: 'merge', scope: 'repo:example-org/svc', limits: { approve_once: { pr: 61, head: '3c9e0a1', uses: 1, ciOverride: true } } };
    render(<AskCard message={card({ options: ['approve_once', 'deny'], pr: { kind: 'merge', line: ciLine, once: { number: 61, headSha: '3c9e0a1ff', reason: 'ci_not_green', failedChecks: ['tflint'] } } })} />);
    const btns = screen.getAllByRole('button').filter((b) => /이번 한 번/.test(b.textContent ?? ''));
    expect(btns).toHaveLength(1);
    const onceBtn = btns[0]!;
    expect(onceBtn.textContent).toBe('CI 실패 무시하고 이번 한 번');
    expect(screen.getByTestId('merge-once-checks').textContent).toContain('tflint');
    fireEvent.click(onceBtn);
    await vi.waitFor(() => expect(approvePermissionOnce).toHaveBeenCalledWith('agent-1', 'r1', { relaxChecks: true, number: 61, headSha: '3c9e0a1ff', failedChecks: ['tflint'] }));
    expect(answerAsk).not.toHaveBeenCalled();
    await screen.findByTestId('merge-once-approved');
    expect(screen.queryByTestId('ask-option-approve_once')).toBeNull();
  });
  it('picking an account under [계정 바꾸기…] then [이번 한 번] sends that ghUser; [취소] collapses back to default', async () => {
    useActiveStore.getState().set({ serverVersion: { version: '0.4.199' } as never });
    const approvePermissionOnce = vi.fn(async () => ({ status: 'approved_once', approvalExpiresAt: '2099-10-11T05:14:00Z', cardMessageId: 'm1' }));
    const getMergeAccounts = vi.fn(async () => ({ operatorId: 'op', report: {
      logins: ['remote-a', 'remote-b'], defaultGhUser: null, byScope: { 'example-org/*': 'remote-a' },
      reach: [{ scope: 'example-org/*', login: 'remote-a', reachable: true }], reportedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    } }));
    setController({ answerAsk, closeAsk: vi.fn(), approvePermissionOnce, getMergeAccounts } as unknown as Controller);
    render(<AskCard message={card({ pr: { kind: 'merge', target: 'example-org/svc', line: LINE, once: { number: 404, headSha: '7b7dd25abc', reason: 'not_granted' } } })} />);
    await screen.findByTestId('merge-once-reported');
    expect(screen.getByTestId('merge-once-account-current').textContent).toContain('example-org/* → remote-a');
    expect(screen.getByTestId('merge-once-reported').textContent).toContain('2분 전 보고');
    fireEvent.click(screen.getByTestId('merge-once-change-account'));
    const sel = await screen.findByTestId('merge-once-remote-account') as HTMLSelectElement;
    expect(screen.getByText('머지 계정 (그 기기)')).toBeTruthy();
    fireEvent.change(sel, { target: { value: 'remote-b' } });
    expect(screen.getByTestId('merge-once-account-pinned').textContent).toContain('remote-b');
    fireEvent.click(screen.getByTestId('merge-once-cancel'));
    expect(screen.queryByTestId('merge-once-form')).toBeNull();
    expect(screen.queryByTestId('merge-once-account-pinned')).toBeNull();
    fireEvent.click(screen.getByTestId('merge-once-change-account'));
    fireEvent.change(await screen.findByTestId('merge-once-remote-account'), { target: { value: 'remote-b' } });
    fireEvent.click(screen.getByTestId('ask-option-approve_once'));
    await vi.waitFor(() => expect(approvePermissionOnce).toHaveBeenCalledWith('agent-1', 'r1', { ghUser: 'remote-b', relaxChecks: false, number: 404, headSha: '7b7dd25abc' }));
    expect(answerAsk).not.toHaveBeenCalled();
  });
  it('genuine mirror renders the same card incl. [이번 한 번]', () => {
    render(<AskCard message={card({ mirror: { rootId: ROOT, neutral: false, kind: 'merge', line: LINE, mandate: MANDATE, once: { number: 404, headSha: '7b7dd25abc', reason: 'not_granted' } } })} />);
    expect(screen.getByTestId('mandate-mirror-genuine')).toBeTruthy();
    expect(screen.getByTestId('mandate-mirror-link').getAttribute('href')).toBe(`harkroom://message/${ROOT}`);
    fireEvent.click(screen.getByTestId('ask-option-approve_once'));
    expect(answerAsk).toHaveBeenCalledWith('m1', 'approve_once', 'c1');
    expect(screen.queryByTestId('merge-once-account')).toBeNull();
    expect(screen.queryByTestId('merge-once-account-row')).toBeNull();
    expect(screen.queryByTestId('merge-once-change-account')).toBeNull();
    expect(screen.getAllByTestId('ask-option-approve_once')).toHaveLength(1);
  });
  it('neutral mirror shows only a line + link', () => {
    render(<AskCard message={card({ mirror: { rootId: ROOT, neutral: true } })} />);
    expect(screen.getByTestId('mandate-mirror-neutral')).toBeTruthy();
    expect(screen.queryByTestId('mandate-line')).toBeNull();
    expect(screen.queryByTestId('ask-option-deny')).toBeNull();
  });
  it.each([
    ['added', { pr: { status: 'granted' }, ask: { answeredWith: 'approve_mandate', answeredBy: ME } }],
    ['once', { options: ['approve_once', 'deny'], pr: { status: 'approved_once', kind: 'command', line: { cap: 'command', scope: 'x', limits: { approve_once: { uses: 1 } } } }, ask: { answeredWith: 'approve_once', answeredBy: ME } }],
    ['denied', { pr: { status: 'denied' }, ask: { answeredWith: 'deny', answeredBy: ME } }],
    ['expired', { pr: { status: 'expired' }, ask: { closedAt: '2026-10-22T00:00:00Z', closedReason: 'expired' } }],
    ['superseded', { pr: { status: 'superseded' }, ask: { closedAt: '2026-10-22T00:00:00Z', closedReason: 'superseded', supersededBy: M2 } }],
  ])('ended state %s', (state, opts) => {
    render(<AskCard message={card(opts as Parameters<typeof card>[0])} />);
    expect(screen.getByTestId('mandate-ended').dataset.state).toBe(state);
    expect(screen.getByTestId('mandate-line')).toBeTruthy();
    expect(screen.queryByTestId('ask-option-deny')).toBeNull();
    if (state === 'superseded') expect(screen.getByTestId('mandate-new-card').getAttribute('href')).toBe(`harkroom://message/${M2}`);
  });
  it('used-once card and seeing mirror show the operator-picked gh account', () => {
    const line = { cap: 'command', scope: 'x', limits: { approve_once: { uses: 1 } } };
    render(<AskCard message={card({ options: ['approve_once', 'deny'], pr: { status: 'approved_once', kind: 'command', line, ghUserUsed: 'picked-account' }, ask: { answeredWith: 'approve_once', answeredBy: ME } })} />);
    expect(screen.getByTestId('mandate-ended').textContent).toContain('gh picked-account');
    cleanup();
    render(<AskCard message={card({ options: ['approve_once', 'deny'], mirror: { rootId: 'root-1', neutral: false, kind: 'command', line, mandate: MANDATE, ghUserUsed: 'picked-account' }, ask: { answeredWith: 'approve_once', answeredBy: ME } })} />);
    expect(screen.getByTestId('mandate-ended').dataset.state).toBe('once');
    expect(screen.getByTestId('mandate-ended').textContent).toContain('gh picked-account');
  });
  it('viewer not owner: read-only, no chip', () => {
    useActiveStore.getState().set({ me: acc('other', 'carol') });
    render(<AskCard message={card()} />);
    expect(screen.getByTestId('mandate-owner-only').textContent).toContain('alice');
    expect(screen.queryByTestId('mandate-chip')).toBeNull();
    expect(screen.queryByTestId('ask-option-approve_mandate')).toBeNull();
  });
  it('chat-answered marker links to the message', () => {
    render(<AskCard message={card({ pr: { status: 'granted', decidedVia: { kind: 'chat', messageId: CHAT } }, ask: { answeredWith: 'approve_mandate', answeredBy: ME } })} />);
    const m = screen.getByTestId('ask-answered-via-chat');
    expect(m.textContent).toContain('글로 답함');
    expect(m.querySelector('a')!.getAttribute('href')).toBe(`harkroom://message/${CHAT}`);
  });
  it('owner unknown: read-only, no buttons, no chip', () => {
    render(<AskCard message={card({ pr: { ownerAccountId: undefined, mandate: undefined } })} />);
    expect(screen.getByTestId('mandate-owner-only')).toBeTruthy();
    expect(screen.queryByTestId('mandate-chip')).toBeNull();
    expect(screen.queryByTestId('ask-option-approve_mandate')).toBeNull();
    expect(screen.queryByTestId('ask-option-deny')).toBeNull();
  });
  it('viewer unknown (me not loaded): read-only', () => {
    useActiveStore.getState().set({ me: null });
    render(<AskCard message={card()} />);
    expect(screen.getByTestId('mandate-owner-only').textContent).toContain('alice');
    expect(screen.queryByTestId('ask-option-approve_mandate')).toBeNull();
  });
  it('non-uuid meta ids render no link', () => {
    const bad = 'x" onclick="y';
    render(<AskCard message={card({ mirror: { rootId: bad, neutral: true } })} />);
    expect(screen.getByTestId('mandate-mirror-neutral')).toBeTruthy();
    expect(screen.queryByTestId('mandate-mirror-link')).toBeNull();
    cleanup();
    render(<AskCard message={card({ pr: { status: 'superseded' }, ask: { closedAt: '2026-10-22T00:00:00Z', closedReason: 'superseded', supersededBy: 'm2/../x' } })} />);
    expect(screen.queryByTestId('mandate-new-card')).toBeNull();
    expect(screen.getByTestId('mandate-ended').textContent).toContain('다시');
    cleanup();
    render(<AskCard message={card({ pr: { status: 'granted', decidedVia: { kind: 'chat', messageId: 'chat-1' } }, ask: { answeredWith: 'approve_mandate', answeredBy: ME } })} />);
    const m = screen.getByTestId('ask-answered-via-chat');
    expect(m.textContent).toContain('글로 답함');
    expect(m.querySelector('a')).toBeNull();
  });
});
