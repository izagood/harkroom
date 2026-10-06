/**
 * 비밀 만들기 알림 줄(서버 `notifyOwner`, `meta.secretNotice`)의 버튼 — 소유자에게만 서고 설정 › 비밀과 API 로 간다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { MessageRow } from '@harkroom/shared';
import { SecretNoticeAction } from '../src/components/SecretNoticeAction';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';

const msg = (ownerAccountId: string): MessageRow => ({
  meta: { secretNotice: { action: 'created', secretId: 's1', name: 'db', version: 1, via: 'generate', agentId: 'agent-1', ownerAccountId } },
} as unknown as MessageRow);

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({ me: acc('owner-1', 'owner') });
});
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); });

describe('SecretNoticeAction', () => {
  it('소유자에게는 [비밀 보기] — 누르면 secrets 절을 연다', () => {
    const open = vi.fn();
    render(<SecretNoticeAction message={msg('owner-1')} onOpenSettings={open} />);
    fireEvent.click(screen.getByTestId('secret-notice-open'));
    expect(open).toHaveBeenCalledWith('secrets');
  });

  it('소유자가 아니면 아무것도 그리지 않는다', () => {
    render(<SecretNoticeAction message={msg('someone-else')} onOpenSettings={vi.fn()} />);
    expect(screen.queryByTestId('secret-notice-open')).toBeNull();
  });
});
