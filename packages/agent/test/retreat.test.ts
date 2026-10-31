// 물러나는 길(retreat.ts) — 종료 신호를 받은 러너는 다시 붙지 않고, 시한 안에 반드시 끝난다.
// 2026-10-22: 장부에서 빠진 고아가 SIGTERM 뒤에도 1초마다 다시 붙으며 살았다(핸들러가 폴 플래그만 껐다).
// 2026-10-31: 오퍼레이터 교체 직후의 회수 신호가 링크 재접속 백오프 한가운데 떨어져, 곧 다시 붙을 러너가 도구 호출
// 중이던 턴을 중단했다 — 링크가 없으면 창(`RETREAT_RELINK_WAIT_MS`) 동안 다시 붙기를 기다린 뒤 판정한다.
import { describe, it, expect, vi } from 'vitest';
import { createRelayClient, type RelayHandlers, type RelayTransport, type RunnerLinkTarget } from '../src/relay.js';
import { createRetreat, RETREAT_DRAIN_DEADLINE_MS, RETREAT_LINK_DOWN_GRACE_MS, RETREAT_RELINK_WAIT_MS } from '../src/retreat.js';

const LINK: RunnerLinkTarget = { socketPath: '/tmp/op.sock', runnerId: 'r-1', secret: 'sec' };
const SESSION = { agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1', harness: 'claude-code', acceptsInput: false } as const;

function fakeDialer() {
  const dials: RelayHandlers[] = [];
  const dial = (_link: RunnerLinkTarget, handlers: RelayHandlers) => { dials.push(handlers); };
  const open = (): RelayTransport => {
    const t: RelayTransport = { send: () => {}, close: () => {} };
    dials.at(-1)!.onOpen(t);
    return t;
  };
  const rejectAndDrop = () => {
    const h = dials.at(-1)!;
    h.onOpen({ send: () => {}, close: () => {} });
    h.onMessage(JSON.stringify({ type: 'link.rejected', reason: 'unknown_runner' }));
    h.onClose();
  };
  return { dial, dials, open, rejectAndDrop };
}

/** 예약을 손으로 돌리는 시계 — 릴레이 재접속과 물러남 시한을 따로 쌓는다. */
function manualSchedule() {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => { pending.push({ fn, ms }); },
    pending,
    fireNext: () => { pending.shift()?.fn(); },
  };
}

describe('종료 신호 — 다시 붙지 않고 시한 안에 끝난다', () => {
  it('계속 거절되는 고아가 SIGTERM 을 받으면 창 동안 다시 붙지 못하고, 창 끝에 열린 턴을 중단하고, 더 dial 하지 않고, 유예 뒤 끝낸다', () => {
    const d = fakeDialer();
    const relaySched = manualSchedule();
    const relay = createRelayClient({ link: LINK, unixDial: d.dial, schedule: relaySched.schedule, initialBackoffMs: 1_000, log: () => {} });
    relay.start();
    const onCancel = vi.fn();
    relay.openSession({ ...SESSION, onCancel });
    // 거절이 몇 번 되풀이되는 중(아직 포기 전)…
    for (let i = 0; i < 3; i++) { d.rejectAndDrop(); relaySched.fireNext(); }

    const exit = vi.fn();
    const stopLoop = vi.fn();
    const retreatSched = manualSchedule();
    const retreat = createRetreat({ relay, stopLoop, exit, schedule: retreatSched.schedule, log: () => {} });
    retreat.onSignal('SIGTERM');

    expect(stopLoop).toHaveBeenCalledTimes(1);
    // 신호 순간에는 고아인지 교체 중인지 모른다 — 아직 중단하지 않고 창을 건다.
    expect(onCancel).not.toHaveBeenCalled();
    expect(retreatSched.pending.map((p) => p.ms)).toEqual([RETREAT_RELINK_WAIT_MS]);
    // 창 안에서도 거절된다(열린 뒤 첫 프레임이 거절) — 창 끝에 링크가 없다.
    d.rejectAndDrop();
    retreatSched.fireNext();
    expect(onCancel).toHaveBeenCalledWith('operator');
    // 판정한 뒤에는 이미 걸려 있던 재접속이 돌아도 다시 dial 하지 않는다.
    const dialsBefore = d.dials.length;
    while (relaySched.pending.length) relaySched.fireNext();
    expect(d.dials.length).toBe(dialsBefore);
    // 링크가 없으니 짧은 유예 뒤 반드시 끝낸다.
    expect(retreatSched.pending.map((p) => p.ms)).toEqual([RETREAT_LINK_DOWN_GRACE_MS]);
    retreatSched.fireNext();
    expect(exit).toHaveBeenCalledWith(0);
  });

  /**
   * 2026-10-31 실측: 앱 업데이트로 오퍼레이터가 바뀌었다. 새 오퍼레이터는 기동하며 옛 러너의 secret 을 받아 두고
   * SIGTERM 을 보낸다 — 그 순간 러너의 링크는 죽은 옛 오퍼레이터를 향해 끊겨 백오프 중이었다. 신호를 받자마자
   * 재접속을 막고 "링크가 없다"로 판정해 도구 호출 중이던 턴을 중단했다.
   *
   * 되돌려 RED: 신호 순간에 `holdReconnect`·`cancelSessions` 를 하던 옛 판정으로 돌리면 `onCancel` 이 불리고 다시 dial 하지 않는다.
   */
  it('링크가 끊긴 채 신호를 받아도 창 안에 다시 붙으면(오퍼레이터 교체) 턴을 중단하지 않고 드레인한다 — 판정 뒤에는 다시 붙지 않는다', () => {
    const d = fakeDialer();
    const relaySched = manualSchedule();
    const relay = createRelayClient({ link: LINK, unixDial: d.dial, schedule: relaySched.schedule, initialBackoffMs: 1_000, log: () => {} });
    relay.start();
    d.open();
    const onCancel = vi.fn();
    relay.openSession({ ...SESSION, onCancel });
    // 옛 오퍼레이터가 죽었다 — 링크가 끊기고 재접속이 백오프에 걸린다.
    d.dials.at(-1)!.onClose();
    expect(relay.connected()).toBe(false);

    const exit = vi.fn();
    const retreatSched = manualSchedule();
    createRetreat({ relay, stopLoop: () => {}, exit, schedule: retreatSched.schedule, log: () => {} }).onSignal('SIGTERM');
    expect(onCancel).not.toHaveBeenCalled();

    // 걸려 있던 재접속이 돌아 새 오퍼레이터에 붙는다(secret 을 받아 두었으므로 거절이 없다).
    relaySched.fireNext();
    expect(d.dials).toHaveLength(2);
    d.open();
    expect(relay.connected()).toBe(true);

    // 창 끝: 붙어 있으니 드레인 — 중단하지 않고 드레인 시한을 건다.
    expect(retreatSched.pending.map((p) => p.ms)).toEqual([RETREAT_RELINK_WAIT_MS]);
    retreatSched.fireNext();
    expect(onCancel).not.toHaveBeenCalled();
    expect(retreatSched.pending.map((p) => p.ms)).toEqual([RETREAT_DRAIN_DEADLINE_MS]);
    // 판정 뒤에는 다시 붙지 않는다.
    d.dials.at(-1)!.onClose();
    while (relaySched.pending.length) relaySched.fireNext();
    expect(d.dials).toHaveLength(2);
    retreatSched.fireNext();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('링크가 끊긴 채 신호를 받고 창이 지나도록 못 붙으면(오퍼레이터 없음) 창 끝에 턴을 중단하고 유예 뒤 끝낸다', () => {
    const d = fakeDialer();
    const relaySched = manualSchedule();
    const relay = createRelayClient({ link: LINK, unixDial: d.dial, schedule: relaySched.schedule, initialBackoffMs: 1_000, log: () => {} });
    relay.start();
    d.open();
    const onCancel = vi.fn();
    relay.openSession({ ...SESSION, onCancel });
    d.dials.at(-1)!.onClose();

    const exit = vi.fn();
    const retreatSched = manualSchedule();
    createRetreat({ relay, stopLoop: () => {}, exit, schedule: retreatSched.schedule, log: () => {} }).onSignal('SIGTERM');
    // 창 안에서는 재접속을 막지 않는다 — 소켓이 없어(ENOENT) 열리지 못한 채 닫힌다.
    relaySched.fireNext();
    expect(d.dials).toHaveLength(2);
    d.dials.at(-1)!.onClose('ENOENT');
    expect(onCancel).not.toHaveBeenCalled();

    retreatSched.fireNext();
    expect(onCancel).toHaveBeenCalledWith('operator');
    expect(retreatSched.pending.map((p) => p.ms)).toEqual([RETREAT_LINK_DOWN_GRACE_MS]);
    while (relaySched.pending.length) relaySched.fireNext();
    expect(d.dials).toHaveLength(2);
    retreatSched.fireNext();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('링크가 붙어 있으면(오퍼레이터의 드레인) 지금 링크로 드레인하고 턴을 중단하지 않는다 — 끊겨도 다시 붙지 않고, 시한이 있다', () => {
    const d = fakeDialer();
    const relaySched = manualSchedule();
    const relay = createRelayClient({ link: LINK, unixDial: d.dial, schedule: relaySched.schedule, initialBackoffMs: 1_000, log: () => {} });
    relay.start();
    d.open();
    const onCancel = vi.fn();
    relay.openSession({ ...SESSION, onCancel });
    const exit = vi.fn();
    const retreatSched = manualSchedule();
    createRetreat({ relay, stopLoop: () => {}, exit, schedule: retreatSched.schedule, log: () => {} }).onSignal('SIGTERM');

    expect(onCancel).not.toHaveBeenCalled();
    expect(relay.connected()).toBe(true);
    expect(retreatSched.pending.map((p) => p.ms)).toEqual([RETREAT_DRAIN_DEADLINE_MS]);
    // 드레인 중 링크가 끊기면 다시 붙지 않는다.
    d.dials.at(-1)!.onClose();
    while (relaySched.pending.length) relaySched.fireNext();
    expect(d.dials).toHaveLength(1);
    retreatSched.fireNext();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('오퍼레이터 거절로 포기한 길도 같은 시한 함수를 쓴다 — 짧은 쪽이 이긴다', () => {
    const relay = { holdReconnect: vi.fn(), cancelSessions: vi.fn(), connected: () => true, stop: vi.fn() };
    const exit = vi.fn();
    const sched = manualSchedule();
    const retreat = createRetreat({ relay, stopLoop: () => {}, exit, schedule: sched.schedule, log: () => {} });
    retreat.onSignal('SIGTERM');
    retreat.onLinkRejectedGiveUp();
    expect(sched.pending.map((p) => p.ms)).toEqual([RETREAT_DRAIN_DEADLINE_MS, RETREAT_LINK_DOWN_GRACE_MS]);
    // 긴 시한은 짧은 시한에 밀려 아무 일도 하지 않는다 — 끝내는 것은 한 번.
    sched.fireNext();
    expect(exit).not.toHaveBeenCalled();
    sched.fireNext();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(relay.stop).toHaveBeenCalledTimes(1);
  });

  it('창 안에 거절이 쌓여 먼저 물러나면(고아) 창 끝의 판정은 아무것도 다시 하지 않는다', () => {
    const relay = { holdReconnect: vi.fn(), cancelSessions: vi.fn(), connected: () => false, stop: vi.fn() };
    const exit = vi.fn();
    const sched = manualSchedule();
    const retreat = createRetreat({ relay, stopLoop: () => {}, exit, schedule: sched.schedule, log: () => {} });
    retreat.onSignal('SIGTERM');
    retreat.onLinkRejectedGiveUp();
    expect(sched.pending.map((p) => p.ms)).toEqual([RETREAT_RELINK_WAIT_MS, RETREAT_LINK_DOWN_GRACE_MS]);
    sched.fireNext();
    // 릴레이가 이미 세션을 중단했다(`giveUpRejected`) — 여기서 다시 부르지 않는다.
    expect(relay.cancelSessions).not.toHaveBeenCalled();
    sched.fireNext();
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
