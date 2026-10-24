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
  it('original merge-refusal card leaves [이번 한 번] to the once panel', () => {
    render(<AskCard message={card({ pr: { kind: 'merge', line: LINE, once: { number: 404, headSha: '7b7dd25abc', reason: 'not_granted' } } })} />);
    expect(screen.getByTestId('ask-option-approve_mandate')).toBeTruthy();
    expect(screen.queryByTestId('ask-option-approve_once')).toBeNull();
  });
  it('genuine mirror renders the same card incl. [이번 한 번]', () => {
    render(<AskCard message={card({ mirror: { rootId: 'root-1', neutral: false, kind: 'merge', line: LINE, mandate: MANDATE, once: { number: 404, headSha: '7b7dd25abc', reason: 'not_granted' } } })} />);
    expect(screen.getByTestId('mandate-mirror-genuine')).toBeTruthy();
    expect(screen.getByTestId('mandate-mirror-link').getAttribute('href')).toBe('harkroom://message/root-1');
    fireEvent.click(screen.getByTestId('ask-option-approve_once'));
    expect(answerAsk).toHaveBeenCalledWith('m1', 'approve_once', 'c1');
    expect(screen.queryByTestId('merge-once-account')).toBeNull();
  });
  it('neutral mirror shows only a line + link', () => {
    render(<AskCard message={card({ mirror: { rootId: 'root-1', neutral: true } })} />);
    expect(screen.getByTestId('mandate-mirror-neutral')).toBeTruthy();
    expect(screen.queryByTestId('mandate-line')).toBeNull();
    expect(screen.queryByTestId('ask-option-deny')).toBeNull();
  });
  it.each([
    ['added', { pr: { status: 'granted' }, ask: { answeredWith: 'approve_mandate', answeredBy: ME } }],
    ['once', { options: ['approve_once', 'deny'], pr: { status: 'approved_once', kind: 'command', line: { cap: 'command', scope: 'x', limits: { approve_once: { uses: 1 } } } }, ask: { answeredWith: 'approve_once', answeredBy: ME } }],
    ['denied', { pr: { status: 'denied' }, ask: { answeredWith: 'deny', answeredBy: ME } }],
    ['expired', { pr: { status: 'expired' }, ask: { closedAt: '2026-10-22T00:00:00Z', closedReason: 'expired' } }],
    ['superseded', { pr: { status: 'superseded' }, ask: { closedAt: '2026-10-22T00:00:00Z', closedReason: 'superseded', supersededBy: 'm2' } }],
  ])('ended state %s', (state, opts) => {
    render(<AskCard message={card(opts as Parameters<typeof card>[0])} />);
    expect(screen.getByTestId('mandate-ended').dataset.state).toBe(state);
    expect(screen.getByTestId('mandate-line')).toBeTruthy();
    expect(screen.queryByTestId('ask-option-deny')).toBeNull();
    if (state === 'superseded') expect(screen.getByTestId('mandate-new-card').getAttribute('href')).toBe('harkroom://message/m2');
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
    render(<AskCard message={card({ pr: { status: 'granted', decidedVia: { kind: 'chat', messageId: 'chat-1' } }, ask: { answeredWith: 'approve_mandate', answeredBy: ME } })} />);
    const m = screen.getByTestId('ask-answered-via-chat');
    expect(m.textContent).toContain('글로 답함');
    expect(m.querySelector('a')!.getAttribute('href')).toBe('harkroom://message/chat-1');
  });
});
