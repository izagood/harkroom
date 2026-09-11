// Phase 2 attach 의 서버 표면(스펙 §5). 다섯 개다:
//
//   GET  /agent-relay              러너가 거는 상시 outbound WS (PAT 헤더 인증)
//   GET  /agent-sessions           내가 볼 수 있는 진행 중 세션 목록
//   POST /agent-sessions/:id/attach  소유자 판정 → attach 티켓 발급
//   POST /agent-sessions/interactive 사람이 스스로 인터랙티브 턴을 연다(#337) → attach 티켓
//   GET  /agent-attach?ticket=...  뷰어 WS (티켓 1회용)
//
// **러너가 포트를 열지 않는다.** 러너는 사람의 로그인 세션 안에서 돌고, 관찰 하나 때문에
// 두 번째 보안 표면(청취 포트 + 인증 + TLS)을 만들지 않는다는 것이 스펙 §2 가 안 C 를
// 기각한 이유다. 그래서 방향이 러너 → 서버이고, 인증은 PAT 헤더다 — 러너는 브라우저가
// 아니라 헤더를 실을 수 있으므로 티켓이 필요 없다(티켓은 URL 노출 문제의 해법이었다).
//
// **인가 술어를 새로 만들지 않았다.** attach 는 `checkOwnerOrAdmin`(auth/plugin.ts) 하나가
// 판정한다 — #253 이 그 술어를 "이 파일에 하나만 둔다"로 못박았고, PAT 목록·메모리 조회와
// attach 는 같은 질문("이 에이전트가 내 것인가")에 답한다. 판정을 복사하면 한쪽만 고치는
// 사고가 나고, 인가에서 그것은 조용히 열리는 쪽으로 어긋난다.
//
// **PTY 바이트는 DB 에 남지 않는다.** 감사에는 attach/detach 사건과 세션 식별자만 남긴다 —
// PTY 출력에는 하네스가 화면에 그린 모든 것(토큰, 환경변수, 사람이 붙여 넣은 비밀)이
// 들어가고, 감사에 복사하면 그것을 지울 방법이 없다(audit.ts 의 `message.deleted`·
// `agent.memory.deleted` 가 같은 이유로 본문을 남기지 않는다).
//
// **#315 로 입력이 열린 뒤에도 그 규칙은 그대로다.** 사람이 친 바이트도 감사에 넣지 않는다 —
// 붙여 넣은 토큰이나 비밀번호 프롬프트의 답이 섞이므로 출력과 성질이 같다. 개입 사실은
// `agent.detached` 의 detail.inputBytes 하나로 남는다(스펙 §5-2 결정 3): 입력마다 행을
// 쓰면 행 타임스탬프가 곧 키 입력의 리듬이라 그 자체가 부채널이다.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AgentSessionView, AgentWakeView } from '@harkroom/shared';
import { checkOwnerOrAdmin } from '../auth/plugin.js';
import { actorOf, recordAudit } from '../audit.js';
import { cancelDelegationsFor } from '../services/delegations.js';
import { createAttachTicketStore } from '../ws/tickets.js';
import { emitEvent } from '../events.js';
import { createRelayHub } from '../ws/relay.js';
import type { AgentPresence } from '../mcp/presence.js';
import { createCredentialSweep, DEFAULT_REVALIDATE_MS, originAllowed } from '../ws/socketLifetime.js';

/**
 * 러너 소켓의 인증. `requireAccount` 뒤에 붙어 **에이전트 계정인지**까지 본다.
 *
 * 사람 계정을 막는 이유: 이 소켓은 세션을 announce 하고 PTY 바이트를 밀어 넣는 자리다.
 * 사람의 세션 토큰으로 붙을 수 있으면 아무 멤버나 "나는 에이전트 X 의 러너다"라고
 * 주장할 수 있고, 그 주장으로 남의 에이전트 세션 목록을 위조한다.
 */
async function requireAgentAccount(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.account && req.account.kind !== 'agent') {
    await reply.code(401).send({
      error: { code: 'unauthorized', message: 'agent account PAT required' },
    });
  }
}

/** 내가 소유한 에이전트 계정들. admin 은 이 질의를 타지 않는다('all' 이다). */
async function ownedAgentIds(pool: Pool, accountId: string): Promise<string[]> {
  const res = await pool.query<{ account_id: string }>(
    `select account_id from agent_config where owner_account_id = $1`,
    [accountId],
  );
  return res.rows.map((r) => r.account_id);
}

export interface AgentRelayDeps {
  /** attach 티켓 수명(ms). 미지정이면 `/ws` 티켓과 같은 기본값(30초). */
  attachTicketTtlMs?: number;
  /**
   * 뷰어 소켓의 Origin 허용 목록. `null`(기본)이면 판정하지 않는다 — `/ws` 와 **같은
   * 값**이어야 한다. WS 핸드셰이크는 CORS 의 보호를 받지 않으므로, 이벤트 소켓만 막고
   * 터미널 소켓을 열어 두면 더 민감한 쪽이 더 느슨해진다.
   */
  allowedOrigins?: readonly string[] | null;
  /** 자격증명 재검증 주기(ms). `/ws` 와 같은 값을 쓴다. 테스트가 짧게 준다. */
  revalidateMs?: number;
  /** interactive.open 응답 대기 한도(ms, #337). 기본 10초 — 테스트가 짧게 준다. */
  interactiveOpenTimeoutMs?: number;
  /**
   * 에이전트 presence 장부. **러너 프레임이 도착할 때마다 갱신한다** — 턴을 도는 동안
   * 러너는 `inbox.poll` 을 못 하지만(루프가 단일 스레드다) PTY 바이트는 초 단위로
   * 흘려 보낸다. 그 프레임을 생존으로 읽지 않으면 일하는 중인 에이전트가 30초 TTL 에
   * 만료돼 화면이 스레드를 '막힘'으로 칠한다.
   *
   * **'소켓 열림'이 아니라 '프레임 도착'이다.** 이 소켓은 heartbeat 추적을 받지 않으므로
   * (`heartbeat` 는 `wsPlugin` 에만 배선돼 있다) 소켓 존재를 생존으로 읽으면 케이블이
   * 뽑힌 러너가 영원히 온라인으로 남는다. 프레임을 신호로 잡으면 TTL 만료가 그대로
   * wedge 감지가 된다.
   *
   * 옵셔널로 두지 않는다 — 배선이 끊겨도 컴파일이 통과하면 presence 가 조용히 no-op 이
   * 되고, 그 조용한 no-op 이 정확히 이 버그의 모양이었다.
   */
  agentPresence: AgentPresence;
}

export async function registerAgentRelayRoutes(
  app: FastifyInstance, pool: Pool, deps: AgentRelayDeps,
): Promise<void> {
  /**
   * 에이전트가 사람 손을 기다린다(2026-09-08). 허브는 세션의 좌표만 주고, 소유자와
   * handle 을 붙여 이벤트로 만드는 것은 여기다 — 그 둘은 DB 에 있고, 허브는 DB 를 모른다.
   *
   * **소유자에게만 간다.** 남의 에이전트가 관문에 걸린 것은 이 사람이 할 수 있는 일이
   * 아니고, 그 창을 띄우면 남의 작업 화면만 가린다.
   */
  const onAttention = (ev: {
    sessionId: string; channelId: string; threadRootId: string | null;
    agentAccountId: string; accountLabel: string;
  }): void => {
    void (async () => {
      try {
        const res = await pool.query<{ owner_account_id: string; handle: string }>(
          `select c.owner_account_id, a.handle
             from agent_config c join account a on a.id = c.account_id
            where c.account_id = $1`,
          [ev.agentAccountId],
        );
        const row = res.rows[0];
        // 소유자를 모르면 보낼 곳이 없다. 조용히 버린다 — 전원에게 뿌리지 않는다.
        if (!row) return;
        emitEvent({
          type: 'agent.attention',
          sessionId: ev.sessionId,
          channelId: ev.channelId,
          threadRootId: ev.threadRootId,
          agentAccountId: ev.agentAccountId,
          agentHandle: row.handle,
          accountLabel: ev.accountLabel,
          audience: [row.owner_account_id],
        });
      } catch (err) {
        // 알림 하나를 못 보낸 것으로 릴레이를 흔들지 않는다. 사람은 여전히
        // [터미널 열기]로 직접 닿을 수 있다.
        app.log.warn({ err }, 'agent.attention 발행 실패');
      }
    })();
  };

  const hub = createRelayHub({ onAttention });
  const attachTickets = createAttachTicketStore({ ttlMs: deps.attachTicketTtlMs });
  /**
   * 뷰어 소켓의 수명. `/ws` 와 **같은 정책**(`ws/socketLifetime.ts`)을 쓴다.
   *
   * 왜 필요한가: attach 티켓은 처음부터 `credentialHash` 를 운반했지만 아무도 읽지
   * 않았다. 그래서 로그인 세션이 만료되거나 PAT 가 폐기된 뒤에도, 열려 있던 터미널
   * 패널로 PTY 바이트가 계속 흘렀다 — 그 바이트에는 하네스가 화면에 그린 모든 것이
   * 들어 있으므로, 이벤트 소켓보다 느슨해서는 안 된다.
   */
  const sweep = createCredentialSweep(pool, deps.revalidateMs ?? DEFAULT_REVALIDATE_MS);
  app.addHook('onClose', async () => { sweep.stop(); });

  /**
   * 러너의 상시 outbound WS. 재접속은 러너가 백오프로 한다(`packages/agent/src/policy.ts`
   * 의 `nextBackoffMs` — inbox.poll 루프와 같은 정책을 쓴다). 서버는 소켓이 끊기면 그
   * 러너의 세션 레지스트리를 버리고, 재접속 시 러너가 보내는 `announce` 로 다시 채운다 —
   * 서버는 러너가 살아 있는지 알 방법이 없으므로 진실의 원천을 러너에 둔다.
   */
  app.get('/agent-relay', {
    websocket: true,
    preHandler: [app.requireAccount, requireAgentAccount],
  }, (socket, req) => {
    const agentAccountId = req.account!.id;
    const detach = hub.addRunner(agentAccountId, socket);
    socket.on('message', (raw) => {
      // 프레임이 왔다 = 이 러너가 살아 있다. `hub` 앞에 두는 이유: 허브가 모르는
      // 프레임 종류(구·신 러너의 차이)도 생존 증거로는 똑같이 유효하다.
      deps.agentPresence.mark(agentAccountId);
      hub.onRunnerMessage(agentAccountId, String(raw));
    });
    socket.on('close', detach);
  });

  /**
   * 내가 볼 수 있는 진행 중 세션. **소유자 아니면 빈 목록이다** — 403 이 아니다:
   * 이 라우트는 "특정 에이전트"를 묻지 않으므로 거절할 대상이 없고, 소유하지 않은
   * 에이전트의 세션이 목록에 없는 것은 정상 응답이다.
   */
  app.get('/agent-sessions', { preHandler: app.requireAccount }, async (req) => {
    const account = req.account!;
    const scope = account.isAdmin ? 'all' as const : await ownedAgentIds(pool, account.id);
    return { sessions: hub.listSessions(scope) satisfies AgentSessionView[] };
  });

  /**
   * **아직 오지 않은 깨움**(Agents 관제 4단계 — 대기).
   *
   * 이 문이 없어서 관제 화면은 *"도는 턴 0개"* 만 말할 수 있었다. 그런데 0개에는 두 뜻이
   * 있다 — 아무 일도 없는 것과 **기다리는 중인 것**이고, 사람이 물어보는 것은 대개
   * 뒤쪽이다("죽었나 기다리나"). 예약은 지금까지 스레드마다 흩어진 wake 메시지로만
   * 보였으므로, 스레드를 다 열어 보지 않으면 알 수 없었다.
   *
   * ## 세션 목록과 **다른 층**이다
   *
   * 세션은 러너 메모리(허브)에 있어 릴레이가 끊기면 서버도 모른다. 깨움은 테이블에 있어
   * **언제나 알 수 있다** — 그래서 이 문은 릴레이 상태와 무관하게 답한다. 화면이 그 둘을
   * 같은 자리에 두면서도 "모른다"를 한쪽에만 그리는 근거가 이것이다.
   *
   * ## 무엇을 안 주는가
   *
   * 이미 깨운 것(`fired_at`)과 취소된 것(`canceled_at`)은 뺀다 — 이 문이 답하는 물음은
   * *"앞으로 올 것"* 이고, 지난 것은 스레드의 wake 메시지가 이미 기록으로 갖고 있다.
   *
   * 앵커와 사유는 **wake 메시지에서 되찾는다**(040 의 규칙: 시계 테이블에 앵커를 또
   * 저장하면 두 번째 진실 원천이 된다). 메시지가 지워졌으면 사유만 `null` 로 비우고
   * 줄은 남긴다 — 시계는 살아 있어 깨움이 그대로 오는데 줄을 감추면 화면이
   * "기다리는 것이 없다"고 거짓말한다.
   *
   * 권한은 `/agent-sessions` 와 **같은 판정**이다: admin 은 전체, 그 외는 자기가 소유한
   * 에이전트 것만. 소유하지 않은 사람에게 403 이 아니라 **빈 목록**인 이유도 같다 —
   * 이 라우트는 특정 에이전트를 묻지 않으므로 거절할 대상이 없다.
   */
  app.get('/agent-wakes', { preHandler: app.requireAccount }, async (req) => {
    const account = req.account!;
    const scope = account.isAdmin ? null : await ownedAgentIds(pool, account.id);
    // 소유한 에이전트가 없으면 질의하지 않는다 — `any('{}')` 는 어차피 0행이다.
    if (scope && !scope.length) return { wakes: [] satisfies AgentWakeView[] };
    const res = await pool.query<{
      id: string; account_id: string; channel_id: string; thread_root_id: string;
      message_id: string; wake_at: Date; reason: string | null;
    }>(
      `select w.id, w.account_id, w.channel_id, w.message_id, w.wake_at,
              coalesce(m.thread_root_id, m.id) as thread_root_id,
              case when m.deleted_at is null then m.body else null end as reason
         from agent_wake w
         join message m on m.id = w.message_id
        where w.fired_at is null and w.canceled_at is null
          ${scope ? 'and w.account_id = any($1::uuid[])' : ''}
        order by w.wake_at
        limit 200`,
      scope ? [scope] : [],
    );
    return {
      wakes: res.rows.map((row) => ({
        id: row.id,
        agentAccountId: row.account_id,
        channelId: row.channel_id,
        threadRootId: row.thread_root_id,
        messageId: row.message_id,
        wakeAt: new Date(row.wake_at).toISOString(),
        reason: row.reason,
      })) satisfies AgentWakeView[],
    };
  });

  /**
   * attach 인가. 통과하면 그 **세션 하나에만** 쓸 수 있는 1회용 티켓을 준다.
   *
   * 세션 id 를 티켓에 박는 이유: WS 핸드셰이크가 쿼리 파라미터의 세션 id 를 믿으면
   * 티켓 하나로 남의 세션에 붙는다. 인가는 여기(Bearer 인증된 REST)서 한 번 하고,
   * 소켓은 그 결정을 운반하는 티켓만 소모한다.
   */
  /**
   * 이 턴을 **그만두게 한다**(Agents 관제 3단계). 인가는 attach 와 **같은 판정**이다
   * (`checkOwnerOrAdmin`) — 남의 에이전트의 일을 멈추는 것이 화면을 보는 것보다 가벼울
   * 이유가 없다.
   *
   * ## 러너 종료와 다른 문이다
   *
   * `POST /accounts/agents/:id/stop` 은 "이 에이전트는 당분간 아무 말도 못 한다"이고
   * 되살리는 데 사람 손이 필요하다. 이 문은 "이 일을 그만둬라"이고 러너는 살아 있어
   * 다음 멘션을 정상으로 받는다. 두 문을 하나로 합치면 사람은 폭주를 멈추려고 팀원을
   * 해고한다 — 그것이 이 문을 낸 이유다.
   *
   * ## 상태 코드
   *
   * - `202` — 러너에게 넘겼다. **끝났다는 뜻이 아니다**: 하네스가 SIGTERM 을 정리하는
   *   시간이 있고, 끝의 증거는 그 턴이 스레드에 남기는 실패 카드다.
   * - `404 not_found` — 그런 세션이 없다. 누르는 사이에 턴이 스스로 끝난 것이 대부분이라
   *   화면은 이것을 실패로 그리지 않아야 한다(사람이 원한 결과와 같다).
   * - `409 no_runner` · `409 runner_outdated` — 보낼 길이 없다. 사유를 가르는 이유는
   *   사람이 할 일이 다르기 때문이다: 앞은 러너를 띄우는 것, 뒤는 러너를 새 버전으로
   *   올리는 것이다.
   *
   * 일괄 중단(스레드 하나 · 전부)을 위한 별도 문을 두지 않는다: 화면이 세션 목록을 이미
   * 갖고 있으므로 이 문을 여러 번 부르면 되고, 서버에 묶음 판정을 두면 "무엇이 한 묶음인가"
   * 가 두 곳(화면·서버)에서 갈린다.
   */
  app.post<{ Params: { id: string } }>('/agent-sessions/:id/cancel', {
    preHandler: app.requireAccount,
  }, async (req, reply) => {
    const account = req.account!;
    const session = hub.getSession(req.params.id);
    if (!session) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such session' } });
    }
    const verdict = await checkOwnerOrAdmin(pool, account, session.agentAccountId);
    if (!verdict.ok) {
      return reply.code(verdict.status).send({ error: { code: verdict.code, message: verdict.message } });
    }
    // **누가 눌렀는지를 러너에게 넘긴다.** 중단된 턴은 실패 카드에 이 이름을 적는다 —
    // 여럿이 같은 스레드를 보는 자리에서 "누가 멈췄나"는 다음 판단의 재료이고, 이름이
    // 없으면 그 카드는 에이전트가 스스로 고장난 것처럼 읽힌다.
    const outcome = hub.cancelSession(session.sessionId, account.handle);
    if (outcome === 'not_found') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such session' } });
    }
    if (outcome !== 'ok') {
      return reply.code(409).send({
        error: {
          code: outcome,
          message: outcome === 'no_runner'
            ? 'that agent has no runner attached — nothing can be signalled'
            : 'that runner is too old to stop a turn — update it',
        },
      });
    }
    /**
     * **중단은 위임 의무도 닫는다**(051). 이것이 없으면 중단된 턴의 의무는 기한이 지나야
     * `timeout` 으로 닫히고, 팀장은 10분 뒤에 "무응답"을 받아 **사람이 일부러 멈춘 일을
     * 다시 하려 든다** — 사람의 중단이 10분 뒤에 되돌려지는 셈이다.
     *
     * 깨울지는 방향에 따라 갈린다(그 판정은 `cancelDelegationsFor` 가 갖는다): 팀원을
     * 멈췄으면 팀장이 다음을 정해야 하므로 깨우고, **팀장을 멈췄으면 깨우지 않는다.**
     *
     * 스레드가 없으면 할 일이 없다 — 위임은 언제나 스레드에 걸린다(050).
     *
     * **중단 자체를 이 실패로 막지 않는다.** 러너에게는 이미 신호가 갔고(위 `cancelSession`),
     * 사람이 원한 것은 그 턴이 멈추는 것이다. 의무를 못 닫았으면 기한이 그 자리를 메운다 —
     * 늦은 대신 틀리지 않는다.
     */
    const wokeByCancel: string[] = [];
    if (session.threadRootId) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        wokeByCancel.push(...await cancelDelegationsFor(client, {
          threadRootId: session.threadRootId, accountId: session.agentAccountId,
        }));
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => {});
        console.error('[cancel] 위임 의무를 닫지 못했다(중단은 이미 보냈다):', err);
      } finally {
        client.release();
      }
      // 이벤트는 커밋 뒤다 — 러너는 이것을 보고 즉시 폴하므로, 앞에서 치면 아직 안 보이는
      // inbox 를 읽고 빈손으로 돌아간다(`postMessage` 가 같은 순서를 지킨다).
      for (const accountId of wokeByCancel) emitEvent({ type: 'inbox.updated', accountId });
    }

    // 감사에는 사건과 세션만(파일 머리 주석). 중단은 사람이 남의 일을 멈춘 것이라
    // attach 와 같은 무게로 남긴다.
    await recordAudit(pool, {
      action: 'agent.turn.canceled',
      ...actorOf(req),
      target: session.agentAccountId,
      detail: { sessionId: session.sessionId, channelId: session.channelId },
    }, req);
    return reply.code(202).send({ ok: true });
  });
  app.post<{ Params: { id: string } }>('/agent-sessions/:id/attach', {
    preHandler: app.requireAccount,
  }, async (req, reply) => {
    const account = req.account!;
    const session = hub.getSession(req.params.id);
    if (!session) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such session' } });
    }

    const verdict = await checkOwnerOrAdmin(pool, account, session.agentAccountId);
    if (!verdict.ok) {
      return reply.code(verdict.status).send({ error: { code: verdict.code, message: verdict.message } });
    }

    // 감사에는 사건과 세션만. 바이트는 넣지 않는다(파일 머리 주석).
    await recordAudit(pool, {
      action: 'agent.attached',
      ...actorOf(req),
      target: session.agentAccountId,
      detail: { sessionId: session.sessionId, channelId: session.channelId },
    }, req);

    // 티켓은 **attach 인가**만 운반한다. 쓰기 차례(지금 누가 writer 인가)는 티켓이 아니라
    // 허브가 산다(스펙 §5-2 결정 2 — 마지막 attach 가 writer, `ws/relay.ts::setWriter`).
    // 판정을 티켓에도 실으면 "누가 쓰는가"의 진실이 두 곳이 되고, 인가에서 그것은 조용히
    // 열리는 쪽으로 어긋난다. `verdict.via` 는 이제 여기서 읽지 않는다.
    return {
      ticket: attachTickets.issue({
        accountId: account.id,
        credentialHash: req.credentialHash!,
        sessionId: session.sessionId,
      }),
      session,
    };
  });

  /**
   * 사람이 스스로 인터랙티브 터미널을 연다(#337, 스펙 §5-2 결정 4). 진행 중인 턴이
   * 없어도 된다 — 러너가 세션을 확보(없으면 생성)해 인터랙티브 PTY 를 띄우고, 서버는
   * 그 세션의 attach 티켓을 준다. 인가는 attach 와 **같은 술어**(checkOwnerOrAdmin)다:
   * "내 에이전트의 셸을 여는" 행위이므로 붙어서 보는 것과 같은 사람만 할 수 있다.
   *
   * 스레드를 가리키는 것은 세션 id 가 아니라 (agentAccountId, channelId, threadRootId)
   * 셋이다 — 세션은 아직 없을 수 있고, 그때 만드는 것이 이 라우트의 존재 이유다.
   */
  app.post<{
    Body: { agentAccountId?: unknown; channelId?: unknown; threadRootId?: unknown };
  }>(
    '/agent-sessions/interactive',
    { preHandler: app.requireAccount },
    async (req, reply) => {
      const account = req.account!;
      const { agentAccountId, channelId, threadRootId } = req.body ?? {};
      if (typeof agentAccountId !== 'string' || typeof channelId !== 'string' || typeof threadRootId !== 'string') {
        return reply.code(400).send({
          error: { code: 'bad_request', message: 'agentAccountId, channelId, threadRootId 가 모두 필요하다' },
        });
      }

      const verdict = await checkOwnerOrAdmin(pool, account, agentAccountId);
      if (!verdict.ok) {
        return reply.code(verdict.status).send({ error: { code: verdict.code, message: verdict.message } });
      }

      const outcome = await hub.openInteractive(
        agentAccountId,
        { channelId, threadRootId, openedByHandle: account.handle },
        { timeoutMs: deps.interactiveOpenTimeoutMs },
      );
      if (!outcome.ok) {
        // 상태를 넷으로 가른다 — 화면이 이 문구를 그대로 사람에게 보여준다(docs/design.md
        // §4: 없는 것·못 한 것·거절된 것을 한 화면으로 뭉치지 않는다).
        switch (outcome.reason) {
          case 'no_runner':
            return reply.code(404).send({
              error: { code: 'no_runner', message: '러너가 접속해 있지 않다 — 이 에이전트의 러너를 먼저 띄워라' },
            });
          case 'runner_outdated':
            return reply.code(409).send({
              error: {
                code: 'runner_outdated',
                message: '러너가 인터랙티브 열기를 지원하지 않는 버전이다 — 러너를 업데이트해라',
              },
            });
          case 'runner_rejected':
            return reply.code(409).send({
              error: { code: 'interactive_rejected', message: outcome.message ?? '러너가 인터랙티브 열기를 거절했다' },
            });
          case 'runner_timeout':
            return reply.code(504).send({
              error: { code: 'runner_timeout', message: '러너가 제때 응답하지 않았다 — 러너 로그를 확인해라' },
            });
        }
      }

      // 같은 소켓의 `session.started` 가 `interactive.opened` 보다 먼저 처리되므로(순서
      // 보장) 여기서 세션 조회는 성립한다. 그래도 방어한다 — 러너가 started 를 빠뜨리는
      // 결함이 생기면 여기서 잡혀야지, 티켓만 받고 붙을 세션이 없는 화면이 되면 안 된다.
      const session = hub.getSession(outcome.sessionId);
      if (!session) {
        return reply.code(504).send({
          error: { code: 'runner_timeout', message: '러너가 세션을 등록하지 않았다 — 러너 로그를 확인해라' },
        });
      }

      // 셸을 여는 것은 관찰보다 강한 행위다 — attach 와 별도 액션으로 남긴다(§5-2 결정 4).
      await recordAudit(pool, {
        action: 'agent.interactive.opened',
        ...actorOf(req),
        target: agentAccountId,
        detail: { sessionId: session.sessionId, channelId, threadRootId, created: outcome.created },
      }, req);

      // 티켓 발급은 attach 와 동일 경로 — 인가를 이미 지났고, 소켓은 이 결정을 소모만 한다.
      return {
        ticket: attachTickets.issue({
          accountId: account.id,
          credentialHash: req.credentialHash!,
          sessionId: session.sessionId,
        }),
        session,
      };
    },
  );

  /**
   * 뷰어 소켓. 티켓만으로 인가된다 — 브라우저의 WebSocket 생성자는 헤더를 붙일 수 없어
   * 자격증명이 URL 로 갈 수밖에 없고, URL 은 앞단 프록시 로그에 남는다(ws/tickets.ts).
   *
   * **인바운드는 `input` 하나다**(#315 — 그전에는 없었다). 사람이 이 터미널에 타이핑해
   * 개입하는 것이 원 요청("터미널에 들어가서 작업하는 것과 동일하게")의 나머지 절반이다.
   *
   * 멘션 턴에도 허용한다: `mention_permission` 은 **에이전트가 스스로 넘지 못하는
   * 선이지 사람이 넘지 못하는 선이 아니다.** 사람이 앞에 앉아 있다는 것 자체가 그 권한의
   * 근거다. 그리고 **입력을 여는 것은 턴 모드를 바꾸는 것이 아니다** — 이 경로는 PTY 에
   * 바이트를 넣을 뿐, 그 턴의 `TurnMode` 도 `mention_permission` 도 건드리지 않는다.
   *
   * 쓰기 판정은 여기서 하지 않는다. writer 차례는 허브가 갖고(`ws/relay.ts::setWriter` —
   * 마지막 attach 가 writer, 스펙 §5-2 결정 2), 이 핸들러는 프레임을 핸들에 넘길 뿐이다.
   */
  app.get('/agent-attach', { websocket: true }, (socket, req) => {
    // Origin 을 티켓 소모보다 **먼저** 본다 — 거절할 연결이 1회용 티켓을 태우면, 사람이
    // 다시 열 때 인가를 한 번 더 받아야 하고 그 이유가 화면에 설명되지 않는다.
    if (!originAllowed(deps.allowedOrigins ?? null, req.headers.origin)) {
      socket.close(4403, 'origin not allowed');
      return;
    }
    const query = req.query as Record<string, string | undefined>;
    const ticket = query.ticket;
    const claim = ticket ? attachTickets.consume(ticket) : null;
    if (!claim) { socket.close(4401, 'unauthorized'); return; }

    const viewer = hub.addViewer(claim.sessionId, socket);
    // 자격증명이 죽으면 이 소켓도 닫힌다(위 `sweep` 주석).
    const untrack = sweep.track(socket, claim.credentialHash);

    // 파싱·writer 판정·포워딩·바이트 누계·resize 값 검증 전부 허브의 몫이다 — "누가
    // 지금 쓰는가"의 진실을 두 곳에 두지 않는다(#335 의 resize 도 같은 핸들을 탄다).
    // 입력의 감사는 아래 detach 행이 합산으로 남긴다.
    socket.on('message', (raw) => { viewer.handleMessage(String(raw)); });

    socket.on('close', () => {
      const inputBytes = viewer.inputBytes();
      viewer.close();
      untrack();
      // detach 도 남긴다 — attach 만 남기면 감사 조회에서 "지금 붙어 있는 사람"과
      // "붙었다 떠난 사람"이 구분되지 않는다.
      //
      // 개입 사실은 이 행의 `inputBytes` **합산 1회**로만 남는다(스펙 §5-2 결정 3).
      // 입력마다(또는 시간 창마다) 행을 쓰면 행 타임스탬프가 곧 키 입력의 리듬이라 그
      // 자체가 부채널이었다. 내용은 여전히 없다 — 수는 base64 길이 산술이다(허브 주석).
      // 서버가 detach 전에 죽으면 이 누계는 사라진다 — 릴레이 전체가 인메모리인 것과
      // 같은 수용이다(스펙 §5: 세션 레지스트리도 재시작이면 비워진다).
      void recordAudit(pool, {
        action: 'agent.detached',
        actorId: claim.accountId,
        actorHandle: null,
        target: null,
        detail: { sessionId: claim.sessionId, inputBytes },
      });
    });
  });
}
