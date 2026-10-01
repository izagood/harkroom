import { describe, it, expect } from 'vitest';
import { decideThreadStatus, THREAD_STATUS_EMOJI, type ThreadStatusFacts } from '../src/threadStatus.js';

const base: ThreadStatusFacts = {
  humanAsk: null, failure: null, deniedMention: null, agentWait: null, openWake: null,
  pendingMention: null, last: { kind: 'user', authorId: 'bot', authorIsAgent: true }, agentInvolved: true,
};
const live = new Set(['bot']);
const f = (o: Partial<ThreadStatusFacts>): ThreadStatusFacts => ({ ...base, ...o });

describe('decideThreadStatus — 위에서부터 이긴다', () => {
  it('에이전트가 안 낀 스레드는 상태를 달지 않는다', () => {
    expect(decideThreadStatus(f({ agentInvolved: false }), live)).toBeNull();
  });
  it('사람 앞 미답 물음이 실패보다 세다(🙋 > 🚨)', () => {
    const d = decideThreadStatus(f({
      humanAsk: { askerId: 'bot', prompt: '어느 쪽?' }, failure: { accountId: 'bot', what: 'x' },
    }), live);
    expect(d).toEqual({ status: 'my-turn', accountId: 'bot', reason: '어느 쪽?' });
  });
  it('안 풀린 실패·막힌 부름은 막힘', () => {
    expect(decideThreadStatus(f({ failure: { accountId: 'bot', what: 'MCP 인증' } }), live)?.status).toBe('stuck');
    expect(decideThreadStatus(f({ deniedMention: { authorId: 'h', targets: ['bot'] } }), live)?.status).toBe('stuck');
  });
  it('계정 관문(account_gate) 실패는 🚨 가 아니라 🙋 — 그 터미널에서 한 번 답하면 풀린다', () => {
    expect(decideThreadStatus(f({ failure: { accountId: 'bot', what: '설정 확인 대기', gate: true } }), live))
      .toEqual({ status: 'my-turn', accountId: 'bot', reason: '설정 확인 대기' });
    // 관문이 아닌 실패는 그대로 막힘이다.
    expect(decideThreadStatus(f({ failure: { accountId: 'bot', what: 'x', gate: false } }), live)?.status).toBe('stuck');
  });
  it('마지막 말이 진행인데 러너가 죽었으면 막힘, 모르면 도는 중', () => {
    const progress = f({ last: { kind: 'progress', authorId: 'bot', authorIsAgent: true } });
    expect(decideThreadStatus(progress, new Set())?.status).toBe('stuck');
    expect(decideThreadStatus(progress, null)?.status).toBe('running');
    expect(decideThreadStatus(progress, live)?.status).toBe('running');
  });
  it('깨움을 걸고 꺼진 러너는 죽은 것이 아니라 기다리는 것이다', () => {
    const d = decideThreadStatus(f({
      last: { kind: 'progress', authorId: 'bot', authorIsAgent: true },
      openWake: { accountId: 'bot', wakeAt: '2026-10-01T00:00:00Z' },
    }), new Set());
    expect(d?.status).toBe('waiting');
  });
  it('에이전트를 기다리는 물음이 깨움보다 먼저다', () => {
    const d = decideThreadStatus(f({
      agentWait: { waiterId: 'lead', blockedById: 'bot' }, openWake: { accountId: 'bot', wakeAt: 't' },
    }), live);
    expect(d).toEqual({ status: 'waiting', accountId: 'lead', reason: 'bot' });
  });
  it('배달됐지만 말이 없으면 받음, 아무것도 안 열려 있으면 끝남', () => {
    expect(decideThreadStatus(f({
      pendingMention: { agentId: 'bot' }, last: { kind: 'user', authorId: 'h', authorIsAgent: false },
    }), live)).toEqual({ status: 'received', accountId: 'bot', reason: null });
    expect(decideThreadStatus(base, live)).toEqual({ status: 'done', accountId: 'bot', reason: null });
  });
  it('이모지는 여섯 상태에 하나씩, 서로 다르다', () => {
    const all = Object.values(THREAD_STATUS_EMOJI);
    expect(new Set(all).size).toBe(6);
    expect(THREAD_STATUS_EMOJI).toMatchObject({ received: '👀', running: '💬', waiting: '⏳', 'my-turn': '🙋', stuck: '🚨', done: '✅' });
  });
});
