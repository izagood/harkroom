import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { emitEvent } from '../events.js';
import {
  findAvatarSource, findAvatarTarget, IMAGE_HEAD_BYTES, readHead, setAccountAvatar, sniffImageType,
} from '../services/avatars.js';
import type { StorageBackend } from '../storage/local.js';

/**
 * 계정 프로필 사진(#159).
 *
 * **업로드 경로를 새로 만들지 않는다.** 파일은 기존 `POST /uploads` 로 올라오고(파일 먼저·행
 * 나중, 크기 제한, 잘린 스트림 거부), 여기서는 그 업로드 하나를 계정에 잇기만 한다. 파일
 * 저장소가 둘이면 백업 순서 규칙도 둘이 되고, 하나를 빠뜨리면 복구 뒤에 깨진 아바타가 남는다.
 *
 * **읽기는 전용 라우트다.** `GET /attachments/:id` 는 메시지에 붙지 않은 업로드를 올린
 * 사람에게만 내준다(게시 전 초안이 새는 경로를 막는 검사다). 아바타는 영원히 메시지에 붙지
 * 않으므로 그 검사에 정면으로 걸려 **다른 모든 계정이 403 을 받는다** — 자기에게만 보이는
 * 아바타는 기능이 아니다. 그 검사 안에 'public 예외'를 넣는 대신 여기 라우트를 따로 둔다:
 * 유출을 막으려고 존재하는 검사에 예외를 하나 뚫으면, `NEVER_INLINE` 주석이 말한 것과 같은
 * 종류의 위험(예외가 통로가 된다)이 ACL 쪽에서 반복된다.
 */
export async function registerAvatarRoutes(
  app: FastifyInstance, pool: Pool, storage: StorageBackend,
): Promise<void> {
  app.put('/accounts/me/avatar', { preHandler: app.requireAccount }, async (req, reply) => {
    const body = z.object({
      // 키를 **필수**로 둔다. 지우기를 `undefined` 로 표현하면 `JSON.stringify` 가 그 키를
      // 버려 조작이 조용히 무시된다 — 사용자는 지웠다고 믿는데 사진이 그대로 남는다.
      // 그래서 지우기는 명시적 `null` 이고, 키가 아예 없는 요청은 400 이다.
      attachmentId: z.string().uuid().nullable(),
    }).parse(req.body);
    const me = req.account!;

    if (body.attachmentId === null) {
      await setAccountAvatar(pool, me.id, null);
      emitEvent({ type: 'avatar.changed', accountId: me.id, avatarAttachmentId: null });
      return { avatarAttachmentId: null };
    }

    // 대상 id 를 받지 않는다 — `me` 하나뿐이다. 남의 아바타를 바꾸는 경로는 만들지 않는다.
    // 그래도 남의 **업로드**를 자기 얼굴로 거는 것은 막아야 하므로, 조회를 업로더로 좁힌다.
    const source = await findAvatarSource(pool, body.attachmentId, me.id);
    if (!source) {
      return reply.code(404).send({
        error: { code: 'not_found', message: 'no unattached upload of yours with that id' },
      });
    }

    const type = sniffImageType(await readHead(storage, source.storageKey, IMAGE_HEAD_BYTES));
    if (!type) {
      // 아무것도 걸지 않고 돌아간다. 첨부 행은 남긴다 — 지우는 것은 고아 업로드 GC 의 일이고,
      // 여기서 지우면 같은 파일을 다른 용도로 쓰려던 요청까지 함께 날린다.
      return reply.code(400).send({
        error: { code: 'not_an_image', message: 'avatar must be a png, jpeg, gif, webp, or avif image' },
      });
    }

    await setAccountAvatar(pool, me.id, { attachmentId: source.id, contentType: type });
    emitEvent({ type: 'avatar.changed', accountId: me.id, avatarAttachmentId: source.id });
    return { avatarAttachmentId: source.id };
  });

  app.get('/accounts/:id/avatar', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const target = await findAvatarTarget(pool, id);
    if (!target) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no avatar' } });
    }

    const body = await storage.read(target.storageKey);
    return reply
      // 첨부 라우트와 같은 방어를 그대로 유지한다. `contentType` 은 설정 시점에 매직 바이트로
      // 판정해 덮어쓴 값이지만, 그렇다고 inline 으로 내주지는 않는다 — 클라이언트는 받은
      // 바이트로 blob 을 만들어 그린다(`Attachments.tsx` 의 선례). 예외를 하나 두면 그
      // 예외가 통로가 된다.
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'attachment')
      .header('content-length', String(target.sizeBytes))
      .type(target.contentType)
      .send(body);
  });
}
