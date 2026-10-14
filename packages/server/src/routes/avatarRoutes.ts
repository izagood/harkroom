import { AVATAR_SOURCE_HEADER, type AvatarSourceMeta } from '@harkroom/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { checkOwnerOrAdmin } from '../auth/plugin.js';
import { emitEvent } from '../events.js';
import {
  currentAvatarIds, detectAvatarType, findAvatarOriginal, releaseAvatarFiles, findAvatarSource, findAvatarSourceTarget, findAvatarTarget,
  setAccountAvatar, type AvatarSetting,
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
/**
 * 비율 하나. 원본 크기에 대한 비율이라 0~1 이다(`AvatarCrop`). 유한수만 — `NaN`·`Infinity` 는 JSON 으로 오지
 * 않지만, 오면 다시 맞출 때 화면이 빈 원을 그린다.
 */
const ratio = z.number().finite().min(0).max(1);

const avatarBody = z.object({
  // 키를 **필수**로 둔다. 지우기를 `undefined` 로 표현하면 `JSON.stringify` 가 그 키를
  // 버려 조작이 조용히 무시된다 — 사용자는 지웠다고 믿는데 사진이 그대로 남는다.
  // 그래서 지우기는 명시적 `null` 이고, 키가 아예 없는 요청은 400 이다.
  attachmentId: z.string().uuid().nullable(),
  // 사진 맞추기(S1): 잘라 올린 아바타의 **원본**과 고른 자리. 옛 앱은 보내지 않는다 — 그때는 원본 칸을 비운다.
  source: z.object({
    attachmentId: z.string().uuid(),
    crop: z.object({ x: ratio, y: ratio, size: ratio.gt(0) }),
  }).nullable().optional(),
});

/**
 * 두 PUT 라우트(`me`·에이전트)가 같은 걸음을 한다 — 판정을 양쪽에 한 벌씩 두면 한쪽만 넓어지고, 이 저장소에서
 * 판정 복제가 반복해 결함을 만들었다(#253·#299·#315). 다른 것은 **대상 계정**과 인가뿐이고 인가는 라우트가 한다.
 */
async function applyAvatar(
  pool: Pool, storage: StorageBackend, reply: FastifyReply,
  targetId: string, uploaderId: string, raw: unknown,
  log?: { warn(obj: unknown, msg: string): void },
) {
  const body = avatarBody.parse(raw);
  // 바꾸기 전의 사진 둘 — 바꾼 뒤 아무도 안 가리키면 지운다(후속 ②). 새 값과 같은 id 는 아직 쓰이니 저절로 남는다.
  const previous = await currentAvatarIds(pool, targetId);
  if (body.attachmentId === null) {
    await setAccountAvatar(pool, targetId, null);
    emitEvent({ type: 'avatar.changed', accountId: targetId, avatarAttachmentId: null });
    await releaseAvatarFiles(pool, storage, previous, log);
    return { avatarAttachmentId: null };
  }

  // 남의 업로드를 자기 얼굴로 거는 것은 막아야 하므로, 조회를 업로더(요청자 자신)로 좁힌다.
  const found = await findAvatarSource(pool, body.attachmentId, uploaderId);
  if (!found) {
    return reply.code(404).send({
      error: { code: 'not_found', message: 'no unattached upload of yours with that id' },
    });
  }

  const detected = await detectAvatarType(storage, found);
  if (!detected.type) {
    // 아무것도 걸지 않고 돌아간다. 첨부 행은 남긴다 — 지우는 것은 고아 업로드 GC 의 일이고,
    // 여기서 지우면 같은 파일을 다른 용도로 쓰려던 요청까지 함께 날린다.
    //
    // 코드·문구는 판정한 자리(`avatars.ts`)가 정한다. 여기서 하나로 뭉개면 화면이
    // 이유별로 다른 말을 할 수 없다.
    return reply.code(400).send({ error: detected.error });
  }

  const setting: AvatarSetting = { attachmentId: found.id, contentType: detected.type, source: null };
  if (body.source) {
    // 원본도 같은 판정을 지난다 — 다시 맞출 때 `<img>` 로 그려지는 바이트다. 원본이 거절되면 **아바타도
    // 걸지 않는다**: 반쯤 걸린 상태(새 아바타 + 옛 원본)는 다음 맞추기에서 엉뚱한 사진을 연다.
    const original = await findAvatarOriginal(pool, body.source.attachmentId, uploaderId, targetId);
    if (!original) {
      return reply.code(404).send({
        error: { code: 'source_not_found', message: 'no usable original with that id' },
      });
    }
    // 원본은 데스크톱이 다시 맞출 때만 푼다 — 폰 원본 사진이 지나게 넉넉한 상한(`AVATAR_PIXEL_LIMITS.original`).
    const originalType = await detectAvatarType(storage, original, 'original');
    if (!originalType.type) return reply.code(400).send({ error: originalType.error });
    setting.source = { attachmentId: original.id, contentType: originalType.type, crop: body.source.crop };
  }

  await setAccountAvatar(pool, targetId, setting);
  emitEvent({ type: 'avatar.changed', accountId: targetId, avatarAttachmentId: found.id });
  await releaseAvatarFiles(pool, storage, previous, log);
  return { avatarAttachmentId: found.id };
}

export async function registerAvatarRoutes(
  app: FastifyInstance, pool: Pool, storage: StorageBackend,
): Promise<void> {
  app.put('/accounts/me/avatar', { preHandler: app.requireAccount }, async (req, reply) => {
    // 대상 id 를 받지 않는다 — `me` 하나뿐이다. 남의 아바타를 바꾸는 경로는 만들지 않는다.
    const me = req.account!;
    return applyAvatar(pool, storage, reply, me.id, me.id, req.body, req.log);
  });

  /**
   * 에이전트의 사진(identity 문서 Task 15-4).
   *
   * 위 `me` 라우트의 주석은 "남의 아바타를 바꾸는 경로는 만들지 않는다"고 적었고, 그것은
   * **사람 계정에 대해서는 여전히 참이다.** 에이전트는 다르다 — 자기 사진을 올릴 손이 없고,
   * 소유자가 대신 올려 주지 않으면 영원히 색 하나로 남는다.
   *
   * 문서가 이 화면의 성패를 여기에 걸었다: *"결국 이 화면의 성패는 사람이 사진을 올리게
   * 만드는 것에 달린다."* `handleColor()` 의 12색은 26개 밀도에서 이미 시끄럽고, 색은
   * **사진이 없을 때의 임시값**이라는 뜻이기 때문이다.
   *
   * **인가 술어를 새로 만들지 않는다.** `requireOwnerOrAdmin` 이 그 판정의 유일한 자리이고
   * (`auth/plugin.ts`), 여기서 다시 쓰면 판정이 두 벌이 된다 — 이 저장소에서 판정 복제가
   * 반복해서 결함을 만들었다(#253·#299·#315).
   *
   * 업로더 검사는 그대로 **요청자 자신**으로 좁힌다: 소유자가 자기 업로드를 자기 에이전트에
   * 거는 것이지, 남의 업로드를 가져다 거는 것이 아니다.
   */
  app.put('/accounts/agents/:id/avatar', { preHandler: app.requireOwnerOrAdmin('id') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const me = req.account!;

    // **대상이 이 서버의 에이전트인지 먼저 본다.** `requireOwnerOrAdmin` 은 없는 id 에도 admin 을
    // 통과시키고 "존재 여부는 라우트가 404 로 답한다"고 적어 두었는데, 이 라우트는 답하지 않았다 —
    // 그래서 아래 `update` 가 0행을 고치고도 200 을 냈다. 데스크톱이 다른 커뮤니티의 에이전트 id 로
    // 이 서버를 부르면(설정 화면이 열린 채 커뮤니티가 바뀐 경우) 화면은 "사진을 바꿨습니다"를
    // 띄우는데 어느 서버에도 사진이 없다(2026-10-02 task_manager 신고).
    // 지운 에이전트도 대상이 아니다 — delegates 라우트(accountRoutes.ts)와 같은 조건.
    const target = await pool.query(
      `select 1 from account where id = $1 and kind = 'agent' and deleted_at is null`, [id],
    );
    if (!target.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
    }

    // 업로더 검사는 **요청자 자신**으로 좁힌다(소유자가 자기 업로드를 자기 에이전트에 건다).
    return applyAvatar(pool, storage, reply, id, me.id, req.body, req.log);
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

  /**
   * 사진 맞추기의 **원본**과 그 첨부 id·고른 자리(`AVATAR_SOURCE_HEADER`). 걸린 아바타와 달리 **모두에게 열지 않는다** —
   * 원본에는 사람이 원 밖으로 일부러 뺀 부분이 남아 있다. 그 사진을 다시 맞출 수 있는 사람(자기 자신, 에이전트면
   * 소유자·admin)만 받는다. 판정은 `checkOwnerOrAdmin` 하나를 그대로 쓴다.
   *
   * 원본이 없으면(이번 변경 전에 건 사진) 404 다 — 화면은 걸린 아바타를 원본으로 연다.
   */
  app.get('/accounts/:id/avatar/source', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const me = req.account!;
    if (id !== me.id) {
      const verdict = await checkOwnerOrAdmin(pool, me, id);
      if (!verdict.ok) {
        return reply.code(verdict.status).send({ error: { code: verdict.code, message: verdict.message } });
      }
      // 사람 계정은 소유자가 없어 admin 만 지나간다 — 남의 원본을 admin 이 볼 이유가 없다.
      const kind = await pool.query(`select 1 from account where id = $1 and kind = 'agent'`, [id]);
      if (!kind.rowCount) return reply.code(403).send({ error: { code: 'forbidden', message: 'not yours' } });
    }
    const target = await findAvatarSourceTarget(pool, id);
    if (!target) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no avatar source' } });
    }
    const body = await storage.read(target.storageKey);
    return reply
      // 걸린 아바타 라우트와 같은 방어(inline 으로 내주지 않는다).
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'attachment')
      .header('content-length', String(target.sizeBytes))
      .header(AVATAR_SOURCE_HEADER, JSON.stringify({ attachmentId: target.attachmentId, crop: target.crop } satisfies AvatarSourceMeta))
      .type(target.contentType)
      .send(body);
  });
}
