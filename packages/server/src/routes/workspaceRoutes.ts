import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { emitEvent } from '../events.js';
import { recordAudit } from '../audit.js';
import { detectAvatarType, findAvatarSource } from '../services/avatars.js';
import { findWorkspaceIcon, getWorkspaceIconId, setWorkspaceIcon } from '../services/workspaceProfile.js';
import type { StorageBackend } from '../storage/local.js';

/**
 * 워크스페이스 아이콘 — 데스크탑 커뮤니티 레일의 사진(2026-09-29).
 *
 * 프로필 사진(#159, `avatarRoutes.ts`)의 길을 그대로 탄다:
 * - 파일은 기존 `POST /uploads` 로 올라오고, 여기서는 그 업로드 하나를 워크스페이스에 잇기만
 *   한다. 파일 저장소가 둘이면 백업 순서 규칙도 둘이 된다.
 * - 판정은 `detectAvatarType` 하나다(매직 바이트 + SVG 상한·스크립트 검사). 판정을 두 벌 두면
 *   한쪽만 넓어진다(#253·#299·#315).
 * - 읽기는 전용 라우트다. `GET /attachments/:id` 는 메시지에 붙지 않은 업로드를 올린 사람에게만
 *   내주므로, 아이콘도 아바타처럼 그 검사에 걸려 다른 멤버가 403 을 받는다.
 *
 * **바꾸기는 `requireAdmin`** 이다. Slack 워크스페이스 아이콘과 같다 — 모든 멤버의 화면에 걸리는
 * 얼굴이라 워크스페이스 설정(`settingsRoutes.ts`)과 같은 게이트를 쓴다. 읽기는 멤버 전원이다.
 */
export async function registerWorkspaceRoutes(
  app: FastifyInstance, pool: Pool, storage: StorageBackend,
): Promise<void> {
  app.put('/settings/workspace-icon', { preHandler: app.requireAdmin }, async (req, reply) => {
    // 아바타 라우트와 같은 이유로 키를 **필수**로 둔다 — 지우기를 `undefined` 로 표현하면
    // `JSON.stringify` 가 그 키를 버려 지우기가 조용히 무시된다. 지우기는 명시적 null 이다.
    const body = z.object({ attachmentId: z.string().uuid().nullable() }).parse(req.body);
    const me = req.account!;
    const before = await getWorkspaceIconId(pool);

    if (body.attachmentId !== null) {
      // 남의 업로드를 워크스페이스 얼굴로 거는 것은 막는다 — 조회를 요청자 자신으로 좁힌다.
      const source = await findAvatarSource(pool, body.attachmentId, me.id);
      if (!source) {
        return reply.code(404).send({
          error: { code: 'not_found', message: 'no unattached upload of yours with that id' },
        });
      }
      const detected = await detectAvatarType(storage, source);
      if (!detected.type) return reply.code(400).send({ error: detected.error });
      await setWorkspaceIcon(pool, { attachmentId: source.id, contentType: detected.type });
    } else {
      await setWorkspaceIcon(pool, null);
    }

    emitEvent({ type: 'workspace.icon.changed', iconAttachmentId: body.attachmentId });
    await recordAudit(pool, {
      action: 'workspace.icon.updated', actorId: me.id, actorHandle: me.handle,
      detail: { before, after: body.attachmentId },
    }, req);
    return { iconAttachmentId: body.attachmentId };
  });

  app.get('/workspace/icon', { preHandler: app.requireAccount }, async (_req, reply) => {
    const icon = await findWorkspaceIcon(pool);
    if (!icon) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no workspace icon' } });
    }
    const body = await storage.read(icon.storageKey);
    return reply
      // 아바타 라우트와 같은 방어 — inline 으로 내주지 않는다. 클라이언트는 blob 으로 그린다.
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'attachment')
      .header('content-length', String(icon.sizeBytes))
      // 받는 쪽이 캐시를 이 id 로 무효화한다. 바이트를 다시 받지 않고 바뀌었는지 가를 수 있다.
      .header('etag', `"${icon.attachmentId}"`)
      .type(icon.contentType)
      .send(body);
  });
}
