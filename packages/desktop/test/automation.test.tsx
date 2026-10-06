/**
 * 자동화(064) 데스크탑 회귀선 — 자동으로 올라간 글은 **만든 사람 이름 그대로** 서고,
 * 자동이라는 사실은 이름줄의 ⚡ 칩 하나가 말한다. 사람이 친 글에는 칩이 없다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { AutomationRunView, AutomationView } from '@harkroom/shared';
import { setController, type Controller } from '../src/state/controller';
import { AutomationsSettings } from '../src/components/settings/AutomationsSettings';
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

  it('에이전트가 돌린 회차(082)면 칩 hover 가 실행한 에이전트를 말한다 — 작성자는 그대로 소유자', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'jaebin'), g1: acc('g1', 'task_manager', 'agent') } });
    render(<MessageItem message={msg('m3', 'c1', 3, '주간 보고', 'u1', {
      meta: { automation: { id: 'a1', name: '주간 보고', trigger: 'manual', runId: 'r1', initiatedBy: 'g1' } },
    })} />);
    expect(screen.getByTestId('author-name').textContent).toBe('jaebin');
    const title = screen.getByTestId('automation-chip').getAttribute('title') ?? '';
    expect(title).toContain('@task_manager');
    expect(title).toContain('주간 보고');
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

  it('readAutomationMeta — initiatedBy 는 문자열일 때만 싣는다(옛 서버 글에는 없다)', () => {
    const base = { id: 'a1', name: 'n', trigger: 'manual', runId: 'r1' };
    expect(readAutomationMeta({ automation: { ...base, initiatedBy: 'g1' } })?.initiatedBy).toBe('g1');
    expect(readAutomationMeta({ automation: base })).not.toHaveProperty('initiatedBy');
    expect(readAutomationMeta({ automation: { ...base, initiatedBy: 7 } })).not.toHaveProperty('initiatedBy');
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

describe('설정 › Automations 실행 이력의 실행자(082)', () => {
  const automation: AutomationView = {
    id: 'a1', ownerId: 'u1', channelId: 'c1', name: '주간 보고', body: 'x',
    trigger: { kind: 'schedule', freq: 'weekly', weekdays: [1], time: '09:00', tz: 'Asia/Seoul' },
    enabled: true, nextAt: null, pausedReason: null, consecutiveFailures: 0, ingressEnabledAt: null,
    debounceSec: null, proposedBy: null, approvedAt: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  } as AutomationView;
  const run = (id: string, extra: Partial<AutomationRunView>): AutomationRunView => ({
    id, automationId: 'a1', eventKey: `manual:${id}`, triggerKind: 'manual', status: 'sent',
    messageId: null, error: null, createdAt: '2026-10-01T06:00:00.000Z', finishedAt: null, ...extra,
  });

  it('에이전트가 돌린 회차에만 "@에이전트 가 실행" 이 서고, 시킨 메시지 링크가 hover 에 있다', async () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'jaebin'), g1: acc('g1', 'task_manager', 'agent') } });
    setController({
      api: {
        listAutomations: vi.fn(async () => [automation]),
        getAutomation: vi.fn(async () => ({
          automation,
          runs: [
            run('r1', { initiatedBy: 'g1', causeMessageId: 'm9' }),
            run('r2', { initiatedBy: null }),
            run('r3', {}),
          ],
        })),
      },
    } as unknown as Controller);
    render(<AutomationsSettings />);
    fireEvent.click(await screen.findByTestId('automation-toggle-details'));
    fireEvent.click(await screen.findByText(translator('ko')('automations.row.history')));
    await waitFor(() => expect(screen.getByTestId('automation-runs')).toBeTruthy());
    const marks = screen.getAllByTestId('automation-run-initiator');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toContain('@task_manager');
    expect(marks[0]!.getAttribute('title')).toContain('harkroom://message/m9');
  });
});

describe('설정 › Automations 목록 — 최신이 위, 기본 접힘', () => {
  const make = (id: string, name: string, createdAt: string, body: string): AutomationView => ({
    id, ownerId: 'u1', channelId: 'c1', name, body,
    trigger: { kind: 'schedule', freq: 'daily', time: '09:00', tz: 'Asia/Seoul' },
    enabled: true, nextAt: null, pausedReason: null, consecutiveFailures: 0, ingressEnabledAt: null,
    debounceSec: null, proposedBy: null, approvedAt: createdAt, createdAt, updatedAt: createdAt,
  } as AutomationView);

  it('서버가 오래된 것부터 줘도 만든 시각 내림차순으로 선다', async () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'jaebin') } });
    setController({
      api: {
        listAutomations: vi.fn(async () => [
          make('a1', '첫째', '2026-09-01T00:00:00.000Z', 'b1'),
          make('a3', '셋째', '2026-10-01T00:00:00.000Z', 'b3'),
          make('a2', '둘째', '2026-09-15T00:00:00.000Z', 'b2'),
        ]),
      },
    } as unknown as Controller);
    render(<AutomationsSettings />);
    await waitFor(() => expect(screen.getAllByTestId('automation-row')).toHaveLength(3));
    expect(screen.getAllByTestId('automation-row').map((r) => r.textContent?.match(/⚡ (첫째|둘째|셋째)/)?.[1]))
      .toEqual(['셋째', '둘째', '첫째']);
  });

  it('카드는 접힌 채 이름·토글·일정만 보이고, 누르면 본문과 버튼이 펼쳐진다', async () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'jaebin') } });
    setController({
      api: { listAutomations: vi.fn(async () => [make('a1', '주간 보고', '2026-10-01T00:00:00.000Z', '본문-비밀')]) },
    } as unknown as Controller);
    render(<AutomationsSettings />);
    const toggle = await screen.findByTestId('automation-toggle-details');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('automation-enabled')).toBeTruthy();
    expect(screen.getByTestId('automation-summary').textContent).toContain('09:00');
    expect(screen.queryByText('본문-비밀')).toBeNull();
    expect(screen.queryByText(translator('ko')('automations.row.runNow'))).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('본문-비밀')).toBeTruthy();
    expect(screen.getByText(translator('ko')('automations.row.runNow'))).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.queryByText('본문-비밀')).toBeNull();
  });
});
