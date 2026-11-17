/**
 * 이벤트 버스 — 다른 프로세스가 `event_outbox` 에 쓴 이벤트를 이 프로세스의 이벤트(`events.ts::emitEvent`)로 옮긴다(S5.0, Rust 전환).
 *
 * 듣는 방향은 **Rust → TS** 다. Rust 서버가 라우트를 하나씩 가져가는 동안(strangler), 그 라우트가 낸 이벤트가 아직 TS 에 붙은
 * WS 구독자에게 닿아야 한다. TS 자신이 낸 이벤트는 여기를 타지 않는다(지금처럼 메모리로 바로 간다).
 *
 * 내는 방향(**TS → Rust**, C6-α)은 `startEventPublisher` 다(`EVENT_BUS_PUBLISH=pg`, 기본 꺼짐). TS 가 낸 이벤트를 outbox 에 쓰고
 * **다른 채널**(`EVENT_OUTBOX_TS_CHANNEL`)로 알린다. Rust 리스너는 두 채널을 다 듣고 이 리스너는 옛 채널만 들으므로, TS 이벤트가 TS 로
 * 되돌아와 두 번 나가지 않는다. 출처는 서버 코드가 고른 채널 이름뿐이다 — 클라이언트 입력이 닿는 자리가 없다.
 * **`HARKROOM_CORE=rust` 인 동안 발행을 끄면 안 된다** — 그때 앱 소켓은 Rust 에 붙어 있어 TS 쓰기의 이벤트가 앱에 닿지 않는다.
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
import { emitEvent, onEvent, type WorkspaceEvent } from './events.js';
import { runGated } from './services/loopGate.js';

export const EVENT_OUTBOX_CHANNEL = 'harkroom_event_outbox';
/** TS 가 낸 이벤트의 알림 채널(C6-α) — Rust `harkroom_bus::EVENT_OUTBOX_TS_CHANNEL` 과 같아야 한다. 이 프로세스는 듣지 않는다. */
export const EVENT_OUTBOX_TS_CHANNEL = 'harkroom_event_outbox_ts';
/**
 * 5분 지난 줄은 걷는다(C6-α 에서 1시간 → 5분). 리스너는 ms 안에 읽고 끊긴 동안의 줄은 다시 읽지 않으므로 오래 둘 이유가 없다 —
 * 표에는 비공개 채널 본문과 audience 계정 id 가 실리니 노출 창만 커진다. Rust `loops/outbox_prune.rs::EVENT_OUTBOX_RETAIN` 과 같다.
 */
export const EVENT_OUTBOX_RETAIN_MS = 5 * 60 * 1000;
/** 정리 주기(1분) — Rust `OUTBOX_PRUNE_INTERVAL` 과 같다. */
export const EVENT_OUTBOX_PRUNE_EVERY_MS = 60 * 1000;

/**
 * 보존이 지난 outbox 줄을 지운다 — 지운 수. Rust `loops/outbox_prune.rs` 와 같은 조건이다(S5.3 C5c-4). 두 쪽이 겹쳐 돌아도
 * 멱등이다(늦은 쪽은 줄 잠금을 기다린 뒤 이미 지워진 줄을 건너뛴다). 평소에는 문지기(`outbox.prune`)가 한쪽만 돌린다.
 */
export async function pruneEventOutbox(pool: pg.Pool): Promise<number> {
  const r = await pool.query('delete from event_outbox where created_at < now() - make_interval(secs => $1)', [EVENT_OUTBOX_RETAIN_MS / 1000]);
  return r.rowCount ?? 0;
}
const RECONNECT_MS = [500, 1_000, 2_000, 5_000, 10_000];

/** `audience` 로 받는 사람을 가르는 이벤트(`visibleTo` 의 같은 갈래). */
export const AUDIENCE_TYPES: ReadonlySet<string> = new Set([
  'message.created', 'message.updated', 'message.deleted', 'reaction.added', 'reaction.removed', 'typing.changed',
  'channel.created', 'channel.updated', 'channel.deleted', 'channel.member_added', 'channel.member_removed',
  'handle_group.changed', 'agent_team.changed', 'grant.changed', 'operator.changed', 'agent_assignment.changed',
  'thread.agent_model.changed', 'thread.status', 'thread.reportWakes.changed', 'thread.plan.changed',
  'agent.attention', 'agent.attention.cleared',
]);
/** 계정 한 명에게만 가는 이벤트. */
export const ACCOUNT_TYPES: ReadonlySet<string> = new Set(['inbox.updated', 'saved.changed']);
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

  // 문지기 아래서 — 주인(`server_loop` 의 `outbox.prune`)이 ts 일 때만 이 프로세스가 지운다(rust 면 Rust 앞단이 지운다).
  const prune = setInterval(() => {
    void runGated(deps.pool, 'outbox.prune', () => pruneEventOutbox(deps.pool), {
      onError: (err: unknown) => log(`event bus: 걷기 실패: ${err instanceof Error ? err.message : String(err)}`),
    });
  }, EVENT_OUTBOX_PRUNE_EVERY_MS);
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

/** TS 가 outbox 로 내지 않는 종류 — 소켓이 낸 순간 신호다. Rust 는 자기 소켓에서 따로 낸다(양만 많고 지난 값은 쓸모없다). */
export const PUBLISH_SKIP_TYPES: ReadonlySet<string> = new Set(['typing.changed']);
/** 발행 사슬에 쌓일 수 있는 최대 건수 — 넘으면 새 이벤트를 버리고 센다(DB 가 멈춰도 메모리가 끝없이 자라지 않게). */
export const PUBLISH_CHAIN_CAP = 10_000;

/** insert 와 NOTIFY 를 **한 문장**으로 — 자동 커밋이라 줄이 커밋될 때 알림도 나간다(받는 쪽이 읽을 때 줄이 있다). */
export const PUBLISH_SQL =
  `with r as (insert into event_outbox (event) values ($1) returning id) select pg_notify('${EVENT_OUTBOX_TS_CHANNEL}', id::text) from r`;

export interface EventPublisherStats {
  published: number;
  /** insert·NOTIFY 가 실패한 수(요청은 막지 않는다). */
  failed: number;
  /** 사슬이 상한을 넘어 버린 수. */
  dropped: number;
  /** 지금 사슬에서 기다리는 수. */
  pending: number;
}

export interface EventPublisherDeps {
  pool: Pick<pg.Pool, 'query'>;
  /** 이 프로세스의 이벤트를 구독한다(기본 `events.ts::onEvent`). */
  subscribe?: (fn: (e: WorkspaceEvent) => void) => () => void;
  cap?: number;
  log?: (line: string) => void;
}

export interface EventPublisher {
  stats(): EventPublisherStats;
  /** 사슬에 쌓인 것을 다 보낼 때까지 기다린다(시험·종료용). */
  flush(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * TS → outbox 발행(C6-α). 이 프로세스가 `emitEvent` 로 낸 이벤트를 **낸 순서대로 하나씩** outbox 에 쓴다.
 *
 * - **직렬 사슬 하나**: 풀에서 병렬로 보내면 A·B 의 커밋 순서가 뒤집힐 수 있다. Rust 리스너는 알림(=커밋) 순서대로 내므로, 커밋 순서를
 *   emit 순서와 같게 두려면 한 번에 하나만 보낸다.
 * - **실패는 요청을 막지 않는다**: emit 은 이미 커밋된 쓰기 뒤에 불린다. 로그와 카운터만 남긴다. 이 프로세스의 메모리 emit 은 그대로 나간다.
 * - 출처 사이 인과 순서: TS 는 커밋 **뒤에** 발행하므로 「TS 쓰기 → 곧바로 Rust 쓰기」에서 Rust 이벤트가 몇 ms 먼저 도착할 수 있다.
 *   받아들인다(지금도 반대 방향으로 같은 창이 있다 — 클라이언트는 모르는 대상을 no-op 하고, 다시 붙으면 처음부터 받는다).
 */
export function startEventPublisher(deps: EventPublisherDeps): EventPublisher {
  const subscribe = deps.subscribe ?? onEvent;
  const cap = deps.cap ?? PUBLISH_CHAIN_CAP;
  const log = deps.log ?? ((l: string) => console.log(l));
  const stats: EventPublisherStats = { published: 0, failed: 0, dropped: 0, pending: 0 };
  let chain: Promise<void> = Promise.resolve();
  let lastFailLog = 0;

  const send = async (e: WorkspaceEvent): Promise<void> => {
    try {
      await deps.pool.query(PUBLISH_SQL, [JSON.stringify(e)]);
      stats.published += 1;
    } catch (err) {
      stats.failed += 1;
      // 같은 오류가 몰아칠 때 로그가 넘치지 않게 — 10초에 한 줄, 오류 문구만(이벤트 내용은 찍지 않는다).
      const now = Date.now();
      if (now - lastFailLog > 10_000) {
        lastFailLog = now;
        log(`event bus: 발행 실패(누적 ${stats.failed}): ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      stats.pending -= 1;
    }
  };

  const off = subscribe((e) => {
    if (PUBLISH_SKIP_TYPES.has(e.type)) return;
    if (stats.pending >= cap) { stats.dropped += 1; return; }
    stats.pending += 1;
    chain = chain.then(() => send(e));
  });

  return {
    stats: () => ({ ...stats }),
    flush: () => chain,
    async stop() {
      off();
      await chain;
    },
  };
}
