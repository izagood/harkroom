import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { MessageItem } from '../src/components/MessageItem';
import { systemLineShape } from '../src/lib/systemLine';
import { acc, msg } from './helpers/fakeApi';

/**
 * 시스템 줄 C안(2026-10-24 jaebin 선택) — 시스템 줄은 누구의 발화로도 그리지 않는다.
 * 사례: 채팅 승인 거절 줄이 그 글을 쓴 사람(author)의 이름·얼굴로 그려져 그 사람 말처럼 보였다.
 */
const POST_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u2', 'other'), accounts: { u1: acc('u1', 'jaebin'), u2: acc('u2', 'other'), a1: acc('a1', 'forge') } });
});
afterEach(() => cleanup());

describe('시스템 줄 두 겹', () => {
  it('채팅 승인 결과는 응답 줄 — 작성자는 Harkroom·시스템, 사람은 원 글로 가는 칩에만', () => {
    render(<MessageItem message={msg('s1', 'c1', 1, '⚠️ 승인 안 됨: 카드 없음', 'u1', {
      kind: 'system', meta: { accountId: 'u1', chatApproval: { messageId: POST_ID, results: [], reason: 'noCard' } },
    })} />);

    const name = screen.getByTestId('author-name');
    expect(name.textContent).toContain('Harkroom');
    expect(name.textContent).not.toContain('jaebin');
    expect(name.tagName).toBe('SPAN'); // 누를 수 없다(c5)
    expect(screen.getByTestId('author-gutter').getAttribute('data-system')).toBe('response');
    const chip = screen.getByTestId('system-target-chip');
    expect(chip.textContent).toContain('jaebin');
    expect(chip.getAttribute('href')).toBe(`harkroom://message/${POST_ID}`);
  });

  it('에이전트가 일으킨 막힘 카드도 응답 줄 — 칩은 그 에이전트의 요청, 링크 없음', () => {
    render(<MessageItem message={msg('s2', 'c1', 1, '막힘', 'a1', {
      kind: 'system', meta: { blocked: { code: 'cause_not_human' } },
    })} />);
    expect(screen.getByTestId('author-name').textContent).not.toContain('forge');
    const chip = screen.getByTestId('system-target-chip');
    expect(chip.textContent).toContain('forge');
    expect(chip.tagName).toBe('SPAN');
  });

  it('스레드 모델 지정은 기록 줄 — 이름줄 없이 한 줄, 스크린리더에는 「시스템 알림」(c2)', () => {
    render(<MessageItem message={msg('s3', 'c1', 1, 'x', 'u1', {
      kind: 'system', meta: { accountId: 'u1', i18n: { key: 'system.threadModel.cleared', args: { accountId: 'u1', agentId: 'a1' } } },
    })} />);
    expect(screen.queryByTestId('author-name')).toBeNull();
    const line = screen.getByTestId('system-record-line');
    expect(line.textContent).toMatch(/^System notice: /);
  });

  it('판정 — 일반 글은 null, 표지 없는 옛 시스템 줄은 기록, 머지 결과 표지는 응답', () => {
    expect(systemLineShape({ kind: 'user', meta: {} })).toBeNull();
    expect(systemLineShape({ kind: 'system', meta: {} })).toBe('record');
    expect(systemLineShape({ kind: 'system', meta: { i18n: { key: 'system.member.addedBy', args: { actorId: 'u1', accountId: 'a1' } } } })).toBe('record');
    expect(systemLineShape({ kind: 'system', meta: { i18n: { key: 'system.merge.merged', args: { repo: 'o/r', number: 1, sha: 'abc' } } } })).toBe('response');
  });
});
