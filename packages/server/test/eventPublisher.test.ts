// TS → outbox 발행(C6-α, `eventBus.ts::startEventPublisher`) — DB 없이 사슬의 규칙을 본다. 실 DB 로 되돌아옴이 없는지는 `eventBus.test.ts`,
// Rust 리스너가 TS 채널을 받아 같은 받는 사람 판정으로 내는지는 `crates/harkroom-server/tests/outbox_listener.rs` 가 본다.
import { describe, expect, it } from 'vitest';
import {
  EVENT_BUS_TYPES, EVENT_OUTBOX_CHANNEL, EVENT_OUTBOX_PRUNE_EVERY_MS, EVENT_OUTBOX_RETAIN_MS, EVENT_OUTBOX_TS_CHANNEL,
  PUBLISH_SKIP_TYPES, PUBLISH_SQL, startEventPublisher,
} from '../src/eventBus.js';
import type { WorkspaceEvent } from '../src/events.js';

/** 시험용 구독 — 손으로 emit 한다. */
function fakeBus() {
  let fn: ((e: WorkspaceEvent) => void) | null = null;
  return {
    subscribe: (f: (e: WorkspaceEvent) => void) => { fn = f; return () => { fn = null; }; },
    emit: (e: WorkspaceEvent) => fn?.(e),
  };
}
const inbox = (i: number): WorkspaceEvent => ({ type: 'inbox.updated', accountId: `a${i}` });

describe('startEventPublisher — 직렬 사슬', () => {
  it('emit 순서대로 하나씩 보낸다 — 앞 insert 가 늦게 끝나도 뒤 것이 먼저 나가지 않는다', async () => {
    const bus = fakeBus();
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let n = 0;
    const pool = {
      query: async (_sql: string, params: unknown[]) => {
        inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, Math.max(0, 30 - (n++) * 3)));
        order.push((JSON.parse(params[0] as string) as { accountId: string }).accountId);
        inFlight -= 1;
        return { rows: [], rowCount: 1 };
      },
    };
    const p = startEventPublisher({ pool: pool as never, subscribe: bus.subscribe, log: () => {} });
    for (let i = 0; i < 8; i += 1) bus.emit(inbox(i));
    await p.flush();
    expect(order).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
    expect(maxInFlight).toBe(1);
    expect(p.stats()).toEqual({ published: 8, failed: 0, dropped: 0, pending: 0 });
  });

  it('insert 와 NOTIFY 는 한 문장이고, 알림은 TS 채널로만 간다(TS 리스너가 듣는 옛 채널이 아니다)', () => {
    expect(PUBLISH_SQL).toMatch(/^with r as \(insert into event_outbox \(event\) values \(\$1\) returning id\) select pg_notify\('harkroom_event_outbox_ts', id::text\) from r$/);
    expect(EVENT_OUTBOX_TS_CHANNEL).not.toBe(EVENT_OUTBOX_CHANNEL);
  });

  it('실패해도 던지지 않고 센다 — 뒤 이벤트는 계속 나간다', async () => {
    const bus = fakeBus();
    const logs: string[] = [];
    let n = 0;
    const pool = { query: async () => { if (n++ === 0) throw new Error('db down'); return { rows: [], rowCount: 1 }; } };
    const p = startEventPublisher({ pool: pool as never, subscribe: bus.subscribe, log: (l) => logs.push(l) });
    expect(() => { bus.emit(inbox(1)); bus.emit(inbox(2)); }).not.toThrow();
    await p.flush();
    expect(p.stats()).toMatchObject({ published: 1, failed: 1, pending: 0 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain('a1'); // 이벤트 내용은 로그에 찍지 않는다
  });

  it('사슬이 상한을 넘으면 새 이벤트는 버리고 센다', async () => {
    const bus = fakeBus();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const pool = { query: async () => { await gate; return { rows: [], rowCount: 1 }; } };
    const p = startEventPublisher({ pool: pool as never, subscribe: bus.subscribe, cap: 3, log: () => {} });
    for (let i = 0; i < 5; i += 1) bus.emit(inbox(i));
    expect(p.stats()).toMatchObject({ pending: 3, dropped: 2 });
    release();
    await p.flush();
    expect(p.stats()).toEqual({ published: 3, failed: 0, dropped: 2, pending: 0 });
  });

  it('typing.changed 는 내지 않는다', async () => {
    const bus = fakeBus();
    const sent: string[] = [];
    const pool = { query: async (_s: string, params: unknown[]) => { sent.push((JSON.parse(params[0] as string) as { type: string }).type); return { rows: [], rowCount: 1 }; } };
    const p = startEventPublisher({ pool: pool as never, subscribe: bus.subscribe, log: () => {} });
    bus.emit({ type: 'typing.changed', channelId: 'c', accountIds: ['a'], audience: 'all' });
    bus.emit(inbox(1));
    await p.flush();
    expect(sent).toEqual(['inbox.updated']);
    expect([...PUBLISH_SKIP_TYPES]).toEqual(['typing.changed']);
  });

  it('출처 사이 인과 순서의 창 — emit 은 insert 를 기다리지 않고 돌아온다(TS 는 커밋 뒤 발행이라, 곧바로 이어진 Rust 쓰기의 이벤트가 몇 ms 먼저 닿을 수 있다. 받아들인 동작이다)', async () => {
    const bus = fakeBus();
    const pool = { query: async () => { await new Promise((r) => setTimeout(r, 20)); return { rows: [], rowCount: 1 }; } };
    const p = startEventPublisher({ pool: pool as never, subscribe: bus.subscribe, log: () => {} });
    bus.emit(inbox(1));
    expect(p.stats()).toMatchObject({ published: 0, pending: 1 });
    await p.flush();
    expect(p.stats().published).toBe(1);
  });

  it('stop 뒤에는 더 보내지 않는다', async () => {
    const bus = fakeBus();
    let calls = 0;
    const p = startEventPublisher({ pool: { query: async () => { calls += 1; return { rows: [], rowCount: 1 }; } } as never, subscribe: bus.subscribe, log: () => {} });
    bus.emit(inbox(1));
    await p.stop();
    bus.emit(inbox(2));
    expect(calls).toBe(1);
  });
});

describe('발행 대상·보존', () => {
  // 컴파일러가 빠짐없이 적게 한다 — `WorkspaceEvent` 에 종류를 더하고 여기를 안 고치면 typecheck 가 빨개진다.
  const ALL_TYPES: Record<WorkspaceEvent['type'], true> = {
    'message.created': true, 'message.updated': true, 'message.deleted': true, 'inbox.updated': true, 'lease.changed': true,
    'presence.changed': true, 'agent.attention': true, 'agent.attention.cleared': true, 'status.changed': true, 'avatar.changed': true,
    'workspace.icon.changed': true, 'account.handle_changed': true, 'reaction.added': true, 'reaction.removed': true, 'typing.changed': true,
    'channel.created': true, 'channel.updated': true, 'channel.deleted': true, 'channel.member_added': true, 'channel.member_removed': true,
    'handle_group.changed': true, 'agent_team.changed': true, 'grant.changed': true, 'operator.changed': true,
    'agent_assignment.changed': true, 'saved.changed': true, 'skill.proposed': true, 'skill.approved': true, 'skill.disabled': true,
    'link_preview.ready': true, 'thread.status': true, 'thread.agent_model.changed': true, 'thread.reportWakes.changed': true,
    'thread.plan.changed': true,
  };

  it('TS `WorkspaceEvent` 의 종류 ⊆ `EVENT_BUS_TYPES` — 발행한 것을 Rust 리스너가 버리지 않는다', () => {
    const missing = Object.keys(ALL_TYPES).filter((t) => !EVENT_BUS_TYPES.has(t));
    expect(missing).toEqual([]);
  });

  it('보존 5분·정리 1분(Rust `loops/outbox_prune.rs` 와 같은 값)', () => {
    expect(EVENT_OUTBOX_RETAIN_MS).toBe(5 * 60 * 1000);
    expect(EVENT_OUTBOX_PRUNE_EVERY_MS).toBe(60 * 1000);
  });

  it('secret 계열 종류는 버스에 없다 — outbox 에는 비밀값을 싣지 않는다', () => {
    expect([...EVENT_BUS_TYPES].filter((t) => /secret/i.test(t))).toEqual([]);
  });
});
