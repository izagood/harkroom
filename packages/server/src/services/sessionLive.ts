import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { isAccountRank, isPoolRank, type AgentSessionView } from '@harkroom/shared';

/**
 * 살아 있는 러너 세션을 DB(`agent_session_live`, 마이그레이션 172)에도 남긴다 — S5.3 C6c-2.
 *
 * TS 릴레이(`ws/relay.ts`)의 메모리 목록이 여전히 정본이다(attach·cancel·`GET /agent-sessions` 는 그대로 메모리를 읽는다).
 * 이 표는 릴레이가 없는 프로세스(Rust 위임 기한 C5f 등)가 같은 답을 읽게 하려는 사본이다.
 *
 * 규율(security C6c):
 * - ① 허용 목록 칸만 싣는다. 계정·풀 이름·프레임 원문·키·바이트 수는 받지도 넘기지도 않는다([`liveRow`]).
 * - ①′ 주인은 인증된 러너 링크(라우트의 `register` 가 배정을 확인한 agentId)에서 온다. 남의 러너가 같은 session_id 를
 *   보내도 주인이 바뀌지 않고, 끝·지우기도 같은 주인 조건으로만 한다.
 * - ①″ 행마다 이 허브의 epoch 를 싣고 `relay_hub.seen_at` 을 박동으로 갱신한다. 쓸기는 seen_at 이 TTL 을 넘긴 허브만 지운다
 *   — 시작하는 인스턴스가 「죽었다」고 짐작해 다른 허브의 줄을 지우지 않는다.
 *
 * - r1 박동은 `insert … on conflict do update` 다. DB 가 끊기거나 이벤트 루프가 멈춰 TTL 을 넘기면 다른 허브가 이 허브 줄을 쓸고
 *   행도 cascade 로 사라진다. 그때 박동이 줄을 새로 넣고(xmax = 0), 이 허브가 쓴 세션(메모리 사본 `mine`)을 다시 쓴다
 *   — 재시작 전까지 사본이 비어 C5f 가 「안 돈다」고 오판하지 않게 한다.
 *
 * 쓰기는 들어온 순서대로 하나씩 한다(started 뒤의 ended 가 먼저 닿으면 유령 행이 남는다). 실패는 기록만 하고 릴레이를 막지 않는다.
 */
export interface SessionLiveStore {
  readonly epoch: string;
  /** 허브 줄을 넣고 죽은 허브를 쓸고 박동을 시작한다. */
  start(): Promise<void>;
  /** 박동을 멈추고 자기 허브 줄을 지운다(행은 cascade). */
  stop(): Promise<void>;
  started(operatorId: string, agentAccountId: string, session: AgentSessionView): void;
  ended(agentAccountId: string, sessionId: string): void;
  /** announce — 이 허브가 든 그 에이전트의 목록을 통째로 바꾼다. */
  replaced(operatorId: string, agentAccountId: string, sessions: AgentSessionView[]): void;
  /** 러너가 물러났다 — 이 허브·이 오퍼레이터가 든 그 에이전트의 행을 지운다. */
  runnerGone(operatorId: string, agentAccountId: string): void;
  /** 쌓인 쓰기가 끝날 때까지 기다린다(시험·종료용). */
  flush(): Promise<void>;
  /** 쓸기를 한 번 돌린다(시험용). */
  sweepDead(): Promise<number>;
  /** 박동을 한 번 돌린다(시험용). 허브 줄이 없어졌다 다시 넣었으면 true. */
  beatOnce(): Promise<boolean>;
}

/** 허브 박동 주기와 생존 TTL. TTL 은 박동 셋을 놓쳐야 넘는다. */
export const RELAY_HUB_BEAT_MS = 30_000;
export const RELAY_HUB_TTL_SEC = 90;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 허용 목록 칸만 꺼낸다. 틀린 모양이면 null(쓰지 않는다 — 없는 것을 있다고 하지 않는다). */
export interface LiveRow {
  sessionId: string; channelId: string; threadRootId: string | null; harness: string;
  mode: 'mention' | 'interactive' | null; startedAt: string | null; poolRank: number | null; accountRank: number | null;
}

export function liveRow(session: AgentSessionView): LiveRow | null {
  const s = session as unknown as Record<string, unknown>;
  const sessionId = s.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 128) return null;
  if (typeof s.channelId !== 'string' || !UUID.test(s.channelId)) return null;
  const threadRootId = typeof s.threadRootId === 'string' && UUID.test(s.threadRootId) ? s.threadRootId : null;
  if (typeof s.harness !== 'string' || s.harness.length < 1 || s.harness.length > 32) return null;
  const mode = s.mode === 'mention' || s.mode === 'interactive' ? s.mode : null;
  const t = typeof s.startedAt === 'string' ? Date.parse(s.startedAt) : NaN;
  return {
    sessionId,
    channelId: s.channelId,
    threadRootId,
    harness: s.harness,
    mode,
    startedAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
    poolRank: isPoolRank(s.claudePoolRank) ? s.claudePoolRank : null,
    accountRank: isAccountRank(s.claudeAccountRank) ? s.claudeAccountRank : null,
  };
}

export function createSessionLiveStore(
  pool: Pool,
  opts: { beatMs?: number; ttlSec?: number; epoch?: string; onError?: (err: unknown, what: string) => void } = {},
): SessionLiveStore {
  const epoch = opts.epoch ?? randomUUID();
  const ttlSec = opts.ttlSec ?? RELAY_HUB_TTL_SEC;
  const onError = opts.onError ?? (() => {});
  let chain: Promise<void> = Promise.resolve();
  let beat: ReturnType<typeof setInterval> | null = null;
  let live = false;
  // 이 허브가 쓴 행의 메모리 사본(허용 목록 칸만 — 이름·키는 여기에도 없다). 허브 줄이 쓸려 나갔을 때 다시 쓰는 데만 쓴다.
  const mine = new Map<string, { operatorId: string; agentAccountId: string; row: LiveRow }>();

  const enqueue = (what: string, fn: () => Promise<unknown>) => {
    if (!live) return;
    chain = chain.then(fn).then(() => undefined, (err) => onError(err, what));
  };

  const writeRow = async (operatorId: string, agentAccountId: string, r: LiveRow) => {
    await pool.query(
      `insert into agent_session_live
         (session_id, agent_account_id, operator_id, channel_id, thread_root_id, harness, mode, started_at,
          status, claude_pool_rank, claude_account_rank, hub_epoch, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, $10, $11, now())
       on conflict (session_id) do update set
         operator_id = excluded.operator_id, channel_id = excluded.channel_id, thread_root_id = excluded.thread_root_id,
         harness = excluded.harness, mode = excluded.mode, started_at = excluded.started_at, status = excluded.status,
         claude_pool_rank = excluded.claude_pool_rank, claude_account_rank = excluded.claude_account_rank,
         hub_epoch = excluded.hub_epoch, updated_at = now()
       where agent_session_live.agent_account_id = excluded.agent_account_id`,
      [r.sessionId, agentAccountId, operatorId, r.channelId, r.threadRootId, r.harness, r.mode, r.startedAt,
        r.poolRank, r.accountRank, epoch],
    );
  };

  const upsert = async (operatorId: string, agentAccountId: string, session: AgentSessionView) => {
    const r = liveRow(session);
    if (!r) return;
    // 남의 에이전트가 같은 세션 id 를 보내면 DB 처럼 사본의 주인도 바꾸지 않는다.
    const had = mine.get(r.sessionId);
    if (had && had.agentAccountId !== agentAccountId) return;
    mine.set(r.sessionId, { operatorId, agentAccountId, row: r });
    await writeRow(operatorId, agentAccountId, r);
  };

  const beatOnce = async (): Promise<boolean> => {
    const res = await pool.query<{ inserted: boolean }>(
      `insert into relay_hub (hub_epoch, impl) values ($1, 'ts')
         on conflict (hub_epoch) do update set seen_at = now()
       returning (xmax = 0) as inserted`,
      [epoch],
    );
    const revived = res.rows[0]?.inserted === true;
    if (revived) {
      // 줄이 쓸려 나갔었다 — 행도 cascade 로 사라졌으니 이 허브가 든 세션을 다시 쓴다.
      for (const m of [...mine.values()]) await writeRow(m.operatorId, m.agentAccountId, m.row);
    }
    await sweepDead();
    return revived;
  };

  const sweepDead = async (): Promise<number> => {
    const res = await pool.query(
      `delete from relay_hub where hub_epoch <> $1 and seen_at < now() - make_interval(secs => $2)`,
      [epoch, ttlSec],
    );
    return res.rowCount ?? 0;
  };

  return {
    epoch,
    async start() {
      await pool.query(`insert into relay_hub (hub_epoch, impl) values ($1, 'ts') on conflict (hub_epoch) do nothing`, [epoch]);
      live = true;
      await sweepDead().catch((err) => onError(err, 'sweep'));
      beat = setInterval(() => {
        enqueue('beat', beatOnce);
      }, opts.beatMs ?? RELAY_HUB_BEAT_MS);
      beat.unref?.();
    },
    async stop() {
      if (beat) clearInterval(beat);
      beat = null;
      await chain;
      live = false;
      mine.clear();
      await pool.query(`delete from relay_hub where hub_epoch = $1`, [epoch]).catch((err) => onError(err, 'stop'));
    },
    started(operatorId, agentAccountId, session) {
      enqueue('started', () => upsert(operatorId, agentAccountId, session));
    },
    ended(agentAccountId, sessionId) {
      enqueue('ended', () => {
        if (mine.get(sessionId)?.agentAccountId === agentAccountId) mine.delete(sessionId);
        return pool.query(
          `delete from agent_session_live where session_id = $1 and agent_account_id = $2`, [sessionId, agentAccountId]);
      });
    },
    replaced(operatorId, agentAccountId, sessions) {
      enqueue('replaced', async () => {
        const keep = sessions.map((s) => liveRow(s)?.sessionId).filter((x): x is string => typeof x === 'string');
        for (const [id, m] of mine) if (m.agentAccountId === agentAccountId && !keep.includes(id)) mine.delete(id);
        await pool.query(
          // announce 는 러너가 진실의 원천이다(같은 에이전트의 러너는 하나 — 4409). 허브를 가리지 않고 목록 밖을 지운다.
          `delete from agent_session_live
            where agent_account_id = $1 and not (session_id = any($2::text[]))`,
          [agentAccountId, keep],
        );
        for (const s of sessions) await upsert(operatorId, agentAccountId, s);
      });
    },
    runnerGone(operatorId, agentAccountId) {
      enqueue('runnerGone', () => {
        for (const [id, m] of mine) if (m.agentAccountId === agentAccountId && m.operatorId === operatorId) mine.delete(id);
        return pool.query(
          `delete from agent_session_live where agent_account_id = $1 and operator_id = $2 and hub_epoch = $3`,
          [agentAccountId, operatorId, epoch]);
      });
    },
    flush() {
      return chain;
    },
    sweepDead,
    beatOnce,
  };
}

/**
 * 읽기 — 살아 있는 허브(seen_at 이 TTL 안)의 행만. `agentAccountIds` 를 주면 그 에이전트들로 좁힌다.
 * 칸은 허용 목록 그대로 돌려준다.
 */
export async function listLiveSessions(
  pool: Pool, agentAccountIds?: readonly string[], ttlSec = RELAY_HUB_TTL_SEC,
): Promise<{ sessionId: string; agentAccountId: string; channelId: string; threadRootId: string | null }[]> {
  const res = await pool.query<{ session_id: string; agent_account_id: string; channel_id: string; thread_root_id: string | null }>(
    `select l.session_id, l.agent_account_id::text, l.channel_id::text, l.thread_root_id::text
       from agent_session_live l join relay_hub h on h.hub_epoch = l.hub_epoch
      where h.seen_at > now() - make_interval(secs => $1)
        and ($2::uuid[] is null or l.agent_account_id = any($2::uuid[]))
      order by l.session_id`,
    [ttlSec, agentAccountIds ?? null],
  );
  return res.rows.map((r) => ({
    sessionId: r.session_id, agentAccountId: r.agent_account_id, channelId: r.channel_id, threadRootId: r.thread_root_id,
  }));
}
