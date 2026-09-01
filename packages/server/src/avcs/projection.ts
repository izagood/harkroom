import type { Pool, PoolClient } from 'pg';
import { emitEvent } from '../events.js';
import { listBoundRepos } from '../services/channels.js';
import type { AvcsLogEntry, AvcsServerClient } from './client.js';

export interface ProjectionDeps {
  pool: Pool;
  avcs: AvcsServerClient;
  systemAccountId: string;
}

export async function ensureSystemAccount(pool: Pool): Promise<string> {
  const res = await pool.query(
    `insert into account (handle, display_name, kind) values ('murmur', 'murmur', 'agent')
     on conflict (handle) do update set display_name = excluded.display_name
     returning id`,
  );
  return res.rows[0].id;
}

async function actorLabel(client: PoolClient, keyId: string | null): Promise<string> {
  // 서명자가 없는 객체(checkpoint·release 등)와 모르는 키로 서명된 객체는 다르다.
  // 둘 다 '외부 작업자'로 적으면 "서명이 없다"가 "외부에서 왔다"는 주장으로 바뀐다.
  if (!keyId) return '작성자 미상';
  const res = await client.query(
    `select a.handle from account_key k join account a on a.id = k.account_id where k.key_id = $1`,
    [keyId],
  );
  return res.rowCount ? `@${res.rows[0].handle}` : `외부 작업자(${keyId})`;
}

export class ProjectionWorker {
  private running = false;
  private connected = false;
  private loop: Promise<void> | null = null;

  constructor(private deps: ProjectionDeps) {}

  status(): { connected: boolean } {
    return { connected: this.connected };
  }

  async runOnce(repo: string, channelId: string): Promise<number> {
    const { pool, avcs, systemAccountId } = this.deps;

    // 아웃바운드 HTTP는 트랜잭션(및 그 안의 pool 커넥션 + row lock) 밖에서 수행한다.
    // avcs 서버가 느려도 채팅 API용 pool 커넥션을 굶기지 않기 위함.
    const before = await pool.query(`select last_log_index from projection_cursor where repo = $1`, [repo]);
    const since: number = before.rowCount ? Number(before.rows[0].last_log_index) : 0;
    const { entries, next } = await avcs.fetchSince(repo, since);
    // 투영할 게 없어도 커서는 전진해야 한다. avcs 로그에는 투영 대상이 아닌 객체(blob·session·
    // view …)가 섞여 있고, 그것들만 담긴 배치에서 커서를 세워두면 waitForChange가 영원히
    // "변경됨"을 돌려주며 백오프 없는 폴 루프가 된다. next === since면 진짜 새 게 없다.
    if (!entries.length && next <= since) return 0;

    const client = await pool.connect();
    try {
      await client.query('begin');
      const cur = await client.query(`select last_log_index from projection_cursor where repo = $1 for update`, [repo]);
      const currentSince: number = cur.rowCount ? Number(cur.rows[0].last_log_index) : 0;
      if (currentSince !== since) {
        // 다른 실행이 이미 커서를 전진시켰다 — 이번 배치는 폐기하고 다음 폴에서 새 since로 재조회한다.
        await client.query('rollback');
        return 0;
      }

      const emitted: { message: import('@murmur/shared').MessageRow }[] = [];
      let leaseChanged = false;

      const insertSystem = async (
        body: string, oid: string, avcsType: string, threadRootId: string | null,
      ): Promise<string | null> => {
        const res = await client.query(
          `insert into message (channel_id, thread_root_id, author_id, body, kind, meta)
           values ($1, $2, $3, $4, 'system', $5)
           on conflict do nothing
           returning id, seq::int as seq, channel_id as "channelId", thread_root_id as "threadRootId",
             author_id as "authorId", body, kind, meta, created_at as "createdAt"`,
          [channelId, threadRootId, systemAccountId, body, JSON.stringify({ repo, oid, avcsType })],
        );
        if (res.rowCount) emitted.push({ message: res.rows[0] });
        return res.rowCount ? res.rows[0].id : null;
      };

      const threadRootFor = async (intentOid: string | null): Promise<string | null> => {
        if (!intentOid) return null;
        const res = await client.query(
          `select thread_root_message_id from work_thread where repo = $1 and intent_oid = $2`,
          [repo, intentOid],
        );
        return res.rowCount ? res.rows[0].thread_root_message_id : null;
      };

      // operation은 배치 내 intentOid별 병합
      const opGroups = new Map<string, AvcsLogEntry[]>();

      for (const entry of entries) {
        const actor = await actorLabel(client, entry.actorKeyId);
        switch (entry.type) {
          case 'intent': {
            const id = await insertSystem(`${actor} intent: ${entry.summary}`, entry.oid, 'intent', null);
            if (id) {
              await client.query(
                `insert into work_thread (repo, intent_oid, thread_root_message_id)
                 values ($1, $2, $3) on conflict (repo, intent_oid) do nothing`,
                [repo, entry.intentOid ?? entry.oid, id],
              );
            }
            break;
          }
          case 'operation': {
            const key = entry.intentOid ?? '(none)';
            opGroups.set(key, [...(opGroups.get(key) ?? []), entry]);
            break;
          }
          case 'decision':
          case 'evidence': {
            const root = await threadRootFor(entry.intentOid);
            await insertSystem(`${actor} ${entry.type}: ${entry.summary}`, entry.oid, entry.type, root);
            break;
          }
          case 'integration':
          case 'checkpoint':
          case 'release':
          case 'finalize': {
            await insertSystem(`${actor} ${entry.type}: ${entry.summary}`, entry.oid, entry.type, null);
            break;
          }
          case 'lease': {
            if (!entry.lease) break;
            if (entry.lease.released) {
              await client.query(
                `delete from active_lease where repo = $1 and path = $2 and actor_key_id = $3`,
                [repo, entry.lease.path, entry.actorKeyId ?? ''],
              );
            } else {
              await client.query(
                `insert into active_lease (repo, path, actor_key_id, expires_at)
                 values ($1, $2, $3, $4)
                 on conflict (repo, path, actor_key_id) do update set expires_at = excluded.expires_at`,
                [repo, entry.lease.path, entry.actorKeyId ?? '', entry.lease.expiresAt],
              );
            }
            leaseChanged = true;
            break;
          }
        }
      }

      for (const [intentOid, ops] of opGroups) {
        const actor = await actorLabel(client, ops[0]!.actorKeyId);
        const root = await threadRootFor(intentOid === '(none)' ? null : intentOid);
        const representative = ops[ops.length - 1]!.oid;
        const body = ops.length === 1
          ? `${actor} operation: ${ops[0]!.summary}`
          : `${actor} ${ops.length} operations: ${ops.map((o) => o.summary).join(', ')}`;
        await insertSystem(body, representative, 'operation', root);
      }

      await client.query(
        `insert into projection_cursor (repo, last_log_index) values ($1, $2)
         on conflict (repo) do update set last_log_index = excluded.last_log_index`,
        [repo, next],
      );
      await client.query('commit');

      for (const { message } of emitted) emitEvent({ type: 'message.created', message, audience: 'all' });
      if (leaseChanged) emitEvent({ type: 'lease.changed', repo });
      return entries.length;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  start(pollMs = 25_000): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      let backoffMs = 1_000;
      while (this.running) {
        let hadFailure = false;
        try {
          const bound = await listBoundRepos(this.deps.pool);
          // repo 단위 try/catch — 한 repo가 연속 실패해도 같은 사이클의 나머지 repo 처리를
          // 막지 않는다(감사 ⑥). 백오프는 단순화를 위해 사이클 전체에 한 번만 적용한다.
          for (const { repo, channelId } of bound) {
            try {
              const cur = await this.deps.pool.query(
                `select last_log_index from projection_cursor where repo = $1`, [repo],
              );
              const since = cur.rowCount ? Number(cur.rows[0].last_log_index) : 0;
              const changed = await this.deps.avcs.waitForChange(repo, since, pollMs);
              this.connected = true;
              if (changed) await this.runOnce(repo, channelId);
            } catch {
              this.connected = false;
              hadFailure = true;
            }
          }
          if (!bound.length) await new Promise((r) => setTimeout(r, pollMs));
        } catch {
          // listBoundRepos 자체 실패(예: DB 다운) — 사이클 전체 실패로 취급.
          this.connected = false;
          hadFailure = true;
        }
        if (hadFailure) {
          await new Promise((r) => setTimeout(r, backoffMs));
          backoffMs = Math.min(backoffMs * 2, 60_000);
        } else {
          backoffMs = 1_000;
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}
