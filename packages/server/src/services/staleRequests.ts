import type { Pool, PoolClient } from 'pg';
import type { FailureMeta } from '@murmur/shared';
import { postMessage } from './messages.js';
import { audienceFor } from './channels.js';
import { emitEvent, emitPosted } from '../events.js';

/**
 * **아무도 집지 않은 요청을 서버가 그 스레드에 말한다**(마이그레이션 049).
 *
 * ## 왜 서버인가 — daemon 이 아니라
 *
 * 러너 프로세스의 주인은 daemon 이고, daemon 은 **그 기계의 앱과만** unix 소켓으로 말한다
 * (`daemonProtocol.ts`: *"daemon 이 소유하는 것은 프로세스이지 세션이 아니다"*). 그래서
 * daemon 은 스레드에서 기다리는 사람에게 닿을 수 없다 — 그 사람은 다른 사람·다른 기계일
 * 수 있다. 게다가 daemon 에게 채널·스레드 어휘를 주면 두 번째 서버 클라이언트가 생기고,
 * `exit.ts` 가 닫아 둔 결정(*"러너↔앱 통신 채널은 만들지 않는다"*)을 반대편에서 다시 연다.
 *
 * 중계자가 애초에 필요 없다: **러너의 살아있음은 러너가 자기 폴로 서버에 알린다.**
 * `inbox.poll`(최대 25초 롱폴)이 그 신호이고 `mcp/presence.ts` 가 그것을 담는다.
 *
 * ## 판정은 두 값을 함께 본다
 *
 * 미읽음만 보면 **일하는 에이전트를 죽은 것으로 단정한다** — 읽음은 턴이 끝날 때 찍히므로
 * 정상적으로 도는 긴 턴(최대 30분)도 그동안 미읽음이다. presence 가 그 둘을 가른다:
 * 폴하고 있으면 살아 있는 것이고, 폴이 멈췄으면 그 요청을 집을 러너가 없는 것이다.
 *
 * ## presence 가 인메모리인 대가
 *
 * 서버가 재시작하면 **전원이 오프라인으로 시작한다.** 그대로 스위퍼를 돌리면 재시작마다
 * 모든 스레드에 통지가 쏟아진다 — 그래서 `startupGraceMs` 가 있다. presence 를 인스턴스
 * 밖으로 빼는 일은 `design.md` §5 「수평 확장 제약」 A 표에 이미 올라 있고, 이 기능은 새
 * 빚을 만들지 않고 그 항목에 함께 묶인다.
 *
 * ## 무엇을 말하지 않는가
 *
 * `wake`·`ask_answered`·`ask_closed` 는 **사람의 요청이 아니라** 에이전트가 자기에게 건
 * 후속이다. 그것들이 막힌 것도 사실이지만 사람이 읽어야 하는 문장이 다르고(스레드에는 이미
 * 대기 줄이 서 있다), 이 스위퍼가 하는 말은 *"이 요청을 집을 러너가 없다"* 하나다. 그
 * 문장이 맞는 사유만 본다.
 */

/** 이 시간을 넘겨 미읽음으로 남아 있으면 후보다. presence 가 오프라인을 45초 안에 확정하므로 넉넉하다. */
export const STALE_AFTER_MS = 2 * 60_000;

/**
 * 서버 기동 후 이만큼은 아무 말도 하지 않는다. presence 는 인메모리라 기동 직후엔 살아 있는
 * 러너도 오프라인으로 보이고, 러너가 다시 폴을 걸기까지 최대 25초가 걸린다. 유예 없이
 * 돌리면 **배포마다** 모든 스레드에 거짓 통지가 남는다.
 */
export const STALE_STARTUP_GRACE_MS = 60_000;

/** 스윕 주기. `read_at`·presence 둘 다 초 단위로 움직이므로 30초면 충분하다. */
export const STALE_SWEEP_INTERVAL_MS = 30_000;

/** 한 번의 스윕에서 말할 스레드 수의 상한. 러너 여럿이 함께 죽어도 한 스윕이 오래 잡히지 않게 한다. */
export const STALE_SWEEP_BATCH = 20;

/** 이 스위퍼가 말하는 사유들 — 사람이 **부른** 것만이다(위 「무엇을 말하지 않는가」). */
const REQUEST_REASONS = ['mention', 'team_mention', 'thread_reply', 'dm'] as const;

export interface SweepHost {
  addHook(hook: 'onClose', fn: () => void | Promise<void>): void;
}

interface Candidate {
  id: number;
  account_id: string;
  handle: string;
  channel_id: string;
  thread_root_id: string;
}

/**
 * 통지 본문. 러너가 스스로 남기는 실패 통지와 **같은 어휘**를 쓴다(`FAILURE_NOTICE` 계열) —
 * 사람이 스레드에서 읽는 문장이 "누가 말했든 같은 종류의 사실"이어야 한다.
 *
 * `retryable: true` 인 이유: 러너를 다시 띄우면 이 요청부터 다시 집는다(항목은 남아 있다).
 * 고칠 수 없는 실패가 아니라 **기다림이 아니라 개입이 필요한** 실패다.
 *
 * `reason` 에 *"서버가 관측했다"* 를 적는다. 저자가 에이전트인데 그 에이전트는 지금 말할
 * 수단이 없으므로(러너가 없다), 그 문장이 없으면 사람은 "죽었다면서 어떻게 말했나"를 묻게
 * 된다. 저자를 시스템 계정으로 두지 않는 이유는 아래 `postOne` 주석에 있다.
 */
function failureFor(handle: string): { body: string; meta: FailureMeta } {
  return {
    body: '(이 요청을 집을 러너가 없습니다 — 운영자 확인이 필요합니다)',
    meta: {
      kind: 'failure',
      failure: {
        retryable: true,
        what: `@${handle} 의 러너가 붙어 있지 않아 이 요청이 처리되지 않았다`,
        reason: '러너가 폴을 멈춘 상태다(서버가 관측했다) — 러너를 다시 띄우면 이 요청부터 다시 집는다',
      },
    },
  };
}

/**
 * 스위퍼를 만든다. `createAgentWakeSweeper`·`createScheduledMessageSweeper` 와 **같은
 * 모양**이다: 한 건씩 자기 트랜잭션, 프로세스 안 겹침은 깃발로, `onClose` 에서 interval 정리.
 *
 * `presence` 를 인자로 받는 이유: 이 모듈이 그 레지스트리를 만들면 서버가 쓰는 것과 다른
 * 인스턴스가 되어 **아무도 온라인이 아닌** 판정을 하게 된다(`buildServer` 가 하나를 만들어
 * 여러 곳에 넘기는 것과 같은 이유다).
 */
export function createStaleRequestSweeper(pool: Pool, opts: {
  presence: { online(): string[] };
  now?: () => number;
  /** 기동 시각. 유예의 기준점이다 — 테스트가 과거로 주어 유예를 지나게 한다. */
  startedAt?: number;
  staleAfterMs?: number;
  startupGraceMs?: number;
}): { startSweep(app: SweepHost): void; sweep(): Promise<void> } {
  const now = opts.now ?? Date.now;
  const startedAt = opts.startedAt ?? now();
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS;
  const graceMs = opts.startupGraceMs ?? STALE_STARTUP_GRACE_MS;
  let sweepInterval: ReturnType<typeof setInterval> | null = null;
  let running = false;

  /**
   * 후보를 모은다 — **미읽음 · 아직 안 말함 · 사람이 부른 것 · 오래됨 · 러너가 오프라인**.
   *
   * 오프라인 판정을 SQL 로 내리는 이유: 온라인 목록은 인메모리에 있으므로 배열로 넘겨
   * `<> all(...)` 로 뺀다. 빈 배열에서도 그 술어는 참이라(아무도 온라인이 아니면 전부
   * 후보다) 특수 분기가 필요 없다.
   *
   * `agent_config` 를 join 하는 이유: 정의가 있는 에이전트만 러너가 뜬다 —
   * `murmur_agent_oldest_unread_seconds` 메트릭이 같은 join 을 쓰고, 그것이
   * "murmur 가 실행할 수 있는 에이전트"의 정의다.
   */
  async function candidates(online: string[]): Promise<Candidate[]> {
    const res = await pool.query<Candidate>(
      `select i.id::int as id, i.account_id, a.handle, m.channel_id,
              coalesce(m.thread_root_id, m.id) as thread_root_id
         from inbox i
         join message m on m.id = i.message_id
         join account a on a.id = i.account_id
         join agent_config c on c.account_id = a.id
        where i.read_at is null
          and i.stale_notified_at is null
          and i.reason = any($1)
          and i.created_at < now() - ($2::int * interval '1 millisecond')
          and i.account_id <> all($3)
          and m.deleted_at is null
        order by i.id
        limit 200`,
      [REQUEST_REASONS, staleAfterMs, online],
    );
    return res.rows;
  }

  /**
   * 한 묶음(**에이전트 하나 × 스레드 하나**)에 대해 한 줄을 남긴다.
   *
   * ## 순서가 계약이다 — 표시하고, 말하고, 커밋한다
   *
   * 표시를 먼저 하는 이유: 그 `update ... where stale_notified_at is null returning` 이
   * 경합에서 진 쪽을 걸러 낸다(043 이 `answeredWith is null` 로 한 것과 같은 모양). 0 행이면
   * 다른 스윕이 이미 집은 것이라 조용히 물러난다.
   *
   * 그럼에도 `idempotencyKey` 를 쓰는 이유: `postMessage` 는 **자기 커넥션에서 커밋**하므로
   * 발화와 이 트랜잭션이 원자적이지 않다. 발화 뒤 커밋 전에 프로세스가 죽으면 표시가
   * 되돌아가고 다음 스윕이 같은 묶음을 다시 집는데, 그때 키가 있으면 새 메시지를 만들지 않고
   * 이미 만든 것을 돌려준다(예약 발송 sweeper 가 같은 이유로 같은 장치를 쓴다).
   *
   * ## 저자가 에이전트다
   *
   * 시스템 계정으로 두지 않는다. 이 실패의 주체는 **그 에이전트**이고, 화면은 실패를 저자로
   * 묶어 그린다(얼굴·실패 수). 시스템 계정이 말하면 "누가 답하지 않았나"가 문장 안으로
   * 들어가 버리고, 같은 사실을 러너가 스스로 남길 때(`message.fail`)와 다른 모양이 된다.
   * 그 에이전트가 지금 말할 수단이 없다는 사실은 `reason` 이 적는다.
   */
  async function postOne(group: Candidate[]): Promise<'done' | 'skipped'> {
    const head = group[0]!;
    const ids = group.map((c) => c.id);
    const client: PoolClient = await pool.connect();
    try {
      await client.query('begin');
      const marked = await client.query(
        `update inbox set stale_notified_at = now()
          where id = any($1) and stale_notified_at is null and read_at is null
          returning id`,
        [ids],
      );
      if (!marked.rowCount) {
        await client.query('commit');
        return 'skipped';
      }

      const { body, meta } = failureFor(head.handle);
      const posted = await postMessage(pool, {
        channelId: head.channel_id,
        authorId: head.account_id,
        body,
        threadRootId: head.thread_root_id,
        meta: meta as unknown as Record<string, unknown>,
        idempotencyKey: `stale:${Math.min(...ids)}`,
      });
      await client.query('commit');

      // **커밋 뒤에 이벤트를 친다** — 앞서 치면 화면이 아직 커밋되지 않은 상태를 읽는다
      // (깨움 sweeper 가 같은 순서를 지킨다). 이벤트를 안 치면 이 줄은 다음 새로고침까지
      // 안 보이고, 그러면 "왜 답이 없지"를 묻는 사람에게 여전히 침묵이다.
      if (posted.message) {
        emitPosted(posted, await audienceFor(pool, head.channel_id));
        for (const accountId of posted.notified ?? []) {
          emitEvent({ type: 'inbox.updated', accountId });
        }
      }
      return 'done';
    } catch (err) {
      await client.query('rollback').catch(() => {});
      // 한 건의 실패로 나머지를 멈추지 않는다. 표시가 되돌아가므로 다음 스윕이 다시 집는다 —
      // 영구 실패로 굳히면 그 요청은 영영 아무 말도 못 듣는다.
      console.error('stale request sweep error:', err);
      return 'done';
    } finally {
      client.release();
    }
  }

  const sweep = async () => {
    if (running) return;
    // 기동 유예 — 위 `STALE_STARTUP_GRACE_MS` 주석이 이유다.
    if (now() - startedAt < graceMs) return;
    running = true;
    try {
      const rows = await candidates(opts.presence.online());
      // **에이전트 하나 × 스레드 하나**로 묶는다. 한 스레드에 미읽음이 셋이어도 줄은 하나이고
      // (사람이 읽을 문장은 하나다) 표시는 셋 다에 찍힌다.
      const groups = new Map<string, Candidate[]>();
      for (const row of rows) {
        const key = `${row.account_id}|${row.thread_root_id}`;
        const bucket = groups.get(key);
        if (bucket) bucket.push(row);
        else groups.set(key, [row]);
      }
      let done = 0;
      for (const group of groups.values()) {
        if (done >= STALE_SWEEP_BATCH) break;
        if ((await postOne(group)) === 'done') done += 1;
      }
    } catch (err) {
      console.error('stale request sweep error:', err);
    } finally {
      running = false;
    }
  };

  return {
    startSweep(app) {
      if (sweepInterval) return;
      sweepInterval = setInterval(() => { void sweep(); }, STALE_SWEEP_INTERVAL_MS);
      sweepInterval.unref?.();
      app.addHook('onClose', async () => {
        if (sweepInterval) {
          clearInterval(sweepInterval);
          sweepInterval = null;
        }
      });
    },
    sweep,
  };
}
