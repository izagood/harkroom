import type { Pool } from 'pg';
import {
  decideThreadStatus, THREAD_STATUS_EMOJI,
  type ThreadStatusDecision, type ThreadStatusFacts, type ThreadStatusReaction,
} from '@harkroom/shared';

import { emitEvent, onEvent, type WorkspaceEvent } from '../events.js';
import { audienceFor } from './channels.js';
import type { AgentPresence } from '../mcp/presence.js';

/**
 * 스레드 상태 리액션(D안)의 서버 쪽 — 사실을 모으고(`readThreadStatusFacts`), shared 의
 * `decideThreadStatus` 를 지나고, 바뀌었을 때만 `thread_status` 에 쓰고 이벤트를 낸다.
 *
 * **다시 판정하는 때는 이벤트 버스 하나에서 정한다**(`startThreadStatusWatcher`). 메시지를
 * 쓰는 자리마다 부르면 경로(REST·MCP·sweeper·거울 답)가 늘 때 하나씩 빠진다 — 새 말·ask
 * 답·wake 예약(=wake 메시지)·삭제는 전부 `message.*` 로, 러너 접속 변화는 `presence.changed`
 * 로 이 버스를 지난다.
 */

/** 실패를 푸는 말의 규칙은 `services/messages.ts` 의 `unresolved_failure_count` 와 같다. */
const FACTS_SQL = `
with t as (
  select m.id, m.seq, m.kind, m.author_id, m.meta, a.kind as author_kind
  from message m join account a on a.id = m.author_id
  where (m.id = $1 or m.thread_root_id = $1) and m.deleted_at is null
)
select
  (select json_build_object('askerId', t.author_id, 'prompt', t.meta->'ask'->>'prompt')
     from t
     where t.meta->>'kind' = 'ask'
       and t.meta->'ask'->>'answeredWith' is null and t.meta->'ask'->>'closedAt' is null
       and (t.meta->'ask'->'to'->>'kind' = 'human'
         or (t.meta->'ask'->'to'->>'kind' = 'account'
           and exists (select 1 from account x where x.id::text = t.meta->'ask'->'to'->>'accountId' and x.kind = 'human')))
     order by t.seq limit 1) as human_ask,
  (select json_build_object('accountId', t.author_id, 'what', coalesce(t.meta->'failure'->>'what', t.meta->'failure'->>'reason'),
                            'gate', coalesce(t.meta->'failure'->>'code' = 'account_gate', false))
     from t
     where t.meta->>'kind' = 'failure'
       and not exists (
         select 1 from t r where r.seq > t.seq
           and (r.kind in ('progress', 'wake') or r.meta->>'kind' = 'report' or r.author_id = t.author_id))
     order by t.seq desc limit 1) as failure,
  (select json_build_object('authorId', t.author_id, 'targets',
            coalesce(t.meta->'mentionDenied', '[]'::jsonb) || coalesce(t.meta->'mentionChainCapped', '[]'::jsonb))
     from t
     where (jsonb_array_length(coalesce(t.meta->'mentionDenied', '[]'::jsonb)) > 0
         or jsonb_array_length(coalesce(t.meta->'mentionChainCapped', '[]'::jsonb)) > 0)
       and t.seq = (select max(seq) from t)
     limit 1) as denied_mention,
  coalesce(
    (select json_build_object('waiterId', t.author_id, 'blockedById', t.meta->'ask'->'to'->>'accountId')
       from t
       where t.meta->>'kind' = 'ask'
         and t.meta->'ask'->>'answeredWith' is null and t.meta->'ask'->>'closedAt' is null
         and t.meta->'ask'->'to'->>'kind' = 'account'
         and exists (select 1 from account x where x.id::text = t.meta->'ask'->'to'->>'accountId' and x.kind = 'agent')
       order by t.seq limit 1),
    (select json_build_object('waiterId', t.author_id, 'blockedById', t.meta->'delegation'->'open'->>0)
       from t
       where t.meta->>'kind' = 'delegation'
         and jsonb_array_length(coalesce(t.meta->'delegation'->'open', '[]'::jsonb)) > 0
       order by t.seq limit 1)
  ) as agent_wait,
  (select json_build_object('accountId', w.account_id, 'wakeAt', w.wake_at)
     from agent_wake w join t on t.id = w.message_id
     where w.fired_at is null and w.canceled_at is null
     order by w.wake_at limit 1) as open_wake,
  -- 이 스레드를 **보고처로 둔** 열린 깨움(2026-10-06). 앵커는 다른 스레드다. 열린 행에서 출발한다(agent_wake_due).
  (select json_build_object('accountId', w.account_id, 'wakeAt', w.wake_at)
     from agent_wake w join message wm on wm.id = w.message_id
     where w.fired_at is null and w.canceled_at is null
       and wm.meta->'wake'->'reportTo'->>'threadRootId' = $1::text
     order by w.wake_at limit 1) as open_report_wake,
  -- 배달된 멘션 중 그 에이전트가 **그 뒤로 아무 말도 안 한** 것. 읽음(read_at)은 보지 않는다 —
  -- 러너가 턴을 시작하며 읽음으로 만든 뒤 첫 진행을 올리기 전까지 ✅ 로 깜빡이지 않게.
  (select json_build_object('agentId', i.account_id)
     from inbox i join t on t.id = i.message_id join account x on x.id = i.account_id
     where x.kind = 'agent' and i.reason <> 'thread_reply'
       and not exists (select 1 from t r where r.seq > t.seq and r.author_id = i.account_id)
     order by t.seq desc limit 1) as pending_mention,
  (select json_build_object('kind', t.kind, 'authorId', t.author_id, 'authorIsAgent', t.author_kind = 'agent')
     from t order by t.seq desc limit 1) as last,
  (exists (select 1 from t where t.author_kind = 'agent')
    or exists (select 1 from inbox i join t on t.id = i.message_id join account x on x.id = i.account_id
               where x.kind = 'agent' and i.reason <> 'thread_reply')) as agent_involved,
  (select channel_id from message where id = $1 and thread_root_id is null) as channel_id`;

export async function readThreadStatusFacts(
  pool: Pool, rootId: string,
): Promise<{ channelId: string; facts: ThreadStatusFacts } | null> {
  const res = await pool.query(FACTS_SQL, [rootId]);
  const r = res.rows[0];
  if (!r || !r.channel_id) return null;
  return {
    channelId: r.channel_id as string,
    facts: {
      humanAsk: r.human_ask, failure: r.failure,
      deniedMention: r.denied_mention ? {
        authorId: r.denied_mention.authorId,
        targets: (r.denied_mention.targets as unknown[]).filter((x): x is string => typeof x === 'string'),
      } : null,
      agentWait: r.agent_wait, openWake: r.open_wake, openReportWake: r.open_report_wake, pendingMention: r.pending_mention,
      last: r.last, agentInvolved: r.agent_involved === true,
    },
  };
}

/**
 * 루트의 상태 리액션(`message_reaction.source = 'status'`, 108)을 판정에 맞춘다 — **한 문장**이다:
 * 맞지 않는 상태 행을 떼고, 원하는 것이 없으면 단다. 사람·에이전트가 손으로 단 행(`user`)은 건드리지
 * 않는다 — 같은 (계정, 이모지)가 이미 손으로 달려 있으면 상태 행은 새로 생기지 않는다(on conflict).
 * 지워진 루트에는 달지 않는다. 바뀐 행마다 `reaction.added`·`reaction.removed` 를 낸다 — 모든 화면이
 * 이미 듣는 이벤트라 따로 그릴 것이 없다.
 *
 * `thread_status` 가 안 바뀌어도 부른다: 손으로 단 것이 떼어진 뒤처럼 리액션만 어긋난 때 다시 맞는다
 * (그 떼기는 watcher 가 `reaction.removed` 로 듣는다). 맞으면 아무 행도 안 바뀌고 이벤트도 없다.
 */
async function syncStatusReaction(
  pool: Pool, channelId: string, rootId: string, decision: ThreadStatusDecision | null,
): Promise<void> {
  const emoji = decision ? THREAD_STATUS_EMOJI[decision.status] : null;
  const accountId = decision?.accountId ?? null;
  const res = await pool.query(
    `with want as (select $2::uuid as account_id, $3::text as emoji where $2::uuid is not null and $3::text is not null),
     del as (
       delete from message_reaction r
        where r.message_id = $1 and r.source = 'status'
          and not exists (select 1 from want w where w.account_id = r.account_id and w.emoji = r.emoji)
       returning r.account_id, r.emoji),
     ins as (
       insert into message_reaction (message_id, account_id, emoji, source)
       select $1, w.account_id, w.emoji, 'status' from want w
        where exists (select 1 from message m where m.id = $1 and m.deleted_at is null)
       on conflict do nothing
       returning account_id, emoji)
     select 'removed' as op, account_id, emoji from del
     union all select 'added' as op, account_id, emoji from ins`,
    [rootId, accountId, emoji],
  );
  if (!res.rowCount) return;
  const audience = await audienceFor(pool, channelId);
  for (const r of res.rows) {
    emitEvent({
      type: r.op === 'added' ? 'reaction.added' : 'reaction.removed', channelId, messageId: rootId,
      emoji: r.emoji as string, accountId: r.account_id as string, audience,
    });
  }
}

/**
 * 한 스레드를 다시 판정해 바뀌었으면 저장하고 알린다. 바뀌지 않았으면 아무것도 하지 않는다 —
 * 같은 상태로 이벤트를 다시 내면 화면이 이유 없이 다시 그린다.
 */
export async function refreshThreadStatus(
  pool: Pool, rootId: string, live: ReadonlySet<string> | null,
): Promise<ThreadStatusReaction | null | 'unchanged'> {
  const read = await readThreadStatusFacts(pool, rootId);
  if (!read) return 'unchanged';
  const decision = decideThreadStatus(read.facts, live);
  await syncStatusReaction(pool, read.channelId, rootId, decision);

  if (!decision) {
    const del = await pool.query(`delete from thread_status where root_id = $1`, [rootId]);
    if (!del.rowCount) return 'unchanged';
    emitEvent({ type: 'thread.status', channelId: read.channelId, rootId, statusReaction: null,
      audience: await audienceFor(pool, read.channelId) });
    return null;
  }

  const emoji = THREAD_STATUS_EMOJI[decision.status];
  // 같으면 쓰지 않는다 — `where` 가 거짓이면 returning 이 비고, 그것이 '안 바뀜'이다.
  const up = await pool.query(
    `insert into thread_status (root_id, status, emoji, account_id, reason)
       values ($1, $2, $3, $4, $5)
     on conflict (root_id) do update
       set status = excluded.status, emoji = excluded.emoji, account_id = excluded.account_id,
           reason = excluded.reason, updated_at = now()
       where (thread_status.status, thread_status.account_id, thread_status.reason)
         is distinct from (excluded.status, excluded.account_id, excluded.reason)
     returning updated_at`,
    [rootId, decision.status, emoji, decision.accountId, decision.reason],
  );
  if (!up.rowCount) return 'unchanged';
  const statusReaction: ThreadStatusReaction = {
    status: decision.status, emoji, accountId: decision.accountId, reason: decision.reason,
    updatedAt: new Date(up.rows[0].updated_at).toISOString(),
  };
  emitEvent({ type: 'thread.status', channelId: read.channelId, rootId, statusReaction,
    audience: await audienceFor(pool, read.channelId) });
  return statusReaction;
}

const STATUS_EMOJIS: ReadonlySet<string> = new Set(Object.values(THREAD_STATUS_EMOJI));

/** 이 이벤트가 어느 스레드 루트를 건드렸는가. 없으면 `null`. */
export function rootOf(e: WorkspaceEvent): string | null {
  if (e.type === 'message.created' || e.type === 'message.updated') {
    return e.message.threadRootId ?? e.message.id;
  }
  return null;
}

/**
 * 버스를 구독해 다시 판정한다. **루트마다 한 번으로 모은다**(`debounceMs`) — 에이전트 하나의
 * 턴이 진행·답·리액션을 몇 백 ms 안에 몰아 내므로, 그때마다 집계 SQL 을 돌리면 낭비다.
 *
 * 삭제(`message.deleted`)는 루트를 모른다(id 와 채널뿐) — 지워진 것이 루트면 cascade 가
 * 행을 지우고, 답글이면 다음 말에서 다시 판정된다.
 */
export function startThreadStatusWatcher(
  pool: Pool, presence: AgentPresence,
  opts: { debounceMs?: number; onError?: (err: unknown) => void } = {},
): { stop(): void; flush(): Promise<void> } {
  const debounceMs = opts.debounceMs ?? 300;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const inflight = new Set<Promise<unknown>>();
  const onError = opts.onError ?? ((err) => console.error('thread status refresh error:', err));

  // **루트마다 한 번에 하나만 돈다**(#1030 security N1). 겹쳐 돌면 먼저 읽은 낡은 사실이
  // 나중에 써질 수 있다. 도는 중에 또 요청이 오면 표시만 해 두고, 끝난 뒤 한 번 더 돈다.
  const running = new Map<string, Promise<unknown>>();
  const again = new Set<string>();
  const run = (rootId: string) => {
    pending.delete(rootId);
    if (running.has(rootId)) { again.add(rootId); return; }
    const p = refreshThreadStatus(pool, rootId, new Set(presence.online())).catch(onError)
      .finally(() => {
        running.delete(rootId);
        inflight.delete(p);
        if (again.delete(rootId)) run(rootId);
      });
    running.set(rootId, p);
    inflight.add(p);
  };
  const schedule = (rootId: string) => {
    const prev = pending.get(rootId);
    if (prev) clearTimeout(prev);
    pending.set(rootId, setTimeout(() => run(rootId), debounceMs));
  };

  const off = onEvent((e) => {
    const root = rootOf(e);
    if (root) { schedule(root); return; }
    // 보고처 깨움이 걸렸다·떴다·접혔다 — 그 보고처 스레드의 머리 ⏳ 를 다시 판정한다(2026-10-06).
    if (e.type === 'thread.reportWakes.changed') { schedule(e.rootId); return; }
    // 상태 이모지가 떼어졌다 — 주인 에이전트가 손으로 단 것(그래서 상태 행이 없던 것)을 떼면 상태
    // 리액션이 비므로 다시 단다(#1227 security n1). 답글이면 판정이 루트가 아니라고 그냥 끝난다.
    // 서버가 스스로 뗀 것도 여기로 오지만 다시 판정해 'unchanged' 로 끝난다(루프 없음).
    if (e.type === 'reaction.removed' && STATUS_EMOJIS.has(e.emoji)) { schedule(e.messageId); return; }
    if (e.type === 'presence.changed') {
      // 그 에이전트가 주인인 스레드만 — 꺼지면 💬·👀 가 🚨 로, 켜지면 🚨 가 💬 로 돌아온다.
      void pool.query(
        `select root_id from thread_status where account_id = $1 and status in ('running', 'received', 'stuck')`,
        [e.accountId],
      ).then((res) => { for (const r of res.rows) schedule(r.root_id as string); }).catch(onError);
    }
  });

  return {
    stop() {
      off();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
    /** 미뤄 둔 판정을 지금 돌리고 끝날 때까지 기다린다(테스트용). */
    async flush() {
      for (const [rootId, t] of [...pending]) { clearTimeout(t); run(rootId); }
      while (inflight.size) await Promise.all([...inflight]);
    },
  };
}
