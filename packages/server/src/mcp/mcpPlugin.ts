import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  ASK_MAX_OPTIONS, ASK_MIN_OPTIONS, MAX_MESSAGE_BODY_CHARS,
  MODEL_ID_MAX, REPORT_MAX_ITEMS, REPORT_MAX_NEXT, TEAM_ROUND_LIMIT,
  type AccountView, type AskAudience, type AskMeta, type DelegationMeta, type FailureMeta,
  type ModelMeta, type ReportMeta,
} from '@murmur/shared';
import { denormalizeBodies, normalizeSearchQuery } from '../services/mentions.js';
import { emitEvent, emitPosted, onEvent } from '../events.js';
import type { Lifecycle } from '../lifecycle.js';
import { assertChannelVisible, audienceFor, getChannelDoc, listChannels } from '../services/channels.js';
import { listInbox, listMessages, markInboxRead, postMessage, searchMessages } from '../services/messages.js';
import {
  createDelegation, leadTeamFor, roundsUsed,
  DELEGATION_DEADLINE_DEFAULT_SEC, DELEGATION_DEADLINE_MAX_SEC, DELEGATION_DEADLINE_MIN_SEC,
} from '../services/delegations.js';
import { addReaction, isEmoji, MAX_REACTIONS_PER_ACTOR, removeReaction } from '../services/reactions.js';
import { getMemory, listMemory, MAX_MEMORY_ITEMS_PER_ACCOUNT, MAX_MEMORY_VALUE_LENGTH, setMemory } from '../services/memory.js';
import { proposeSkill, isValidSkillSlug } from '../services/skills.js';
import { scheduleWake, WAKE_MAX_SEC, WAKE_MIN_SEC } from '../services/agentWakes.js';
import { guideFor } from './guide.js';
import { recordClaudeLane } from '../services/claudeLane.js';
import { recordRunnerVersion } from '../services/runnerVersion.js';
import { resolveAttachmentFor } from '../services/attachments.js';
import { reportedModelMeta } from '../services/reportedModel.js';
import { AttachmentMissingError, type StorageBackend } from '../storage/local.js';
import type { Readable } from 'node:stream';

const MEMORY_SLUG_REGEX = /^core$|^mem\/[a-z0-9][a-z0-9_-]{0,63}((\/[a-z0-9][a-z0-9_-]{0,63})*)$/;

function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 255 && MEMORY_SLUG_REGEX.test(slug);
}
import type { AgentPresence } from './presence.js';

/**
 * 발화 도구가 공통으로 받는 `model` — 에이전트가 신고하는 **자기 모델 ID**(#600).
 *
 * 옵셔널인 이유는 두 가지다. ① 사람의 PAT 으로도 이 도구를 부를 수 있고 사람에게는 모델이
 * 없다. ② 모델을 못 아는 하네스(또는 옛 러너)도 계속 발화할 수 있어야 한다 — 필수로 두면
 * 프롬프트를 못 받은 러너의 답이 통째로 막힌다. 모르면 생략하고, 그때 화면은 아무것도
 * 그리지 않는다.
 */
const MODEL_ARG = z.string().min(1).max(MODEL_ID_MAX).optional();

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/**
 * 그림으로 실을 타입. **허용 목록이다** — `contentType` 은 올린 클라이언트가 보낸 값이라
 * 신뢰하지 않고(attachmentRoutes.ts 의 같은 판단), 여기 없는 것은 바이트를 싣지 않는다.
 *
 * 이 네 개인 이유: 모델이 실제로 그림으로 읽는 형식이 이것들이다. `image/svg+xml` 이
 * 빠진 것은 크기나 취향 문제가 아니다 — SVG 는 마크업이고 `<script>` 를 담을 수 있어
 * 이름만 이미지다(REST 쪽 `NEVER_INLINE` 이 같은 이유로 그것을 내려받기로만 내준다).
 */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * 그림으로 실어 줄 최대 원본 크기. base64 는 4/3 로 부풀므로 3MiB → 4MiB 가 되고,
 * 그것이 한 요청에 이미지 하나로 실리는 실질 한계 안이다.
 *
 * 넘는 것을 **거절하지 않는다** — 메타데이터로 떨어뜨린다. 그래야 에이전트가 "무엇이
 * 왔는지"는 알고, 정말 필요하면 REST 로 스트리밍해 받는다. 여기서 200MB 를 통째로
 * base64 로 만들면 서버 메모리와 모델 컨텍스트를 함께 태운다.
 */
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * 스트림을 메모리로 모은다. 도구 응답은 base64 **문자열** 하나라 스트리밍할 수가 없다 —
 * REST 는 스트림을 그대로 흘려보내지만 여기서는 전부 손에 들어야 한다.
 *
 * 모으는 동안에도 한계를 다시 센다. 위에서 `sizeBytes` 로 이미 걸렀지만 그것은 **DB 가
 * 기억하는 크기**다. 파일이 그것과 다르면(잘못된 마이그레이션·수동 조작) 한계가 없는 것과
 * 같아지므로, 실제로 흘러온 바이트로 한 번 더 막는다.
 */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += (chunk as Buffer).length;
    if (total > IMAGE_MAX_BYTES) {
      stream.destroy();
      throw new OversizeError(`read ${total}B, over the inline limit`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** 파일이 DB 가 기억하는 크기보다 큰 경우. 이 하나만 위 `collect` 가 던진다. */
class OversizeError extends Error {}

function buildMcpServer(
  pool: Pool,
  account: AccountView,
  lifecycle: Lifecycle,
  storage: StorageBackend,
  /**
   * 러너가 붙어 있는 에이전트들(050 의 층 0). `message.delegate` 가 **도달 불가한 팀원에는
   * 의무를 만들지 않으려고** 본다 — 만들면 아무도 닫지 않는 의무가 되어 팀장은 기한까지
   * 아무 것도 모른다. 여기까지 넘기는 이유는 그 판정의 정본이 인메모리라는 것이다
   * (`presence.ts`: *"지금 붙어 있나"는 이 표가 답하지 않는다*).
   */
  presence: Pick<AgentPresence, 'online'>,
): McpServer {
  const server = new McpServer({ name: 'murmur', version: '0.1.0' });

  /**
   * 워크스페이스 규칙. `mode` 로 독자를 가른다(`guide.ts` 머리의 실측 참고) — 러너가 띄운
   * 턴은 인박스를 자기가 물지 않으므로 poll 절을 받으면 **남의 요청을 대신 해 버린다**.
   *
   * 기본값이 'resident' 인 이유: 모드를 모르는 옛 호출자(러너가 서버보다 늦게 배포되는
   * 창)는 지금까지와 글자 그대로 같은 전문을 받아야 한다. 새 값은 옵트인이다.
   */
  server.registerTool('workspace.guide', {
    description: '워크스페이스 규칙(avcs 사용 경계 포함). mode=turn 이면 러너 턴용 판본',
    inputSchema: { mode: z.enum(['resident', 'turn']).optional() },
  }, async ({ mode }) => jsonResult({ guide: guideFor(mode ?? 'resident') }));

  server.registerTool('account.me', { description: '내 계정 정보' },
    async () => jsonResult(account));

  // 에이전트도 사람과 같은 가시성 규칙을 받는다 — private 채널은 멤버인 에이전트만 본다.
  // admin 예외는 주지 않는다: 이 목록은 곧 `message.read` 로 이어지는 경로이고, admin 이
  // 목록에서 이름을 보는 절충은 사람이 운영 화면에서 쓰라고 만든 것이다.
  server.registerTool('channel.list', { description: '채널 목록' },
    async () => jsonResult({ channels: await listChannels(pool, account.id) }));

  /**
   * 채널 문서 읽기(#188). **에이전트에게는 읽기만 준다 — 짝이 되는 쓰기 도구가 없다.**
   *
   * 문서는 덮어쓰기다. 에이전트에게 쓰기를 열면 "누가 바꿨나"·버전·되돌리기가 곧바로
   * 요구사항으로 딸려 온다(사람은 자기가 지운 단락을 에이전트가 지운 것과 구별해야 한다).
   * 그것은 별개 결정이므로 v1 에서는 만들지 않는다.
   *
   * 읽기를 여는 이유는 이 기능의 존재 이유 자체다: 새 세션의 에이전트가 채널의 전제를
   * 재구성할 곳이 필요하다. 그 목적에는 읽기만으로 충분하다.
   *
   * 별도 도구인 이유: `channel.list` 에 본문을 실으면 채널 수만큼 문서 전문이 목록 응답에
   * 실려 컨텍스트를 먹는다. 문서는 필요할 때 하나만 읽는 것이다.
   */
  server.registerTool('channel.doc', {
    description: '채널 문서 조회(읽기 전용)',
    inputSchema: { channelId: z.string().uuid() },
  }, async ({ channelId }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    return jsonResult(await getChannelDoc(pool, channelId));
  });

  server.registerTool('message.read', {
    description: '채널/스레드 메시지 읽기(seq 커서)',
    inputSchema: {
      channelId: z.string().uuid(),
      since: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      threadRootId: z.string().uuid().optional(),
    },
  }, async ({ channelId, since, limit, threadRootId }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    // 에이전트는 handle 로 생각한다 — 정본(`<@id>`)을 **현재** handle 로 되돌려 준다(#271).
    const messages = await listMessages(pool, channelId, { since, limit, threadRootId: threadRootId ?? null });
    return jsonResult({ messages: await denormalizeBodies(pool, messages) });
  });

  server.registerTool('message.search', {
    description: '메시지 전문 검색',
    inputSchema: { query: z.string().min(1).max(256) },
  }, async ({ query }) => {
    // 검색어도 본문과 같은 규칙으로 정본에 맞춘다 — REST `/search` 와 **같은 함수**다.
    const page = await searchMessages(pool, account.id, await normalizeSearchQuery(pool, query));
    return jsonResult({ messages: await denormalizeBodies(pool, page.messages) });
  });

  server.registerTool('message.post', {
    description: '채널 또는 스레드에 메시지 발화',
    inputSchema: {
      channelId: z.string().uuid(),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
      threadRootId: z.string().uuid().optional(),
      alsoInChannel: z.boolean().optional(),
      model: MODEL_ARG,
    },
  }, async ({ channelId, body, threadRootId, alsoInChannel, model }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const posted = await postMessage(pool, {
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null, alsoInChannel,
      meta: await reportedModelMeta(pool, account.id, model),
    });
    // 에이전트는 첨부를 붙이지 않는다(도구에 그 입력이 없다). 그래도 합 타입이므로 확인해야
    // 하고, 확인 자체가 나중에 도구가 첨부를 받게 될 때의 자리를 남겨 둔다.
    if (posted.failure) {
      return jsonResult({ error: { code: 'bad_attachment', message: 'attachments must be your own, unused uploads' } });
    }
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const audience = await audienceFor(pool, channelId);
      emitPosted(posted, audience);
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    /**
     * 누구를 불렀는지 함께 준다(Task 8 Step 2). 발화하는 다섯 도구가 **모두 같은 모양**이다 —
     * 하나만 빠지면 그 도구로 부른 에이전트만 결과를 모른다.
     *
     * REST 쪽은 같은 사실을 **헤더**로 싣는다(`NOTIFIED_HEADER`). 모양이 다른 이유는 응답의
     * 모양이 다르기 때문이다: REST 의 POST 응답 본문은 `MessageRow` 그 자체라 형제 키를
     * 얹으면 그 타입이 오염되지만, MCP 는 이미 `{ message }` **봉투**라 곁에 키 하나를 더해도
     * `MessageRow` 는 그대로다. 두 표면이 같은 사실을 각자의 관습으로 싣는다.
     *
     * 재생(idempotency)이면 빈 배열이다 — 그 요청이 새로 부른 사람이 없다는 뜻이다.
     */
    return jsonResult({ message, notified });
  });

  // #144: 진행 설명 메시지 — 결과 발화로 세지 않고, 사용자가 읽을 수 있어야 뜻이 있다.
  // kind='progress'로 저장되어 message.read 응답에서 구분할 수 있다.
  server.registerTool('message.progress', {
    description: '긴 작업 시작 시 진행 설명 메시지(결과 발화로 세지 않음)',
    inputSchema: {
      channelId: z.string().uuid(),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
      threadRootId: z.string().uuid().optional(),
      model: MODEL_ARG,
    },
  }, async ({ channelId, body, threadRootId, model }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const posted = await postMessage(pool, {
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null, kind: 'progress',
      meta: await reportedModelMeta(pool, account.id, model),
    });
    if (posted.failure) {
      return jsonResult({ error: { code: 'bad_attachment', message: 'attachments must be your own, unused uploads' } });
    }
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const audience = await audienceFor(pool, channelId);
      emitPosted(posted, audience);
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return jsonResult({ message, notified });
  });

  /**
   * 선택 요청 — 갈림길에서 선택지를 내놓는다. 고르면 그 즉시 진행되므로 사람이 다시
   * 타이핑하지 않는다(디자인 문서 규칙 05: 답할 자리가 말 옆에 있다).
   *
   * **`message.post` 와 같은 삽입 경로를 쓴다** — `meta` 만 다르다(`message.progress` 의
   * 선례). 도구를 따로 두는 이유는 발행 시점에 **옵션 수와 수신자 handle 을 서버가
   * 검증**할 수 있기 때문이다. `meta` 규약으로 두면 깨진 카드가 저장된 뒤에 화면이
   * 그것을 발견한다.
   *
   * `to` 는 handle 로 받는다 — 에이전트가 아는 것은 `@forge` 이고 accountId 가 아니다.
   * 없는 handle 은 거절한다: 아무도 답할 수 없는 물음은 교착이고, 그것을 저장하는 것은
   * 조용한 실패다.
   */
  server.registerTool('message.ask', {
    description: '갈림길에서 선택지를 내놓는다(고르면 즉시 진행). to 는 사람이면 생략, 특정 대상이면 handle',
    inputSchema: {
      channelId: z.string().uuid(),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
      threadRootId: z.string().uuid().optional(),
      options: z.array(z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(200),
        hint: z.string().min(1).max(200).optional(),
      })).min(ASK_MIN_OPTIONS).max(ASK_MAX_OPTIONS),
      /** 답할 대상의 handle. 비우면 '사람 아무나'다. */
      to: z.string().min(1).max(64).optional(),
      prompt: z.string().min(1).max(500).optional(),
      model: MODEL_ARG,
    },
  }, async ({ channelId, body, threadRootId, options, to, prompt, model }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    // 옵션 id 가 겹치면 답을 기록할 때 어느 것을 고른 것인지 정할 수 없다.
    const ids = new Set(options.map((o) => o.id));
    if (ids.size !== options.length) {
      return jsonResult({ error: { code: 'duplicate_option', message: 'option ids must be unique' } });
    }
    let audience: AskAudience = { kind: 'human' };
    if (to) {
      const handle = to.replace(/^@/, '').toLowerCase();
      const found = (await pool.query(
        `select id from account where lower(handle) = $1`, [handle],
      )).rows as { id: string }[];
      if (found.length === 0) {
        return jsonResult({ error: { code: 'unknown_handle', message: `no account with handle @${handle}` } });
      }
      audience = { kind: 'account', accountId: found[0]!.id };
    }
    const meta: AskMeta & Partial<ModelMeta> = {
      kind: 'ask', ask: { options, to: audience, ...(prompt ? { prompt } : {}) },
      ...(await reportedModelMeta(pool, account.id, model)),
    };
    const posted = await postMessage(pool, {
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null,
      meta: meta as unknown as Record<string, unknown>,
    });
    if (posted.failure) {
      return jsonResult({ error: { code: 'bad_attachment', message: 'attachments must be your own, unused uploads' } });
    }
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const channelAudience = await audienceFor(pool, channelId);
      emitPosted(posted, channelAudience);
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return jsonResult({ message, notified });
  });

  /**
   * 실패 — 스스로 못 끝냈다고 사람에게 알린다(규칙 03: 막는 말).
   *
   * `message.ask` 와 같은 삽입 경로를 쓰되 **수신자를 받지 않는다**: 실패의 수신자는 언제나
   * 사람이다. 넘겨받은 에이전트가 실패해도 결국 사람에게 온다 — 사슬의 끝은 언제나 사람이다.
   *
   * `retryable` 을 옵셔널로 두지 않는다. 기본값을 서버가 정하면 "다시 불러도 소용없는
   * 실패"에 버튼이 생기거나 "고칠 수 있는 실패"의 경로가 사라진다. 둘 다 거짓 신호이므로
   * 보내는 쪽이 반드시 정하게 한다.
   */
  server.registerTool('message.fail', {
    description: '스스로 못 끝냈음을 알린다(수신자는 언제나 사람). retryable 로 다시 부를 수 있는지 밝힌다',
    inputSchema: {
      channelId: z.string().uuid(),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
      threadRootId: z.string().uuid().optional(),
      what: z.string().min(1).max(500).optional(),
      reason: z.string().min(1).max(1000).optional(),
      retryable: z.boolean(),
      model: MODEL_ARG,
    },
  }, async ({ channelId, body, threadRootId, what, reason, retryable, model }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const meta: FailureMeta & Partial<ModelMeta> = {
      kind: 'failure',
      failure: { retryable, ...(what ? { what } : {}), ...(reason ? { reason } : {}) },
      ...(await reportedModelMeta(pool, account.id, model)),
    };
    const posted = await postMessage(pool, {
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null,
      meta: meta as unknown as Record<string, unknown>,
    });
    if (posted.failure) {
      return jsonResult({ error: { code: 'bad_attachment', message: 'attachments must be your own, unused uploads' } });
    }
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const channelAudience = await audienceFor(pool, channelId);
      emitPosted(posted, channelAudience);
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return jsonResult({ message, notified });
  });

  /**
   * **위임** — 팀장이 팀원에게 일을 넘긴다(050). 결말이 나면 팀장이 다시 깨어난다.
   *
   * ## 왜 `@handle` 멘션이 아닌 새 도구인가
   *
   * 두 가지를 서버가 알아야 한다: **이것이 위임이라는 것**과 **누구를 기다리는지**. 멘션으로는
   * 둘 다 알 수 없다 — "이 작성자가 지금 팀장으로 도는 중인가"는 러너의 턴에 있는 사실이고
   * 메시지에는 없다. 그리고 `to` 가 명시되면 *"본문 맨 앞에 이름을 둬야 턴이 뜬다"* 는 함정이
   * 사라진다: 인용·코드 블록 안이든 문장 가운데든 결과가 같다.
   *
   * ## 층 0 — 도달 불가한 팀원에는 의무를 만들지 않는다
   *
   * 러너가 붙어 있지 않거나 비활성인 팀원은 `unreachable` 로 돌려주고 **의무를 만들지
   * 않는다.** 만들면 아무도 닫지 않는 의무가 되어 팀장은 기한까지 아무 것도 모른다. 요점은
   * 이때 팀장이 **아직 자기 턴 안**이라는 것이다 — 그 자리에서 직접 하거나 다른 팀원을 고를
   * 수 있다. 복구보다 예방이 싸다.
   *
   * 전원이 도달 불가면 **메시지도 만들지 않는다.** 위임 메시지만 남으면 사람은 넘어간 줄
   * 알고 기다리는데 기다릴 것이 없다.
   *
   * ## 스레드가 필수다
   *
   * `threadRootId` 를 옵셔널로 두지 않는다: 위임은 라운드를 스레드 단위로 세고(무한 왕복을
   * 막는 유일한 장치다) 닫힘도 *"이 스레드에서 이 팀원이 답했는가"* 로 판정한다. 채널
   * 최상위에 걸면 그 둘이 성립하지 않는다.
   */
  server.registerTool('message.delegate', {
    description: '팀원에게 일을 넘긴다(팀장만). 전부 끝나거나 기한이 지나면 다시 깨어난다',
    inputSchema: {
      channelId: z.string().uuid(),
      threadRootId: z.string().uuid(),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
      to: z.array(z.string().min(1).max(64)).min(1).max(8),
      deadlineSec: z.number().int()
        .min(DELEGATION_DEADLINE_MIN_SEC).max(DELEGATION_DEADLINE_MAX_SEC).optional(),
      model: MODEL_ARG,
    },
  }, async ({ channelId, threadRootId, body, to, deadlineSec, model }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    if (to.some((h) => h.toLowerCase() === account.handle.toLowerCase())) {
      return jsonResult({ error: { code: 'self_delegation', message: 'you cannot delegate to yourself' } });
    }

    const team = await leadTeamFor(pool, account.id, to);
    if (!team) {
      // 사유를 갈라 말한다 — 팀장이 아닌 것과 그 팀원들이 내 팀에 없는 것은 다음 행동이
      // 다르다(전자는 사람에게 말해야 하고, 후자는 `to` 를 고치면 된다).
      const anyTeam = await leadTeamFor(pool, account.id, []);
      return jsonResult({
        error: anyTeam
          ? { code: 'not_team_members', message: 'every handle in `to` must be a member of your team' }
          : { code: 'not_a_lead', message: 'only a team lead can delegate' },
      });
    }

    const used = await roundsUsed(pool, { threadRootId, leadAccountId: account.id });
    if (used >= TEAM_ROUND_LIMIT) {
      // 상한을 넘으면 **사람이 봐야 하는 상태**다. 그 판단을 서버가 대신 하지 않고 사유를
      // 돌려준다 — 팀장이 `message.fail(retryable: true)` 로 사람에게 넘기는 것이 올바른 종료다.
      return jsonResult({
        error: {
          code: 'round_limit',
          message: `이 스레드에서 이미 ${used}번 넘겼다(상한 ${TEAM_ROUND_LIMIT}) — 직접 하거나 사람에게 넘겨라`,
        },
      });
    }

    const online = new Set(presence.online());
    const delegates: { handle: string; accountId: string }[] = [];
    const unreachable: string[] = [];
    for (const handle of to) {
      const member = team.members.get(handle.toLowerCase())!;
      if (member.disabled || !online.has(member.accountId)) unreachable.push(handle);
      else delegates.push({ handle, accountId: member.accountId });
    }
    if (!delegates.length) {
      return jsonResult({ delegated: [], unreachable, message: null });
    }

    const deadlineAt = new Date(Date.now() + (deadlineSec ?? DELEGATION_DEADLINE_DEFAULT_SEC) * 1000);
    const meta: DelegationMeta & Partial<ModelMeta> = {
      kind: 'delegation',
      delegation: {
        to: delegates.map((d) => d.handle),
        // **아직 답하지 않은 팀원**(3-3). 만들 때는 전원이다. 의무가 닫힐 때마다 서버가
        // 줄이고, 화면은 이 값으로 대기 사슬을 세운다 — 표는 어느 화면에도 닿지 않는다.
        open: delegates.map((d) => d.accountId),
        unreachable,
        deadlineAt: deadlineAt.toISOString(),
      },
      ...(await reportedModelMeta(pool, account.id, model)),
    };
    const posted = await postMessage(pool, {
      channelId, authorId: account.id, body, threadRootId,
      meta: meta as unknown as Record<string, unknown>,
    });
    if (posted.failure || !posted.message) {
      return jsonResult({ error: { code: 'post_failed', message: posted.failure ?? 'could not post' } });
    }

    /**
     * **발화와 의무가 한 커밋이 아니다.** `postMessage` 는 자기 커넥션에서 커밋하므로 여기
     * 아래가 실패하면 위임 메시지만 남고 아무도 불리지 않는다. 그 창을 없애려면 `postMessage`
     * 가 외부 트랜잭션을 받아야 하는데, 그것은 이 도구가 정할 수 있는 계약이 아니다(예약 발송
     * sweeper 도 같은 창을 갖고 `idempotencyKey` 로 감수한다).
     *
     * 그래서 창을 없애는 대신 **사람이 읽을 수 있게** 만든다: 실패하면 그 사실을 그대로
     * 돌려주므로 팀장은 다시 넘기거나 직접 할 수 있다. 조용히 성공으로 답하는 것이 가장 나쁘다.
     */
    const client = await pool.connect();
    try {
      await client.query('begin');
      await createDelegation(client, {
        messageId: posted.message.id,
        channelId,
        threadRootId,
        teamId: team.teamId,
        leadAccountId: account.id,
        delegateIds: delegates.map((d) => d.accountId),
        deadlineAt,
      });
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      console.error('[message.delegate] 의무를 만들지 못했다(메시지는 남았다):', err);
      return jsonResult({
        error: {
          code: 'delegation_failed',
          message: '위임 메시지는 올라갔지만 의무를 만들지 못했다 — 팀원은 부르지 않았다',
        },
      });
    } finally {
      client.release();
    }

    const channelAudience = await audienceFor(pool, channelId);
    emitPosted(posted, channelAudience);
    for (const accountId of posted.notified ?? []) emitEvent({ type: 'inbox.updated', accountId });
    // 넘겨받은 팀원의 부름은 `createDelegation` 이 직접 만들었으므로 위 `notified` 에 없다 —
    // 그들의 러너가 즉시 폴하도록 여기서 따로 친다(치지 않으면 다음 롱폴까지 최대 25초 늦다).
    for (const d of delegates) emitEvent({ type: 'inbox.updated', accountId: d.accountId });

    return jsonResult({
      message: posted.message,
      delegated: delegates.map((d) => d.handle),
      unreachable,
      deadlineAt: deadlineAt.toISOString(),
      roundsLeft: Math.max(0, TEAM_ROUND_LIMIT - used - 1),
    });
  });

  /**
   * 완료 보고 — 무엇을 했고, 무엇이 바뀌었고, 무엇이 남았는가(규칙 03: 읽히는 말).
   *
   * 이 스레드에서 **가장 오래 남고 가장 많이 다시 읽히는 말**이므로 자유 문장이 아니라
   * 형식으로 받는다. `checks` 만 필수다 — 바꾼 파일이 없는 작업은 있어도, 무엇을 확인했는지
   * 없는 보고는 보고가 아니다.
   */
  server.registerTool('message.report', {
    description: '완료 보고(확인한 것 · 바뀐 파일 · 남은 것 · 다음 제안). checks 는 필수',
    inputSchema: {
      channelId: z.string().uuid(),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
      threadRootId: z.string().uuid().optional(),
      checks: z.array(z.string().min(1).max(300)).min(1).max(REPORT_MAX_ITEMS),
      files: z.array(z.string().min(1).max(400)).max(REPORT_MAX_ITEMS).optional(),
      remaining: z.array(z.string().min(1).max(300)).max(REPORT_MAX_ITEMS).optional(),
      durationMs: z.number().int().nonnegative().optional(),
      next: z.array(z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(200),
      })).max(REPORT_MAX_NEXT).optional(),
      model: MODEL_ARG,
    },
  }, async ({ channelId, body, threadRootId, checks, files, remaining, durationMs, next, model }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const meta: ReportMeta & Partial<ModelMeta> = {
      ...(await reportedModelMeta(pool, account.id, model)),
      kind: 'report',
      report: {
        checks,
        ...(files?.length ? { files } : {}),
        ...(remaining?.length ? { remaining } : {}),
        ...(durationMs != null ? { durationMs } : {}),
        ...(next?.length ? { next } : {}),
      },
    };
    const posted = await postMessage(pool, {
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null,
      meta: meta as unknown as Record<string, unknown>,
    });
    if (posted.failure) {
      return jsonResult({ error: { code: 'bad_attachment', message: 'attachments must be your own, unused uploads' } });
    }
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const channelAudience = await audienceFor(pool, channelId);
      emitPosted(posted, channelAudience);
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return jsonResult({ message, notified });
  });

  server.registerTool('message.react', {
    description: '메시지에 리액션 추가',
    inputSchema: {
      channelId: z.string().uuid(),
      messageId: z.string().uuid(),
      emoji: z.string().min(1).max(32),
    },
  }, async ({ channelId, messageId, emoji }) => {
    if (!isEmoji(emoji)) {
      return jsonResult({ error: { code: 'bad_request', message: 'a reaction must be a single emoji' } });
    }
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const result = await addReaction(pool, { channelId, messageId, accountId: account.id, emoji });
    if (result === 'not_found') {
      return jsonResult({ error: { code: 'not_found', message: 'no such message in this channel' } });
    }
    if (result === 'too_many') {
      return jsonResult({
        error: { code: 'too_many_reactions', message: `at most ${MAX_REACTIONS_PER_ACTOR} reactions per message` },
      });
    }
    // REST 라우트와 **똑같이** 이벤트를 낸다. 이게 없으면 리액션은 DB 에만 남고 붙어 있는
    // 데스크탑은 다시 조회할 때까지 못 본다 — 에이전트가 👀 를 다는 목적이 "사람이 지금
    // 본다"인데 그 목적이 사라진다(#99). 두 표면이 같은 규칙을 갖는다는 계약의 일부다.
    emitEvent({
      type: 'reaction.added', channelId, messageId, emoji,
      accountId: account.id, audience: await audienceFor(pool, channelId),
    });
    return jsonResult({ emoji });
  });

  server.registerTool('message.unreact', {
    description: '메시지에서 리액션 제거',
    inputSchema: {
      channelId: z.string().uuid(),
      messageId: z.string().uuid(),
      emoji: z.string().min(1).max(32),
    },
  }, async ({ channelId, messageId, emoji }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    await removeReaction(pool, { messageId, accountId: account.id, emoji });
    // 제거도 REST 와 같이 이벤트를 낸다 — 없는 것을 떼는 것도 성공이라(REST 주석 참고)
    // 이벤트를 조건부로 내지 않는다. 결과 상태가 같으니 재시도가 안전해야 한다.
    emitEvent({
      type: 'reaction.removed', channelId, messageId, emoji,
      accountId: account.id, audience: await audienceFor(pool, channelId),
    });
    return jsonResult({ ok: true });
  });

  server.registerTool('inbox.poll', {
    description: '미읽음 inbox 조회. timeoutMs>0이면 새 항목이 올 때까지 long-poll',
    inputSchema: {
      timeoutMs: z.number().int().min(0).max(25_000).optional(),
      version: z.string().optional(),
      // 러너가 기동 때 읽은 claude lane(5단계). **버전과 같은 자리로 온다** — 러너가
      // 이미 25초마다 부르는 것이 이 도구 하나뿐이라, lane 만을 위한 엔드포인트를 두면
      // 러너가 새 실패 지점을 하나 더 갖는다(못 보내면 폴까지 실패하는 것이 아니라,
      // 폴은 되는데 lane 만 조용히 안 오는 상태를 따로 다뤄야 한다).
      claudeLane: z.object({
        pool: z.string().nullable(),
        // 이름만 받는다 — 경로·이메일은 받지 않는다(러너 로그와 같은 규율).
        accounts: z.array(z.string()).max(64),
      }).optional(),
    },
  }, async ({ timeoutMs, version, claudeLane }) => {
    // 버전이 오면 기록한다 — 배포가 넣어 준 빌드 시점 값이다(#129). 값이 바뀔 때만
    // 실제로 쓰이므로 이 핫 패스에 쓰기 비용이 없다(services/runnerVersion.ts 주석).
    if (version) {
      await recordRunnerVersion(pool, account.id, version);
    }
    // lane 도 같은 규칙이다 — 값이 바뀔 때만 쓴다(services/claudeLane.ts 주석).
    // **사람 계정에는 쓰지 않는다**: 사람이 MCP 로 폴을 걸 수 있고, lane 은 러너에만
    // 있는 개념이라 사람 계정에 행이 생기면 화면이 사람에게 계정 순서를 그린다.
    if (claudeLane && account.kind === 'agent') {
      await recordClaudeLane(pool, account.id, claudeLane);
    }
    // presence 를 여기서 표시하지 않는다 — `/mcp` 라우트가 요청마다 이미 했다.
    // 예전에는 이 자리가 유일한 mark 였고, 그것이 **일하는 중인 에이전트를 죽었다고
    // 말하는 버그**였다: 러너 루프는 단일 스레드라 턴이 도는 동안 폴이 나가지 않으므로
    // 30초 TTL 이 만료됐다. 신호를 게이트로 올리면 도구 하나가 빠뜨릴 수 없다.
    const fetchUnread = async () => {
      const entries = await listInbox(pool, account.id, { unreadOnly: true });
      if (!entries.length) return { entries, messages: [] };
      const ids = entries.map((e) => e.messageId);
      const msgs = await pool.query(
        `select id, seq::int as seq, channel_id as "channelId", thread_root_id as "threadRootId",
           author_id as "authorId", body, kind, meta, created_at as "createdAt",
           also_in_channel as "alsoInChannel"
         from message where id = any($1) order by seq`, [ids]);
      return { entries, messages: await denormalizeBodies(pool, msgs.rows as { body: string }[]) };
    };
    // Subscribe before the first fetch so an inbox.updated arriving during that DB round trip is
    // not lost in the gap between "query returned empty" and "we started listening" — it sets
    // `woken`, and we skip the wait and refetch immediately instead of blocking for timeoutMs.
    let woken = false;
    let notify: (() => void) | null = null;
    const off = onEvent((e) => {
      if (e.type === 'inbox.updated' && e.accountId === account.id) {
        woken = true;
        notify?.();
      }
    });
    // 종료가 시작되면 park를 걷어낸다. 이 응답은 hijack된 raw 소켓이라 Fastify close()가
    // 기다려 주지 않으므로, park를 유지하면 정상 타임아웃이 아니라 transport error로 절단된다.
    // draining 중에 도착한 poll은 애초에 park하지 않는다 — 종료 중 서버가 25초를 붙잡는 것도
    // 같은 절단이다. enterPoll은 그동안 종료가 이 응답을 기다리게 만든다.
    let draining = false;
    const offDrain = lifecycle.onDrain(() => {
      draining = true;
      notify?.();
    });
    const releasePoll = lifecycle.enterPoll();
    try {
      let result = await fetchUnread();
      let waited = false;
      if (!result.entries.length && !woken && !draining && (timeoutMs ?? 0) > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          notify = () => { clearTimeout(timer); resolve(); };
        });
        waited = true;
      }
      // Refetch whenever the first read was empty and either a wake fired (whether during the
      // initial DB round trip or during the wait) or we sat through the wait — the latter is a
      // safety net against a wake event that lands in a gap our flag-based tracking still misses.
      if (!result.entries.length && (woken || waited)) {
        result = await fetchUnread();
      }
      return jsonResult(result);
    } finally {
      off();
      offDrain();
      releasePoll();
    }
  });

  // inbox.poll 만 있으면 미읽음을 소비할 수 없어, MCP 로만 붙은 에이전트가 같은 멘션에 영원히
  // 반복 응답한다. 루프가 성립하려면 읽음 처리도 같은 표면에 있어야 한다.
  // messageId 가 아니라 inbox entry id 를 받는다 — entry 가 계정에 묶여 있고, 서비스가
  // account_id 로 스코프를 걸어 남의 inbox 는 소비되지 않는다.
  server.registerTool('inbox.read', {
    description: 'inbox 항목을 읽음 처리(자기 inbox 한정). ids 는 inbox.poll 이 준 entry id',
    inputSchema: { ids: z.array(z.number().int()).min(1).max(200) },
  }, async ({ ids }) => {
    const read = await markInboxRead(pool, account.id, ids);
    return jsonResult({ read });
  });

  /**
   * `work.link` 를 걷어냈다 — intent 를 기존 대화 스레드에 묶어 그 스레드를 작업
   * 스레드로 승격시키는 도구였다.
   *
   * 그 도구는 **스레드 투영의 배선**이었다. 존재 이유가 "이 intent 의 operation·decision
   * 을 어느 스레드에 붙일지 정한다"였고, 붙일 자리가 없어진 지금 남길 것이 없다. 쓰던
   * 테이블(`work_thread`)도 같은 커밋에서 사라진다.
   *
   * 대신 껍데기만 남겨 `{ ok: true }` 를 돌려주지 않았다. 그렇게 하면 에이전트는 계속
   * 호출하고 계속 성공을 받는데 아무 일도 일어나지 않는다 — 그것이 이 도구가 처음
   * 고치려던 문제(#381: 실패가 아니라 침묵)와 정확히 같은 모양이다. 도구가 없으면
   * MCP 는 "그런 도구 없음"으로 답하고, 그것이 정직한 답이다. `workspace.guide` 에서도
   * 이 호출 지시를 함께 지운다 — 가이드가 없는 도구를 부르라고 하면 그 가이드 전체의
   * 신뢰가 깎인다.
   *
   * avcs 객체를 보는 자리는 협업 탭이고, 그 탭은 avcs 로그를 직접 읽는다.
   */

  // memory.list — slug만 돌려주고 값은 주지 않는다(값이 새면 목록 조회가 곧 전체 주입이 된다).
  server.registerTool('memory.list', {
    description: '에이전트 메모리 slug 목록(값은 포함 안 함)',
  }, async () => {
    const slugs = await listMemory(pool, account.id);
    return jsonResult({ slugs });
  });

  server.registerTool('memory.get', {
    description: '메모리 조회',
    inputSchema: { slug: z.string().min(1) },
  }, async ({ slug }) => {
    if (!isValidSlug(slug)) {
      return jsonResult({ error: { code: 'invalid_slug', message: 'invalid slug format' } });
    }
    const memory = await getMemory(pool, account.id, slug);
    if (!memory) {
      return jsonResult({ error: { code: 'not_found', message: 'memory not found' } });
    }
    return jsonResult({ slug: memory.slug, value: memory.value, updatedAt: memory.updatedAt.toISOString() });
  });

  // value 가 null 이면 삭제 — 키 부재가 아니라 명시적 null 이 삭제다.
  // .nullable() 은 "값이 반드시 있고 null 일 수 있다"를 의미한다.
  server.registerTool('memory.set', {
    description: '메모리 저장 또는 삭제(value가 null이면 삭제)',
    inputSchema: { slug: z.string().min(1), value: z.string().max(MAX_MEMORY_VALUE_LENGTH).nullable() },
  }, async ({ slug, value }) => {
    if (!isValidSlug(slug)) {
      return jsonResult({ error: { code: 'invalid_slug', message: 'invalid slug format' } });
    }
    // 길이는 위 zod `.max()` 가 이미 거른다 — 여기서 또 재지 않는다.
    // 삭제는 멱등이라 '없는 것을 지웠다'는 오류가 아니다(services/memory.ts 주석).
    const result = await setMemory(pool, account.id, slug, value);
    if (result === 'too_many') {
      return jsonResult({
        error: { code: 'too_many', message: `at most ${MAX_MEMORY_ITEMS_PER_ACCOUNT} memories per account` },
      });
    }
    return jsonResult({ ok: true });
  });

  // skill.propose — 에이전트가 스킬을 제안한다. 미승인 상태로 들어가고 채널에 알림이 간다.
  server.registerTool('skill.propose', {
    description: '워크스페이스 스킬 제안(미승인 상태, 채널에 알림)',
    inputSchema: {
      slug: z.string().min(1).max(40),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
      channelId: z.string().uuid(),
    },
  }, async ({ slug, body, channelId }) => {
    if (!isValidSkillSlug(slug)) {
      return jsonResult({ error: { code: 'invalid_slug', message: 'slug must be [a-z0-9-]{2,40}' } });
    }
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    const result = await proposeSkill(pool, { slug, body, proposedBy: account.id, channelId });
    return jsonResult(result);
  });

  /**
   * 깨움(wake) — **나를 나중에 다시 부른다.**
   *
   * 이 도구가 없으면 "기다린다"를 표현할 방법이 백그라운드 프로세스뿐이고, 그것은 턴이
   * 끝나는 순간 죽는다(2026-09-07 15:08 에 PR #533 의 CI 대기가 그렇게 사라졌다).
   * 스레드별 하네스 세션은 이미 `-r` 로 재개되므로, 필요한 것은 시계 하나였다.
   *
   * `threadRootId` 가 필수인 이유: 그 값이 러너의 **세션 키**다(agent/src/mentionTurn.ts
   * ::mentionAnchor). 비우면 깨어난 턴이 새 스레드로 시작해 지금까지의 맥락을 잃는다 —
   * 멘션 턴의 프롬프트 머리에 항상 실제 앵커가 실려 오므로(채널 최상위 멘션이면 그 멘션
   * 메시지 id) 에이전트는 이 값을 언제나 알고 있다.
   *
   * 하한을 zod 로 거절하는 이유(에러 코드가 아니라 예외): 60초보다 이른 예약은 정책 위반이
   * 아니라 **잘못된 인자**다. 상한(연속 횟수)은 그 스레드의 상태에 따라 달라지므로 서비스가
   * 판정해 `wake_limit` 으로 답한다 — 같은 거절이 아니다.
   */
  server.registerTool('turn.wake', {
    description: '나를 나중에 다시 부른다(기다릴 것이 있을 때). 예약은 스레드에 대기 줄로 보인다',
    inputSchema: {
      channelId: z.string().uuid(),
      threadRootId: z.string().uuid(),
      notBeforeSec: z.number().int().min(WAKE_MIN_SEC).max(WAKE_MAX_SEC),
      reason: z.string().min(1).max(200),
    },
  }, async ({ channelId, threadRootId, notBeforeSec, reason }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    const result = await scheduleWake(pool, {
      accountId: account.id, channelId, threadRootId, notBeforeSec, reason,
    });
    if (result.refusal) return jsonResult({ error: result.refusal });

    // 대기 줄은 **지금 보여야** 뜻이 있다 — 사람이 "죽었나 기다리나"를 아는 근거다.
    // 그래서 일반 발화와 같은 이벤트를 태운다. inbox 는 만들지 않는다(자기 자신이다).
    const audience = await audienceFor(pool, channelId);
    emitEvent({ type: 'message.created', message: result.message, audience });
    return jsonResult({ wake: result.wake, message: result.message });
  });

  /**
   * 첨부 바이트 받기(#585). **이미지는 그림으로 이 응답에 실린다.**
   *
   * 왜 REST 가 있는데도 필요한가: 프롬프트에 `curl` 안내를 넣어 셸이 있는 하네스는 이미
   * 열 수 있게 됐지만(agent/src/prompt.ts::attachmentHowTo), **셸이 없는 하네스의
   * 에이전트는 그 안내로 아무것도 못 한다.** 그쪽에는 도구 호출이 유일한 통로다.
   *
   * 판정을 여기서 다시 쓰지 않는다 — REST 다운로드와 **같은 함수**(`resolveAttachmentFor`)를
   * 부른다. 두 통로가 같은 바이트를 내주는데 규칙이 두 벌이면, 한쪽만 고친 날에 새는 쪽은
   * 아무도 안 보는 통로가 된다.
   *
   * 이미지가 아니거나 크면 **바이트 대신 메타데이터**를 준다(아래 IMAGE_TYPES·
   * IMAGE_MAX_BYTES 주석). 실패가 아니라 "이렇게 받아라"까지 함께 답한다.
   */
  server.registerTool('attachment.fetch', {
    description: '첨부 바이트 받기 — 이미지는 그림으로 실린다. id 는 프롬프트의 [첨부: …] 에 있다',
    inputSchema: { attachmentId: z.string().uuid() },
  }, async ({ attachmentId }) => {
    const resolved = await resolveAttachmentFor(pool, attachmentId, account.id);
    if (!resolved.ok) {
      // 사유를 뭉개지 않는다 — 에이전트가 할 다음 행동이 다르다(`not_found` 는 id 를 다시
      // 보고, `not_visible` 은 사람에게 묻는다). REST 와 같은 문장으로 답한다.
      if (resolved.denial === 'not_found') {
        return jsonResult({ error: { code: 'not_found', message: 'no such attachment' } });
      }
      return jsonResult({
        error: {
          code: 'forbidden',
          message: resolved.denial === 'not_yours' ? 'not your upload' : 'not a member of this dm channel',
        },
      });
    }
    const { id, filename, contentType, sizeBytes } = resolved.attachment;
    const meta = { id, filename, contentType, sizeBytes };

    if (!IMAGE_TYPES.includes(contentType) || sizeBytes > IMAGE_MAX_BYTES) {
      return jsonResult({
        attachment: meta,
        // 왜 바이트가 없는지 **이유를 말한다.** "빈 응답"으로 두면 에이전트는 받기가
        // 실패한 것과 구별하지 못하고 같은 호출을 다시 한다.
        note: sizeBytes > IMAGE_MAX_BYTES
          ? `too large to inline (${sizeBytes}B > ${IMAGE_MAX_BYTES}B)`
          : 'not an inlineable image type; bytes are not carried in this response',
        // 셸이 없는 하네스에는 이 경로가 **막힌 길**이라는 것을 말해 준다. 그러지 않으면
        // 에이전트는 이 안내를 만족시키려 시도했다가 조용히 실패하고 같은 자리를 돈다 —
        // 못 여는 것을 아는 것이 사람에게 물어볼 근거가 된다.
        download: `GET /attachments/${id} (Authorization: Bearer $MURMUR_PAT) — needs shell/HTTP access; if you have neither, say so and ask the human instead of guessing`,
      });
    }

    let body: Buffer;
    try {
      body = await collect(await storage.read(resolved.attachment.storageKey));
    } catch (err) {
      if (err instanceof OversizeError) {
        return jsonResult({
          attachment: meta,
          note: `file is larger than its recorded size and exceeds ${IMAGE_MAX_BYTES}B`,
          download: `GET /attachments/${id} (Authorization: Bearer $MURMUR_PAT)`,
        });
      }
      if (err instanceof AttachmentMissingError) {
        // 행은 있는데 파일이 없다(#257). REST 와 같은 코드로 답한다 — 찾은 경로는 싣지
        // 않는다(서버 파일시스템 경로를 알려 주는 셈이고, 에이전트가 할 일이 달라지지 않는다).
        return jsonResult({
          error: { code: 'attachment_missing', message: 'attachment file not found on the server' },
        });
      }
      throw err;
    }

    // 텍스트 한 줄을 그림 **앞에** 같이 싣는다. 그림만 주면 에이전트는 자기가 무엇을 보고
    // 있는지(어느 첨부인지) 말할 수 없어, 나중에 "그 스크린샷"을 가리킬 근거가 없다.
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ attachment: meta }) },
        { type: 'image' as const, data: body.toString('base64'), mimeType: contentType },
      ],
    };
  });

  return server;
}

export async function registerMcp(
  app: FastifyInstance,
  pool: Pool,
  lifecycle: Lifecycle,
  agentPresence: AgentPresence,
  storage: StorageBackend,
): Promise<void> {
  app.post('/mcp', async (req, reply) => {
    if (!req.account || req.account.kind !== 'agent') {
      return reply.code(req.account ? 403 : 401)
        .send({ error: { code: 'agent_only', message: 'MCP surface requires an agent PAT' } });
    }
    /**
     * **이 요청 자체가 생존 신호다.** 예전에는 `inbox.poll` 안에서만 mark 했는데, 러너
     * 루프는 단일 스레드라 **턴이 도는 동안 폴이 나가지 않는다** — 30초 TTL 이 만료돼
     * 일하는 중인 에이전트가 `online` 에서 빠지고, 화면은 그것을 "마지막 말이 진행인데
     * 저자가 살아 있지 않다"로 읽어 스레드를 **'막힘'** 으로 칠했다. 실패한 적이 없는데도.
     *
     * 그래서 게이트 바로 뒤에 둔다: 여기를 지난 요청은 **에이전트 PAT 로 온 것**이
     * 확정이므로(위 분기), 도구 하나하나에 mark 를 흩는 것보다 정확하고 빠뜨릴 수 없다.
     * 진행 메시지를 올리는 것도, 메모리를 읽는 것도 전부 "나 여기 있다"다.
     */
    agentPresence.mark(req.account.id);
    const server = buildMcpServer(pool, req.account, lifecycle, storage, agentPresence);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: { code: 'internal', message: 'mcp transport failure' } }));
      }
    }
  });
}
