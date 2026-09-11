import type { Pool } from 'pg';
import type { ProjectionRuntime } from '@harkroom/shared';
import { emitEvent } from '../events.js';
import { listBoundRepos } from '../services/channels.js';
import type { AvcsServerClient } from './client.js';

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
  /**
   * 이 워커가 보고 있는 avcs 서버. `projection_cursor`·`active_lease` 는 이제 (repo,
   * avcs_base_url)로 키가 잡힌다 — `last_log_index` 가 **그 서버의** 로그 안 위치라서,
   * 서버가 바뀌면 같은 repo 이름이라도 다른 행이어야 한다(042_projection_state_per_server.sql).
   */
  baseUrl: string;
}

/**
 * ## 이 워커가 더 이상 하지 않는 일 — avcs 객체를 채널 메시지·스레드로 만드는 것
 *
 * murmur 의 자리는 `avcs ↔ avcs-server ↔ avcshub` 에서 avcshub 자리다. 코드 관리·협업은
 * avcs 를 통해서 하고, murmur 는 그 제안·충돌·결정을 **보는 자리**다.
 *
 * 그런데 이 워커는 다른 것을 했다: `intent` 를 스레드 뿌리로 세우고 `operation`·`decision`·
 * `evidence` 를 그 아래 답글로, `checkpoint`·`release`·`finalize` 를 채널 메시지로 붙였다.
 * 즉 거버넌스 객체를 채팅 대화로 **번역**했고, 그것은 avcshub 를 대신하는 일이 아니었다.
 * 스레드는 사람이 쓰는 자리이지 avcs 로그의 표현 형식이 아니다. 협업은 별도 탭이 맡고,
 * 그 탭은 여기서 남긴 재료(`active_lease`)와 `client.ts`(`fetchSince`·`waitForChange`)를
 * 직접 읽는다 — 중간에 메시지로 바꿔 놓는 단계가 필요하지 않다.
 *
 * **남긴 것과 그 이유:**
 * - `active_lease` 투영 — 협업 탭이 충돌 판정에 쓸 재료다. 누가 어떤 경로를 언제까지
 *   잡고 있는지는 avcs 로그를 처음부터 접어야 알 수 있는 상태값이고, 그 접기를 여기서
 *   한 번 해 두는 것이 이 워커가 남는 이유다.
 * - `projection_cursor` — 어디까지 봤는지. lease 를 접으려면 로그를 순서대로 한 번씩
 *   봐야 하고, 커서 없이는 재기동마다 처음부터 다시 접는다.
 * - 커서 전진 규칙·백오프·repo 단위 격리 — lease 만 남아도 그대로 필요하다. 특히
 *   "투영할 게 없어도 커서는 전진한다"는 lease 아닌 객체가 대다수가 된 지금 더 중요하다.
 *
 * 되돌리려면 `work_thread` 테이블과 `message_avcs_oid` 유니크 인덱스를 되살려야 한다
 * (`040_drop_thread_projection.sql` 이 지운다).
 *
 * **`ensureSystemAccount` 을 함께 지운 판단:** 그 함수는 `murmur` 핸들의 agent 계정을
 * 만들어 투영 메시지의 `author_id` 로 쓰는 것이 유일한 용도였고, 다른 호출자는 없었다
 * (유일하게 남은 언급은 `metricsEndpoint.test.ts` 인데, 그것은 "러너 없는 agent 계정은
 * 지표에서 빠진다"를 확인하려고 마침 손에 있던 계정을 쓴 것이라 그 성질에 `murmur` 라는
 * 이름이 필요하지 않다). 메시지를 만들지 않으면 작성자로 세울 것이 없으므로 계정을
 * 만들 이유가 사라진다.
 *
 * 다만 **이미 만들어진 계정 행은 마이그레이션으로 지우지 않는다.** `message.author_id` 는
 * `not null references account(id)` 라서, 과거에 투영된 `system` 메시지가 하나라도 있는
 * DB 에서 그 계정을 지우면 FK 위반으로 터진다 — 그 메시지를 함께 지우는 것 말고는 길이
 * 없고, 그것은 기록을 지우는 별개의 결정이다. 그래서 운영 중인 DB 에는 이 계정이 남고,
 * 새 DB 에는 애초에 생기지 않는다. 둘 다 맞다: 계정은 과거 메시지의 작성자라는 뜻이고,
 * 작성자가 필요한 과거가 없으면 계정도 필요 없다.
 */

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

  /**
   * `repo` 하나를 커서부터 따라잡는다. 돌려주는 수는 **읽은 로그 엔트리 수**이고
   * 투영한 것의 수가 아니다 — 대부분의 엔트리는 lease 가 아니라서 아무것도 남기지 않는다.
   *
   * 채널 인자를 받지 않는다. 예전에는 이 자리에서 메시지를 만들었기 때문에 어느 채널에
   * 넣을지 알아야 했지만, `active_lease` 는 `(repo, avcs_base_url, path, actor_key_id)` 로
   * 키가 잡힌다(042) — 채널이 아니라 이 워커가 보고 있는 서버로 스코프된다. 채널을 계속
   * 받으면 "repo 는 채널 하나에만 바인딩된다"는 제약이 필요 없어진 뒤에도 인자에 남아,
   * 읽는 사람에게 lease 가 채널에 속한 것처럼 보인다.
   */
  async runOnce(repo: string): Promise<number> {
    const { pool, avcs, baseUrl } = this.deps;

    // 아웃바운드 HTTP는 트랜잭션(및 그 안의 pool 커넥션 + row lock) 밖에서 수행한다.
    // avcs 서버가 느려도 채팅 API용 pool 커넥션을 굶기지 않기 위함.
    const before = await pool.query(
      `select last_log_index from projection_cursor where repo = $1 and avcs_base_url = $2`,
      [repo, baseUrl],
    );
    const since: number = before.rowCount ? Number(before.rows[0].last_log_index) : 0;
    const { entries, next } = await avcs.fetchSince(repo, since);
    // 투영할 게 없어도 커서는 전진해야 한다. avcs 로그에는 투영 대상이 아닌 객체(blob·session·
    // view …)가 섞여 있고, 그것들만 담긴 배치에서 커서를 세워두면 waitForChange가 영원히
    // "변경됨"을 돌려주며 백오프 없는 폴 루프가 된다. next === since면 진짜 새 게 없다.
    //
    // 스레드 투영을 걷어낸 뒤 이 성질은 **예외가 아니라 통상**이 됐다: 이제 lease 만
    // 남기므로 intent·operation·decision 이 가득한 배치도 남기는 것 없이 지나간다.
    if (!entries.length && next <= since) return 0;

    const client = await pool.connect();
    try {
      await client.query('begin');
      // **`#523` 의 seq 락은 여기서 필요 없다.** 그 락은 "이 트랜잭션도 `message` 에
      // insert 하므로"가 근거였는데, 스레드 투영을 걷어낸 뒤 이 경로는 **메시지를 만들지
      // 않는다** — `active_lease` upsert 뿐이라 seq 를 발급받을 일이 없다. 근거가 사라진
      // 락을 남기면 배치 하나를 처리하는 이 긴 트랜잭션이 채널 발화를 이유 없이 막는다.
      const cur = await client.query(
        `select last_log_index from projection_cursor where repo = $1 and avcs_base_url = $2 for update`,
        [repo, baseUrl],
      );
      const currentSince: number = cur.rowCount ? Number(cur.rows[0].last_log_index) : 0;
      if (currentSince !== since) {
        // 다른 실행이 이미 커서를 전진시켰다 — 이번 배치는 폐기하고 다음 폴에서 새 since로 재조회한다.
        await client.query('rollback');
        return 0;
      }

      let leaseChanged = false;

      // `lease` 만 접는다. `intent`·`operation`·`decision`·`evidence`·`integration`·
      // `checkpoint`·`release`·`finalize` 는 **의도적으로 지나친다** — 그 객체들을 보는
      // 자리는 협업 탭이고, 그 탭은 avcs 로그를 직접 읽는다. 여기서 메시지로 바꿔 두면
      // 같은 사실이 두 곳에 다른 모양으로 있게 되고, 채팅 쪽 사본이 원본을 가린다.
      // switch 를 남기지 않은 이유가 이것이다: 통과시킬 타입을 나열해 두면 다음 사람이
      // "여기에 case 를 더하면 되는구나"로 읽고, 걷어낸 구조가 조용히 돌아온다.
      for (const entry of entries) {
        if (entry.type !== 'lease' || !entry.lease) continue;
        if (entry.lease.released) {
          await client.query(
            `delete from active_lease where repo = $1 and avcs_base_url = $2 and path = $3 and actor_key_id = $4`,
            [repo, baseUrl, entry.lease.path, entry.actorKeyId ?? ''],
          );
        } else {
          await client.query(
            `insert into active_lease (repo, avcs_base_url, path, actor_key_id, expires_at)
             values ($1, $2, $3, $4, $5)
             on conflict (repo, avcs_base_url, path, actor_key_id) do update set expires_at = excluded.expires_at`,
            [repo, baseUrl, entry.lease.path, entry.actorKeyId ?? '', entry.lease.expiresAt],
          );
        }
        leaseChanged = true;
      }

      await client.query(
        `insert into projection_cursor (repo, avcs_base_url, last_log_index) values ($1, $2, $3)
         on conflict (repo, avcs_base_url) do update set last_log_index = excluded.last_log_index`,
        [repo, baseUrl, next],
      );
      await client.query('commit');

      // 커서가 전진했다. **이것은 살아 있음의 신호가 아니라 기록이다** — 조용한
      // 저장소는 영영 전진하지 않으므로 상태 판정은 lastPolledAt 이 한다(#267).
      this.runtime.lastAdvancedAt = Date.now();
      this.runtime.lastLogIndex = next;

      // `message.created` 는 더 이상 여기서 나가지 않는다 — 만드는 메시지가 없다.
      // 남는 이벤트는 `lease.changed` 뿐이고, 그것이 곧 협업 탭을 깨우는 신호다.
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
          // 따라갈 repo 목록은 계속 채널 바인딩에서 온다. lease 를 채널에 넣지 않게 된
          // 뒤에도 이 출처가 맞다 — "이 저장소를 여기서 본다"는 선언은 사람이 채널에
          // repo 를 붙이는 행위이고, 그 선언이 없는 저장소를 서버가 멋대로 폴링할
          // 이유가 없다. 다만 이제 `channelId` 는 쓰지 않는다(`runOnce` 주석 참조).
          const bound = await listBoundRepos(this.deps.pool);
          // repo 단위 try/catch — 한 repo가 연속 실패해도 같은 사이클의 나머지 repo 처리를
          // 막지 않는다(감사 ⑥). 백오프는 단순화를 위해 사이클 전체에 한 번만 적용한다.
          for (const { repo } of bound) {
            try {
              // 폴링한 저장소를 남긴다 — 커서가 안 움직여도(조용한 저장소) 물어봤다는 사실이다.
              this.runtime.repo = repo;
              const cur = await this.deps.pool.query(
                `select last_log_index from projection_cursor where repo = $1 and avcs_base_url = $2`,
                [repo, this.deps.baseUrl],
              );
              const since = cur.rowCount ? Number(cur.rows[0].last_log_index) : 0;
              const changed = await this.deps.avcs.waitForChange(repo, since, pollMs);
              this.runtime.connected = true;
              if (changed) await this.runOnce(repo);
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
