// 모바일 푸시 1단계: 디바이스 토큰 등록·해제(092). 설계 harkroom://message/80130503-ca6c-4873-8bfe-3084ee182052
// 와 security 반영본 harkroom://message/9e6faa09-2be1-4eb6-b5c6-f3d142ef0a10 을 따른다.
// 이 PR 은 저장만 한다. 발송은 다음 PR 이다.
//
// **사람의 로그인 세션에만 열린다**(security G3). PAT 은 에이전트의 것이고, 오퍼레이터 토큰은
// `X-Harkroom-Agent` 로 에이전트가 되어 선다. 어느 쪽도 "사람이 들고 다니는 폰"이 아니다.
// `credentialHash` 는 세 경로가 똑같이 채우므로 `authVia` 표지를 보고, 계정 종류도 **함께** 본다.
// 세션 FK 가 PAT 해시를 거절해 500 이 나는 데 기대지 않는다. 그건 거절이 아니라 사고다.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';

/** 계정당 기기 상한. 넘으면 가장 오래 등록하지 않은 기기부터 지운다(security 덧). */
export const PUSH_DEVICES_PER_ACCOUNT = 20;

/**
 * 기본값: 사람에게 오는 사유는 다 켠다(데스크톱 알림 기본값과 같다). **본문 미리보기는 끈다**
 * (결정 3) — APNs 페이로드는 Apple 을 지나고 잠금 화면에 뜬다. 켜는 것은 기기 주인의 옵트인이다.
 */
export const DEFAULT_PUSH_PREFS = { mention: true, dm: true, threadReply: true, ask: true, preview: false, badge: true } as const;

const prefsInput = z.object({
  mention: z.boolean(), dm: z.boolean(), threadReply: z.boolean(), ask: z.boolean(), preview: z.boolean(),
  /**
   * 아이콘 배지를 이 서버가 정할지(기본 켬). 기기에 커뮤니티가 둘 이상이면 앱이 끈다 — 서버는 자기 미읽음만
   * 세므로, 배경에서 이 서버의 알림이 오면 배지가 합계보다 **줄어든다**(designer #1087). 끄면 페이로드에
   * `badge` 를 싣지 않고, 앱이 앞에 올 때 합계로 적는다.
   */
  badge: z.boolean(),
}).partial().strict();

const deviceInput = z.object({
  /**
   * APNs 기기 토큰. 지금은 32바이트(hex 64자)지만 Apple 은 길이를 약속하지 않는다 — 상한을 넉넉히
   * 두되 hex 만 받는다. 이 값이 다음 PR 에서 APNs 요청 경로(`/3/device/<token>`)에 들어가므로
   * 형식을 여기서 못 박는다. 대문자는 소문자로 고쳐 같은 토큰이 두 행이 되지 않게 한다.
   */
  token: z.string().regex(/^[0-9a-fA-F]{64,200}$/).transform((t) => t.toLowerCase()),
  platform: z.literal('ios'),
  env: z.enum(['production', 'sandbox']),
  prefs: prefsInput.optional(),
}).strict();

type PushPrefs = { [K in keyof typeof DEFAULT_PUSH_PREFS]: boolean };

interface DeviceRow {
  id: string; platform: 'ios'; env: 'production' | 'sandbox'; prefs: PushPrefs; createdAt: Date; lastSeenAt: Date;
}

/**
 * 응답 모양. **토큰·세션 해시·발송 오류는 싣지 않는다**(security 덧) — 기기는 자기 토큰을 이미
 * 알고, 세션 해시는 자격증명의 파생값이다.
 */
function view(row: DeviceRow) {
  return {
    id: row.id, platform: row.platform, env: row.env, prefs: row.prefs,
    createdAt: row.createdAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

const RETURNING = `id, platform, apns_env as env, prefs, created_at as "createdAt", last_seen_at as "lastSeenAt"`;

export async function registerPushRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const requireHumanSession = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.account) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'authentication required' } });
      return;
    }
    if (req.authVia !== 'session' || req.account.kind !== 'human' || !req.credentialHash) {
      await reply.code(403).send({
        error: { code: 'push_session_only', message: '푸시 기기는 사람의 로그인 세션으로만 등록한다' },
      });
    }
  };

  /**
   * 등록(또는 다시 등록). 같은 (token, 계정)이 있으면 **지금 세션으로 옮긴다** — 다시 로그인한 폰은
   * 새 세션을 들고 오고, 옛 세션에 묶인 채 두면 그 세션이 지워지는 순간 살아 있는 기기의 행이
   * 사라진다. prefs 는 보낸 키만 바꾸고 나머지는 지금 값(새 행이면 기본값)을 둔다.
   *
   * 남의 토큰을 내 계정에 등록하는 것은 막지 않는다 — 그래 봐야 그 기기에 **내** 알림이 갈 뿐
   * 정보가 새지 않고, 토큰은 쉽게 얻는 값이 아니다(security 판정 1). 남이 내 계정에 등록하려면
   * 내 세션이 있어야 한다.
   */
  app.put('/push/devices', { preHandler: requireHumanSession }, async (req) => {
    const body = deviceInput.parse(req.body);
    const accountId = req.account!.id;
    const client = await pool.connect();
    try {
      await client.query('begin');
      const before = await client.query<{ prefs: PushPrefs }>(
        `select prefs from push_device where token = $1 and account_id = $2 for update`, [body.token, accountId]);
      const prefs: PushPrefs = { ...DEFAULT_PUSH_PREFS, ...(before.rows[0]?.prefs ?? {}), ...(body.prefs ?? {}) };
      const res = await client.query<DeviceRow>(
        `insert into push_device (account_id, session_token_hash, platform, apns_env, token, prefs)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (token, account_id) do update
           set session_token_hash = excluded.session_token_hash, platform = excluded.platform,
               apns_env = excluded.apns_env, prefs = excluded.prefs, last_seen_at = now()
         returning ${RETURNING}`,
        [accountId, req.credentialHash, body.platform, body.env, body.token, JSON.stringify(prefs)],
      );
      // 상한: 방금 등록한 것은 last_seen_at 이 가장 새로우므로 남는다.
      await client.query(
        `delete from push_device where account_id = $1 and id not in (
           select id from push_device where account_id = $1 order by last_seen_at desc, id limit $2)`,
        [accountId, PUSH_DEVICES_PER_ACCOUNT],
      );
      await client.query('commit');
      return view(res.rows[0]!);
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  });

  /**
   * 이 기기에서 푸시를 끈다 — **지금 세션에 묶인 행만** 지운다. 토큰을 받지 않는 이유: 받으면
   * 남의 토큰을 아는 사람이 그 기기의 등록을 지우는 길이 생긴다(같은 계정 안이라도 다른 기기다).
   * 로그아웃은 이 라우트를 부를 필요가 없다 — 세션이 지워지면 cascade 로 함께 사라진다.
   */
  app.delete('/push/devices/current', { preHandler: requireHumanSession }, async (req, reply) => {
    await pool.query(
      `delete from push_device where session_token_hash = $1 and account_id = $2`,
      [req.credentialHash, req.account!.id],
    );
    return reply.code(204).send();
  });
}
