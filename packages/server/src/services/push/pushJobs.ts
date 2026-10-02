// 푸시 발송 worker(093). 설계 harkroom://message/80130503-ca6c-4873-8bfe-3084ee182052 와
// security 반영본 harkroom://message/9e6faa09-2be1-4eb6-b5c6-f3d142ef0a10.
//
// 흐름: `insertInbox`(같은 트랜잭션)가 job 을 넣는다 → 15초 뒤 worker 가 한 건씩 집는다
// (`for update skip locked`) → **보내기 직전에 한 쿼리로 다시 확인한다**(G1·G2) → job 을 지우고 커밋한
// 뒤 기기마다 보낸다. 네트워크는 트랜잭션 밖이다. 재시도가 필요한 기기만 새 job 으로 돌아온다.
import type { Pool, PoolClient } from 'pg';
import { ANY_MENTION_TOKEN_PATTERN } from '@harkroom/shared';
import { channelVisibleSql } from '../channels.js';
import type { SecretLeakGuard } from '../secretLeakGuard.js';
import { redactToken, type ApnsEnv, type PushTransport } from './apns.js';
import {
  buildPushPayload, classifyPush, isUrgentPush, pushCollapseId, pushThreadKey, PUSH_REPLY_SOUND_WINDOW_MS,
  PUSH_URGENT_WINDOW_MS,
  type PushReason,
} from './payload.js';
import type { SweepHost } from '../scheduledMessages.js';

/** inbox 사유 가운데 사람의 폰을 울리는 것(결정 4). 나머지는 에이전트에게만 가는 사유다. */
const INBOX_PUSH_REASONS = new Set<string>(['mention', 'thread_reply', 'dm']);

/** prefs 의 어느 스위치가 이 사유를 켜고 끄나. */
const PREF_KEY: Record<PushReason, 'mention' | 'threadReply' | 'dm' | 'ask'> = {
  mention: 'mention', thread_reply: 'threadReply', dm: 'dm', ask: 'ask',
};

/** 429·5xx·네트워크 오류 재시도 간격. 세 번이 넘으면 버린다. */
export const PUSH_RETRY_DELAYS_SEC = [30, 120, 600] as const;

const SWEEP_INTERVAL_MS = 5_000;

/**
 * 에이전트의 보통 답은 60초 뒤에 보낸다(기본 15초). 데스크톱에서 보고 있으면 그 사이 읽혀서 폰이
 * 아예 울리지 않는다 — 보내기 직전 확인이 `read_at` 을 본다. 결정·실패·사람의 말은 15초 그대로다.
 */
export const PUSH_AGENT_REPLY_DELAY_SEC = 60;

/**
 * 받는 사람 `acct` 의 스레드인가 — 루트를 썼거나 그 스레드에서 말한 적이 있다. 에이전트가 거기서
 * 나를 부른 글은 "부름"이 아니라 내가 시킨 일의 "답"이다(규칙 표). `m` 은 message 별칭.
 */
const mineThreadSql = (m: string, acct: string) => `(${m}.thread_root_id is not null and exists (
    select 1 from message mt where mt.author_id = ${acct} and mt.deleted_at is null
       and (mt.id = ${m}.thread_root_id or (mt.thread_root_id = ${m}.thread_root_id and mt.id <> ${m}.id))))`;

/** 결정·실패·완료가 아닌 에이전트의 글(보통 답 후보). `m`·`au` 는 message·작성자 account 별칭. */
const agentPlainSql = (m: string, au: string) =>
  `(${au}.kind = 'agent' and coalesce(${m}.meta->>'kind', '') not in ('ask', 'failure', 'report'))`;
const SWEEP_BATCH = 50;
const PUSH_SOUND_PRUNE_EVERY_MS = 60 * 60_000;

/**
 * inbox 를 넣은 그 트랜잭션에서 부른다. **사람이고 기기가 하나라도 있을 때만** 넣는다 — 기기가 없는
 * 사람(데스크톱만 쓰는 사람)의 멘션마다 행을 쌓을 이유가 없다. 받는 사람이 에이전트면 아무 일도 없다.
 */
export async function enqueueInboxPush(
  client: PoolClient | Pool, inboxId: string | number, accountId: string, messageId: string, reason: string,
): Promise<void> {
  if (!INBOX_PUSH_REASONS.has(reason)) return;
  await client.query(
    `insert into push_job (account_id, message_id, inbox_id, reason, not_before)
     select $1, $2, $3, $4,
            now() + case when $4 <> 'dm' and ${agentPlainSql('m', 'au')} and ${mineThreadSql('m', '$1::uuid')}
                         then make_interval(secs => $5) else interval '15 seconds' end
       from message m join account au on au.id = m.author_id
      where m.id = $2
        and exists (select 1 from account where id = $1 and kind = 'human')
        and exists (select 1 from push_device where account_id = $1)`,
    [accountId, messageId, inboxId, reason, PUSH_AGENT_REPLY_DELAY_SEC],
  );
}

/** inbox 를 거치지 않는 `ask`(G4). 받는 사람은 부르는 쪽이 차례 주인으로 정해 넘긴다. */
export async function enqueueAskPush(pool: Pool | PoolClient, accountId: string, messageId: string): Promise<void> {
  await pool.query(
    `insert into push_job (account_id, message_id, reason)
     select $1, $2, 'ask'
      where exists (select 1 from account where id = $1 and kind = 'human')
        and exists (select 1 from push_device where account_id = $1)`,
    [accountId, messageId],
  );
}

interface JobRow {
  id: string; accountId: string; messageId: string; inboxId: string | null; reason: PushReason;
  deviceId: string | null; attempts: number;
}

interface LiveRow {
  channelId: string; threadRootId: string | null; body: string; authorId: string;
  authorHandle: string; authorKind: 'human' | 'agent'; channelKind: 'standard' | 'dm'; channelName: string;
  metaKind: string | null; failureCode: string | null; optionCount: number; mineThread: boolean;
}

interface DeviceRow { id: string; token: string; env: ApnsEnv; preview: boolean; badge: boolean }

export type PushHealth = 'off' | 'ok' | 'degraded';

export function createPushSweeper(pool: Pool, deps: {
  transport: PushTransport | null;
  leakGuard?: SecretLeakGuard | null;
  log?: (msg: string) => void;
}): { startSweep(app: SweepHost): void; sweep(): Promise<void>; health(): PushHealth } {
  const log = deps.log ?? ((m: string) => console.warn(m));
  let interval: ReturnType<typeof setInterval> | null = null;
  let running = false;
  // 403(InvalidProviderToken 등)은 기기 탓이 아니라 설정 탓이다. 다음 200 이 오면 풀린다.
  let degraded = false;

  /**
   * **보내기 직전의 다시 확인**(security G1·G2). 하나라도 거짓이면 행이 없다 → 보내지 않는다.
   * 15초 사이에 채널에서 빠졌거나, 글이 지워졌거나, 계정이 지워졌거나 꺼졌거나, 데스크톱에서
   * 읽었거나, 채널을 `none` 으로 돌렸으면 여기서 걸린다. 본문도 **지금 값**을 읽는다(수정 반영).
   */
  async function liveCheck(client: PoolClient, job: JobRow): Promise<LiveRow | null> {
    const res = await client.query<LiveRow>(
      `select m.channel_id as "channelId", m.thread_root_id as "threadRootId", m.body,
              m.author_id as "authorId", au.handle as "authorHandle", au.kind as "authorKind",
              c.kind as "channelKind", c.name as "channelName",
              m.meta->>'kind' as "metaKind", m.meta->'failure'->>'code' as "failureCode",
              coalesce(jsonb_array_length(case when jsonb_typeof(m.meta->'ask'->'options') = 'array'
                                               then m.meta->'ask'->'options' end), 0)::int as "optionCount",
              ${mineThreadSql('m', 'j.account_id')} as "mineThread"
         from push_job j
         join account a on a.id = j.account_id
         join message m on m.id = j.message_id
         join channel c on c.id = m.channel_id
         join account au on au.id = m.author_id
         left join inbox i on i.id = j.inbox_id
         left join channel_pref p on p.channel_id = c.id and p.account_id = j.account_id
        where j.id = $1
          and a.kind = 'human' and a.deleted_at is null and a.disabled_at is null
          and m.deleted_at is null
          and (j.inbox_id is null or i.read_at is null)
          and coalesce(p.notify_level, 'mentions') <> 'none'
          and ${channelVisibleSql('c', 'j.account_id')}`,
      [job.id],
    );
    return res.rows[0] ?? null;
  }

  async function devicesFor(client: PoolClient, job: JobRow): Promise<DeviceRow[]> {
    const res = await client.query<DeviceRow>(
      `select d.id, d.token, d.apns_env as env, coalesce((d.prefs->>'preview')::boolean, false) as preview,
              coalesce((d.prefs->>'badge')::boolean, true) as badge
         from push_device d join session s on s.token_hash = d.session_token_hash
        where d.account_id = $1 and s.expires_at > now()
          and coalesce((d.prefs->>$2)::boolean, true)
          and ($3::uuid is null or d.id = $3)`,
      [job.accountId, PREF_KEY[job.reason], job.deviceId],
    );
    return res.rows;
  }

  /** 배지 — 에이전트의 보통 답은 스레드마다 하나로 센다(알림 센터에서도 한 장이다). */
  async function badgeFor(client: PoolClient, accountId: string): Promise<number> {
    const res = await client.query<{ n: string }>(
      `select count(distinct case when m.thread_root_id is not null and ${agentPlainSql('m', 'au')}
                                  then 't:' || m.thread_root_id else 'i:' || i.id end) as n
         from inbox i join message m on m.id = i.message_id join account au on au.id = m.author_id
        where i.account_id = $1 and i.read_at is null
          and i.reason in ('mention', 'thread_reply', 'dm')`, [accountId]);
    return Number(res.rows[0]?.n ?? 0);
  }

  /** "답 N" — 이 스레드에 와 있는 에이전트의 안 읽은 보통 답 수. */
  async function repliesFor(client: PoolClient, accountId: string, threadRootId: string): Promise<number> {
    const res = await client.query<{ n: string }>(
      `select count(*) as n
         from inbox i join message m on m.id = i.message_id join account au on au.id = m.author_id
        where i.account_id = $1 and i.read_at is null and m.thread_root_id = $2
          and i.reason in ('mention', 'thread_reply') and ${agentPlainSql('m', 'au')}`, [accountId, threadRootId]);
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * 이번에 울려도 되나 — 보통 답은 스레드마다 10분에 첫 한 번(jaebin D1, 키 = 스레드), 결정·실패·관문은
   * 1분에 한 번(security L1, 키 = `urgent:<스레드>`). 울리는 쪽이 시각을 적는다 — 한 문장(upsert … where)이라
   * worker 가 둘이어도 둘 다 울리지 않는다.
   */
  async function claimSound(client: PoolClient, accountId: string, threadKey: string, windowMs: number): Promise<boolean> {
    const res = await client.query(
      `insert into push_thread_sound (account_id, thread_key, sounded_at) values ($1, $2, now())
       on conflict (account_id, thread_key) do update set sounded_at = now()
        where push_thread_sound.sounded_at <= now() - make_interval(secs => $3)
       returning 1`, [accountId, threadKey, windowMs / 1000]);
    return (res.rowCount ?? 0) > 0;
  }

  /** 본문의 `<@id>`·`<@group:id>`·`<@team:id>` 를 지금 이름으로 바꿀 지도. */
  async function handlesFor(client: PoolClient, body: string): Promise<Map<string, string>> {
    const keys = [...body.matchAll(new RegExp(ANY_MENTION_TOKEN_PATTERN, 'g'))].map((m) => (m[1] ?? m[2])!).filter(Boolean);
    const map = new Map<string, string>();
    if (!keys.length) return map;
    const plain = keys.filter((k) => !k.includes(':'));
    const group = keys.filter((k) => k.startsWith('group:')).map((k) => k.slice(6));
    const team = keys.filter((k) => k.startsWith('team:')).map((k) => k.slice(5));
    if (plain.length) {
      for (const r of (await client.query<{ id: string; handle: string }>(
        `select id, handle from account where id = any($1::uuid[])`, [plain])).rows) map.set(r.id, r.handle);
    }
    if (group.length) {
      for (const r of (await client.query<{ id: string; handle: string }>(
        `select id, handle from handle_group where id = any($1::uuid[])`, [group])).rows) map.set(`group:${r.id}`, r.handle);
    }
    if (team.length) {
      for (const r of (await client.query<{ id: string; name: string }>(
        `select id, name from agent_team where id = any($1::uuid[])`, [team])).rows) map.set(`team:${r.id}`, r.name);
    }
    return map;
  }

  /**
   * 미리보기 본문. 에이전트가 쓴 글이면 그 에이전트에 걸린 비밀이 들어 있지 않은지 한 번 더 본다
   * (secretLeakGuard). 글을 올릴 때 이미 거르지만, 비밀은 그 뒤에 부여될 수도 있다. 걸리면 미리보기를
   * 통째로 뺀다(사유만 간다).
   */
  async function safePreview(live: LiveRow): Promise<string | null> {
    if (live.authorKind === 'agent' && deps.leakGuard) {
      const hits = await deps.leakGuard.findInTexts(live.authorId, [live.body]);
      if (hits.length) return null;
    }
    return live.body;
  }

  async function sendOne(skip: string[]): Promise<'done' | 'none'> {
    const client = await pool.connect();
    let job: JobRow | undefined;
    let live: LiveRow | null = null;
    let devices: DeviceRow[] = [];
    let badge = 0;
    let idToHandle = new Map<string, string>();
    let kind: ReturnType<typeof classifyPush> = 'mention';
    let replyCount = 0;
    let sound = true;
    let threadKey = '';
    try {
      await client.query('begin');
      job = (await client.query<JobRow>(
        `select id, account_id as "accountId", message_id as "messageId", inbox_id as "inboxId", reason, device_id as "deviceId", attempts
           from push_job where not_before <= now() and not (id = any($1::bigint[]))
          order by not_before limit 1 for update skip locked`, [skip])).rows[0];
      if (!job) { await client.query('commit'); return 'none'; }
      skip.push(job.id);
      live = await liveCheck(client, job);
      if (live) {
        devices = await devicesFor(client, job);
        if (devices.length) {
          kind = classifyPush({
            reason: job.reason, authorKind: live.authorKind, metaKind: live.metaKind,
            failureCode: live.failureCode, mineThread: live.mineThread,
          });
          threadKey = pushThreadKey({
            channelId: live.channelId, channelName: live.channelKind === 'dm' ? null : live.channelName,
            threadRootId: live.threadRootId, messageId: job.messageId,
          });
          if (kind === 'agent_reply') {
            replyCount = live.threadRootId ? await repliesFor(client, job.accountId, live.threadRootId) : 1;
            // 재시도(device_id 가 찬 job)는 이미 첫 시도에서 정한 몫이다 — 시각을 다시 적지 않고 조용히 보낸다.
            sound = job.deviceId === null && await claimSound(client, job.accountId, threadKey, PUSH_REPLY_SOUND_WINDOW_MS);
          } else if (isUrgentPush(kind)) {
            sound = await claimSound(client, job.accountId, `urgent:${threadKey}`, PUSH_URGENT_WINDOW_MS);
          } else {
            sound = true;
          }
          badge = await badgeFor(client, job.accountId);
          if (devices.some((d) => d.preview)) idToHandle = await handlesFor(client, live.body);
        }
      }
      // 집은 job 은 여기서 지운다 — 다시 보낼 것은 기기 단위의 새 job 으로 돌아온다.
      await client.query(`delete from push_job where id = $1`, [job.id]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (!live || !devices.length) return 'done';

    const preview = devices.some((d) => d.preview) ? await safePreview(live) : null;
    for (const device of devices) {
      const payload = buildPushPayload({
        kind, replyCount, optionCount: live.optionCount, sound,
        accountId: job.accountId, messageId: job.messageId,
        channelId: live.channelId, threadRootId: live.threadRootId,
        authorHandle: live.authorHandle, channelName: live.channelKind === 'dm' ? null : live.channelName,
        badge: device.badge ? badge : null, previewBody: device.preview ? preview : null, idToHandle,
      });
      const result = await deps.transport!.send({ token: device.token, env: device.env, payload, collapseId: pushCollapseId(kind, threadKey, job.messageId) });
      await settle(job, device, result.status, result.reason);
    }
    return 'done';
  }

  async function settle(job: JobRow, device: DeviceRow, status: number, reason?: string): Promise<void> {
    if (status === 200) {
      degraded = false;
      await pool.query(`update push_device set last_ok_at = now(), last_error = null where id = $1`, [device.id]);
      return;
    }
    const label = `${status}${reason ? ` ${reason}` : ''}`;
    // 기기가 없어졌다(앱 삭제·토큰 교체) → 행을 지운다. 다시 등록하면 돌아온다.
    if (status === 410 || (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'))) {
      await pool.query(`delete from push_device where id = $1`, [device.id]);
      log(`[push] device ${redactToken(device.token)} removed (${label})`);
      return;
    }
    if (status === 403) {
      // 설정 오류(키·팀·topic). 토큰은 멀쩡하므로 지우지 않는다.
      degraded = true;
      await pool.query(`update push_device set last_error = $2 where id = $1`, [device.id, label]);
      log(`[push] provider rejected (${label}) — check APNS_* settings`);
      return;
    }
    if (status === 0 || status === 429 || status >= 500) {
      const next = PUSH_RETRY_DELAYS_SEC[job.attempts];
      await pool.query(`update push_device set last_error = $2 where id = $1`, [device.id, label]);
      if (next !== undefined) {
        await pool.query(
          `insert into push_job (account_id, message_id, inbox_id, device_id, reason, attempts, not_before)
           values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
          // inbox 를 그대로 잇는다 — 재시도 사이에 읽으면 다시 확인에서 걸린다.
          [job.accountId, job.messageId, job.inboxId, device.id, job.reason, job.attempts + 1, next],
        );
      } else {
        log(`[push] device ${redactToken(device.token)} gave up after ${job.attempts} retries (${label})`);
      }
      return;
    }
    await pool.query(`update push_device set last_error = $2 where id = $1`, [device.id, label]);
    log(`[push] device ${redactToken(device.token)} rejected (${label})`);
  }

  /** 하루 넘게 안 울린 스레드의 소리 기록은 지운다(security L2) — 간격이 10분이라 그 뒤로는 없는 것과 같다. 한 시간에 한 번. */
  let prunedAt = 0;
  async function pruneSounds(): Promise<void> {
    if (Date.now() - prunedAt < PUSH_SOUND_PRUNE_EVERY_MS) return;
    prunedAt = Date.now();
    await pool.query(`delete from push_thread_sound where sounded_at < now() - interval '1 day'`);
  }

  async function sweep(): Promise<void> {
    if (!deps.transport || running) return;
    running = true;
    try {
      const skip: string[] = [];
      for (let i = 0; i < SWEEP_BATCH; i++) if ((await sendOne(skip)) === 'none') break;
      await pruneSounds();
    } catch (err) {
      log(`[push] sweep failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }

  return {
    startSweep(app) {
      if (!deps.transport || interval) return;
      interval = setInterval(() => { void sweep(); }, SWEEP_INTERVAL_MS);
      interval.unref?.();
      app.addHook('onClose', async () => {
        if (interval) { clearInterval(interval); interval = null; }
        deps.transport?.close();
      });
    },
    sweep,
    health: () => (!deps.transport ? 'off' : degraded ? 'degraded' : 'ok'),
  };
}
