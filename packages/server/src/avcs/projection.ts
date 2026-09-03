import type { Pool, PoolClient } from 'pg';
import type { ProjectionRuntime } from '@murmur/shared';
import { emitEvent } from '../events.js';
import { listBoundRepos } from '../services/channels.js';
import type { AvcsLogEntry, AvcsServerClient } from './client.js';

/**
 * 워커가 내보내는 상태(#267). `ProjectionRuntime`(공유 계약) + `connected`.
 *
 * `connected` 는 이 객체에 남지만 **`/projection/status` 로는 나가지 않는다** —
 * `/healthz` 의 사실이다(shared 의 `ProjectionStatus` 주석 참고). 저장 자리는 한 곳이다:
 * 예전에는 `this.connected` 와 상태 객체 안의 사본이 따로 있었고, 갱신이 한쪽에만
 * 가서 `status().connected` 가 영구히 false 였다.
 */
export type ProjectionWorkerStatus = ProjectionRuntime & { connected: boolean };

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
  private loop: Promise<void> | null = null;
  /**
   * 상태의 **유일한 저장 자리**. 워커가 만들어졌다는 것 자체가 `AVCS_BASE_URL` 이
   * 있었다는 뜻이므로 `configured` 는 여기서 항상 true 다 — 없는 경우는 워커가 아예
   * 없고, `main.ts` 가 그 자리를 대신 답한다.
   */
  private runtime: ProjectionWorkerStatus = {
    configured: true,
    connected: false,
    repo: null,
    lastLogIndex: 0,
    lastPolledAt: null,
    lastAdvancedAt: null,
    lastError: null,
  };

  constructor(private deps: ProjectionDeps) {}

  status(): ProjectionWorkerStatus {
    return { ...this.runtime };
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

      // 커서가 전진했다. **이것은 살아 있음의 신호가 아니라 기록이다** — 조용한
      // 저장소는 영영 전진하지 않으므로 상태 판정은 lastPolledAt 이 한다(#267).
      this.runtime.lastAdvancedAt = Date.now();
      this.runtime.lastLogIndex = next;

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
        let lastRepoError: string | null = null;
        /**
         * **사이클마다 한 번, repo 목록을 보기 전에 찍는다**(#267). repo 루프 안에서
         * 찍으면 바인딩된 저장소가 하나도 없는 서버는 폴링이 멀쩡히 돌고 있는데도
         * `lastPolledAt` 이 영영 null 로 남아 `stalled` 로 보인다 — 정상을 장애로
         * 부르는 것이고, 그러면 사람은 이 표시를 곧 무시한다.
         */
        this.runtime.lastPolledAt = Date.now();
        try {
          const bound = await listBoundRepos(this.deps.pool);
          // repo 단위 try/catch — 한 repo가 연속 실패해도 같은 사이클의 나머지 repo 처리를
          // 막지 않는다(감사 ⑥). 백오프는 단순화를 위해 사이클 전체에 한 번만 적용한다.
          for (const { repo, channelId } of bound) {
            try {
              // 폴링한 저장소를 남긴다 — 커서가 안 움직여도(조용한 저장소) 물어봤다는 사실이다.
              this.runtime.repo = repo;
              const cur = await this.deps.pool.query(
                `select last_log_index from projection_cursor where repo = $1`, [repo],
              );
              const since = cur.rowCount ? Number(cur.rows[0].last_log_index) : 0;
              const changed = await this.deps.avcs.waitForChange(repo, since, pollMs);
              this.runtime.connected = true;
              if (changed) await this.runOnce(repo, channelId);
            } catch (err) {
              this.runtime.connected = false;
              hadFailure = true;
              // 에러 메시지를 200자로 자른다.
              lastRepoError = err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
            }
          }
          if (!bound.length) await new Promise((r) => setTimeout(r, pollMs));
        } catch (err) {
          // listBoundRepos 자체 실패(예: DB 다운) — 사이클 전체 실패로 취급.
          this.runtime.connected = false;
          hadFailure = true;
          lastRepoError = err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
        }
        /**
         * 사이클이 끝날 때 `lastError` 를 **덮어쓴다** — 실패면 메시지, 성공이면 null.
         * `if (lastRepoError)` 로 실패만 기록하면 한 번 난 오류가 영영 남아 복구한
         * 서버가 계속 `stalled` 로 보인다("다음 성공 폴링이 지운다"가 성립해야 한다).
         */
        this.runtime.lastError = lastRepoError;
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

/** 워커가 없을 때의 상태. `main.ts` 와 테스트가 같은 값을 보게 한 곳에 둔다. */
export const DISABLED_PROJECTION_STATUS: ProjectionWorkerStatus = {
  configured: false,
  connected: false,
  repo: null,
  lastLogIndex: 0,
  lastPolledAt: null,
  lastAdvancedAt: null,
  lastError: null,
};

/**
 * 투영이 꺼져 있으면 기동 시 **경고 한 줄**을 남긴다(#267).
 *
 * 함수로 빼 둔 이유는 시험 가능성이다 — `main.ts` 는 최상위 await 로 서버를 띄우는
 * 스크립트라 임포트만으로 포트를 잡는다. 결정(경고를 낼지)과 실행(서버 기동)이 한
 * 파일에 붙어 있으면 이 한 줄은 어떤 테스트도 확인할 수 없다.
 *
 * 로거는 인자로 받는다. `buildServer` 가 fastify 로거를 만들기 **전**이라 이 시점에는
 * 아직 로거가 없고, `main.ts` 의 나머지(`console.error`·`console.log`)와 모양을 맞춘다.
 *
 * @returns 경고를 냈는가.
 */
export function warnIfProjectionDisabled(
  avcsBaseUrl: string | null,
  warn: (message: string) => void = (m) => console.warn(m),
): boolean {
  if (avcsBaseUrl) return false;
  warn('avcs projection is disabled — set AVCS_BASE_URL to enable it');
  return true;
}
