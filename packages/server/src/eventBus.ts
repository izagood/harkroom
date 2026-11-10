/**
 * 이벤트 버스 — 다른 프로세스가 `event_outbox` 에 쓴 이벤트를 이 프로세스의 이벤트(`events.ts::emitEvent`)로 옮긴다(S5.0, Rust 전환).
 *
 * 방향은 **Rust → TS 한 방향**이다. Rust 서버가 라우트를 하나씩 가져가는 동안(strangler), 그 라우트가 낸 이벤트가 아직 TS 에 붙은
 * WS 구독자에게 닿아야 한다. TS 자신이 낸 이벤트는 여기를 타지 않는다(지금처럼 메모리로 바로 간다).
 *
 * - 켜기: `EVENT_BUS=pg`(기본 꺼짐). 꺼져 있으면 아무 연결도 열지 않는다.
 * - 쓰는 쪽 계약: 한 트랜잭션에서 `insert into event_outbox(event) values ($1) returning id` 뒤
 *   `select pg_notify('harkroom_event_outbox', id::text)`. NOTIFY 는 커밋될 때만 나가므로 받는 쪽이 읽을 때 줄이 이미 있다.
 * - 받는 쪽: LISTEN 전용 연결 하나. 알림의 id 로 줄을 다시 읽어 검사한 뒤 낸다. 끊기면 다시 붙는다(끊긴 동안의 이벤트는 잃는다 —
 *   WS 클라이언트는 다시 붙을 때 처음부터 다시 받는 지금 규칙 그대로다).
 *
 * **검사하는 이유:** WS 걸러내기(`wsPlugin.ts::visibleTo`)는 모르는 `type` 을 모두에게 보내고, `audience` 가 없으면 던진다. outbox 에
 * 쓸 수 있는 것은 DB 에 쓰는 서버뿐이지만, 모양이 틀린 한 줄이 전원에게 퍼지지 않게 아는 `type` 과 받는 사람 모양만 통과시킨다.
 */
import type pg from 'pg';
import { emitEvent, type WorkspaceEvent } from './events.js';

export const EVENT_OUTBOX_CHANNEL = 'harkroom_event_outbox';
/** 한 시간 지난 줄은 걷는다 — 모든 프로세스가 이미 읽었을 시간이다. */
export const EVENT_OUTBOX_RETAIN_MS = 60 * 60 * 1000;
const PRUNE_EVERY_MS = 10 * 60 * 1000;
const RECONNECT_MS = [500, 1_000, 2_000, 5_000, 10_000];

/** `audience` 로 받는 사람을 가르는 이벤트(`visibleTo` 의 같은 갈래). */
const AUDIENCE_TYPES = new Set([
  'message.created', 'message.updated', 'message.deleted', 'reaction.added', 'reaction.removed', 'typing.changed',
  'channel.created', 'channel.updated', 'channel.deleted', 'channel.member_added', 'channel.member_removed',
  'handle_group.changed', 'agent_team.changed', 'grant.changed', 'operator.changed', 'agent_assignment.changed',
  'thread.agent_model.changed', 'thread.status', 'thread.reportWakes.changed', 'thread.plan.changed',
  'agent.attention', 'agent.attention.cleared',
]);
/** 계정 한 명에게만 가는 이벤트. */
const ACCOUNT_TYPES = new Set(['inbox.updated', 'saved.changed']);
/** 모두에게 가는 이벤트(`visibleTo` 가 true 를 돌려주는 것). */
const OPEN_TYPES = new Set([
  'presence.changed', 'status.changed', 'avatar.changed', 'workspace.icon.changed', 'account.handle_changed', 'lease.changed',
  'link_preview.ready', 'skill.approved', 'skill.disabled', 'skill.proposed',
]);
export const EVENT_BUS_TYPES: ReadonlySet<string> = new Set([...AUDIENCE_TYPES, ...ACCOUNT_TYPES, ...OPEN_TYPES]);

/** outbox 의 한 줄이 이 프로세스가 낼 수 있는 모양인가. 아니면 null(버린다). */
export function toWorkspaceEvent(value: unknown): WorkspaceEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  if (typeof e.type !== 'string' || !EVENT_BUS_TYPES.has(e.type)) return null;
  if (AUDIENCE_TYPES.has(e.type)) {
    const a = e.audience;
    const ok = a === 'all' || (Array.isArray(a) && a.every((x) => typeof x === 'string'));
    if (!ok) return null;
  }
  if (ACCOUNT_TYPES.has(e.type) && typeof e.accountId !== 'string') return null;
  return e as unknown as WorkspaceEvent;
}

export interface EventBusStats {
  received: number;
  dropped: number;
  /** 마지막으로 낸 이벤트의 `created_at` → 낸 시각(ms). 같은 DB 시계를 쓰므로 다시 읽기까지 든 지연이다. */
  lastLagMs: number | null;
}

export interface EventBusDeps {
  pool: pg.Pool;
  /** LISTEN 전용 연결을 만든다(풀 밖). 시험은 같은 DB 의 새 클라이언트를 준다. */
  connect: () => Promise<pg.Client>;
  emit?: (e: WorkspaceEvent) => void;
  log?: (line: string) => void;
}

export interface EventBus {
  stats(): EventBusStats;
  stop(): Promise<void>;
}

export async function startEventBus(deps: EventBusDeps): Promise<EventBus> {
  const emit = deps.emit ?? emitEvent;
  const log = deps.log ?? ((l: string) => console.log(l));
  const stats: EventBusStats = { received: 0, dropped: 0, lastLagMs: null };
  let client: pg.Client | null = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 알림을 하나씩 처리하는 사슬(위 `notification` 처리기). */
  let delivering: Promise<void> = Promise.resolve();

  const deliver = async (payload: string | undefined): Promise<void> => {
    if (!payload || !/^[1-9][0-9]{0,18}$/.test(payload)) { stats.dropped += 1; return; }
    const r = await deps.pool.query<{ event: unknown; lag_ms: number }>(
      'select event, extract(epoch from (clock_timestamp() - created_at)) * 1000 as lag_ms from event_outbox where id = $1',
      [payload],
    );
    const row = r.rows[0];
    const e = row ? toWorkspaceEvent(row.event) : null;
    if (!e) { stats.dropped += 1; return; }
    stats.received += 1;
    stats.lastLagMs = Number(row!.lag_ms);
    emit(e);
  };

  const open = async (): Promise<void> => {
    if (stopped) return;
    try {
      const c = await deps.connect();
      c.on('notification', (n) => {
        if (n.channel !== EVENT_OUTBOX_CHANNEL) return;
        // **알림이 온 순서대로 하나씩** 낸다. 알림 순서 = 커밋 순서다(같은 메시지의 created → updated 가 이 순서로 커밋된다).
        // 줄을 병렬로 다시 읽으면 늦게 끝난 읽기가 앞 이벤트를 추월해 WS 에 순서가 뒤바뀐 채 나간다. id 순서는 쓰지 않는다 —
        // bigserial 은 insert 때 정해져 커밋 순서와 다를 수 있다.
        delivering = delivering
          .then(() => deliver(n.payload))
          .catch((err: unknown) => log(`event bus: 읽기 실패: ${err instanceof Error ? err.message : String(err)}`));
      });
      c.on('error', (err) => { log(`event bus: 연결 오류: ${err.message}`); reconnect(c); });
      c.on('end', () => reconnect(c));
      await c.query(`listen ${EVENT_OUTBOX_CHANNEL}`);
      if (stopped) { await c.end().catch(() => {}); return; }
      client = c;
      attempt = 0;
    } catch (err) {
      log(`event bus: 붙지 못했다: ${err instanceof Error ? err.message : String(err)}`);
      reconnect(null);
    }
  };

  const reconnect = (from: pg.Client | null): void => {
    if (stopped || reconnectTimer) return;
    if (from && client !== from) return;
    client = null;
    const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)]!;
    attempt += 1;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void open(); }, delay);
    reconnectTimer.unref?.();
  };

  const prune = setInterval(() => {
    deps.pool.query('delete from event_outbox where created_at < now() - make_interval(secs => $1)', [EVENT_OUTBOX_RETAIN_MS / 1000])
      .catch((err: unknown) => log(`event bus: 걷기 실패: ${err instanceof Error ? err.message : String(err)}`));
  }, PRUNE_EVERY_MS);
  prune.unref?.();

  await open();
  return {
    stats: () => ({ ...stats }),
    async stop() {
      stopped = true;
      clearInterval(prune);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const c = client;
      client = null;
      if (c) await c.end().catch(() => {});
    },
  };
}
