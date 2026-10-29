/** W4 위임장 줄 카드(designer 시안 v1) — 선택지 묶음·거울(진짜/중립)·이름 없는 칩·끝난 상태·글로 답함 표시. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { MessageRow } from '@harkroom/shared';
import { AskCard } from '../src/components/AskCard';
import { bodyForLineCard } from '../src/components/MandateLineBody';
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
    // 서버가 싣는 그대로 — CI 거절 카드의 선택지는 [거절] 하나다(`permissionCardOptions`). 2개짜리 목으로는 10-28 사고(버튼 없음)를 못 잡았다.
    render(<AskCard message={card({ options: ['deny'], pr: { kind: 'merge', line: ciLine, once: { number: 61, headSha: '3c9e0a1ff', reason: 'ci_not_green', failedChecks: ['tflint'] } } })} />);
    expect(screen.getByTestId('ask-card')).toBeTruthy();
    const btns = screen.getAllByRole('button').filter((b) => /이번 한 번/.test(b.textContent ?? ''));
    expect(btns).toHaveLength(1);
    const onceBtn = btns[0]!;
    expect(onceBtn.textContent).toBe('CI 실패 무시하고 이번 한 번');
    expect(screen.getByTestId('merge-once-checks').textContent).toContain('tflint');
    // g-n1/g-n2: PR 줄이 서면 줄 상자에 PR·head 칩이 없고, head 는 7자다.
    const limits = screen.getByTestId('mandate-line-limits').textContent ?? '';
    expect(limits).not.toContain('PR #61');
    expect(limits).not.toContain('head');
    expect(limits).toContain('CI 무시');
    expect(screen.getByTestId('merge-once-head').textContent).toBe('3c9e0a1');
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
  // r5: 답한 줄 카드는 머리가 결과를 말하고, 같은 말만 하는 상태 줄은 빠진다.
  it.each([
    ['이 위임장에 더함 · alice', { pr: { status: 'granted' }, ask: { answeredWith: 'approve_mandate', answeredBy: ME } }],
    ['위임장을 만들고 더함 · alice', { options: ['approve_new_mandate', 'deny'], pr: { status: 'granted', mandate: undefined }, ask: { answeredWith: 'approve_new_mandate', answeredBy: ME } }],
    ['이번 한 번 허락함 · alice', { options: ['approve_once', 'deny'], pr: { status: 'approved_once', kind: 'command', line: { cap: 'command', scope: 'x', limits: { approve_once: { uses: 1 } } } }, ask: { answeredWith: 'approve_once', answeredBy: ME } }],
    ['거절함 · alice', { pr: { status: 'denied' }, ask: { answeredWith: 'deny', answeredBy: ME } }],
  ])('answered line card head says the result: %s', (head, opts) => {
    render(<AskCard message={card(opts as Parameters<typeof card>[0])} />);
    expect(screen.getByTestId('ask-card').textContent).toContain(head);
    expect(screen.getByTestId('ask-card').textContent).not.toContain('정해졌다');
    expect(screen.getByTestId('ask-card').textContent).not.toContain('골랐다');
    expect(screen.queryByTestId('mandate-ended')).toBeNull();
    expect(screen.getByTestId('mandate-line')).toBeTruthy();
  });
  it('result head in English, chat marker kept after it', () => {
    usePrefsStore.getState().setLocale('en');
    render(<AskCard message={card({ pr: { status: 'denied', decidedVia: { kind: 'chat', messageId: CHAT } }, ask: { answeredWith: 'deny', answeredBy: ME } })} />);
    expect(screen.getByTestId('ask-card').textContent).toContain('alice denied');
    expect(screen.getByTestId('ask-answered-via-chat')).toBeTruthy();
  });
  it('unknown owner: read-only line waits for "the owner", not a someone placeholder', () => {
    useActiveStore.getState().set({ me: acc('other', 'carol') });
    render(<AskCard message={card({ pr: { ownerAccountId: 'ghost' } })} />);
    expect(screen.getByTestId('mandate-owner-only').textContent).toBe('이 에이전트를 부를 수 있는 사람이 정한다');
  });
  it.each([
    ['denied', { pr: { status: 'denied' } }],
    ['added', { pr: { status: 'granted' } }],
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

  describe('g1 줄 빼기', () => {
    const added = (pr: Record<string, unknown> = {}) => card({ pr: { status: 'granted', lineId: 'ln1', ...pr }, ask: { answeredWith: 'approve_mandate', answeredBy: ME } });

    it('owner sees [줄 빼기] only when the card carries lineId; confirm calls the route and shows 「줄을 뺐다」', async () => {
      const revokeMandateLine = vi.fn(async () => ({ ok: true as const, lineId: 'ln1', revokedAt: '2026-10-24T01:05:00Z' }));
      setController({ answerAsk, closeAsk: vi.fn(), api: { revokeMandateLine } } as unknown as Controller);
      render(<AskCard message={card({ pr: { status: 'granted' }, ask: { answeredWith: 'approve_mandate', answeredBy: ME } })} />);
      expect(screen.queryByTestId('mandate-line-revoke')).toBeNull();
      cleanup();
      render(<AskCard message={added()} />);
      fireEvent.click(screen.getByTestId('mandate-line-revoke'));
      expect(revokeMandateLine).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '줄 빼기' }));
      await waitFor(() => expect(screen.getByTestId('mandate-ended').getAttribute('data-state')).toBe('revoked'));
      expect(revokeMandateLine).toHaveBeenCalledWith('md1', 'ln1');
      expect(screen.getByTestId('mandate-ended').textContent).toContain('줄을 뺐다 · ');
      expect(screen.queryByTestId('mandate-line-revoke')).toBeNull();
    });

    it('7-day grant still live: dialog says the grant stays until its date, links to grant settings, state notes the grant', async () => {
      const revokeMandateLine = vi.fn(async () => ({ ok: true as const, lineId: 'ln1', revokedAt: '2026-10-24T01:05:00Z' }));
      setController({ answerAsk, closeAsk: vi.fn(), api: { revokeMandateLine } } as unknown as Controller);
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const onOpenSettings = vi.fn();
      render(<AskCard message={added({ grantExpiresAt: future })} onOpenSettings={onOpenSettings} />);
      fireEvent.click(screen.getByTestId('mandate-line-revoke'));
      const detail = screen.getByTestId('mandate-revoke-grant-live').textContent ?? '';
      expect(detail).toContain('같은 결정으로 준 7일 허락이 ');
      expect(detail).toContain('까지 남아 그때까지는 에이전트가 이 일을 계속 할 수 있다');
      expect(detail).not.toContain('다시 묻는다');
      fireEvent.click(screen.getByTestId('mandate-revoke-open-grants'));
      expect(onOpenSettings).toHaveBeenCalledWith('agents', 'agent-1#permissions');
      expect(screen.queryByTestId('mandate-revoke-grant-live')).toBeNull();
      fireEvent.click(screen.getByTestId('mandate-line-revoke'));
      fireEvent.click(screen.getByRole('button', { name: '줄 빼기' }));
      await waitFor(() => expect(screen.getByTestId('mandate-ended').getAttribute('data-state')).toBe('revoked'));
      expect(screen.getByTestId('mandate-ended').textContent).toContain('줄을 뺐다 · 7일 허락은 남음');
    });

    it('expired grant or command card: dialog keeps the ask-again sentence, state is plain 「줄을 뺐다」', () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      render(<AskCard message={added({ grantExpiresAt: past })} onOpenSettings={vi.fn()} />);
      fireEvent.click(screen.getByTestId('mandate-line-revoke'));
      expect(screen.queryByTestId('mandate-revoke-grant-live')).toBeNull();
      expect(screen.getByRole('dialog').textContent).toContain('에이전트가 다시 묻는다');
      expect(screen.queryByTestId('mandate-revoke-open-grants')).toBeNull();
      cleanup();
      render(<AskCard message={added({ kind: 'command', grantExpiresAt: new Date(Date.now() + 3_600_000).toISOString() })} />);
      fireEvent.click(screen.getByTestId('mandate-line-revoke'));
      expect(screen.queryByTestId('mandate-revoke-grant-live')).toBeNull();
      cleanup();
      render(<AskCard message={added({ lineRevokedAt: '2026-10-24T01:05:00Z', grantExpiresAt: past })} />);
      expect(screen.getByTestId('mandate-ended').textContent).not.toContain('7일 허락은 남음');
      expect(screen.getByTestId('mandate-ended').textContent).toContain('줄을 뺐다 · ');
    });

    it('card already marked lineRevokedAt shows the removed state; non-owner never sees the button', () => {
      render(<AskCard message={added({ lineRevokedAt: '2026-10-24T01:05:00Z' })} />);
      expect(screen.getByTestId('mandate-ended').getAttribute('data-state')).toBe('revoked');
      cleanup();
      useActiveStore.getState().set({ me: acc('other', 'carol') });
      render(<AskCard message={added()} />);
      expect(screen.queryByTestId('mandate-line-revoke')).toBeNull();
    });
  });

  it('r3: line card head comes from i18n, not the server ask.prompt (ko/en, with and without mandate)', () => {
    const { unmount } = render(<AskCard message={card({ ask: { prompt: '권한을 줄까?' } })} />);
    expect(screen.getByTestId('ask-card').textContent).toContain('위임장에 줄을 더할까? · alice 차례');
    expect(screen.getByTestId('ask-card').textContent).not.toContain('권한을 줄까?');
    expect(screen.getByTestId('ask-card').textContent).not.toContain('골라 줘');
    unmount();
    usePrefsStore.getState().setLocale('en');
    const a = render(<AskCard message={card({ ask: { prompt: '권한을 줄까?' } })} />);
    expect(screen.getByTestId('ask-card').textContent).toContain("Add a line to the mandate? · alice's turn");
    expect(screen.getByTestId('ask-card').textContent).not.toContain('Pick one');
    expect(screen.getByTestId('ask-card').textContent).not.toContain('권한을 줄까?');
    a.unmount();
    render(<AskCard message={card({ options: ['approve_new_mandate', 'deny'], ask: { prompt: '권한을 줄까?' }, pr: { mandate: undefined, line: { cap: 'tool', scope: 'x', limits: { approve_new_mandate: { untilMs: 1 } } } } })} />);
    expect(screen.getByTestId('ask-card').textContent).toContain("Start a mandate and add this line? · alice's turn");
  });
  it("r5(designer s1): owner handle unknown → head without the 「· owner 차례」 tail (ko/en, mandate and new)", () => {
    const { unmount } = render(<AskCard message={card({ pr: { ownerAccountId: 'ghost', mandate: { ...MANDATE, ownerId: 'ghost' } } })} />);
    const head = () => screen.getByTestId('ask-card').textContent ?? '';
    expect(head()).toContain('위임장에 줄을 더할까?');
    expect(head()).not.toContain('차례');
    expect(head()).not.toContain('누군가');
    unmount();
    const b = render(<AskCard message={card({ options: ['approve_new_mandate', 'deny'], pr: { mandate: undefined } })} />);
    expect(head()).toContain('위임장을 만들고 줄을 더할까? · alice 차례');
    b.unmount();
    usePrefsStore.getState().setLocale('en');
    const c = render(<AskCard message={card({ pr: { ownerAccountId: 'ghost', mandate: { ...MANDATE, ownerId: 'ghost' } } })} />);
    expect(head()).toContain('Add a line to the mandate?');
    expect(head()).not.toContain('turn');
    c.unmount();
    render(<AskCard message={card({ options: ['approve_new_mandate', 'deny'], pr: { ownerAccountId: 'ghost', mandate: undefined } })} />);
    expect(head()).toContain('Start a mandate and add this line?');
    expect(head()).not.toContain('turn');
  });
  it('r5(designer F1): when the line box is drawn, only the server target line (meta bodyTargetLine) leaves the body', () => {
    const TL = '명령 허용 `Bash(psql:*)`';
    const body = `권한 요청 · @rcms\n${TL}\n이유: 확인`;
    const m = card({ pr: { bodyTargetLine: TL } });
    expect(bodyForLineCard(body, m.meta as Record<string, unknown>)).toBe('권한 요청 · @rcms\n이유: 확인');
    // 대상 줄이 없거나(옛 카드) 줄 상자를 안 그리면(줄 없음·중립 거울·ask 없음) 본문 그대로.
    expect(bodyForLineCard(body, card().meta as Record<string, unknown>)).toBe(body);
    expect(bodyForLineCard(body, card({ pr: { bodyTargetLine: TL, line: undefined } }).meta as Record<string, unknown>)).toBe(body);
    expect(bodyForLineCard(body, card({ mirror: { rootId: ROOT, neutral: true, bodyTargetLine: TL } }).meta as Record<string, unknown>)).toBe(body);
    const { ask: _ask, ...noAsk } = m.meta as Record<string, unknown>;
    expect(bodyForLineCard(body, noAsk)).toBe(body);
    // 거울도 같은 칸으로 — 같은 글이 이유 줄에 있어도 하나만 뺀다(이유는 「이유: 」로 시작해 겹치지 않는다).
    const mirror = card({ mirror: { rootId: ROOT, neutral: false, kind: 'tool', line: LINE, bodyTargetLine: TL } });
    expect(bodyForLineCard(`${body}\n${TL}`, mirror.meta as Record<string, unknown>)).toBe(`권한 요청 · @rcms\n이유: 확인\n${TL}`);
  });
  it('r3: a plain ask (no permission line) keeps its generic head and prompt', () => {
    usePrefsStore.getState().setLocale('en');
    const plain = { ...card({ ask: { prompt: 'Which one?' } }), meta: { kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to: { kind: 'human' }, prompt: 'Which one?' } } } as unknown as MessageRow;
    render(<AskCard message={plain} />);
    expect(screen.getByTestId('ask-card').textContent).toContain('Pick one');
    expect(screen.getByTestId('ask-card').textContent).toContain('Which one?');
  });
});

describe('H4 card warnings (designer v1)', () => {
  it('draws known warnings as sentences under the limit chips, most dangerous first; unknown codes dropped', () => {
    render(<AskCard message={card({ pr: { warnings: ['uses_github_account', 'short_prefix', 'bogus'] } })} />);
    const items = [...screen.getByTestId('mandate-line-warnings').querySelectorAll('li')];
    expect(items.map((li) => li.getAttribute('data-warning'))).toEqual(['short_prefix', 'uses_github_account']);
    expect(items[1]!.textContent).toContain('GitHub 계정으로 돈다 — 이 에이전트가 도는 맥의 gh 로그인 계정이 쓰인다');
  });
  it('no warnings → no list; genuine mirror draws the copied warnings', () => {
    const c = render(<AskCard message={card()} />);
    expect(screen.queryByTestId('mandate-line-warnings')).toBeNull();
    c.unmount();
    render(<AskCard message={card({ mirror: { rootId: ROOT, neutral: false, kind: 'tool', line: { cap: 'tool', scope: 'Bash(gh pr list)', limits: {} }, warnings: ['uses_github_account'] } })} />);
    expect(screen.getByTestId('mandate-line-warnings').textContent).toContain('GitHub 계정으로 돈다');
  });
  it('the server warning line (meta bodyWarningLine) leaves the body too', () => {
    const TL = '명령 허용 `Bash(gh pr list)`';
    const WL = '⚠ GitHub 계정으로 돈다';
    const body = `권한 요청 · @rcms\n${TL}\n${WL}\n이유: 확인`;
    expect(bodyForLineCard(body, card({ pr: { bodyTargetLine: TL, bodyWarningLine: WL } }).meta as Record<string, unknown>)).toBe('권한 요청 · @rcms\n이유: 확인');
  });
});

describe('permission mirror owner + in-app links', () => {
  const MIRROR_LINE = { cap: 'command', scope: 'kubectl get pods', limits: { approve_once: { uses: 1, untilMs: 3_600_000 } } };
  it('a mirror without a mandate still draws the owner buttons when the server filled ownerAccountId', () => {
    render(<AskCard message={card({ options: ['approve_once', 'deny'], mirror: { rootId: ROOT, neutral: false, kind: 'command', line: MIRROR_LINE, ownerAccountId: ME } })} />);
    expect(screen.getByTestId('ask-option-approve_once')).toBeTruthy();
    expect(screen.queryByTestId('mandate-owner-only')).toBeNull();
  });
  it('someone else is the owner → no buttons, owner-only line', () => {
    render(<AskCard message={card({ options: ['approve_once', 'deny'], mirror: { rootId: ROOT, neutral: false, kind: 'command', line: MIRROR_LINE, ownerAccountId: 'other' } })} />);
    expect(screen.queryByTestId('ask-option-approve_once')).toBeNull();
    expect(screen.getByTestId('mandate-owner-only').textContent).toContain('carol');
  });
  it('「원본 열기」 moves inside the app (openMessage), not via the webview', () => {
    const openMessage = vi.fn(async () => {});
    setController({ answerAsk, closeAsk: vi.fn(), openMessage } as unknown as Controller);
    render(<AskCard message={card({ options: ['approve_once', 'deny'], mirror: { rootId: ROOT, neutral: false, kind: 'command', line: MIRROR_LINE, ownerAccountId: ME } })} />);
    const link = screen.getByTestId('mandate-mirror-link');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(openMessage).toHaveBeenCalledWith(ROOT);
  });
});

describe('P3 decide-check: people who can call the agent decide too (designer v2 ②·③)', () => {
  const MERGE_ONCE = { number: 135, headSha: 'fcd39b6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', reason: 'no_mandate_line', repo: 'example-org/app', denialId: 'd1' };
  function useServer(check: Record<string, unknown> | 'fail', extra: Record<string, unknown> = {}) {
    useActiveStore.getState().set({ me: acc('other', 'carol'), serverVersion: { version: '0.4.315' } as never });
    const decideCheck = vi.fn(async () => { if (check === 'fail') throw new Error('boom'); return check; });
    setController({ answerAsk, closeAsk: vi.fn(), api: { decideCheck }, ...extra } as unknown as Controller);
    return decideCheck;
  }
  const newCard = () => card({ options: ['approve_new_mandate', 'deny'], pr: { mandate: undefined, line: { cap: 'tool', scope: 'x', limits: { approve_new_mandate: { untilMs: 1 } } } } });

  it('viewerCanDecide → a non-owner gets the buttons and the 「네가 정할 수 있다」 tail, but no chip', async () => {
    const decideCheck = useServer({ viewerCanDecide: true, asOwner: false, decideScope: 'community', ownerAccountId: ME });
    render(<AskCard message={newCard()} />);
    await screen.findByTestId('ask-option-approve_new_mandate');
    expect(decideCheck).toHaveBeenCalledWith('agent-1', 'c1');
    expect(screen.getByText('위임장을 만들고 줄을 더할까? · 네가 정할 수 있다')).toBeTruthy();
    expect(screen.queryByTestId('mandate-owner-only')).toBeNull();
    expect(screen.queryByTestId('mandate-chip')).toBeNull();
    fireEvent.click(screen.getByTestId('ask-option-approve_new_mandate'));
    expect(answerAsk).toHaveBeenCalledWith('m1', 'approve_new_mandate', 'c1');
  });
  it('cannot decide → no buttons, no tail, scope line names who decides', async () => {
    useServer({ viewerCanDecide: false, asOwner: false, decideScope: 'list', ownerAccountId: ME });
    render(<AskCard message={newCard()} />);
    await waitFor(() => expect(screen.getByTestId('mandate-owner-only').textContent).toBe('@alice 또는 명단의 사람이 정한다'));
    expect(screen.getByText('위임장을 만들고 줄을 더할까?')).toBeTruthy();
    expect(screen.queryByTestId('ask-option-approve_new_mandate')).toBeNull();
  });
  it.each([
    ['owner', '@alice 가 정한다'], ['channel', '@alice 또는 이 채널의 멤버가 정한다'],
    ['community', '@alice 또는 이 에이전트를 부를 수 있는 사람이 정한다'], ['switchOff', '@alice 만 정한다'],
  ])('scope %s line', async (scope, text) => {
    useServer({ viewerCanDecide: false, asOwner: false, decideScope: scope, ownerAccountId: ME });
    render(<AskCard message={newCard()} />);
    await waitFor(() => expect(screen.getByTestId('mandate-owner-only').textContent).toBe(text));
  });
  it('check failed or server older than 0.4.315 → owner-only as before', async () => {
    const decideCheck = useServer('fail');
    render(<AskCard message={newCard()} />);
    await waitFor(() => expect(decideCheck).toHaveBeenCalled());
    expect(screen.getByTestId('mandate-owner-only').textContent).toBe('소유자 alice의 결정을 기다린다');
    cleanup();
    useActiveStore.getState().set({ serverVersion: { version: '0.4.314' } as never });
    decideCheck.mockClear();
    render(<AskCard message={newCard()} />);
    expect(decideCheck).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ask-option-approve_new_mandate')).toBeNull();
  });
  it('merge-refusal card: a decider gets [이번 한 번] but never [계정 바꾸기]', async () => {
    const approvePermissionOnce = vi.fn(async () => ({ approvalExpiresAt: '2026-10-31T00:00:00Z' }));
    useServer({ viewerCanDecide: true, asOwner: false, decideScope: 'community', ownerAccountId: ME }, { approvePermissionOnce, getMergeAccounts: vi.fn(async () => ({ operatorId: null, report: null })) });
    render(<AskCard message={card({ options: ['approve_new_mandate', 'deny'], pr: { kind: 'merge', target: 'repo:example-org/app', mandate: undefined, once: MERGE_ONCE, line: { cap: 'merge', scope: 'repo:example-org/app', limits: { approve_new_mandate: { untilMs: 1 }, approve_once: { pr: 135, head: 'fcd39b6', uses: 1 } } } } })} />);
    const once = await screen.findByTestId('ask-option-approve_once');
    expect(screen.queryByTestId('merge-once-change-account')).toBeNull();
    fireEvent.click(once);
    await waitFor(() => expect(approvePermissionOnce).toHaveBeenCalled());
    expect((approvePermissionOnce.mock.calls[0] as unknown[])[2]).not.toHaveProperty('ghUser');
  });
  it('a refused answer is not swallowed: mandate_unavailable shows a reason under the card', async () => {
    useActiveStore.getState().set({ me: acc(ME, 'alice') });
    answerAsk = vi.fn(async () => ({ status: 409, code: 'mandate_unavailable', message: 'x' }));
    setController({ answerAsk, closeAsk: vi.fn() } as unknown as Controller);
    render(<AskCard message={newCard()} />);
    fireEvent.click(screen.getByTestId('ask-option-approve_new_mandate'));
    expect((await screen.findByTestId('mandate-answer-error')).textContent).toContain('이 스레드에서는 위임장을 만들 수 없다');
  });
  it('a lost race (already answered) adds no error line', async () => {
    useActiveStore.getState().set({ me: acc(ME, 'alice') });
    answerAsk = vi.fn(async () => ({ status: 409, code: 'already_answered', message: 'x' }));
    setController({ answerAsk, closeAsk: vi.fn() } as unknown as Controller);
    render(<AskCard message={newCard()} />);
    fireEvent.click(screen.getByTestId('ask-option-approve_new_mandate'));
    await waitFor(() => expect(answerAsk).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId('mandate-answer-error')).toBeNull();
  });
});
