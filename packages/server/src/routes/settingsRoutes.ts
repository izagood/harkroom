import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { RUNNABLE_HARNESSES, resolveProjectionUrl, type ProjectionConfigView } from '@murmur/shared';
import { getAgentDefaults, updateAgentDefaults } from '../services/agentDefaults.js';
import { getProjectionConfig, setProjectionConfig } from '../services/projectionConfig.js';
import { recordAudit } from '../audit.js';

/**
 * `z.string().url()` 만으로는 `file:`·`ftp:` 가 통과한다. 그것을 서버의 아웃바운드 대상으로
 * 두면 avcs 가 아닌 것을 투영하려 든다. 그래서 프로토콜까지 본다.
 *
 * 후행 슬래시는 정규화하지 않는다 — `httpAvcsClient` 가 이미 자른다(`client.ts:162`).
 * 두 곳에서 자르면 어느 쪽이 진실인지가 흐려진다.
 */
const PROJECTION_URL = z.string().min(1).max(512).refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'http(s) URL 이어야 한다');

/**
 * 워크스페이스 설정. 새 에이전트의 기본값(#171)과 투영 URL(설계 §5) 두 갈래다.
 *
 * 읽기도 `requireAdmin` 인 이유: 이 저장소의 에이전트 관리 라우트가 전부 그렇다
 * (`accountRoutes.ts` 의 `/accounts/agents*`). 기본값은 그 에이전트들의 **정의에 준하는
 * 상태**이므로 같은 게이트를 쓴다. 투영 URL 도 마찬가지다 — 인프라 설정이라 상태
 * (`/projection/status`, requireAccount)와 다른 표면으로 둔다.
 */
export async function registerSettingsRoutes(
  app: FastifyInstance,
  pool: Pool,
  projection?: {
    envBaseUrl: string | null;
    reconfigure(url: string | null): Promise<void>;
  },
): Promise<void> {
  app.get('/settings/agent-defaults', { preHandler: app.requireAdmin }, async () => (
    getAgentDefaults(pool)
  ));

  app.put('/settings/agent-defaults', { preHandler: app.requireAdmin }, async (req) => {
    // harness 검증을 `RUNNABLE_HARNESSES` 로 좁히는 것은 에이전트 생성·수정과 같은 규칙이다
    // (#83). 실행할 수 없는 harness 를 기본값으로 두면 그 뒤 만드는 에이전트가 전부 못 돈다.
    //
    // model·effort 는 `.nullable()` 이다 — **지우기는 명시적 null 이다.** 키를 빼는 것으로
    // 지우기를 표현하면 `JSON.stringify` 가 `undefined` 를 버리는 것과 구분되지 않아,
    // 지우려는 조작이 '손대지 않음'으로 조용히 바뀐다.
    const body = z.object({
      harness: z.enum(RUNNABLE_HARNESSES).optional(),
      model: z.string().max(64).nullable().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
    }).parse(req.body);

    const before = await getAgentDefaults(pool);
    const after = await updateAgentDefaults(pool, body);
    // 감사에 값을 그대로 남긴다 — harness·model·effort 는 비밀이 아니고, "누가 다음
    // 에이전트들의 서식을 바꿨나" 가 이 기록의 존재 이유다.
    await recordAudit(pool, {
      action: 'agent.defaults.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
      detail: { before, after },
    }, req);
    return after;
  });

  // 이 표면 없이 뜨는 서버가 많다(테스트 대부분). 없으면 등록하지 않는다.
  if (!projection) return;

  /** 응답 한 벌. 판정은 `resolveProjectionUrl` 이 하고 이 함수는 재료를 모을 뿐이다. */
  const view = async (): Promise<ProjectionConfigView> => {
    const appUrl = await getProjectionConfig(pool);
    const { url, source } = resolveProjectionUrl(projection.envBaseUrl, appUrl);
    return { url, source, appUrl, envUrl: projection.envBaseUrl };
  };

  app.get('/settings/projection', { preHandler: app.requireAdmin }, view);

  app.put('/settings/projection', { preHandler: app.requireAdmin }, async (req) => {
    // 지우기는 **명시적 null** 이다. 키를 빼는 것으로 표현하면 `JSON.stringify` 가
    // `undefined` 를 버리는 것과 구분되지 않아 지우려는 조작이 '손대지 않음'이 된다.
    const body = z.object({ url: PROJECTION_URL.nullable() }).parse(req.body);

    const before = await view();
    await setProjectionConfig(pool, body.url);
    const after = await view();
    // **부름의 결과가 아니라 판정의 결과로 재설정한다.** body.url 로 부르면 지우기
    // (null)가 '투영을 끈다' 가 되어 env 로 복귀하지 않는다.
    await projection.reconfigure(after.url);
    await recordAudit(pool, {
      action: 'projection.url.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
      detail: {
        before: { appUrl: before.appUrl, source: before.source },
        after: { appUrl: after.appUrl, source: after.source },
      },
    }, req);
    return after;
  });
}
