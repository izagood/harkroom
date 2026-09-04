import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AccountView } from '@murmur/shared';
import { hashToken } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    account: AccountView | null;
    /** 이 요청을 인증한 자격증명의 해시. WS 티켓이 운반해 소켓 수명을 자격증명에 묶는다. */
    credentialHash: string | null;
  }
  interface FastifyInstance {
    requireAccount: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOwnerOrAdmin: (paramName: string) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// 상태는 여기서 함께 읽는다 — `/auth/me` 가 `req.account` 를 그대로 돌려주므로,
// 빠뜨리면 내가 방금 정한 상태가 내 화면에만 안 보인다.
const ACCOUNT_COLS = `a.id, a.handle, a.display_name as "displayName", a.kind, a.is_admin as "isAdmin",
  a.status, a.status_text as "statusText", a.avatar_attachment_id as "avatarAttachmentId"`;

export async function registerAuth(app: FastifyInstance, pool: Pool): Promise<void> {
  app.decorateRequest('account', null);
  app.decorateRequest('credentialHash', null);

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const hash = hashToken(header.slice('Bearer '.length));
    const viaSession = await pool.query(
      `select ${ACCOUNT_COLS} from session s join account a on a.id = s.account_id
       where s.token_hash = $1 and s.expires_at > now()`, [hash]);
    if (viaSession.rowCount) { req.account = viaSession.rows[0]; req.credentialHash = hash; return; }
    const viaPat = await pool.query(
      `select ${ACCOUNT_COLS} from pat p join account a on a.id = p.account_id
       where p.token_hash = $1 and p.revoked_at is null`, [hash]);
    if (viaPat.rowCount) { req.account = viaPat.rows[0]; req.credentialHash = hash; }
  });

  app.decorate('requireAccount', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.account) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'authentication required' } });
    }
  });

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.account?.isAdmin) {
      await reply.code(403).send({ error: { code: 'forbidden', message: 'admin required' } });
    }
  });

  app.decorate('requireOwnerOrAdmin', (paramName: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.account) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'authentication required' } });
      return;
    }

    // 어느 파라미터가 대상 에이전트인지는 라우트마다 다르다(`:id` 인 곳과 `:agentId` 인
    // 곳이 있다) — 그래서 술어가 이름을 인자로 받는다.
    const paramValue = (req.params as Record<string, string>)[paramName];
    if (!paramValue) {
      await reply.code(400).send({ error: { code: 'bad_request', message: `param '${paramName}' not found` } });
      return;
    }

    const verdict = await checkOwnerOrAdmin(pool, req.account, paramValue);
    if (!verdict.ok) {
      await reply.code(verdict.status).send({ error: { code: verdict.code, message: verdict.message } });
    }
  });
}

/**
 * 인가 판정 결과. 거절은 그대로 응답이 되도록 상태·코드·문구를 함께 들고 온다.
 *
 * `via` 는 **무슨 자격으로** 통과했는지다(#315). 터미널 입력은 소유자만 허용하고 admin 은
 * 읽기 전용인데, 그 구분을 부르는 쪽에서 다시 계산하면 판정이 두 벌이 된다 — 이 저장소에서
 * 판정 복제가 반복해서 결함을 만들었고(#253 이 이 술어를 "이 파일에 하나만" 으로 못박은
 * 이유), 인가에서 사본은 조용히 열리는 쪽으로 어긋난다. 술어는 이미 두 사실을 다 알고
 * 있었으므로 새 술어를 만들지 않고 **알던 것을 돌려주게만** 했다.
 *
 * **`'owner'` 는 소유자 자격을 우선해서 읽은 값이다.** 요청자가 admin 이면서 동시에 그
 * 에이전트의 소유자면 `'owner'` 다 — `'admin'` 은 "소유자가 아닌데 admin 이라 통과했다"만
 * 뜻한다. 이 우선순위가 없으면 admin 이 만든(그래서 admin 이 소유한) 에이전트는 칠 수
 * 있는 사람이 하나도 없어진다. 아래 함수의 분기 순서가 이 문장을 지킨다.
 */
export type OwnerVerdict =
  | { ok: true; via: 'owner' | 'admin' }
  | { ok: false; status: 403; code: 'forbidden'; message: string }
  | { ok: false; status: 404; code: 'not_found'; message: string };

/**
 * 소유자 기반 인가 술어 — **이 파일에 하나만 둔다**(#253).
 *
 * `requireOwnerOrAdmin` preHandler 와, 필드별로 게이트가 갈려서 preHandler 로는 표현할 수
 * 없는 `PATCH /accounts/agents/:id` 가 **같은 이 함수**를 부른다. 판정을 두 곳에 복사하면
 * 한쪽만 고치는 사고가 난다 — 인가에서 그것은 조용히 열리는 쪽으로 어긋난다.
 *
 * 판정: 요청자가 admin 이거나, 대상 에이전트의 `agent_config.owner_account_id` 와 같다.
 *
 * **소유자가 없는 에이전트(`null`)는 admin 만이다.** 마이그레이션 `008` 이 기존 에이전트에
 * backfill 을 넣지 않은 것은 의도였다 — 그래서 `null` 은 "아무나"가 아니라 "아직 아무도"다.
 * `null` 을 "일치"로 읽으면 소유자를 지정하지 않은 모든 에이전트의 PAT 가 워크스페이스
 * 전체에 열린다. 아래 분기를 **명시적으로** 두는 이유가 이것이다: 이어지는 `!==` 비교도
 * 지금은 `null` 을 걸러 내지만, 그 비교가 언젠가 느슨해지거나(`==`, `?? ''`) 요청자 쪽
 * 값이 비게 되면 조용히 통과한다. 판정의 근거를 비교의 부산물로 두지 않는다.
 */
export async function checkOwnerOrAdmin(
  pool: Pool,
  account: AccountView,
  agentAccountId: string,
): Promise<OwnerVerdict> {
  // `left join` 이라 계정은 있는데 agent_config 가 없는 경우(사람 계정)도 한 행으로 온다 —
  // 그때 owner_account_id 는 null 이고, 아래 null 분기가 admin 만으로 좁힌다.
  //
  // **admin 이어도 이 조회를 건너뛰지 않는다**(#315). 예전에는 `isAdmin` 하나로 즉시
  // 통과시켰는데, 그러면 admin 이 소유한 에이전트에서 `via` 가 항상 `'admin'` 이 되어
  // "소유자인가"를 물을 수 없다. 그리고 에이전트를 만들 수 있는 것은 admin 뿐이고 만든
  // 사람이 그대로 소유자가 되므로(`services/agents.ts::createAgentAccount`), 그 상태가
  // 새 에이전트의 **기본값**이다 — 즉 지름길이 있으면 갓 만든 에이전트의 터미널에 칠 수
  // 있는 사람이 한 명도 없다. 조회 한 번이 그 값을 정확하게 만드는 값이다.
  const res = await pool.query<{ owner_account_id: string | null }>(
    `select c.owner_account_id from account a left join agent_config c on c.account_id = a.id where a.id = $1`,
    [agentAccountId],
  );
  if (!res.rowCount) {
    // 대상이 없다. admin 은 **예전과 똑같이** 통과하고(존재 여부는 라우트가 404 로 답한다),
    // 그 외에는 404 다 — 이 함수가 존재 여부를 흘리는 유일한 자리이므로 admin 에게만 연다.
    if (account.isAdmin) return { ok: true, via: 'admin' };
    return { ok: false, status: 404, code: 'not_found', message: 'no such agent' };
  }

  const ownerAccountId = res.rows[0]!.owner_account_id;
  // **소유자 판정이 admin 판정보다 앞이다.** 둘 다인 사람은 `'owner'` 로 읽는다(위 주석).
  // `null` 을 명시적으로 걸러 내는 이유는 아래 분기 주석과 같다 — 소유자가 없는 에이전트에
  // 계정 id 가 우연히 비어 오는 일이 생겨도 "일치"가 되면 안 된다.
  if (ownerAccountId !== null && ownerAccountId === account.id) return { ok: true, via: 'owner' };
  if (account.isAdmin) return { ok: true, via: 'admin' };
  if (ownerAccountId === null) {
    return { ok: false, status: 403, code: 'forbidden', message: 'owner required — this agent has no owner' };
  }
  return { ok: false, status: 403, code: 'forbidden', message: 'owner or admin required' };
}
