// Task 9 — 완료 보고 + 다음 제안(규칙 03: 읽히는 말).
//
// 이 스레드에서 **가장 오래 남고 가장 많이 다시 읽히는 말**이다. 그래서 자유 문장이 아니라
// 형식이고, 형식을 안 지키면 **조용히 사라진다** — 빈 상자는 거짓 신호다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { MessageRow, ReportMeta } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const ME = 'u-me';
const FORGE = 'a-forge';

const reportMeta = (over: Partial<ReportMeta['report']> = {}): Record<string, unknown> => ({
  kind: 'report',
  report: { checks: ['ws 재연결 경로를 따라갔다'], ...over },
} as unknown as Record<string, unknown>);

const reportMsg = (meta: Record<string, unknown>, threadRootId: string | null = null): MessageRow =>
  msg('m-report', 'c1', 1, 'ws 쪽 점검을 끝냈다', FORGE, { meta, threadRootId });

beforeEach(() => {
  useAppStore.getState().reset();
  setController({} as unknown as Controller);
  useAppStore.getState().set({
    me: acc(ME, 'jaebin'),
    accounts: { [ME]: acc(ME, 'jaebin'), [FORGE]: acc(FORGE, 'forge', 'agent') },
  });
});
afterEach(() => cleanup());

describe('ReportCard — 읽기 조판', () => {
  it('확인한 것 · 바뀐 파일 · 남은 것을 나눠 그린다', () => {
    render(<MessageItem message={reportMsg(reportMeta({
      checks: ['연속 미응답만 끊는다', '회귀 테스트로 고정했다'],
      files: ['ws/heartbeat.test.ts', 'projection/worker.ts'],
      remaining: ['lint 를 다시 부를지'],
      durationMs: 400_000,
    }))} />);

    expect(screen.getByTestId('report-card')).toBeTruthy();
    expect(screen.getByText('연속 미응답만 끊는다')).toBeTruthy();
    expect(screen.getByText('ws/heartbeat.test.ts')).toBeTruthy();
    expect(screen.getByText('lint 를 다시 부를지')).toBeTruthy();
    expect(screen.getByText('6분 40초')).toBeTruthy();
  });

  it('없는 묶음은 그리지 않는다 — 0 은 자리를 차지하지 않는다', () => {
    render(<MessageItem message={reportMsg(reportMeta())} />);
    expect(screen.getByTestId('report-checks')).toBeTruthy();
    expect(screen.queryByTestId('report-files')).toBeNull();
    expect(screen.queryByTestId('report-remaining')).toBeNull();
  });
});

describe('ReportCard — 다음 제안', () => {
  it('누르면 작성창을 채운다 — 바로 보내지 않는다', () => {
    render(<MessageItem message={reportMsg(reportMeta({
      next: [{ id: 'lint', label: 'lint 를 다시 불러 줘' }],
    }))} />);

    fireEvent.click(screen.getByTestId('report-next-lint'));
    // 한 번의 확인을 남긴다(`FailureCard` 의 '다시 부르기'와 같은 규약).
    expect(useAppStore.getState().drafts['c1']).toBe('lint 를 다시 불러 줘');
  });

  it('스레드 안에서는 스레드 작성창을 채운다 — 채널 것을 채우면 사람이 못 본다', () => {
    render(
      <MessageItem
        message={reportMsg(reportMeta({ next: [{ id: 'x', label: '다음' }] }), 'root-1')}
        inThread
      />,
    );
    fireEvent.click(screen.getByTestId('report-next-x'));
    expect(useAppStore.getState().drafts['thread:root-1']).toBe('다음');
  });
});

/**
 * **형식을 안 지키면 조용히 사라진다.** 계획서가 "지키지 않으면 조용히 사라지는 설계가
 * 필수"라고 적은 자리다 — 빈 상자만 남으면 화면이 요약 품질에 인질로 잡힌다.
 */
describe('ReportCard — 못 알아본 형식', () => {
  it('checks 가 비면 카드를 그리지 않고 본문만 남는다', () => {
    for (const meta of [
      {},
      { kind: 'report' },
      { kind: 'report', report: {} },
      { kind: 'report', report: { checks: [] } },
      { kind: 'report', report: { checks: [''] } },
      // files 만 있고 checks 가 없는 것도 보고가 아니다.
      { kind: 'report', report: { files: ['a.ts'] } },
    ] as Record<string, unknown>[]) {
      cleanup();
      render(<MessageItem message={reportMsg(meta)} />);
      expect(screen.queryByTestId('report-card')).toBeNull();
      expect(screen.getByText(/ws 쪽 점검을 끝냈다/)).toBeTruthy();
    }
  });
});
