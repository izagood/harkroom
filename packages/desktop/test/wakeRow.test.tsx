import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { MessageRow } from '@harkroom/shared';
import { readWakeMeta } from '@harkroom/shared';
import { WakeRow } from '../src/components/WakeRow';
import { MessageItem } from '../src/components/MessageItem';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { stampLabel } from '../src/lib/day';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, msg as fakeMsg } from './helpers/fakeApi';

/**
 * 대기 줄(wake) — 에이전트가 "이 시각에 다시 본다"고 걸어 둔 예약(마이그레이션 040).
 *
 * 왜 보이게 그리는가: 2026-09-07 15:15 에 사용자가 화면을 보고 물은 것이 정확히
 * "죽었나 도나?" 였다. 그 답을 화면이 갖고 있지 않았다. 예약을 감추면 러너가 조용히
 * 기다리는 6분과 러너가 죽은 6분이 사람 눈에 **똑같이** 보인다.
 *
 * 왜 말풍선이 아닌가: 이것은 발화가 아니다(러너의 발화 판정에서도 세지 않는다 —
 * prompt.ts::countOwnPostsSince). 진행 줄과 같은 급의 상태 한 줄이다(규칙 02).
 */
const msg = (body: string, meta: Record<string, unknown>): MessageRow => ({
  id: 'w1', seq: 10, channelId: 'c', threadRootId: 't', authorId: 'a1', body,
  kind: 'wake', meta, createdAt: '2026-09-07T06:07:00.000Z', editedAt: null,
  reactions: [], attachments: [], replyCount: null, lastReplyAt: null,
  participantIds: null,
} as unknown as MessageRow);

describe('readWakeMeta', () => {
  it('시각을 읽어 준다', () => {
    const w = readWakeMeta({ kind: 'wake', wake: { wakeAt: '2026-09-07T06:12:00.000Z', reason: 'CI 결과 확인' } });
    expect(w?.wakeAt).toBe('2026-09-07T06:12:00.000Z');
  });

  // 모르는 meta 는 평문으로 흘린다 — 빈 상자는 "여기 뭔가 있다"는 거짓 신호다(readAskMeta 판례).
  it('형식을 못 알아보면 null 이다', () => {
    expect(readWakeMeta({ kind: 'wake' })).toBeNull();
    expect(readWakeMeta({ kind: 'wake', wake: { wakeAt: 42 } })).toBeNull();
    expect(readWakeMeta({})).toBeNull();
    expect(readWakeMeta(null)).toBeNull();
  });
});

// 이 저장소의 데스크탑 테스트는 auto-cleanup 을 켜 두지 않았다(progressRow.test.tsx 는
// 한 it 에서 한 번만 render 해 부딪치지 않았을 뿐이다). 같은 testid 를 두 번 그리는
// 파일에서는 직접 치운다 — 안 치우면 두 번째 단정이 앞 테스트의 DOM 을 본다.
afterEach(cleanup);

describe('WakeRow', () => {
  it('사유와 예약 시각을 한 줄로 그린다', () => {
    render(<WakeRow message={msg('CI 결과 확인', {
      kind: 'wake', wake: { wakeAt: '2026-09-07T06:12:00.000Z', reason: 'CI 결과 확인' },
    })} />);
    const row = screen.getByTestId('wake-row');
    expect(row.textContent).toContain('CI 결과 확인');
    // 시각은 **로컬 시간대로** 읽는다 — 서버가 문자열로 구워 보내면 다른 시간대에서 거짓이 된다.
    const local = new Date('2026-09-07T06:12:00.000Z')
      .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    expect(row.textContent).toContain(local);
  });

  // 옛 서버가 만든 wake 메시지나 손으로 쓴 meta 는 시각을 갖지 않을 수 있다. 그때도 사유는
  // 보여야 한다 — 대기 자체가 사실이고, 시각을 모르는 것은 그 사실을 지우지 않는다.
  it('시각을 못 읽어도 사유는 그린다', () => {
    render(<WakeRow message={msg('CI 결과 확인', {})} />);
    expect(screen.getByTestId('wake-row').textContent).toContain('CI 결과 확인');
  });

  describe('✅ 확인함 · 새로 없음 (2026-11-05)', () => {
    const WAKE_AT = '2026-09-07T06:12:00.000Z';
    const CHECKED_AT = '2026-09-07T06:13:00.000Z';
    const hhmm = (iso: string) => stampLabel(iso, 'ko');
    beforeEach(() => { usePrefsStore.getState().setLocale('ko'); });
    afterEach(() => { usePrefsStore.getState().setLocale('system'); });
    const row = (checkedAt: string | undefined, reactions: Array<{ emoji: string; accountIds: string[] }>): MessageRow => ({
      ...msg('CI 결과 확인', { kind: 'wake', wake: { wakeAt: WAKE_AT, reason: 'CI 결과 확인', ...(checkedAt ? { checkedAt } : {}) } }),
      reactions,
    });
    const owners = [{ emoji: '✅', accountIds: ['a1'] }];

    it('줄 주인의 ✅ + checkedAt: 🕐 자리에 ✅, 확인 시각, 말풍선에 약속 시각', () => {
      render(<WakeRow message={row(CHECKED_AT, owners)} />);
      const el = screen.getByTestId('wake-row');
      expect(el.textContent).toContain('✅');
      expect(el.textContent).not.toContain('🕐');
      expect(el.textContent).toContain(`${hhmm(CHECKED_AT)} 확인 · 새로 없음`);
      expect(el.querySelector('[title*="새 글 없이 끝남"]')?.getAttribute('title')).toBe(
        `${hhmm(WAKE_AT)} 에 다시 보기로 한 예약 — ${hhmm(CHECKED_AT)} 에 확인, 새 글 없이 끝남`,
      );
    });

    it('영어 문구', () => {
      usePrefsStore.getState().setLocale('en');
      render(<WakeRow message={row(CHECKED_AT, owners)} />);
      const at = (iso: string) => stampLabel(iso, 'en');
      const el = screen.getByTestId('wake-row');
      expect(el.textContent).toContain(`checked ${at(CHECKED_AT)} · nothing new`);
      expect(el.querySelector('[title*="nothing new"]')?.getAttribute('title')).toBe(
        `Scheduled to check at ${at(WAKE_AT)} — checked ${at(CHECKED_AT)}, ended with nothing new`,
      );
    });

    it('checkedAt 이 없거나 못 읽으면 시각 없이 「확인함 · 새로 없음」', () => {
      for (const at of [undefined, 'not-a-date']) {
        const { unmount } = render(<WakeRow message={row(at, owners)} />);
        const el = screen.getByTestId('wake-row');
        expect(el.textContent).toContain('✅');
        expect(el.textContent).toContain('확인함 · 새로 없음');
        expect(el.querySelector('[title*="새 글 없이 끝남"]')).toBeNull();
        unmount();
      }
    });

    it('사람이 단 ✅ 는 확인이 아니다 — checkedAt 이 있어도 🕐 그대로', () => {
      render(<WakeRow message={row(CHECKED_AT, [{ emoji: '✅', accountIds: ['u1'] }])} />);
      const el = screen.getByTestId('wake-row');
      expect(el.textContent).toContain('🕐');
      expect(el.textContent).not.toContain('✅');
      expect(el.textContent).toContain(`${hhmm(WAKE_AT)} 에 다시 본다`);
    });

    it('줄 주인의 다른 리액션(👀)은 확인이 아니다', () => {
      render(<WakeRow message={row(undefined, [{ emoji: '👀', accountIds: ['a1'] }])} />);
      expect(screen.getByTestId('wake-row').textContent).toContain('🕐');
    });

    it('사유는 한 줄로 자르고 전문은 title 에, 상태 문구는 줄바꿈하지 않는다', () => {
      const long = '가'.repeat(300);
      render(<WakeRow message={{ ...row(CHECKED_AT, owners), body: long }} />);
      const reason = screen.getByTitle(long);
      expect(reason.className).toContain('truncate');
      expect(reason.className).toContain('min-w-0');
      const status = screen.getByText(`${hhmm(CHECKED_AT)} 확인 · 새로 없음`);
      expect(status.className).toContain('whitespace-nowrap');
      expect(status.className).toContain('shrink-0');
    });

    it('리액션 칩을 그리지 않는다', () => {
      render(<WakeRow message={row(CHECKED_AT, owners)} />);
      expect(screen.getByTestId('wake-row').querySelector('button')).toBeNull();
    });
  });
});

/**
 * 라우팅 회귀선 — 대기 줄은 `MessageItem` 안에서 갈린다.
 *
 * 왜 `ChannelPane`/`ThreadPanel` 두 곳이 아니라 여기인가: 그 두 곳은 이미 같은 슬롯
 * 함수(`groupProgress`·`groupAgentExchanges`)를 공유하고, 분기를 양쪽에 심으면 한쪽만
 * 고쳐지는 날이 온다 — 이 저장소가 반복해 고친 결함이다. 종류로 갈리는 판정은 종류를
 * 아는 한 곳에 둔다.
 */
describe('MessageItem 라우팅', () => {
  it("kind='wake' 는 말풍선이 아니라 대기 줄로 그린다", () => {
    useAppStore.getState().reset();
    useAppStore.getState().set({ me: acc('u1', 'alice'), accounts: { u1: acc('u1', 'alice'), a1: acc('a1', 'mumur') } });

    render(<MessageItem message={fakeMsg('w9', 'c1', 10, 'CI 결과 확인', 'a1', {
      kind: 'wake', threadRootId: 't1',
      meta: { kind: 'wake', wake: { wakeAt: '2026-09-07T06:12:00.000Z', reason: 'CI 결과 확인' } },
    })} />);

    expect(screen.getByTestId('wake-row')).toBeTruthy();
    // 말풍선의 장치(리액션·툴바)가 붙으면 대기가 발화처럼 보인다.
    expect(screen.queryByTestId('message-toolbar')).toBeNull();
  });
});
