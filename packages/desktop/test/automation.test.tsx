/**
 * 자동화(064) 데스크탑 회귀선 — 자동으로 올라간 글은 **만든 사람 이름 그대로** 서고,
 * 자동이라는 사실은 이름줄의 ⚡ 칩 하나가 말한다. 사람이 친 글에는 칩이 없다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { MessageItem } from '../src/components/MessageItem';
import { translator } from '../src/i18n';
import { describeTrigger, readAutomationMeta } from '../src/lib/automation';
import { acc, msg } from './helpers/fakeApi';

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'jaebin'), accounts: { u1: acc('u1', 'jaebin') } });
});
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

describe('자동화 메시지 칩', () => {
  it('meta.automation 이 있으면 작성자 이름 옆에 ⚡ 칩과 자동화 이름 hover 가 선다', () => {
    render(<MessageItem message={msg('m1', 'c1', 1, '@schedule_manager 정리', 'u1', {
      meta: { automation: { id: 'a1', name: '회사일 정리', trigger: 'schedule', runId: 'r1' } },
    })} />);
    expect(screen.getByTestId('author-name').textContent).toBe('jaebin');
    const chip = screen.getByTestId('automation-chip');
    expect(chip.getAttribute('title')).toContain('회사일 정리');
  });

  it('사람이 친 글에는 칩이 없다', () => {
    render(<MessageItem message={msg('m2', 'c1', 2, '그냥 말', 'u1', { meta: {} })} />);
    expect(screen.queryByTestId('automation-chip')).toBeNull();
  });
});

describe('lib/automation', () => {
  it('readAutomationMeta — 모양이 어긋나면 null', () => {
    expect(readAutomationMeta({ automation: { id: 1 } })).toBeNull();
    expect(readAutomationMeta({})).toBeNull();
  });

  it('describeTrigger — 매주 월 09:00 (Asia/Seoul)', () => {
    const t = translator('ko');
    const s = describeTrigger({ kind: 'schedule', freq: 'weekly', weekdays: [1], time: '09:00', tz: 'Asia/Seoul' }, 'ko', t);
    expect(s).toBe('매주 월 09:00 (Asia/Seoul)');
  });

  it('describeTrigger — GitHub 어댑터 추가 트리거', () => {
    const t = translator('ko');
    const s = describeTrigger({
      kind: 'github', repo: 'izagood/harkroom', event: 'push', branch: 'main',
      paths: ['packages/agent/src/adapters/*.ts'], change: 'added',
    }, 'ko', t);
    expect(s).toBe('GitHub izagood/harkroom push → main · packages/agent/src/adapters/*.ts (added)');
  });
});
