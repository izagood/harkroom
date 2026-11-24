import { describe, expect, it } from 'vitest';
import type { AgentWakeView, MessageRow } from '@harkroom/shared';
import { firstMyTurnMessageId, flattenWork, threadWorkItems, type ThreadWorkInput } from '../src/lib/threadWork';
import { threadProgress } from '../src/lib/threadProgress';

const NOW = new Date(2026, 10, 24, 10, 0, 0).getTime();
const TODAY = new Date(2026, 10, 24, 9, 0, 0).toISOString();
const YESTERDAY = new Date(2026, 10, 23, 23, 0, 0).toISOString();

let seq = 0;
function row(over: Partial<MessageRow>): MessageRow {
  seq += 1;
  return {
    id: `m${seq}`, seq, channelId: 'c', threadRootId: 'root', authorId: 'agent', body: `body ${seq}`, kind: 'user',
    meta: null, createdAt: TODAY, ...over,
  } as MessageRow;
}
const ask = (to: object, prompt?: string) => row({
  meta: { kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to, ...(prompt ? { prompt } : {}) } },
});
const report = (createdAt = TODAY) => row({ createdAt, meta: { kind: 'report', report: { checks: ['ok'] } } });
const failure = (meta: object = {}) => row({ meta: { kind: 'failure', failure: { what: 'deploy', reason: 'x', retryable: true, ...meta } } });
const wake = (id: string): AgentWakeView => ({
  id, agentAccountId: 'agent', channelId: 'c', threadRootId: 'root', messageId: `wm-${id}`,
  wakeAt: new Date(NOW + 7 * 60_000).toISOString(), reason: 'check the gate\nsecond line',
} as AgentWakeView);

function build(over: Partial<ThreadWorkInput>) {
  return threadWorkItems({
    messages: [], myAccountId: 'me', turns: [], wakes: [], work: [], planBlocked: 0,
    titleOf: (m) => m.body, now: NOW, ...over,
  });
}

describe('threadWorkItems', () => {
  it('묶음은 띠와 같은 순서다 — 내 차례 → 막힘 → 도는 중 → 기다림 → 오늘 끝', () => {
    const items = build({
      messages: [report(), ask({ kind: 'account', accountId: 'other' }), ask({ kind: 'human' }), failure()],
      turns: [{ agentAccountId: 'agent', startedAt: TODAY }],
      wakes: [wake('w1')],
    });
    expect(items.map((i) => i.group)).toEqual(['myTurn', 'blocked', 'running', 'waiting', 'waiting', 'doneToday']);
  });

  it('카드 줄은 물음의 첫 줄을 제목으로 쓰고, 남에게 간 카드는 누구의 답을 기다리는지 든다', () => {
    const mine = ask({ kind: 'human' }, 'merge #1?\nmore');
    const theirs = ask({ kind: 'account', accountId: 'other' });
    const items = build({ messages: [mine, theirs] });
    expect(items[0]).toMatchObject({ group: 'myTurn', title: 'merge #1?', messageId: mine.id, detail: { kind: 'ask', awaitingId: null } });
    expect(items[1]).toMatchObject({ group: 'waiting', title: theirs.body, detail: { kind: 'ask', awaitingId: 'other' } });
    expect(firstMyTurnMessageId(items)).toBe(mine.id);
  });

  it('풀린 실패는 줄이 없고, 내 앞의 계정 관문 실패는 내 차례다', () => {
    expect(build({ messages: [failure(), row({ kind: 'progress' })] })).toEqual([]);
    const gate = failure({ code: 'account_gate', awaitingAccountId: 'me' });
    const items = build({ messages: [gate] });
    expect(items[0]).toMatchObject({ group: 'myTurn', detail: { kind: 'gate' }, title: 'deploy', messageId: gate.id });
  });

  it('도는 턴의 「무엇을」은 그 에이전트의 안 끝난 작업 행, 없으면 마지막 진행 글에서 잇는다', () => {
    const progress = row({ kind: 'progress', body: 'building' });
    const turns = [{ agentAccountId: 'agent', startedAt: TODAY }];
    const fromWork = build({
      messages: [progress], turns,
      work: flattenWork([{ id: 'w', state: 'running', title: 'ship the drawer', assigneeId: 'agent' }]),
    });
    expect(fromWork[0]).toMatchObject({ group: 'running', title: 'ship the drawer', actorId: 'agent', at: TODAY });
    expect(build({ messages: [progress], turns })[0]!.title).toBe('building');
    expect(build({ turns })[0]!.title).toBeNull();
  });

  it('도는 턴·예약을 못 읽었으면 0 줄이 아니라 「모름」 줄이 선다', () => {
    const items = build({ turns: null, wakes: null });
    expect(items.map((i) => i.detail.kind)).toEqual(['turnUnknown', 'wakeUnknown']);
  });

  it('기다리는 작업 행만 기다림에 서고, 나무는 납작하게 편다', () => {
    const work = flattenWork([
      { id: 'a', state: 'open', title: 'parent', children: [{ id: 'b', state: 'waiting', title: 'child', openChildren: 2 }] },
      { nope: true }, 'junk',
    ]);
    expect(work.map((w) => w.id)).toEqual(['a', 'b']);
    const items = build({ work });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ group: 'waiting', title: 'child', detail: { kind: 'work', openChildren: 2 } });
    expect(flattenWork(null)).toEqual([]);
  });

  it('오늘 끝은 오늘 올라온 완료 보고만이고 최근 것이 위다', () => {
    const first = report();
    const second = report();
    const items = build({ messages: [report(YESTERDAY), first, second] });
    expect(items.map((i) => i.messageId)).toEqual([second.id, first.id]);
  });

  it('띠의 수와 서랍의 줄 수가 같다', () => {
    const messages = [
      report(), ask({ kind: 'account', accountId: 'other' }), ask({ kind: 'human' }), ask({ kind: 'human' }), failure(),
    ];
    const turns = [{ agentAccountId: 'agent', startedAt: TODAY }, { agentAccountId: 'b', startedAt: null }];
    const work = flattenWork([{ id: 'w', state: 'waiting', title: 't' }]);
    const items = build({ messages, turns, wakes: [wake('w1')], work, planBlocked: 2 });
    const p = threadProgress({
      messages, myAccountId: 'me', turns: { kind: 'known', turns }, wakes: 1, workWaiting: 1,
      plan: { blocked: 2 }, legacyRunning: false, now: NOW,
    });
    const n = (g: string) => items.filter((i) => i.group === g)
      .reduce((sum, i) => sum + (i.detail.kind === 'planBlocked' ? i.detail.count : 1), 0);
    expect({ myTurn: n('myTurn'), blocked: n('blocked'), running: n('running'), waiting: n('waiting'), doneToday: n('doneToday') })
      .toEqual({ myTurn: p.myTurn, blocked: p.blocked, running: p.running, waiting: p.waiting, doneToday: p.doneToday });
  });
});
