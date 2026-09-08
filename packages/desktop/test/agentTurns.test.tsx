/**
 * **지금 도는 턴** 구획(Agents 관제 1단계).
 *
 * 이 시험이 지키는 것은 화면의 모양이 아니라 **판단 셋**이다:
 *
 * 1. 묶음은 스레드다 — 폭주가 스레드 단위로 일어나므로, 한 스레드에서 넷이 도는 사실이
 *    한 줄로 보여야 한다.
 * 2. **0 과 모름을 같은 모양으로 그리지 않는다** — 물어서 답을 못 받았을 때 "도는 턴 없음"이
 *    뜨면 사람은 폭주가 멈춘 줄 안다. 그 사고를 막는 것이 이 파일의 존재 이유다.
 * 3. 없는 문을 그리지 않는다 — 러너가 스레드를 말하지 않은 묶음에는 이동 버튼이 없다.
 *
 * 버튼을 **글자로 집지 않는다**(로케일 기본값이 바뀌면 이유 없이 빨개진다) — `data-testid`
 * 로 줄을 집고, 글자는 그 안에서 확인한다.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { AgentSessionView } from '@murmur/shared';
import { AgentTurns } from '../src/components/AgentTurns';
import { groupTurnsByThread } from '../src/lib/agentTurns';

const turn = (over: Partial<AgentSessionView> & { sessionId: string }): AgentSessionView => ({
  agentAccountId: 'a1',
  channelId: 'c1',
  threadRootId: 't1',
  harness: 'claude-code',
  startedAt: '2026-09-09T00:00:00.000Z',
  ...over,
});

const NOW = Date.parse('2026-09-09T00:14:00.000Z');

const renderTurns = (
  snapshot: Parameters<typeof AgentTurns>[0]['snapshot'],
  onOpenThread = vi.fn(),
  onCancelTurns: ((turns: AgentSessionView[]) => void) | undefined = undefined,
) => {
  render(
    <AgentTurns
      snapshot={snapshot}
      onCancelTurns={onCancelTurns}
      handleOf={(id) => (id === 'a1' ? 'murmur' : id === 'a2' ? 'patch' : id)}
      channelLabel={(id) => (id === 'c1' ? '#murmur' : `#${id}`)}
      onOpenThread={onOpenThread}
      now={NOW}
    />,
  );
  return onOpenThread;
};

afterEach(() => cleanup());

describe('묶음 — 스레드 단위이고, 오래된 쪽이 먼저다', () => {
  it('같은 스레드의 턴이 한 묶음으로 모인다', () => {
    const groups = groupTurnsByThread([
      turn({ sessionId: 's1' }),
      turn({ sessionId: 's2', agentAccountId: 'a2' }),
      turn({ sessionId: 's3', channelId: 'c2', threadRootId: 't9' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.turns.map((t) => t.sessionId)).toEqual(['s1', 's2']);
  });

  it('오래 도는 턴이 있는 묶음이 앞에 온다 — 사람이 먼저 봐야 하는 것이 그것이다', () => {
    const groups = groupTurnsByThread([
      turn({ sessionId: 'new', threadRootId: 't-new', startedAt: '2026-09-09T00:13:00.000Z' }),
      turn({ sessionId: 'old', threadRootId: 't-old', startedAt: '2026-09-09T00:01:00.000Z' }),
    ]);
    expect(groups.map((g) => g.threadRootId)).toEqual(['t-old', 't-new']);
  });

  it('스레드를 말하지 않은 턴(threadRootId=null)도 묶음을 갖는다 — 세지 않으면 숫자가 거짓이 된다', () => {
    const groups = groupTurnsByThread([turn({ sessionId: 's1', threadRootId: null })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.threadRootId).toBeNull();
  });
});

describe('화면 — 도는 턴이 있을 때', () => {
  it('전체 수와 묶음별 수를 낸다', () => {
    renderTurns({ kind: 'known', turns: [
      turn({ sessionId: 's1' }),
      turn({ sessionId: 's2', agentAccountId: 'a2' }),
    ] });
    expect(screen.getByTestId('agent-turns-count').textContent).toContain('2');
    const group = screen.getByTestId('agent-turns-group-c1-t1');
    expect(group.textContent).toContain('#murmur');
    expect(group.textContent).toContain('@murmur');
    expect(group.textContent).toContain('@patch');
  });

  it('묶음을 누르면 그 스레드로 이동한다', () => {
    const onOpen = renderTurns({ kind: 'known', turns: [turn({ sessionId: 's1' })] });
    fireEvent.click(screen.getByTestId('agent-turns-open-t1'));
    expect(onOpen).toHaveBeenCalledWith('t1');
  });

  it('사람이 조종 중인 턴만 그 표시를 받는다 — mode 가 없는 턴은 아무 말도 하지 않는다', () => {
    renderTurns({ kind: 'known', turns: [
      turn({ sessionId: 's-human', mode: 'interactive' }),
      turn({ sessionId: 's-quiet' }),
    ] });
    expect(screen.getByTestId('agent-turn-human-s-human')).toBeTruthy();
    expect(screen.queryByTestId('agent-turn-human-s-quiet')).toBeNull();
  });

  /*
    다중 계정 3단계 — **어느 claude 계정으로 도는지**가 줄에 보인다.

    셋을 가르는 것이 이 시험의 요지다: 이름이 있으면 그 이름, `null` 이면 시스템 기본
    로그인(확인된 사실), 없으면 아무것도 그리지 않는다(모른다). 없을 때 "기본"이라고
    적으면 화면이 확인한 적 없는 것을 단언하고, 그러면 계정을 쫓는 사람은 화면을 더 이상
    믿을 수 없다 — `mode`·`acceptsInput` 이 옵셔널인 것과 같은 규율이다.
  */
  it('계정 배지는 이름 · 기본 로그인 · 모름 셋을 다르게 그린다', () => {
    renderTurns({ kind: 'known', turns: [
      turn({ sessionId: 's-named', claudeAccount: 'lime', claudePool: 'work' }),
      turn({ sessionId: 's-default', claudeAccount: null, claudePool: null }),
      turn({ sessionId: 's-unknown' }),
    ] });
    expect(screen.getByTestId('agent-turn-account-s-named').textContent).toBe('lime');
    // 풀은 배지가 아니라 `title` 이 말한다 — 줄이 좁고, 같은 이름의 계정이 풀마다 있을
    // 수 있어서 풀은 그것을 가릴 때만 필요하다.
    expect(screen.getByTestId('agent-turn-account-s-named').getAttribute('title')).toContain('work');
    // 풀이 빈 러너는 시스템 기본 로그인으로 돈다 — 계정 이름이 없는 것과 다른 사실이다.
    expect(screen.getByTestId('agent-turn-account-s-default').textContent).not.toBe('');
    expect(screen.queryByTestId('agent-turn-account-s-unknown')).toBeNull();
  });

  it('스레드를 모르는 묶음에는 이동 버튼이 없다 — 눌러도 갈 곳이 없다', () => {
    renderTurns({ kind: 'known', turns: [turn({ sessionId: 's1', threadRootId: null })] });
    expect(screen.getByTestId('agent-turns-group-c1-root')).toBeTruthy();
    expect(screen.queryByTestId('agent-turns-open-null')).toBeNull();
  });
});

describe('화면 — 0 과 모름은 다른 것이다', () => {
  it('빈 목록은 "없음"이고, 범위를 함께 적는다', () => {
    renderTurns({ kind: 'known', turns: [] });
    expect(screen.getByTestId('agent-turns-none')).toBeTruthy();
    expect(screen.queryByTestId('agent-turns-unknown')).toBeNull();
  });

  it('답을 못 받으면 "없음"이 아니라 "알 수 없다"이고, 사유를 그대로 싣는다', () => {
    renderTurns({ kind: 'unknown', reason: 'fetch failed: ECONNREFUSED' });
    const box = screen.getByTestId('agent-turns-unknown');
    expect(box.textContent).toContain('ECONNREFUSED');
    expect(screen.queryByTestId('agent-turns-none')).toBeNull();
    expect(screen.queryByTestId('agent-turns-count')).toBeNull();
  });

  it('첫 답이 오기 전에는 "없음"을 말하지 않는다', () => {
    renderTurns({ kind: 'checking' });
    expect(screen.getByTestId('agent-turns-checking')).toBeTruthy();
    expect(screen.queryByTestId('agent-turns-none')).toBeNull();
  });
});

/**
 * **중단**(3단계). 여기서 지키는 것은 "무엇을 멈추는가"의 범위다 — 이 기능은 의도 없이
 * 여럿을 건드린 사고에서 나왔으므로, 그것을 고치는 손이 같은 실수를 하면 안 된다.
 */
describe('중단 — 줄 · 스레드 · 전부', () => {
  /**
   * 확인 겹창의 두 버튼. **글자로 집지 않는다**(로케일 기본값이 바뀌면 이유 없이 빨개진다)
   * — 겹창 안에 버튼이 정확히 둘임을 확인하고 자리로 고른다: `ConfirmDialog` 의 마크업이
   * `justify-end` 로 [취소][확인] 순서를 정해 두었고, 순서가 바뀌면 이 단정이 먼저 깨진다.
   */
  const dialogButtons = () => {
    const buttons = within(screen.getByRole('dialog')).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    return { cancel: buttons[0]!, confirm: buttons[1]! };
  };

  const twoThreads = (): AgentSessionView[] => [
    turn({ sessionId: 's1' }),
    turn({ sessionId: 's2', agentAccountId: 'a2' }),
    turn({ sessionId: 's3', channelId: 'c2', threadRootId: 't9' }),
  ];

  it('배선이 없으면 버튼이 없다 — 눌러도 아무 일이 없는 버튼을 그리지 않는다', () => {
    renderTurns({ kind: 'known', turns: [turn({ sessionId: 's1' })] });
    expect(screen.queryByTestId('agent-turn-cancel-s1')).toBeNull();
    expect(screen.queryByTestId('agent-turns-cancel-all')).toBeNull();
  });

  it('줄의 [중단] 은 그 턴 하나만 보낸다', () => {
    const onCancel = vi.fn();
    renderTurns({ kind: 'known', turns: twoThreads() }, vi.fn(), onCancel);
    fireEvent.click(screen.getByTestId('agent-turn-cancel-s2'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel.mock.calls[0]![0].map((t: AgentSessionView) => t.sessionId)).toEqual(['s2']);
  });

  it('[스레드 중단] 은 그 스레드의 턴만 보낸다 — 다른 스레드는 건드리지 않는다', () => {
    const onCancel = vi.fn();
    renderTurns({ kind: 'known', turns: twoThreads() }, vi.fn(), onCancel);
    fireEvent.click(screen.getByTestId('agent-turns-cancel-group-c1-t1'));
    expect(onCancel.mock.calls[0]![0].map((t: AgentSessionView) => t.sessionId)).toEqual(['s1', 's2']);
  });

  it('사람이 조종 중인 턴에는 [중단] 이 없고, 묶음 중단에서도 빠진다', () => {
    const onCancel = vi.fn();
    renderTurns({ kind: 'known', turns: [
      turn({ sessionId: 's1' }),
      turn({ sessionId: 's-human', agentAccountId: 'a2', mode: 'interactive' }),
    ] }, vi.fn(), onCancel);
    expect(screen.queryByTestId('agent-turn-cancel-s-human')).toBeNull();
    fireEvent.click(screen.getByTestId('agent-turns-cancel-group-c1-t1'));
    expect(onCancel.mock.calls[0]![0].map((t: AgentSessionView) => t.sessionId)).toEqual(['s1']);
  });

  it('[전부 중단] 은 확인을 받고서야 보낸다 — 목록 밖의 스레드까지 멈춘다', () => {
    const onCancel = vi.fn();
    renderTurns({ kind: 'known', turns: twoThreads() }, vi.fn(), onCancel);
    fireEvent.click(screen.getByTestId('agent-turns-cancel-all'));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(dialogButtons().confirm);
    expect(onCancel.mock.calls[0]![0]).toHaveLength(3);
  });

  it('확인을 취소하면 아무것도 멈추지 않는다', () => {
    const onCancel = vi.fn();
    renderTurns({ kind: 'known', turns: twoThreads() }, vi.fn(), onCancel);
    fireEvent.click(screen.getByTestId('agent-turns-cancel-all'));
    fireEvent.click(dialogButtons().cancel);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('멈출 것이 하나뿐이면 [전부 중단] 을 세우지 않는다 — 같은 일을 하는 길이 둘이 된다', () => {
    renderTurns({ kind: 'known', turns: [turn({ sessionId: 's1' })] }, vi.fn(), vi.fn());
    expect(screen.queryByTestId('agent-turns-cancel-all')).toBeNull();
    expect(screen.getByTestId('agent-turn-cancel-s1')).toBeTruthy();
  });
});
