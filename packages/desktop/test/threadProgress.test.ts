import { describe, expect, it } from 'vitest';
import type { MessageRow } from '@harkroom/shared';
import { hasLiveWork, isIdle, threadProgress, type ThreadTurnsSnapshot } from '../src/lib/threadProgress';

const NOW = new Date(2026, 10, 24, 10, 0, 0).getTime();
const TODAY = new Date(2026, 10, 24, 9, 0, 0).toISOString();
const YESTERDAY = new Date(2026, 10, 23, 23, 0, 0).toISOString();

let seq = 0;
function row(over: Partial<MessageRow>): MessageRow {
  seq += 1;
  return {
    id: `m${seq}`, seq, channelId: 'c', threadRootId: 'root', authorId: 'agent', body: '', kind: 'user',
    meta: null, createdAt: TODAY, ...over,
  } as MessageRow;
}
const ask = (to: object, answered = false) => row({
  meta: { kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to, ...(answered ? { answeredWith: 'a' } : {}) } },
});
const report = (createdAt = TODAY) => row({ createdAt, meta: { kind: 'report', report: { checks: ['ok'] } } });
const failure = (meta: object = {}) => row({ meta: { kind: 'failure', failure: { reason: 'x', retryable: true, ...meta } } });

function count(messages: MessageRow[], turns: ThreadTurnsSnapshot = { kind: 'known', turns: [] }, extra: Partial<Parameters<typeof threadProgress>[0]> = {}) {
  return threadProgress({ messages, myAccountId: 'me', turns, wakes: 0, plan: null, legacyRunning: false, now: NOW, ...extra });
}

describe('threadProgress', () => {
  it('아무 일도 없으면 빈 띠다', () => {
    const p = count([row({})]);
    expect(p).toEqual({
      myTurn: 0, blocked: 0, running: 0, waiting: 0, waitingUnknown: false, doneToday: 0, lastDoneAt: null, lastReplyAt: TODAY,
    });
    expect(isIdle(p)).toBe(true);
  });

  it('나에게 열린 카드는 내 차례, 남에게 간 카드는 기다림이다', () => {
    const p = count([ask({ kind: 'human' }), ask({ kind: 'account', accountId: 'other' }), ask({ kind: 'human' }, true)]);
    expect(p.myTurn).toBe(1);
    expect(p.waiting).toBe(1);
  });

  it('도는 턴은 R1 목록의 수다 — 못 읽으면 0 이 아니라 모름이다', () => {
    expect(count([row({})], { kind: 'known', turns: [{ agentAccountId: 'a', startedAt: null }, { agentAccountId: 'b', startedAt: TODAY }] }).running).toBe(2);
    const unknown = count([row({})], { kind: 'unknown' });
    expect(unknown.running).toBeNull();
    expect(isIdle(unknown)).toBe(false);
  });

  it('읽는 길이 없는 서버에서는 스레드 상태의 「도는 중」으로 물러난다', () => {
    expect(count([row({})], { kind: 'off' }, { legacyRunning: true }).running).toBe(1);
    expect(count([row({})], { kind: 'off' }).running).toBe(0);
  });

  it('첫 답 전에도 같은 옛 판정으로 센다 — 0 으로 섰다가 바뀌지 않는다', () => {
    expect(count([row({})], { kind: 'checking' }, { legacyRunning: true }).running).toBe(1);
    expect(count([row({})], { kind: 'checking' }).running).toBe(0);
  });

  it('안 풀린 실패와 계획의 막힌 단계는 막힘이다 — 에이전트가 다시 움직이면 풀린다', () => {
    expect(count([failure()], undefined, { plan: { blocked: 2 } }).blocked).toBe(3);
    expect(count([failure(), row({ kind: 'progress' })]).blocked).toBe(0);
  });

  it('내 앞에 선 계정 관문 실패는 막힘이 아니라 내 차례다', () => {
    const p = count([failure({ code: 'account_gate', awaitingAccountId: 'me' })]);
    expect(p.myTurn).toBe(1);
    expect(p.blocked).toBe(0);
  });

  it('끝은 오늘 올라온 완료 보고만 센다', () => {
    expect(count([report(YESTERDAY), report(), report()]).doneToday).toBe(2);
  });

  it('이 스레드로 돌아올 예약은 기다림에 더한다', () => {
    expect(count([row({})], undefined, { wakes: 2 }).waiting).toBe(2);
  });

  it('예약을 못 읽었으면(null) 읽힌 것만 세고 「모름」을 세운다 — 빈 띠가 아니다', () => {
    const p = count([ask({ kind: 'account', accountId: 'other' })], undefined, { wakes: null });
    expect(p.waiting).toBe(1);
    expect(p.waitingUnknown).toBe(true);
    expect(isIdle(count([row({})], undefined, { wakes: null }))).toBe(false);
  });

  it('기다리는 작업 행도 기다림에 센다', () => {
    expect(count([row({})], undefined, { wakes: 1, workWaiting: 2 }).waiting).toBe(3);
  });

  it('마지막 끝은 마지막 완료 보고의 시각이고, 마지막 답은 진행·예약 줄을 건너뛴다', () => {
    const p = count([report(YESTERDAY), row({ createdAt: TODAY }), row({ kind: 'progress', createdAt: new Date(NOW).toISOString() })]);
    expect(p.lastDoneAt).toBe(YESTERDAY);
    expect(p.lastReplyAt).toBe(TODAY);
    expect(p.doneToday).toBe(0);
  });

  it('「오늘 끝」만 남으면 볼 일이 없다 — 모름은 볼 일로 친다', () => {
    const base = count([report(TODAY)]);
    expect(base.doneToday).toBe(1);
    expect(hasLiveWork(base)).toBe(false);
    expect(hasLiveWork({ ...base, waiting: 1 })).toBe(true);
    expect(hasLiveWork({ ...base, running: null })).toBe(true);
    expect(hasLiveWork({ ...base, waitingUnknown: true })).toBe(true);
  });
});
