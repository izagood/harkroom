/**
 * 투영이 꺼졌다는 띠가 "설정 열기" 를 내밀 때, **그 문 뒤에 그 사실이 있어야 한다**.
 *
 * 사용자가 실제로 겪은 것(실측 2026-09-07): 띠의 `설정 열기` 를 눌렀는데 설정 화면이
 * 비어 있었다. 원인은 두 개였다 — ① 배너가 섹션 대신 `MouseEvent` 를 흘렸다
 * ② 고쳐도 **투영을 말하는 설정 자리가 아예 없었다**. ②를 그대로 두면 문은 열리지만
 * 그 방은 투영에 대해 한 마디도 하지 않는다(docs/design.md §4: 배선을 잊은 문은
 * 아무 일도 없는 항목이 된다).
 *
 * 이 화면이 그 자리인 이유: `Connection` 은 "이 앱이 말을 거는 서버 하나" 를 말하는
 * 자리고, 투영은 **그 서버가 avcs 를 향해 돌리는 것**이다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PROJECTION_UNCONFIGURED_DETAIL, PROJECTION_UNCONFIGURED_HEADLINE } from '@murmur/shared';
import type { ProjectionStatus } from '@murmur/shared';
import { useActiveStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ConnectionSettings } from '../src/components/settings/ConnectionSettings';
import { usePrefsStore } from '../src/state/prefsStore';

const status = (over: Partial<ProjectionStatus>): ProjectionStatus => ({
  state: 'ok', configured: true, repo: 'izagood/murmur', lastLogIndex: 0,
  lastPolledAt: Date.now(), lastAdvancedAt: null, lastError: null, ...over,
});

beforeEach(() => {
  localStorage.clear();
  useActiveStore.getState().reset();
  // **언어를 고정한다**(`#619` 후속으로 `N분 전` 이 앱 언어를 따른다). 이 파일이 재는 것은
  // 이 행이 사정을 말하는가이지 그 문구의 언어가 아니다.
  usePrefsStore.getState().setLocale('ko');
  setController({ api: { baseUrl: 'http://localhost:3400' } } as unknown as Controller);
});
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

const row = () => screen.getByTestId('projection-row').textContent ?? '';

describe('Connection 설정의 투영 행', () => {
  it('꺼져 있으면 무엇을 켜야 하는지 적는다', () => {
    useActiveStore.getState().set({ projectionStatus: status({ state: 'unconfigured', configured: false, repo: null }) });
    render(<ConnectionSettings onSignOut={vi.fn()} />);
    expect(row()).toContain(PROJECTION_UNCONFIGURED_HEADLINE);
    expect(row()).toContain(PROJECTION_UNCONFIGURED_DETAIL);
  });

  /** 정상과 고장이 같은 말이면 이 행은 아무것도 알려 주지 않는다. */
  it('돌고 있으면 무엇을 보고 있는지 말한다', () => {
    useActiveStore.getState().set({ projectionStatus: status({ state: 'ok' }) });
    render(<ConnectionSettings onSignOut={vi.fn()} />);
    expect(row()).toContain('izagood/murmur');
    expect(row()).not.toContain(PROJECTION_UNCONFIGURED_HEADLINE);
  });

  it('멈췄으면 언제부터인지 말한다', () => {
    useActiveStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: Date.now() - 10 * 60_000 }),
    });
    render(<ConnectionSettings onSignOut={vi.fn()} />);
    expect(row()).toContain('10분 전부터');
  });

  /** 못 읽은 것을 "꺼졌다"로 부르면 화면이 없는 사실을 주장한다. */
  it('상태를 못 읽었으면 그렇게 말한다', () => {
    useActiveStore.getState().set({ projectionStatusError: 'boom' });
    render(<ConnectionSettings onSignOut={vi.fn()} />);
    expect(row()).toContain('읽지 못했다');
  });
});
