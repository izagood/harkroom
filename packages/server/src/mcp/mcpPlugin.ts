import { delegateApiGrant, listDelegations, revokeDelegation } from '../services/apiDelegation.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  ASK_MAX_OPTIONS, ASK_MIN_OPTIONS, MAX_MESSAGE_BODY_CHARS,
  MODEL_ID_MAX, REPORT_MAX_ITEMS, REPORT_MAX_NEXT, TEAM_ROUND_LIMIT,
  ACCOUNT_GATE_LABEL_PATTERN, FAILURE_CODES, type AccountView, type AskAudience, type AskMeta, type DelegationMeta, type FailureMeta,
  type MessageRow, type ModelMeta, type ReportMeta,
} from '@harkroom/shared';
import { CAUSE_HEADER } from '@harkroom/shared/runnerLink';
import { denormalizeBodies, normalizeSearchQuery } from '../services/mentions.js';
import { emitEvent, emitPosted, onEvent } from '../events.js';
import type { Lifecycle } from '../lifecycle.js';
import { assertChannelVisible, audienceFor, getChannelDoc, listChannels } from '../services/channels.js';
import { BAD_THREAD_MESSAGE, checkAskMirror, checkAskSupersede, getMessageById, gateAwaitingAccount, listInbox, listMessages, markInboxRead, notifyGateAwaiting, postMessage, searchInput, searchMessages, supersedeAsk, syncAskMirrors, type AskMirrorRefusal, type AskSupersedeRefusal } from '../services/messages.js';

/** `message.ask` 의 `mirrorOf` 거절 사유 — 에이전트가 읽고 고칠 수 있게 무엇을 바꾸면 되는지 적는다. */
const MIRROR_REFUSAL_MESSAGE: Record<AskMirrorRefusal, string> = {
  mirror_not_found: 'no choice request with that id that you can see',
  mirror_of_mirror: 'that card is itself a mirror; point mirrorOf at its original',
  mirror_not_human: 'only a card addressed to humans can be mirrored',
  mirror_options_mismatch: "options must carry exactly the original card's option ids",
  mirror_resolved: 'the original card is already answered or closed',
};

/** `message.ask` 의 `supersedes` 거절 사유(2026-10-09). */
const SUPERSEDE_REFUSAL_MESSAGE: Record<AskSupersedeRefusal, string> = {
  supersedes_not_found: 'no choice request with that id',
  supersedes_not_yours: 'you can only replace a card you posted',
  supersedes_other_thread: 'the new card must go in the same thread as the card it replaces',
  supersedes_resolved: 'that card is already answered, declined, or replaced',
  supersedes_permission_card: 'a permission-request card ends only by the owner approving or denying it',
};
import {
  createDelegation, leadTeamFor, roundsUsed,
  DELEGATION_DEADLINE_DEFAULT_SEC, DELEGATION_DEADLINE_MAX_SEC, DELEGATION_DEADLINE_MIN_SEC,
} from '../services/delegations.js';
import { addReaction, isEmoji, MAX_REACTIONS_PER_ACTOR, removeReaction } from '../services/reactions.js';
import {
  listMemoryIndex, MAX_CORE_MEMORY_LENGTH, MAX_JOURNAL_MEMORIES_PER_ACCOUNT, MAX_MEMORY_DESCRIPTION_LENGTH,
  MAX_MEMORY_ITEMS_PER_ACCOUNT, MAX_MEMORY_VALUE_LENGTH, MEMORY_KINDS, memoryRev, readMemoryCounted, searchMemory, auditMemory,
  setMemory, lastCleanRevision, coreSections, listMemoryRevisions,
} from '../services/memory.js';
import {
  acquireMemoryLease, archiveMemory, memoryLeaseStatus, memoryWarnings, mergeMemory, releaseMemoryLease, restoreMemory,
  unarchiveMemory, MEMORY_LEASE_DEFAULT_MINUTES, MEMORY_LEASE_MAX_MINUTES, MAX_ARCHIVED_MEMORIES_PER_ACCOUNT,
} from '../services/memoryCurate.js';
import { randomUUID as newLeaseToken } from 'node:crypto';
import { proposeSkill, isValidSkillSlug } from '../services/skills.js';
import { scanWrite } from '../services/contentScan.js';
import { listAutomationsForAgent, proposeAutomation, runAutomationForAgent, triggerSchema } from '../services/automations.js';
import { channelPostGate } from '../services/channels.js';
import { announceReportWakes, scheduleWake, WAKE_MAX_SEC, WAKE_MIN_SEC } from '../services/agentWakes.js';
import { guideFor } from './guide.js';
import { listWorkItems, removeWorkItem, resolveWorkItemOwner, upsertWorkItem, WORK_ITEM_REFUSAL_MESSAGE, WORK_ITEM_SOURCES } from '../services/workItems.js';
import { workItemUpsertSchema } from '../routes/workItemRoutes.js';
import { listTeams } from '../services/teams.js';
import { listHandleGroups } from '../services/handleGroups.js';
import { recordClaudeLane } from '../services/claudeLane.js';
import { recordRunnerVersion } from '../services/runnerVersion.js';
import { recordUpload, resolveAttachmentFor } from '../services/attachments.js';
import { ARTIFACT_PUBLISH_ARG_MAX_BYTES, ARTIFACT_REJECTION_MESSAGES, attachArtifactVersion } from '../services/artifacts.js';
import { reportedModelMeta } from '../services/reportedModel.js';
import { axisValid, getThreadAgentModel } from '../services/threadAgentModels.js';
import { applyAgentPicks, cleanPicks, type PickChange } from '../services/agentModelPicks.js';
import { agentModelOptions, announceChange, checkOffered, emitChanged } from '../routes/threadAgentModelRoutes.js';
import type { OperatorHub } from '../ws/operatorHub.js';
import { AttachmentMissingError, type StorageBackend } from '../storage/local.js';
import { Readable } from 'node:stream';
import { downscaleImage, DOWNSCALE_READ_MAX_BYTES, tryAcquireDownscaleSlot } from './imageDownscale.js';

// slug 문법과 거절 문구는 services/memory.ts 에 있다 — 사람용 REST(accountRoutes)도 같은 것을 쓴다.
import { isValidSlug, MEMORY_SLUG_HINT } from '../services/memory.js';
import { listGrantedSecrets } from '../services/secretAccess.js';
import { collectStrings, SECRET_IN_BODY, type SecretLeakGuard } from '../services/secretLeakGuard.js';
import type { AgentPresence } from './presence.js';
import { enqueueAskPush } from '../services/push/pushJobs.js';
import { DENIAL_CARD_REFUSAL_MESSAGE, prepareDenialCard } from '../services/mergeDenials.js';
import { linkPermissionCard, openPermissionRequest, permissionCardBody, permissionCardOptions, releaseGrant } from '../services/permissionRequests.js';

/**
 * 발화 도구가 공통으로 받는 `model` — 에이전트가 신고하는 **자기 모델 ID**(#600).
 *
 * 옵셔널인 이유는 두 가지다. ① 사람의 PAT 으로도 이 도구를 부를 수 있고 사람에게는 모델이
 * 없다. ② 모델을 못 아는 하네스(또는 옛 러너)도 계속 발화할 수 있어야 한다 — 필수로 두면
 * 프롬프트를 못 받은 러너의 답이 통째로 막힌다. 모르면 생략하고, 그때 화면은 아무것도
 * 그리지 않는다.
 */
const MODEL_ARG = z.string().min(1).max(MODEL_ID_MAX).optional();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 미리보기 제목을 파일명으로 — 받은 파일이 무엇인지 보이게. 경로 성분·제어문자는 `displayName` 이 한 번 더 지운다. */
function slugFilename(title: string): string {
  const slug = title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 80);
  return slug || 'preview';
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/** 게시 거절을 도구 결과로. 첨부 사유 셋은 한 코드로 합친다(라우트와 같은 이유 — 존재 여부를 흘리지 않는다). */
/** `/mcp` 본문 상한 — `artifact.publish` 의 2MB 인자가 JSON 이스케이프로 부풀어도 들어가게. */
const MCP_BODY_LIMIT_BYTES = 2 * ARTIFACT_PUBLISH_ARG_MAX_BYTES + 512 * 1024;

function postFailureResult(failure: string) {
  if (failure === 'bad_thread') return jsonResult({ error: { code: 'bad_thread', message: BAD_THREAD_MESSAGE } });
  return jsonResult({ error: { code: 'bad_attachment', message: 'attachments must be your own, unused uploads' } });
}

/**
 * 발화 도구의 결과 — `{ message, notified }` 에 **못 부른 이름**을 앞세운다(2026-09-29).
 *
 * 막힌 부름(`mentionChainCapped`·`mentionDenied`)은 meta 에 남아 화면에는 그려지지만, 발화한
 * 에이전트는 `notified: []` 만 보고 "불렀다"고 믿은 채 턴을 끝냈다 — task_manager 가 담당을
 * 부른 글이 상한에 막히고 사람이 직접 부르기 전까지 위임이 조용히 끊겼다(#harkroom seq 3336).
 * 그래서 사유와 다음 할 일을 문장으로 준다. JSON 의 맨 앞 키로 두는 것은 에이전트가 결과를
 * 끝까지 읽지 않아도 보게 하려는 것이다.
 */
function postedResult(message: MessageRow, notified: string[], extra: Record<string, unknown> = {}) {
  const meta = (message.meta ?? {}) as Record<string, unknown>;
  const capped = Array.isArray(meta.mentionChainCapped) ? meta.mentionChainCapped as string[] : [];
  const denied = Array.isArray(meta.mentionDenied) ? meta.mentionDenied as string[] : [];
  const warnings: string[] = [];
  if (capped.length) {
    warnings.push(
      `${capped.map((h) => `@${h}`).join(', ')} 를 부르지 못했다: 멘션 연쇄 상한 ${String(meta.mentionChainLimit)} 에 닿았다`
      + ' (사람 없이 에이전트끼리 이어진 부름이 너무 길다). 사람에게 message.ask 로 넘겨라.',
    );
  }
  if (denied.length) {
    warnings.push(
      `${denied.map((h) => `@${h}`).join(', ')} 를 부르지 못했다: 너는 그 에이전트의 호출 범위(invokeScope) 밖이다.`
      + ' 사람에게 message.ask 로 넘기거나 소유자에게 호출 범위를 물어라.',
    );
  }
  return jsonResult(warnings.length ? { warnings, message, notified, ...extra } : { message, notified, ...extra });
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
 * 넘는 것을 **거절하지 않는다** — 32MiB 까지는 줄인 사본을 싣고(`imageDownscale.ts`),
 * 그보다 크거나 줄이지 못하면 메타데이터로 떨어뜨린다. 그래야 에이전트가 "무엇이
 * 왔는지"는 알고, 정말 필요하면 REST 로 스트리밍해 받는다. 여기서 200MB 를 통째로
 * base64 로 만들면 서버 메모리와 모델 컨텍스트를 함께 태운다.
 */
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * 텍스트로 실을 타입(#609). **이것도 허용 목록이다** — 위 `IMAGE_TYPES` 와 같은 이유로
 * `contentType` 을 신뢰하지 않는다.
 *
 * ## 왜 "이미지가 아닌 것은 텍스트" 가 아닌가
 *
 * 그 규칙은 한 자리에서 어긋난다: **`image/svg+xml` 은 텍스트인데 이미지 이름을 달고 있다.**
 * 반대 방향의 함정이라 눈에 잘 안 띈다 — SVG 를 그림으로 싣지 않기로 한 판단(`IMAGE_TYPES`
 * 주석)만 지키고 "나머지는 텍스트" 로 흘리면, 마크업이 그대로 모델 컨텍스트에 실린다.
 * **그리고 허용 목록으로 쓴다고 저절로 빠지지도 않는다.** 이 함수의 첫 판본은 `+xml` 접미를
 * 타입 전체에서 봤고, `image/svg+xml` 이 그 조건에 그대로 걸렸다 — 회귀선 `does not inline
 * svg as an image` 가 그것을 잡았다. 그래서 접미 규칙을 **`application/` 아래로 한정한다**:
 * SVG 는 `text/*` 도 `application/*` 도 아니므로 이제 규칙이 판정으로 빼낸다. 다음 사람이
 * SVG 를 기억해야 하는 것이 아니다.
 *
 * `+json`·`+xml` 접미를 받는 이유: `application/vnd.…+json` 같은 것이 실제로 올라온다.
 * 구조는 JSON 이고 사람이 읽는 것도 JSON 이다.
 *
 * ## REST 의 `NEVER_INLINE` 과 왜 다른가
 *
 * 그쪽은 `text/html` 을 막는데(`attachmentRoutes.ts`), 이유가 **브라우저가 그것을 렌더한다**
 * 는 것이다 — XSS 통로. 여기서 돌려주는 것은 도구 응답의 문자열이고 렌더하는 것이 없다.
 * 그래서 같은 목록을 쓰지 않는다. 모델이 첨부 내용에 적힌 지시를 읽는 문제는 남지만,
 * 그것은 `.txt` 에도 똑같이 있고 타입으로 가를 수 있는 종류가 아니다.
 */
function isTextType(contentType: string): boolean {
  const type = contentType.split(';', 1)[0]!.trim().toLowerCase();
  if (type.startsWith('text/')) return true;
  if (!type.startsWith('application/')) return false;
  return type === 'application/json'
    || type === 'application/xml'
    || type.endsWith('+json')
    || type.endsWith('+xml');
}

/**
 * 응답에 실어 줄 텍스트의 최대 크기(#609). **이미지의 3MiB 를 그대로 쓰지 않는다** —
 * 이미지는 base64 로 부풀지만 소비하는 것은 한 장이고, 텍스트는 **토큰을 그 길이만큼**
 * 태운다. 3MiB 로그 하나가 컨텍스트를 통째로 먹으면 에이전트는 그것을 받고도 아무것도
 * 못 한다.
 *
 * 256KiB 는 사람이 붙이는 로그·diff 대부분이 통째로 들어오는 크기이면서, 넘는 경우에도
 * 앞뒤를 보여 주기에 넉넉하다.
 */
const TEXT_MAX_BYTES = 256 * 1024;

/**
 * 텍스트를 **읽기라도 해 볼** 상한. 넘으면 이미지와 같이 메타데이터로 떨어뜨린다.
 *
 * 왜 `TEXT_MAX_BYTES` 와 따로인가: 자르더라도 **뒤쪽**을 보여 주려면 파일 끝까지 읽어야
 * 하고(로그는 실패가 끝에 있다), 그러려면 한 번은 메모리에 들어와야 한다. 그 비용의
 * 상한이 이 값이다. 이것마저 넘는 파일은 잘라 주는 것보다 "REST 로 받아라" 가 정직하다.
 */
const TEXT_READ_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 스트림을 메모리로 모은다. 도구 응답은 base64 **문자열** 하나라 스트리밍할 수가 없다 —
 * REST 는 스트림을 그대로 흘려보내지만 여기서는 전부 손에 들어야 한다.
 *
 * 모으는 동안에도 한계를 다시 센다. 위에서 `sizeBytes` 로 이미 걸렀지만 그것은 **DB 가
 * 기억하는 크기**다. 파일이 그것과 다르면(잘못된 마이그레이션·수동 조작) 한계가 없는 것과
 * 같아지므로, 실제로 흘러온 바이트로 한 번 더 막는다.
 *
 * `limit` 을 인자로 받는 이유(#609): 이미지와 텍스트의 상한이 다르다. 상수를 여기서
 * 직접 읽으면 텍스트 경로가 이미지의 한계에 묶인다.
 */
async function collect(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += (chunk as Buffer).length;
    if (total > limit) {
      stream.destroy();
      throw new OversizeError(`read ${total}B, over the inline limit`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * UTF-8 로만 디코딩한다. **못 읽으면 텍스트가 아니다**(#609).
 *
 * `fatal: true` 가 요점이다. 기본 디코더는 깨진 바이트를 `U+FFFD` 로 바꿔 **조용히**
 * 성공하고, 그러면 에이전트는 깨진 글자가 원본인지 인코딩 사고인지 구별할 수 없다.
 * 그 구별이 안 되면 "내용은 알지만 틀렸다"가 되어 원래 결함보다 나쁘다 — 차라리
 * 메타데이터로 떨어뜨리고 사람에게 묻게 한다.
 */
function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 길면 **앞뒤를 남기고 가운데를 버린다**(#609). 자른 것은 본문 안에서도 보인다 — 응답의
 * `truncated` 만으로는 잘린 자리가 어디인지 알 수 없고, 에이전트가 이어진 줄로 오독한다.
 *
 * 앞만 남기지 않는 이유: 로그는 **끝**에 실패가 있고 diff 는 **앞**에 파일 이름이 있다.
 * 둘 다 붙는 통로라 한쪽만 고르면 절반의 경우에 쓸모가 없다.
 *
 * 바이트가 아니라 **디코딩한 뒤** 자른다. 바이트로 자르면 문자 가운데를 갈라 깨진 글자를
 * 만든다 — 위 `decodeUtf8` 이 막으려던 바로 그것을 여기서 만들어 내는 셈이다.
 * 대리쌍(surrogate pair)도 같은 이유로 경계에서 한 칸 물러선다.
 */
function truncateText(text: string, limit: number): { text: string; dropped: number } | null {
  if (Buffer.byteLength(text, 'utf8') <= limit) return null;
  const half = Math.floor(limit / 2);
  const head = sliceBytes(text, half, 'head');
  const tail = sliceBytes(text, half, 'tail');
  const dropped = text.length - head.length - tail.length;
  // 앞뒤가 겹칠 만큼 짧으면 자를 것이 없다. 바이트로는 한계를 넘었는데 **글자 수**로는
  // 넘지 않는 경우(한 글자가 여러 바이트)에 이 조건이 성립한다.
  if (dropped <= 0) return null;
  return {
    text: `${head}

… [${dropped} characters omitted — fetch the whole file over REST] …

${tail}`,
    dropped,
  };
}

/**
 * 앞(또는 뒤)에서 **UTF-8 로 `maxBytes` 안에 들어오는 가장 긴 조각**을 준다.
 *
 * 글자 수로 자르면 안 되는 이유가 이 함수가 있는 이유다: 한계는 바이트인데 한글은 한 글자가
 * 3바이트다. 첫 판본은 `limit / 2` 를 글자 수로 썼고, 그래서 한글 20만 자(600KB)에서 앞뒤
 * 조각이 원본보다 길어져 **잘라낸 양이 음수**로 나왔다 — 회귀선이 그것을 잡았다.
 *
 * 이분 탐색인 이유: `Buffer.byteLength` 는 O(n) 이라 한 글자씩 세면 O(n²) 이 된다. 여기에는
 * 4MiB 까지 들어오므로 그 차이가 실제로 보인다.
 */
function sliceBytes(text: string, maxBytes: number, from: 'head' | 'tail'): string {
  const take = (n: number) => (from === 'head' ? text.slice(0, n) : text.slice(text.length - n));
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(take(mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // 경계가 대리쌍(surrogate pair) 한가운데면 그 반쪽을 버린다 — 남기면 그것이 곧
  // `decodeUtf8` 이 막으려던 깨진 글자다.
  return from === 'head' ? backOffSurrogate(take(lo)) : forwardOffSurrogate(take(lo));
}

/** 끝이 대리쌍의 앞쪽 반이면 그 한 칸을 버린다. */
function backOffSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

/** 시작이 대리쌍의 뒤쪽 반이면 그 한 칸을 버린다. */
function forwardOffSurrogate(s: string): string {
  const first = s.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? s.slice(1) : s;
}

/** 파일이 DB 가 기억하는 크기보다 큰 경우. 이 하나만 위 `collect` 가 던진다. */
class OversizeError extends Error {}

/**
 * 다른 에이전트를 부르며 그 스레드의 모델을 고른다(087, 결정 1). 두 축이 다 null 이면 "풀기" 다.
 * 사람 작성창의 `agentModels[]` 와 같은 모양이다.
 */
const AGENT_MODELS_ARG = z.array(z.object({
  agentId: z.string().uuid(),
  model: z.string().max(MODEL_ID_MAX).nullable().optional(),
  effort: z.string().max(64).nullable().optional(),
})).max(8).optional();

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
  /** 이 요청을 낸 턴의 원인 메시지(`CAUSE_HEADER`). 발화 도구가 `postMessage` 에 넘긴다. */
  cause: string | null = null,
  /** 본문 거절(D5). null 이면 보관소가 꺼져 있다. */
  leakGuard: SecretLeakGuard | null = null,
  operatorId: string | null = null,
  /** 오퍼레이터 능력(하네스가 밝힌 모델·effort) — 에이전트의 모델 고르기가 `checkOffered` 로 본다. */
  operatorHub?: OperatorHub,
): McpServer {
  const server = new McpServer({ name: 'harkroom', version: '0.1.0' });

  /**
   * 고른 값을 다듬고, **하네스가 밝힌 목록**(`checkOffered`)을 게시 전에 본다 — 사람 경로와 같은
   * 함수다. 나머지 판정(대상·허용 목록·사람 우선·횟수)은 게시 트랜잭션 안의 `applyAgentPicks` 가 한다.
   */
  async function preparePicks(raw: z.infer<typeof AGENT_MODELS_ARG>) {
    const list = cleanPicks(raw ?? []);
    for (const p of list) {
      if (p.model === null && p.effort === null) continue;
      if (!axisValid(p.model) || !axisValid(p.effort)) {
        return { error: { code: 'bad_model_value', message: '모델·effort 는 영숫자로 시작하고 영숫자·._:/[]- 만 쓴다' } };
      }
      const offered = await checkOffered(pool, operatorHub, p.agentId, p.model, p.effort);
      if (!offered.ok) return { error: { code: offered.code, message: offered.message } };
    }
    return { list };
  }
  /**
   * 비밀 보관소 D5: 에이전트의 **모든 도구 인자**에 grant 받은 비밀 값이 있으면 그 도구를 돌리지 않는다.
   * 도구마다 검사를 흩지 않고 등록 자리에서 감싼다 — 새 도구가 생겨도 빠지지 않는다. 오류는 고정 문장이고
   * 어느 비밀인지 되비추지 않는다. 입력 스키마가 없는 도구는 첫 인자가 extra 라 볼 것이 없다.
   */
  if (leakGuard && account.kind === 'agent') {
    const guard = leakGuard;
    const register = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
    (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, handler: unknown) => {
      const hasInput = !!(config as { inputSchema?: unknown }).inputSchema;
      const run = handler as (...a: unknown[]) => unknown;
      return register(name, config, async (...a: unknown[]) => {
        if (hasInput) {
          const hits = await guard.findInTexts(account.id, collectStrings(a[0]));
          if (hits.length) {
            await guard.record(null, account.id, operatorId, hits, `mcp:${String(name)}`);
            return jsonResult({ error: SECRET_IN_BODY });
          }
        }
        return run(...a);
      });
    };
  }

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

  /**
   * 다른 에이전트를 부르며 고를 수 있는 모델(087, 결정 1·3). 그 에이전트 **소유자가 켠 목록**과
   * 하네스가 밝힌 목록의 교집합만 준다 — 둘 중 하나라도 비면 고를 것이 없다(`pickable: []`).
   * 하네스 목록을 모르면(오퍼레이터가 오프라인) 소유자 목록을 그대로 주고 `efforts` 는 싣지 않는다.
   * 자기 자신의 모델은 고를 수 없으므로 자기 handle 이면 빈 목록과 그 사유를 준다.
   */
  server.registerTool('agent.modelOptions', {
    description: '다른 에이전트를 부를 때 agentModels 로 고를 수 있는 모델(그 소유자가 켠 것). handle 로 묻는다',
    inputSchema: { handle: z.string().min(1).max(64) },
  }, async ({ handle }) => {
    const found = await pool.query<{ id: string }>(
      `select id from account where lower(handle) = lower($1) and kind = 'agent' and deleted_at is null`,
      [handle.replace(/^@/, '')]);
    if (!found.rowCount) return jsonResult({ error: { code: 'unknown_handle', message: `no agent with handle @${handle}` } });
    const agentId = found.rows[0]!.id;
    if (agentId === account.id) {
      return jsonResult({ agentId, pickable: [], reason: '자기 자신의 모델은 고를 수 없다 — 사람만 바꾼다' });
    }
    const opts = await agentModelOptions(pool, operatorHub, agentId);
    if (!opts) return jsonResult({ error: { code: 'unknown_handle', message: `no agent with handle @${handle}` } });
    // (모델·effort) 조합(결정 11): 허용 목록의 effort 를 주되, 하네스가 그 모델에 대해 밝힌 effort 가 있으면
    // 그 교집합만 준다. 하네스 목록을 모르면 허용 목록 그대로다(서버는 그래도 목록 밖을 거절한다).
    const pickable = opts.pickable.flatMap((e) => {
      const offered = opts.models?.find((m) => m.id === e.model);
      if (opts.models && !offered) return [];
      const efforts = offered?.efforts ? e.efforts.filter((x) => offered.efforts!.includes(x)) : e.efforts;
      return [{ id: e.model, ...(offered?.label ? { label: offered.label } : {}), efforts }];
    });
    return jsonResult({
      agentId, harness: opts.harness, defaultModel: opts.model, defaultEffort: opts.effort, pickable,
      ...(pickable.length ? {} : { reason: '그 에이전트의 소유자가 고를 수 있는 모델을 켜지 않았다' }),
    });
  });

  /**
   * handle → id 를 푸는 표. 워크스페이스 가이드의 「이름이 아니라 id 로」 절이 이 도구를 가리킨다 —
   * 규칙만 주고 남의 id 를 얻을 길을 안 주면 에이전트는 결국 이름을 적는다(2026-09-28).
   *
   * 사람 화면의 `GET /accounts` 와 같은 가시성(로그인한 계정이면 누구나)이고, 거기서 이름을 푸는 데
   * 필요한 열만 싣는다 — 상태·아바타·소유자는 에이전트가 기록할 키가 아니다. 비활성·삭제 계정을
   * 빼지 않는 이유도 그 라우트와 같다: 지난 기록의 id 를 이름으로 되짚는 표이기도 하다.
   * 팀·집합은 `listTeams`·`listHandleGroups` 하나가 낸다(질의 사본을 두지 않는다 — #285).
   */
  server.registerTool('account.list', { description: '계정·팀·집합 목록(handle → id 조회)' },
    async () => {
      const res = await pool.query(
        `select id, handle, display_name as "displayName", kind,
                disabled_at is not null as disabled, deleted_at is not null as deleted
         from account order by handle`,
      );
      const teams = (await listTeams(pool)).map((t) => ({ id: t.id, name: t.name, leadAccountId: t.leadAccountId }));
      const groups = (await listHandleGroups(pool)).map((g) => ({ id: g.id, handle: g.handle }));
      return jsonResult({ accounts: res.rows, teams, groups });
    });

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

  // REST `/search` 와 **같은 함수·같은 입력 조각**(`searchInput`)이다(S2). 가시성 판단은 `searchMessages`
  // 하나에만 있고, 여기는 인자를 옮겨 줄 뿐이다 — 두 벌로 두면 한쪽만 고쳐지는 날이 온다.
  server.registerTool('message.search', {
    description: '메시지 전문 검색 — 볼 수 있는 대화 전체(channelId·threadRootId 로 좁힘). 보낸 사람(authorIds, 계정 id 최대 10개 — account.list 로 얻는다)·기간(after·before, 시간대 붙은 ISO, [after, before))·첨부 있는 것만(hasAttachment)·정렬(relevance 기본 | recent)으로 거른다. 50개씩, hasMore 면 offset 으로 다음 묶음',
    inputSchema: {
      query: searchInput.query,
      channelId: z.string().uuid().optional(),
      threadRootId: z.string().uuid().optional(),
      offset: searchInput.offset.optional(),
      authorIds: searchInput.authorIds.optional(),
      after: searchInput.time.optional(),
      before: searchInput.time.optional(),
      hasAttachment: z.boolean().optional(),
      sort: searchInput.sort.optional(),
    },
  }, async ({ query, channelId, threadRootId, offset, authorIds, after, before, hasAttachment, sort }) => {
    // 볼 수 없는 채널을 범위로 주면 REST 의 403 과 같은 거절 — 빈 결과로 답하면 "못 보는 채널"과
    // "일치가 없는 채널"이 구분되지 않는다(message.read 와 같은 문장).
    if (channelId && !(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    // 검색어도 본문과 같은 규칙으로 정본에 맞춘다(`@handle` → `<@id>`).
    const page = await searchMessages(pool, account.id, await normalizeSearchQuery(pool, query), {
      channelId: channelId ?? null,
      threadRootId: threadRootId ?? null,
      offset: offset ?? 0,
      authorIds: authorIds ?? null,
      after: after ?? null,
      before: before ?? null,
      hasAttachment: hasAttachment ?? null,
      sort: sort ?? 'relevance',
    });
    return jsonResult({ messages: await denormalizeBodies(pool, page.messages), hasMore: page.hasMore });
  });

  server.registerTool('message.post', {
    description: '채널 또는 스레드에 메시지 발화',
    inputSchema: {
      channelId: z.string().uuid(),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
      threadRootId: z.string().uuid().optional(),
      alsoInChannel: z.boolean().optional(),
      // 내가 올린, 아직 아무 글에도 안 붙은 업로드(`attachment.upload` 가 돌려준 id). REST 와 같은 상한이다.
      attachmentIds: z.array(z.string().uuid()).max(10).optional(),
      model: MODEL_ARG,
      agentModels: AGENT_MODELS_ARG,
    },
  }, async ({ channelId, body, threadRootId, alsoInChannel, attachmentIds, model, agentModels }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const picks = await preparePicks(agentModels);
    if ('error' in picks) return jsonResult({ error: picks.error });
    let changes: PickChange[] = [];
    const posted = await postMessage(pool, {
      causeMessageId: cause,
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null, alsoInChannel,
      attachmentIds: attachmentIds ?? [],
      meta: await reportedModelMeta(pool, account.id, model, threadRootId ?? null),
      ...(picks.list.length ? {
        beforeCommit: async (client, ctx) => {
          const out = await applyAgentPicks(client, {
            channelId, threadRootId: threadRootId ?? ctx.message.id, actorId: account.id,
            picks: picks.list, notified: ctx.notified,
          });
          if (!out.ok) return out.rejection;
          changes = out.changes;
          return null;
        },
      } : {}),
    });
    if (posted.failure === 'rejected') return jsonResult({ error: { code: posted.rejection.code, message: posted.rejection.message } });
    // 첨부 연결 실패(남의 업로드·이미 붙은 업로드·없는 id)는 REST 와 같은 판정이다(`attachToMessage`).
    if (posted.failure) return postFailureResult(posted.failure);
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const audience = await audienceFor(pool, channelId);
      emitPosted(posted, audience);
      // 지정이 바뀌었으면 시스템 줄·이벤트(커밋 뒤). 러너는 턴 시작에 실효값을 읽으므로 이 순서가
      // 첫 턴에 닿는다 — 행은 이미 위 트랜잭션에서 커밋됐다.
      for (const c of changes) {
        await announceChange(pool, channelId, threadRootId ?? message.id, account.id, c.agentId, c.row, 'agent');
        await emitChanged(pool, channelId, threadRootId ?? message.id, c.agentId, c.row);
      }
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
    return postedResult(message, notified);
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
      causeMessageId: cause,
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null, kind: 'progress',
      meta: await reportedModelMeta(pool, account.id, model, threadRootId ?? null),
    });
    if (posted.failure) return postFailureResult(posted.failure);
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const audience = await audienceFor(pool, channelId);
      emitPosted(posted, audience);
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return postedResult(message, notified);
  });

  /**
   * 미리보기(아티팩트) 올리기(2026-10-02). 디자인 안·보고서 같은 HTML 한 장을 **글 하나로** 올린다 —
   * 사람은 그 글의 카드를 눌러 앱 안에서 바로 본다(`GET /preview/:token`, 격리는 previewRoutes 주석).
   * claude.ai 아티팩트 링크는 그 브라우저에 로그인한 사람만 열고, 폰에서는 막힌다 — 이 도구가 그 대신이다.
   *
   * 페이지는 둘 중 하나로 받는다: `html` 글자(2MB 까지 — 모델이 어차피 글자로 쓴다) 또는 `attachmentId`
   * (브릿지 `attachment.upload` 로 올린 내 파일, 5MB 까지). 표지 그림은 선택이다.
   *
   * 고쳐 올릴 때는 `artifactId` 를 준다 → 같은 안의 v(n+1) 이 **새 글**로 올라간다. 옛 글은 그때
   * 버전을 그대로 가리킨다. 같은 채널·내가 만든 안에만 얹을 수 있다(`attachArtifactVersion`).
   *
   * 메시지·첨부 연결·버전 행은 `postMessage` 의 한 트랜잭션이다. `html` 로 받은 바이트는 그보다 먼저
   * 디스크·업로드 행으로 쓰고, 게시가 실패하면 지운다(실패해도 붙지 않은 업로드라 GC 대상이기도 하다).
   */
  server.registerTool('artifact.publish', {
    description: 'HTML 미리보기(디자인 안 등)를 글로 올린다 — 사람이 앱 안에서 바로 연다. claude.ai 아티팩트 링크 대신 쓴다. html 글자 또는 attachment.upload 로 올린 파일 id, 고쳐 올릴 땐 artifactId',
    inputSchema: {
      channelId: z.string().uuid(),
      threadRootId: z.string().uuid().optional(),
      title: z.string().trim().min(1).max(200),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
      html: z.string().min(1).optional(),
      attachmentId: z.string().uuid().optional(),
      coverAttachmentId: z.string().uuid().optional(),
      artifactId: z.string().uuid().optional(),
      summary: z.string().trim().min(1).max(500).optional(),
      model: MODEL_ARG,
    },
  }, async ({ channelId, threadRootId, title, body, html, attachmentId, coverAttachmentId, artifactId, summary, model }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    if ((html === undefined) === (attachmentId === undefined)) {
      return jsonResult({ error: { code: 'bad_request', message: 'give exactly one of html or attachmentId' } });
    }

    // html 글자로 받았으면 먼저 업로드 행으로 만든다 — 그래야 아래가 파일로 받은 경우와 한 길이다.
    let uploaded: { id: string; storageKey: string } | null = null;
    if (html !== undefined) {
      const bytes = Buffer.from(html, 'utf8');
      if (bytes.length > ARTIFACT_PUBLISH_ARG_MAX_BYTES) {
        return jsonResult({ error: { code: 'too_large', message: `html exceeds ${ARTIFACT_PUBLISH_ARG_MAX_BYTES / 1024 / 1024}MB — write it to a file and use attachment.upload` } });
      }
      const stored = await storage.write(Readable.from([bytes]));
      try {
        const row = await recordUpload(pool, {
          uploaderId: account.id, filename: `${slugFilename(title)}.html`, contentType: 'text/html',
          sizeBytes: stored.bytes, storageKey: stored.key,
        });
        uploaded = { id: row.id, storageKey: stored.key };
      } catch (err) {
        await storage.remove(stored.key).catch(() => {});
        throw err;
      }
    }
    const htmlId = uploaded?.id ?? attachmentId!;

    let published: { artifactId: string; version: number } | null = null;
    const posted = await postMessage(pool, {
      causeMessageId: cause,
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null,
      attachmentIds: [htmlId, ...(coverAttachmentId ? [coverAttachmentId] : [])],
      meta: await reportedModelMeta(pool, account.id, model, threadRootId ?? null),
      beforeCommit: async (client) => {
        const out = await attachArtifactVersion(client, {
          channelId, actorId: account.id, title, htmlAttachmentId: htmlId,
          coverAttachmentId: coverAttachmentId ?? null, summary: summary ?? null, artifactId: artifactId ?? null,
        });
        if (!out.ok) return { status: 400, code: out.code, message: ARTIFACT_REJECTION_MESSAGES[out.code] };
        published = { artifactId: out.artifactId, version: out.version };
        return null;
      },
    });
    if (posted.failure) {
      // 글이 안 생겼다 — 이 도구가 만든 업로드는 아무도 가리키지 않는다. 지금 지운다.
      if (uploaded) {
        await pool.query(`delete from attachment where id = $1 and message_id is null`, [uploaded.id]).catch(() => {});
        await storage.remove(uploaded.storageKey).catch(() => {});
      }
      if (posted.failure === 'rejected') return jsonResult({ error: { code: posted.rejection.code, message: posted.rejection.message } });
      return postFailureResult(posted.failure);
    }
    const { message, notified, replayed } = posted;
    if (replayed && uploaded) {
      // 같은 요청의 재생이다 — 글은 앞서 만든 것이고, 방금 쓴 업로드는 아무 글에도 붙지 않았다. 지금 지운다
      // (security #1050 b: GC 가 치우긴 하지만 남길 이유가 없다).
      await pool.query(`delete from attachment where id = $1 and message_id is null`, [uploaded.id]).catch(() => {});
      await storage.remove(uploaded.storageKey).catch(() => {});
    }
    if (!replayed) {
      const audience = await audienceFor(pool, channelId);
      emitPosted(posted, audience);
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return postedResult(message, notified, { artifact: published });
  });

  /**
   * 권한 요청 줄을 열고 소유자 앞 권한 카드를 세운다 — `permission.request` 와 머지 거절 카드(P4, `message.ask` 의 `mergeDenialId`)가
   * 함께 쓴다. 카드는 일반 ask 꼴이라 데스크톱·모바일·웹 어디서든 [7일 허락하고 다시 시도]가 눌린다(ask-answer → decideFromCard).
   */
  const raisePermission = async (
    { kind, rule, repo, command, reason, channelId, threadRootId, model, denial }:
      { kind: 'tool' | 'merge' | 'command'; rule?: string; repo?: string; command?: string; reason: string; channelId: string; threadRootId: string; model?: string;
        denial?: { id: string; number: number; headSha: string; reason: 'not_granted' | 'cause_not_human' } },
  ) => {
    const opened = await openPermissionRequest(pool, { agentId: account.id, kind, rule, repo, command, reason, channelId, threadRootId, denial });
    if (!opened.ok) return jsonResult({ error: opened.refusal });
    if ('alreadyGranted' in opened) {
      return jsonResult({
        alreadyGranted: true, expiresAt: opened.alreadyGranted.expiresAt,
        message: kind === 'command' ? 'already granted in this thread — run exactly that command now' : 'already granted — it applies from the next turn in this channel',
      });
    }
    if ('existing' in opened) {
      return jsonResult({ requestId: opened.existing.requestId, cardMessageId: opened.existing.cardMessageId, pending: true, message: 'the same request is already waiting for the owner in this thread' });
    }
    const { requestId, meta: permissionRequest } = opened.created;
    const meta: AskMeta & Partial<ModelMeta> & { permissionRequest: typeof permissionRequest } = {
      kind: 'ask', ask: { options: permissionCardOptions(kind), to: { kind: 'human' }, prompt: '권한을 줄까?' },
      permissionRequest,
      ...(await reportedModelMeta(pool, account.id, model, threadRootId)),
    };
    const posted = await postMessage(pool, {
      causeMessageId: cause,
      channelId, authorId: account.id, body: permissionCardBody(permissionRequest, `@${account.handle}`), threadRootId,
      meta: meta as unknown as Record<string, unknown>,
    });
    if (posted.failure) return postFailureResult(posted.failure);
    const { message, notified, replayed } = posted;
    // replayed 여도 잇는다(security) — 앞 시도가 글만 세우고 잇기 전에 끊겼으면 카드가 요청 없이 남아 누르면 404 가 된다.
    await linkPermissionCard(pool, requestId, message.id);
    if (!replayed) {
      emitPosted(posted, await audienceFor(pool, channelId));
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
      // 받는 사람은 소유자 하나다 — 그 사람만 승인할 수 있다.
      if (permissionRequest.ownerAccountId && !notified.includes(permissionRequest.ownerAccountId)) {
        await enqueueAskPush(pool, permissionRequest.ownerAccountId, message.id);
      }
    }
    return jsonResult({ requestId, cardMessageId: message.id, pending: true, expiresAt: permissionRequest.expiresAt });
  };

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
    description: '갈림길에서 선택지를 내놓는다(고르면 즉시 진행). to 는 사람이면 생략, 특정 대상이면 handle. mirrorOf 는 다른 스레드의 사람 앞 카드 id — 같은 선택지 id 로 다시 세우면 사람이 여기서 고른 답이 원본에도 적힌다. 사람이 글로 답해 접힌 내 카드를 다시 물을 땐 supersedes 에 그 카드 id',
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
      /**
       * 다른 스레드의 **사람 앞 물음**을 여기 같은 선택지로 다시 세운다(원본 메시지 id).
       * 사람이 이 카드에 답하면 원본에도 같은 답이 그 사람 이름으로 적히고, 원본이 먼저
       * 정해지면 이 카드가 그 결과로 닫힌다. 답은 끝까지 사람이 누른다 — 대리 답이 아니다.
       */
      mirrorOf: z.string().uuid().optional(),
      /**
       * 이 카드가 **대신하는 내 옛 카드**의 id(2026-10-09). 사람이 글로 되물어 옛 카드가 접힌 뒤
       * 다시 물을 때 싣는다 — 옛 카드는 「새 질문으로 바뀜」으로 접혀 카드가 쌓이지 않는다.
       * 같은 스레드의 내 카드만, 답이 났거나 「답하지 않기」로 닫힌 것은 안 된다.
       */
      supersedes: z.string().uuid().optional(),
      /**
       * 머지 래퍼가 `not_granted` 와 함께 돌려준 `denialId`(스레드 febe9ff8 P3). 실으면 서버가 그 거절 기록으로 카드의 권한
       * 칸(저장소·PR·에이전트)을 채우고, 소유자에게 [7일 주기] 버튼이 뜬다. 선택지에는 「다시 머지」 같은 다음 걸음을 둔다 —
       * 권한 주기는 선택지가 아니다. 같은 날 같은 저장소면 새 카드 대신 있던 카드의 횟수가 오른다.
       */
      mergeDenialId: z.string().uuid().optional(),
      model: MODEL_ARG,
    },
  }, async ({ channelId, body, threadRootId, options, to, prompt, mirrorOf, supersedes, mergeDenialId, model }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    // 옵션 id 가 겹치면 답을 기록할 때 어느 것을 고른 것인지 정할 수 없다.
    const ids = new Set(options.map((o) => o.id));
    if (ids.size !== options.length) {
      return jsonResult({ error: { code: 'duplicate_option', message: 'option ids must be unique' } });
    }
    // 머지 거절 카드는 사람 앞 원본만이다(C1) — 거울 검사보다 먼저 막아야 어느 쪽을 실어도 같은 코드로 거절된다(security n2).
    if (mergeDenialId && (to || mirrorOf)) {
      return jsonResult({ error: { code: 'merge_denial_audience', message: 'a merge-denial card is addressed to humans; omit `to` and `mirrorOf`' } });
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
    if (mirrorOf) {
      // 거울은 사람이 누를 자리다 — 원본이 사람 앞이므로 거울도 사람 앞이어야 옮겨 적을 수 있다.
      if (audience.kind !== 'human') {
        return jsonResult({ error: { code: 'mirror_audience', message: 'a mirror card is always addressed to humans; omit `to`' } });
      }
      const refusal = await checkAskMirror(pool, { rootId: mirrorOf, callerId: account.id, optionIds: options.map((o) => o.id) });
      if (refusal) {
        return jsonResult({ error: { code: refusal, message: MIRROR_REFUSAL_MESSAGE[refusal] } });
      }
    }
    if (supersedes) {
      const refusal = await checkAskSupersede(pool, { oldId: supersedes, callerId: account.id, channelId, threadRootId: threadRootId ?? null });
      if (refusal) {
        return jsonResult({ error: { code: refusal, message: SUPERSEDE_REFUSAL_MESSAGE[refusal] } });
      }
    }
    // 머지 거절 카드(P3, security C1·C3). 권한 칸은 거절 기록에서만 채운다 — 에이전트가 쓴 본문·선택지와 섞지 않는다.
    if (mergeDenialId) {
      if (audience.kind !== 'human' || mirrorOf) {
        return jsonResult({ error: { code: 'merge_denial_audience', message: 'a merge-denial card is addressed to humans; omit `to` and `mirrorOf`' } });
      }
      const prepared = await prepareDenialCard(pool, { agentId: account.id, denialId: mergeDenialId, channelId, threadRootId: threadRootId ?? null });
      if (!prepared.ok) return jsonResult({ error: { code: prepared.code, message: DENIAL_CARD_REFUSAL_MESSAGE[prepared.code] } });
      /*
        P4(스레드 f61af808, 10-07): 머지 거절 카드는 **권한 요청 카드로 세운다**. 권한 카드는 일반 ask 꼴이라 어느 클라이언트에서든
        소유자가 [7일 허락하고 다시 시도](7일 grant) 또는 [이번 한 번 머지](이 PR·이 head 만, 스레드 1b75d7a0)를 누르면 새 턴이 뜬다.
        저장소·PR·head 는 거절 기록의 값이다(C3). 배포 저장소도 같은 길이다(jaebin 10-10). `prepareDenialCard` 가 스레드 일치를
        보므로 여기 오면 threadRootId 가 있다.
      */
      const d = prepared.meta;
      return raisePermission({
        kind: 'merge', repo: d.repo, channelId, threadRootId: threadRootId!, model,
        reason: `PR #${d.number} 머지가 ${d.reason === 'cause_not_human' ? '사람이 띄운 턴이 아니라서(cause_not_human)' : '권한 없음(not_granted)으로'} 막혔다 — ${body}`,
        denial: { id: d.denialId, number: d.number, headSha: d.headSha ?? '', reason: d.reason ?? 'not_granted' },
      });
    }
    const meta: AskMeta & Partial<ModelMeta> = {
      kind: 'ask', ask: { options, to: audience, ...(prompt ? { prompt } : {}), ...(mirrorOf ? { mirrorOf } : {}) },
      ...(await reportedModelMeta(pool, account.id, model, threadRootId ?? null)),
    };
    const posted = await postMessage(pool, {
      causeMessageId: cause,
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null,
      meta: meta as unknown as Record<string, unknown>,
    });
    if (posted.failure) return postFailureResult(posted.failure);
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const channelAudience = await audienceFor(pool, channelId);
      emitPosted(posted, channelAudience);
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
      // 검사와 발행 사이에 원본이 정해졌으면 방금 세운 거울을 곧바로 그 결과로 닫는다.
      if (mirrorOf) await syncAskMirrors(pool, mirrorOf);
      if (supersedes) await supersedeAsk(pool, { oldId: supersedes, newId: message.id, actorId: account.id });
      /*
        사람 앞 물음의 푸시(security G4). to:human 은 받는 사람이 정해져 있지 않다 — 그 턴을 띄운 멘션의
        작성자(차례 주인, `gateAwaitingAccount`)에게만 보낸다. 원인 헤더가 없거나 차례 주인이 사람이
        아니거나 그 채널이 안 보이면 보내지 않는다. 이 글로 이미 inbox 를 받았으면(멘션) 그 job 이 간다.
      */
      if (audience.kind === 'human' && cause) {
        const awaiting = await gateAwaitingAccount(pool, account.id, channelId, cause);
        if (awaiting && !notified.includes(awaiting)) await enqueueAskPush(pool, awaiting, message.id);
      }
      // 받는 사람을 이름으로 정한 물음이면 그 사람이다. 에이전트면 `enqueueAskPush` 가 아무것도 넣지 않는다.
      if (audience.kind === 'account' && !notified.includes(audience.accountId)) {
        await enqueueAskPush(pool, audience.accountId, message.id);
      }
    }
    return postedResult(message, notified);
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
  /**
   * 권한 요청(111, 스레드 f61af808) — 분류기·래퍼에 막힌 권한 하나를 소유자에게 청한다. **이 도구는 아무것도 열지 않는다** —
   * 소유자가 카드에서 승인해야(사람 세션 REST) grant 가 생기고, 그 카드 답이 새 턴을 띄운다. 넓은 규칙은 여기서 거절한다
   * (`validateToolRule`). 카드의 권한 칸은 서버 값뿐이고 에이전트가 쓴 것은 이유 한 줄이다.
   */
  server.registerTool('permission.request', {
    description: '막힌 권한 하나를 소유자에게 청한다(이 도구로는 열리지 않는다 — 소유자가 승인해야 열린다). kind=command 면 command 에 막힌 명령 하나 그대로(셸 이어 붙이기·따옴표 없이, 이 스레드에서만, 소유자가 「이번 한 번」/「1시간」 중 고름, 승인되면 같은 턴에서 다시 시도해도 된다). kind=tool 이면 rule 에 Claude Code allow 규칙 하나(Bash(<고정 낱말 둘 이상> …:*)·Bash(<명령 전체>)·mcp__<서버>__<도구>, 이 채널에서 7일, 다음 턴부터), kind=merge 면 repo 에 owner/name',
    inputSchema: {
      kind: z.enum(['tool', 'merge', 'command']),
      rule: z.string().min(1).max(300).optional(),
      command: z.string().min(1).max(300).optional(),
      repo: z.string().min(3).max(201).optional(),
      reason: z.string().min(1).max(500),
      channelId: z.string().uuid(),
      threadRootId: z.string().uuid(),
      model: MODEL_ARG,
    },
  }, async ({ kind, rule, repo, command, reason, channelId, threadRootId, model }) => {
    if (account.kind !== 'agent') return jsonResult({ error: { code: 'not_agent', message: 'only an agent can request a permission' } });
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    if ((kind === 'tool') !== (rule !== undefined) || (kind === 'merge') !== (repo !== undefined) || (kind === 'command') !== (command !== undefined)) {
      return jsonResult({ error: { code: 'bad_request', message: 'kind "tool" takes `rule`, kind "merge" takes `repo`, kind "command" takes `command` — exactly one' } });
    }
    return raisePermission({ kind, rule, repo, command, reason, channelId, threadRootId, model });
  });

  /**
   * 내 grant 하나를 내려놓는다(권한 요청 스레드 f61af808). 좁히기만 하므로 어느 턴에서나 된다 — 설정 화면이 없는 동안 소유자가
   * 채팅(모바일 포함)으로 "그 권한 거둬"라고 하면 에이전트가 이것으로 거둔다. 넓히는 길은 `permission.request` 하나뿐이다.
   */
  server.registerTool('permission.revoke', {
    description: '내가 받은 명령 허용(kind=tool, 그 채널의 규칙)이나 머지 권한(kind=merge, owner/name 또는 조직 전체 owner/*) 하나를 내려놓는다. 다음 턴부터 빠진다',
    inputSchema: {
      kind: z.enum(['tool', 'merge']),
      rule: z.string().min(1).max(300).optional(),
      repo: z.string().min(3).max(201).optional(),
      channelId: z.string().uuid(),
    },
  }, async ({ kind, rule, repo, channelId }) => {
    if (account.kind !== 'agent') return jsonResult({ error: { code: 'not_agent', message: 'only an agent can release its own permission' } });
    if ((kind === 'tool') !== (rule !== undefined) || (kind === 'merge') !== (repo !== undefined)) {
      return jsonResult({ error: { code: 'bad_request', message: 'kind "tool" takes `rule`, kind "merge" takes `repo` — exactly one' } });
    }
    const r = await releaseGrant(pool, { agentId: account.id, kind, rule, repo, channelId });
    if (!r.ok) return jsonResult({ error: { code: r.code, message: r.message } });
    return jsonResult({ revoked: true, capability: r.capability, scope: r.scope });
  });

  server.registerTool('message.fail', {
    description: '스스로 못 끝냈음을 알린다(수신자는 언제나 사람). retryable 로 다시 부를 수 있는지 밝힌다',
    inputSchema: {
      channelId: z.string().uuid(),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
      threadRootId: z.string().uuid().optional(),
      what: z.string().min(1).max(500).optional(),
      reason: z.string().min(1).max(1000).optional(),
      retryable: z.boolean(),
      // 기계가 읽는 실패 갈래(FailureMeta 주석). 러너가 스레드 지정 모델 거절·계정 관문 때 싣는다.
      code: z.enum(FAILURE_CODES).optional(),
      /**
       * `account_gate` 때만: 그 턴을 띄운 멘션(차례 주인을 정할 재료 — 서버가 확인한다)과 관문이 선
       * 계정의 이름표(`풀/계정`). 러너의 자기 호출에는 원인 헤더가 없어서 멘션을 직접 싣는다.
       */
      mentionId: z.string().uuid().optional(),
      account: z.string().regex(ACCOUNT_GATE_LABEL_PATTERN).optional(),
      model: MODEL_ARG,
    },
  }, async ({ channelId, body, threadRootId, what, reason, retryable, code, mentionId, account: gateAccount, model }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    /*
      **`thread_model_rejected` 는 그 스레드에 이 에이전트의 살아 있는 모델 지정이 있을 때만 싣는다**
      (결정 10, 2026-10-01). 이 표지가 붙으면 앱 실패 카드가 [기본으로 되돌리고 다시 부르기]를 주
      버튼으로 띄운다 — 지정이 없는데(또는 무효인데) 붙으면 그 버튼이 사람이 **막 정한** 지정을 지운다
      (설계 검토 스레드 b64632ac 에서 에이전트가 스스로 붙인 실측). 실패 통지 자체는 사람에게 닿아야
      하므로 글은 그대로 올리고 표지만 뺀다.
    */
    const keepCode = code === 'thread_model_rejected'
      ? !!threadRootId && !!(await getThreadAgentModel(pool, threadRootId, account.id).then((r) => r && !r.stale))
      : !!code;
    /*
      **`account_gate` 의 차례 주인은 서버가 정한다**(2026-10-02, 관문 대응 안 2). 그 턴을 띄운 멘션
      (`mentionId`, 없으면 원인 헤더)이 이 에이전트를 실제로 깨웠고 작성자가 사람이면 그 사람이다
      (`gateAwaitingAccount`). 못 정해도 표지는 남긴다 — 사람이 풀어야 하는 관문이라는 사실은 같다.
      이름표·차례 주인은 이 표지에만 붙는다: 다른 실패에 계정 사실이 따라 올라가지 않게.
    */
    const gate = code === 'account_gate' && keepCode;
    const gateSource = mentionId ?? cause;
    const awaiting = gate && gateSource ? await gateAwaitingAccount(pool, account.id, channelId, gateSource) : null;
    const meta: FailureMeta & Partial<ModelMeta> = {
      kind: 'failure',
      failure: {
        retryable, ...(what ? { what } : {}), ...(reason ? { reason } : {}), ...(code && keepCode ? { code } : {}),
        ...(awaiting ? { awaitingAccountId: awaiting } : {}),
        ...(gate && gateAccount ? { account: gateAccount } : {}),
      },
      ...(await reportedModelMeta(pool, account.id, model, threadRootId ?? null)),
    };
    const posted = await postMessage(pool, {
      causeMessageId: cause,
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null,
      meta: meta as unknown as Record<string, unknown>,
      // 차례 주인이 이 글로 알림을 못 받는 자리(남이 세운 스레드에서 불렀다 등)면 Inbox 에 넣는다.
      ...(awaiting ? {
        beforeCommit: async (client, ctx) => {
          await notifyGateAwaiting(client, awaiting, ctx.message.id, ctx.notified);
          return null;
        },
      } : {}),
    });
    if (posted.failure) return postFailureResult(posted.failure);
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const channelAudience = await audienceFor(pool, channelId);
      emitPosted(posted, channelAudience);
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return postedResult(message, notified);
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
      agentModels: AGENT_MODELS_ARG,
    },
  }, async ({ channelId, threadRootId, body, to, deadlineSec, model, agentModels }) => {
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

    const picks = await preparePicks(agentModels);
    if ('error' in picks) return jsonResult({ error: picks.error });
    let pickChanges: PickChange[] = [];

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
      ...(await reportedModelMeta(pool, account.id, model, threadRootId ?? null)),
    };
    const posted = await postMessage(pool, {
      causeMessageId: cause,
      channelId, authorId: account.id, body, threadRootId,
      meta: meta as unknown as Record<string, unknown>,
      /*
        위임에서 "이 글이 깨우는 상대"는 팬아웃이 아니라 **넘겨받는 팀원**이다 — 그들의 부름은 아래
        `createDelegation` 이 만든다. 그래서 판정의 `notified` 로 그 명단(도달 가능한 팀원)을 준다.
      */
      ...(picks.list.length ? {
        beforeCommit: async (txn, ctx) => {
          const out = await applyAgentPicks(txn, {
            channelId, threadRootId, actorId: account.id, picks: picks.list,
            notified: new Set([...ctx.notified, ...delegates.map((d) => d.accountId)]),
          });
          if (!out.ok) return out.rejection;
          pickChanges = out.changes;
          return null;
        },
      } : {}),
    });
    if (posted.failure === 'rejected') return jsonResult({ error: { code: posted.rejection.code, message: posted.rejection.message } });
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
    // 고른 모델(087) — 지정 행은 게시 트랜잭션에서 이미 커밋됐다. 시스템 줄·이벤트는 여기서.
    for (const c of pickChanges) {
      await announceChange(pool, channelId, threadRootId, account.id, c.agentId, c.row, 'agent');
      await emitChanged(pool, channelId, threadRootId, c.agentId, c.row);
    }
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
      ...(await reportedModelMeta(pool, account.id, model, threadRootId ?? null)),
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
      causeMessageId: cause,
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null,
      meta: meta as unknown as Record<string, unknown>,
    });
    if (posted.failure) return postFailureResult(posted.failure);
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const channelAudience = await audienceFor(pool, channelId);
      emitPosted(posted, channelAudience);
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return postedResult(message, notified);
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
    const removed = await removeReaction(pool, { messageId, accountId: account.id, emoji });
    // 제거도 REST 와 같이 이벤트를 낸다 — 없는 것을 떼는 것도 성공이라(REST 주석 참고)
    // 이벤트를 조건부로 내지 않는다. 결과 상태가 같으니 재시도가 안전해야 한다.
    // 단 서버가 단 상태 리액션이 남았으면 내지 않는다 — 화면이 남은 리액션을 지운다(108).
    if (removed === 'status_kept') return jsonResult({ ok: true });
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
      // 턴을 띄울 배치에만 메모리 판본을 얹는다(러너 메모리 캐시, 2026-09-28). 러너는 이
      // 값이 자기 사본과 같으면 턴 시작 때 메모리를 **한 번도 왕복하지 않는다.** 빈 폴에는
      // 싣지 않는다 — 25초마다 도는 롱폴에 질의를 하나 더 얹을 까닭이 없고, 러너는 빈
      // 배치로는 턴을 띄우지 않는다. 판본이 필요한 순간이 곧 항목이 있는 순간이다.
      if (result.entries.length && account.kind === 'agent') {
        return jsonResult({ ...result, memoryRev: await memoryRev(pool, account.id) });
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
    // rev 를 함께 준다 — 러너가 이 값을 자기 사본과 대 보고, 같으면 core 를 다시 받지 않는다
    // (services/memory.ts::memoryRev). 옛 러너는 모르는 필드를 무시한다.
    // entries 는 slug 와 한 줄 요약(069) — 러너가 목록에 같이 싣는다. slugs 는 옛 러너용으로 둔다.
    const [entries, rev] = await Promise.all([listMemoryIndex(pool, account.id), memoryRev(pool, account.id)]);
    return jsonResult({ slugs: entries.map((e) => e.slug), entries, rev });
  });

  server.registerTool('memory.get', {
    description: '메모리 조회',
    inputSchema: { slug: z.string().min(1) },
  }, async ({ slug }) => {
    if (!isValidSlug(slug)) {
      return jsonResult({ error: { code: 'invalid_slug', message: MEMORY_SLUG_HINT } });
    }
    // 읽은 횟수를 센다(069) — 무엇이 안 읽히는지가 정리의 근거다.
    const memory = await readMemoryCounted(pool, account.id, slug);
    if (!memory) {
      return jsonResult({ error: { code: 'not_found', message: 'memory not found' } });
    }
    // 쓰기 검사(080)에 걸린 판은 사람이 확인할 때까지 **어느 프롬프트에도 싣지 않는다** — 이 응답이
    // 곧 프롬프트다(러너는 core 를 이 도구로 받는다). 걸리기 전 마지막 판이 있으면 그것을 준다.
    // updatedAt 은 지금 판의 것이다: 에이전트가 고쳐 쓸 때 ifUpdatedAt 으로 그대로 준다.
    if (memory.flaggedAt) {
      const clean = await lastCleanRevision(pool, account.id, slug);
      return jsonResult({
        slug: memory.slug, updatedAt: memory.updatedAt.toISOString(),
        ...(clean ? { value: clean.value, ...(clean.description ? { description: clean.description } : {}) } : {}),
        flagged: { reason: memory.flagReason, at: memory.flaggedAt.toISOString() },
        notice: '지금 판은 쓰기 검사에 걸려 사람의 확인을 기다린다 — 본문을 싣지 않는다. '
          + (clean ? 'value 는 걸리기 전 마지막 판이다. ' : '걸리기 전 판이 없다. ')
          + '지시문·비밀 값 없이 다시 쓰면 표시가 풀린다.',
      });
    }
    return jsonResult({
      slug: memory.slug, value: memory.value, updatedAt: memory.updatedAt.toISOString(),
      ...(memory.description ? { description: memory.description } : {}),
      // 보관된 기억(097)도 읽힌다 — 목록·recall 에서만 빠진다. 다시 쓰려면 memory.unarchive.
      ...(memory.archivedAt ? { archived: true, archivedAt: memory.archivedAt.toISOString() } : {}),
    });
  });

  // memory.search — 목록에 안 실리는 journal 을 찾는 길이자, 러너가 요청 본문으로 관련 기억을
  // 골라 주입하는 길이다(070). includeValue 는 본문까지 준다 — 러너가 왕복 한 번에 끝내려고 쓴다.
  server.registerTool('memory.search', {
    description: '내 기억을 낱말로 찾는다(이름·요약 3점, 본문 1점). journal 도 여기서 찾는다',
    inputSchema: {
      query: z.string().min(1).max(2000),
      limit: z.number().int().min(1).max(20).optional(),
      includeValue: z.boolean().optional(),
      // 러너 자동 주입용(recall P1) — 이름·상투어를 거르고 이름·요약 일치만, journal 빼고.
      // 옛 서버는 모르는 키를 버리므로(zod strip) 러너는 응답의 nameHits 로 새 서버를 알아본다.
      recall: z.boolean().optional(),
      // recall 모드만(S2 F1·F6): 이 세션에 이미 실은 판(`slug@updatedAt`, 옛 러너는 맨 slug)을 빼고,
      // 러너가 실을 앞 recordTop 개를 recall_count 로 센다. 옛 서버는 둘 다 버린다 — 러너는 제 쪽에서도 거른다.
      exclude: z.array(z.string().max(300)).max(200).optional(),
      recordTop: z.number().int().min(0).max(5).optional(),
      // recall 모드만(G): 이번에 새로 온 말. 주면 그 낱말이 이름·요약에 하나 이상 걸린 것만 돌려주고(후속 턴 게이트)
      // 응답에 focusTerms 를 싣는다. 옛 서버는 버린다 — 러너는 focusTerms 가 없으면 루트 머리 없이 다시 묻는다.
      focus: z.string().max(2000).optional(),
      // 보관된 것(097)도 찾는다 — 에이전트가 직접 찾을 때만. recall 은 보관을 보지 않는다.
      includeArchived: z.boolean().optional(),
    },
  }, async ({ query, limit, includeValue, recall, exclude, recordTop, focus, includeArchived }) => {
    const res = await searchMemory(pool, account.id, query, {
      limit: limit ?? 5, includeValue: includeValue ?? false, recall: recall ?? false,
      ...(recall
        ? { exclude: exclude ?? [], recordTop: recordTop ?? 0, ...(focus !== undefined ? { focus } : {}) }
        : { includeArchived: includeArchived ?? false }),
    });
    return jsonResult(recall ? res : { hits: res.hits });
  });

  // memory.audit — 정리 턴(M4)이 볼 후보. 판단은 에이전트가 한다; 서버는 사실만 모은다.
  server.registerTool('memory.audit', {
    description: '내 기억의 정리 후보: 한 번도/30일 넘게 안 읽힘·깨진 [[링크]]·이름이 거의 같은 짝(similar)·본문이 절반 넘게 겹치는 짝(similarBody)·'
      + '같은 PR 번호를 공유하는 묶음(sharedRefs)·90일 넘게 안 고침(old)·긴 것(largest)·곧 밀려날 journal(expiringJournal)·낡은 낱말(patterns)·요약 없음(undescribed)·core 길이·항목 수(items). '
      + '정리 절차: 먼저 memory.lease 로 임대를 잡는다(다른 턴이 정리 중이면 물러난다). 후보마다 memory.get 으로 읽고 판단한다 — '
      + '합칠 것은 memory.merge(한 호출로 into 를 쓰고 from 을 보관), 안 쓰는 것은 지우지 말고 memory.archive(보관 — 목록·recall 에서 빠지고 unarchive 로 돌아온다), '
      + '되풀이할 교훈만 남기고 줄이거나, 낡은 이름을 고친다. 틀렸으면 memory.restore. truncated 면 고친 뒤 다시 부른다. 요약이 없는 것은 읽고 "언제 열어 볼지" 한 줄을 description 으로 채운다(목록·자동 recall 이 요약으로 찾는다). 고칠 땐 ifUpdatedAt 을 준다(이전 판이 남아 되돌릴 수 있다). 끝나면 무엇을 바꿨는지 스레드에 보고한다',
    inputSchema: { patterns: z.array(z.string().min(3).max(100)).max(20).optional() },
  }, async ({ patterns }) => jsonResult(await auditMemory(pool, account.id, patterns ?? [])));

  // value 가 null 이면 삭제 — 키 부재가 아니라 명시적 null 이 삭제다.
  // .nullable() 은 "값이 반드시 있고 null 일 수 있다"를 의미한다.
  server.registerTool('memory.set', {
    description: `메모리 저장 또는 삭제(value가 null이면 삭제). ifUpdatedAt(memory.get 의 updatedAt, 새로 만들 땐 null)을 주면 그 사이 바뀌었을 때 conflict 로 거절한다. description 은 목록에 같이 실리는 한 줄 요약(생략하면 있던 것 유지, 빈 문자열이면 지움). core 는 ${MAX_CORE_MEMORY_LENGTH}자까지. kind: topic(기본)·procedure(절차)·journal(한 작업의 경위 — 목록에 안 실리고 최근 ${MAX_JOURNAL_MEMORIES_PER_ACCOUNT}개만 남는다)`,
    inputSchema: {
      slug: z.string().min(1),
      value: z.string().max(MAX_MEMORY_VALUE_LENGTH).nullable(),
      description: z.string().max(MAX_MEMORY_DESCRIPTION_LENGTH).optional(),
      // 종류(070). 생략하면 새 기억은 topic, 있던 기억은 그대로다.
      kind: z.enum(MEMORY_KINDS).optional(),
      // 낙관적 동시성(M3). memory.get 이 준 updatedAt 을 그대로 준다 — 그 사이 누가 고쳤으면
      // 쓰지 않고 conflict 를 돌려준다. null 은 "아직 없어야 한다". 생략하면 무조건 쓴다.
      ifUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
    },
  }, async ({ slug, value, description, kind, ifUpdatedAt }) => {
    if (!isValidSlug(slug)) {
      return jsonResult({ error: { code: 'invalid_slug', message: MEMORY_SLUG_HINT } });
    }
    // 길이는 위 zod `.max()` 가 이미 거른다 — 여기서 또 재지 않는다.
    // 삭제는 멱등이라 '없는 것을 지웠다'는 오류가 아니다(services/memory.ts 주석).
    // core 는 매 턴 통째로 실린다 — 그래서 한도가 따로다(메모리 고도화 PR3). 전에는 프롬프트에
    // "2,000자 안쪽"이라고만 적혀 있어 아무도 안 지켰다. 거절에 **어떻게 하라**를 싣는다 —
    // 이유 없는 거절을 받은 에이전트는 포기하고 엉뚱한 곳(하네스 파일 메모리)에 적는다(09-11 실측).
    if (slug === 'core' && value !== null && value.length > MAX_CORE_MEMORY_LENGTH) {
      return jsonResult({
        error: {
          code: 'core_too_long',
          message: `core 는 ${MAX_CORE_MEMORY_LENGTH}자까지다(지금 ${value.length}자). core 는 매 턴 통째로 실린다 — `
            + '한 가지 주제로 묶이는 것은 `mem/<이름>` 으로 옮기고 core 에는 포인터 한 줄만 남겨라. sections 는 절(## 제목) 단위 길이, 긴 것부터 — 내릴 후보다.',
          sections: coreSections(value),
        },
      });
    }
    // 쓰기 검사(080, contentScan.ts). 걸려도 거절하지 않는다 — 저장하고 표시한다.
    const flag = value === null ? null : scanWrite(value, description);
    const result = await setMemory(
      pool, account.id, slug, value, description, kind,
      ifUpdatedAt === undefined ? undefined : { updatedAt: ifUpdatedAt === null ? null : new Date(ifUpdatedAt) },
      flag?.reason ?? null,
    );
    if (typeof result === 'object') {
      const now = result.conflict.updatedAt;
      return jsonResult({
        error: {
          code: 'conflict',
          message: now
            ? `그 사이 다른 턴이 이 기억을 고쳤다(지금 판 ${now.toISOString()}). memory.get 으로 지금 값을 읽고, `
              + '네 변경을 합쳐 그 updatedAt 으로 다시 써라 — 덮어쓰면 그 턴이 적은 것이 사라진다.'
            : '그 사이 이 기억이 지워졌다. 되살릴 것인지 먼저 판단하고, 되살린다면 ifUpdatedAt: null 로 써라.',
          updatedAt: now ? now.toISOString() : null,
        },
      });
    }
    if (result === 'too_many') {
      return jsonResult({
        error: { code: 'too_many', message: `at most ${MAX_MEMORY_ITEMS_PER_ACCOUNT} memories per account` },
      });
    }
    // 쓴 자리에서 알린다(C1): core 가 곧 넘침·항목이 곧 상한·journal 이 곧 밀려남. 비어 있으면 싣지 않는다.
    const warnings = await memoryWarnings(pool, account.id);
    const warn = warnings.length ? { warnings } : {};
    if (flag) {
      return jsonResult({
        ok: true,
        ...warn,
        flagged: { reason: flag.reason, rules: flag.rules },
        notice: `저장했지만 쓰기 검사에 걸렸다(${flag.reason}). 사람이 확인할 때까지 이 판은 목록 요약·recall·memory.get `
          + '어디에도 실리지 않는다. 남의 글을 옮겨 적었거나 비밀 값을 넣었다면 빼고 다시 써라. 그대로 둬야 하면 '
          + '사람에게 확인을 부탁해라(설정 › 에이전트 › 기억).',
      });
    }
    return jsonResult({ ok: true, ...warn });
  });

  // ── 정리 도구(C1, services/memoryCurate.ts). 지우기 대신 보관, 합치기는 한 호출, 되돌리기는 도구로. ──
  const slugArg = z.string().min(1);
  const ifUpdatedAtArg = z.string().datetime({ offset: true }).nullable().optional();
  const toDate = (v: string | null | undefined): Date | null | undefined => (v === undefined ? undefined : v === null ? null : new Date(v));
  const conflictError = (slug: string, now: Date | null) => jsonResult({
    error: {
      code: 'conflict', slug, updatedAt: now ? now.toISOString() : null,
      message: now
        ? `그 사이 다른 턴이 ${slug} 를 고쳤다(지금 판 ${now.toISOString()}). memory.get 으로 다시 읽고 그 updatedAt 으로 다시 해라.`
        : `${slug} 가 그 사이 지워졌거나 아직 없다.`,
    },
  });

  server.registerTool('memory.archive', {
    description: '기억을 보관한다(삭제 대신). 목록(<memory-index>)·recall·검색·200 상한에서 빠지지만 memory.get 으로 읽히고 memory.unarchive 로 돌아온다. '
      + `보관은 ${MAX_ARCHIVED_MEMORIES_PER_ACCOUNT}개까지 — 넘치면 가장 오래 보관된 것부터 이전 판으로 밀려난다. `
      + '안 쓰는 것 같은데 지우기 아까우면 이것이다. core 는 보관할 수 없다. ifUpdatedAt 은 memory.get 의 updatedAt',
    inputSchema: { slug: slugArg, ifUpdatedAt: ifUpdatedAtArg },
  }, async ({ slug, ifUpdatedAt }) => {
    if (!isValidSlug(slug)) return jsonResult({ error: { code: 'invalid_slug', message: MEMORY_SLUG_HINT } });
    if (slug === 'core') return jsonResult({ error: { code: 'core_not_archivable', message: 'core 는 매 턴 실리는 자리라 보관할 수 없다 — 줄여 써라' } });
    const r = await archiveMemory(pool, account.id, slug, toDate(ifUpdatedAt));
    if (r === 'not_found') return jsonResult({ error: { code: 'not_found', message: 'memory not found' } });
    if (typeof r === 'object') return conflictError(slug, r.conflict.updatedAt);
    return jsonResult({ ok: true });
  });

  server.registerTool('memory.unarchive', {
    description: '보관한 기억을 되살린다. 살아 있는 항목이 상한(200)이면 too_many — 먼저 자리를 비운다',
    inputSchema: { slug: slugArg },
  }, async ({ slug }) => {
    if (!isValidSlug(slug)) return jsonResult({ error: { code: 'invalid_slug', message: MEMORY_SLUG_HINT } });
    const r = await unarchiveMemory(pool, account.id, slug);
    if (r === 'not_found') return jsonResult({ error: { code: 'not_found', message: 'memory not found' } });
    if (r === 'too_many') return jsonResult({ error: { code: 'too_many', message: `at most ${MAX_MEMORY_ITEMS_PER_ACCOUNT} active memories per account` } });
    return jsonResult({ ok: true });
  });

  server.registerTool('memory.merge', {
    description: '기억 여럿을 하나로 합친다 — 한 호출로 into 를 value 로 쓰고 from 을 전부 보관한다(두 호출로 나누면 그 사이 다른 턴이 from 을 고친다). '
      + 'into 는 있는 것이든 새 이름이든 된다. ifUpdatedAt 은 {slug: updatedAt} 꼴로, 적은 slug 만 대 본다(into 가 없어야 하면 null). '
      + '이전 판이 reason=merge 로 남아 memory.restore 로 되돌린다. 합친 본문에는 from 의 되풀이할 사실만 남기고 경위는 버려라',
    inputSchema: {
      into: slugArg,
      from: z.array(slugArg).min(1).max(10),
      value: z.string().min(1).max(MAX_MEMORY_VALUE_LENGTH),
      description: z.string().max(MAX_MEMORY_DESCRIPTION_LENGTH).optional(),
      kind: z.enum(MEMORY_KINDS).optional(),
      ifUpdatedAt: z.record(z.string(), z.string().datetime({ offset: true }).nullable()).optional(),
    },
  }, async ({ into, from, value, description, kind, ifUpdatedAt }) => {
    for (const s of [into, ...from]) if (!isValidSlug(s)) return jsonResult({ error: { code: 'invalid_slug', slug: s, message: MEMORY_SLUG_HINT } });
    if (into === 'core' || from.includes('core')) return jsonResult({ error: { code: 'core_not_mergeable', message: 'core 는 합치기의 대상이 아니다 — memory.set 으로 써라' } });
    const flag = scanWrite(value, description);
    const expect = ifUpdatedAt
      ? Object.fromEntries(Object.entries(ifUpdatedAt).map(([k, v]) => [k, v === null ? null : new Date(v)]))
      : undefined;
    const r = await mergeMemory(pool, account.id, { into, from, value, description, kind, expect, flagReason: flag?.reason ?? null });
    if (r === 'too_many') return jsonResult({ error: { code: 'too_many', message: `at most ${MAX_MEMORY_ITEMS_PER_ACCOUNT} active memories per account` } });
    if (typeof r === 'object' && 'notFound' in r) return jsonResult({ error: { code: 'not_found', slugs: r.notFound, message: 'from 중 없는 기억이 있다 — 아무것도 바꾸지 않았다' } });
    if (typeof r === 'object') return conflictError(r.conflict.slug, r.conflict.updatedAt);
    const warnings = await memoryWarnings(pool, account.id);
    return jsonResult({
      ok: true, archived: from.filter((s) => s !== into),
      ...(warnings.length ? { warnings } : {}),
      ...(flag ? { flagged: { reason: flag.reason, rules: flag.rules }, notice: '합친 본문이 쓰기 검사에 걸렸다 — 사람이 확인할 때까지 프롬프트에 안 실린다. 지시문·비밀 값 없이 다시 써라.' } : {}),
    });
  });

  server.registerTool('memory.revisions', {
    description: '한 기억의 이전 판(최근 것부터, 최대 5 + 정리로 생긴 판 20). reason=merge 의 detail.from 은 거기 합쳐진 기억들. memory.restore 에 id 를 준다',
    inputSchema: { slug: slugArg },
  }, async ({ slug }) => {
    if (!isValidSlug(slug)) return jsonResult({ error: { code: 'invalid_slug', message: MEMORY_SLUG_HINT } });
    const revisions = await listMemoryRevisions(pool, account.id, slug);
    return jsonResult({
      revisions: revisions.map((r) => ({
        id: r.id, updatedAt: r.updatedAt.toISOString(), replacedAt: r.replacedAt.toISOString(), chars: r.value.length, ...(r.kind ? { kind: r.kind } : {}),
        ...(r.description ? { description: r.description } : {}), ...(r.reason ? { reason: r.reason } : {}),
        ...(r.detail ? { detail: r.detail } : {}), ...(r.flagged ? { flagged: true } : {}),
      })),
    });
  });

  server.registerTool('memory.restore', {
    description: '이전 판으로 되돌린다(revisionId 생략=가장 최근 판). 지금 판은 reason=restore 로 남아 되돌리기도 되돌릴 수 있다. 지워졌거나 보관된 기억도 이것으로 살아난다(종류는 판에 적힌 대로). 되살리는 본문은 쓰기 검사를 다시 거친다',
    inputSchema: { slug: slugArg, revisionId: z.number().int().positive().optional() },
  }, async ({ slug, revisionId }) => {
    if (!isValidSlug(slug)) return jsonResult({ error: { code: 'invalid_slug', message: MEMORY_SLUG_HINT } });
    // 되살리는 본문도 지금 규칙으로 검사한다(080, security L1) — 걸리면 걸린 채로 산다.
    const r = await restoreMemory(pool, account.id, slug, revisionId, (v, d) => scanWrite(v, d)?.reason ?? null);
    if (r === 'not_found') return jsonResult({ error: { code: 'not_found', message: '그 판이 없다 — memory.revisions 로 확인해라' } });
    if (r === 'too_many') return jsonResult({ error: { code: 'too_many', message: `at most ${MAX_MEMORY_ITEMS_PER_ACCOUNT} active memories per account` } });
    return jsonResult({ ok: true });
  });

  server.registerTool('memory.lease', {
    description: '정리 임대(계정당 하나). acquire 로 잡고(token 을 돌려준다, 같은 token 으로 다시 부르면 연장) 끝나면 release. '
      + '다른 턴이 들고 있으면 acquired:false 와 만료 시각 — 그때는 정리하지 말고 물러나라(둘이 같이 고치면 ifUpdatedAt 충돌만 난다). status 는 조회',
    inputSchema: {
      action: z.enum(['acquire', 'release', 'status']),
      token: z.string().min(8).max(80).optional(),
      minutes: z.number().int().min(1).max(MEMORY_LEASE_MAX_MINUTES).optional(),
    },
  }, async ({ action, token, minutes }) => {
    const view = (l: { holder: string; acquiredAt: Date; expiresAt: Date } | null) => (l
      ? { acquiredAt: l.acquiredAt.toISOString(), expiresAt: l.expiresAt.toISOString() } : null);
    if (action === 'status') return jsonResult({ lease: view(await memoryLeaseStatus(pool, account.id)) });
    if (action === 'release') {
      if (!token) return jsonResult({ error: { code: 'token_required', message: 'release 에는 acquire 가 준 token 이 필요하다' } });
      return jsonResult({ ok: true, released: await releaseMemoryLease(pool, account.id, token) });
    }
    const t = token ?? newLeaseToken();
    const r = await acquireMemoryLease(pool, account.id, t, minutes ?? MEMORY_LEASE_DEFAULT_MINUTES);
    // token 은 잡은 쪽에만 준다 — 남의 token 을 알면 남의 임대를 놓을 수 있다.
    if (r.acquired) return jsonResult({ acquired: true, token: t, lease: view(r.lease) });
    return jsonResult({ acquired: false, heldBy: view(r.heldBy), notice: '다른 턴이 이 계정의 기억을 정리하고 있다 — 만료 뒤에 다시 하거나 물러나라.' });
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
    // 쓰기 검사(080). 스킬은 원래 사람이 승인해야 깔리므로 걸린 것도 승인 전에는 아무 데도 안 간다 —
    // 표시는 승인하는 사람이 보라고 남긴다.
    const flag = scanWrite(body);
    const result = await proposeSkill(pool, { slug, body, proposedBy: account.id, channelId, flagReason: flag?.reason ?? null });
    if (flag && 'ok' in result) {
      return jsonResult({ ...result, flagged: { reason: flag.reason, rules: flag.rules } });
    }
    return jsonResult(result);
  });

  /**
   * automation.propose(072) — 에이전트가 반복 작업을 **제안**한다. 만들지는 못한다(064: 사람만).
   *
   * 승인할 사람은 `forHandle`(사람), 없으면 이 에이전트의 소유자다. 승인하면 글이 **그 사람
   * 이름으로** 나가므로, 그 사람이 `channelId` 에 쓸 수 있어야 한다 — 여기서 미리 막아 두면
   * 승인 뒤 첫 회차가 거부로 멈추는 일이 없다. 제안은 설정 › Automations 에 승인 대기로 선다.
   * 사람에게 알리는 것은 에이전트의 발화 몫이다(워크스페이스 규칙: 오브젝트는 채팅에 투영되지 않는다).
   */
  server.registerTool('automation.propose', {
    description: '반복 작업 자동화를 제안한다(사람이 설정 › Automations 에서 승인해야 돈다). 글은 승인한 사람 이름으로 나간다',
    inputSchema: {
      name: z.string().trim().min(1).max(100),
      channelId: z.string().uuid(),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
      trigger: triggerSchema,
      debounceSec: z.number().int().min(0).max(3600).optional(),
      forHandle: z.string().min(1).max(64).optional(),
    },
  }, async ({ name, channelId, body, trigger, debounceSec, forHandle }) => {
    const ownerRes = forHandle
      ? await pool.query<{ id: string }>(
        `select id from account where handle = $1 and kind = 'human' and deleted_at is null and disabled_at is null`,
        [forHandle.replace(/^@/, '')],
      )
      : await pool.query<{ id: string }>(
        `select o.id from agent_config c join account o on o.id = c.owner_account_id
         where c.account_id = $1 and o.kind = 'human' and o.deleted_at is null and o.disabled_at is null`,
        [account.id],
      );
    const ownerId = ownerRes.rows[0]?.id;
    if (!ownerId) {
      return jsonResult({ error: { code: 'no_owner', message: forHandle ? `no active human @${forHandle}` : 'this agent has no owner; pass forHandle' } });
    }
    const exists = await pool.query(`select 1 from channel where id = $1`, [channelId]);
    if (!exists.rowCount || (await channelPostGate(pool, channelId, ownerId)) !== 'ok') {
      return jsonResult({ error: { code: 'forbidden', message: 'the approver cannot post in this channel' } });
    }
    const automation = await proposeAutomation(pool, {
      ownerId, proposedBy: account.id, channelId, name, body, trigger, debounceSec: debounceSec ?? null,
    });
    return jsonResult({ automation, next: 'Tell the approver in chat: Settings › Automations › Approve.' });
  });

  /**
   * automation.list · automation.run(082) — 승인된 자동화를 **소유자가 시킨 턴에서만** "지금 한 번" 돌린다.
   *
   * 판정은 이 턴의 원인(`cause`, `CAUSE_HEADER`)이 그 자동화의 소유자가 쓴 글인지다 — 사람이
   * "지금 돌려"라고 했는데 에이전트가 같은 절차를 손으로 흉내 내던 것(10-01 #task)을 대신한다.
   * 원인이 에이전트(위임)거나 자동화가 낸 글이면 거절한다. 글은 버튼과 똑같이 소유자 이름으로
   * 나가고, 실행자는 회차와 `meta.automation.initiatedBy` 에 남는다. 규칙과 근거는 `automations.ts`.
   */
  const automationRefusal: Record<string, string> = {
    no_cause: 'only the automation owner can ask you to run it — this turn was not started by a human message that called you',
    cause_stale: 'the request that started this turn is more than an hour old; ask the owner to ask again',
    cause_used: 'this request already ran an automation once; ask the owner to ask again',
    cause_not_human: 'this turn was started by an agent; the automation owner must ask you directly',
    automation_reentry: 'this turn was started by an automation post; automations cannot re-run themselves through agents',
    not_found: 'no automation with this id owned by the person who asked',
    not_approved: 'the proposal is not approved yet (Settings › Automations › Approve)',
    agent_quota: 'agents may run one automation at most once per 10 minutes and 3 times per hour',
    chain_capped: 'the mention chain limit is reached',
    rate_limited: 'too many runs in the last hour; the automation is paused',
    duplicate: 'not queued', inactive: 'not queued',
  };

  server.registerTool('automation.list', {
    description: '이 턴을 시킨 사람의 승인된 자동화 목록(id·이름·대상 채널·켜짐·본문 앞 200자·마지막 회차). automation.run 에 줄 id 를 여기서 찾는다',
    inputSchema: {},
  }, async () => {
    const out = await listAutomationsForAgent(pool, { agentId: account.id, causeMessageId: cause });
    if ('refused' in out) return jsonResult({ error: { code: out.refused, message: automationRefusal[out.refused] } });
    return jsonResult(out);
  });

  server.registerTool('automation.run', {
    description: '승인된 자동화를 지금 한 번 돌린다(설정 › Automations 의 버튼과 같다). 그 자동화의 주인이 직접 시킨 턴에서만 된다. 글은 주인 이름으로 15초 안에 나간다',
    inputSchema: { automationId: z.string().uuid() },
  }, async ({ automationId }) => {
    const out = await runAutomationForAgent(pool, { automationId, agentId: account.id, causeMessageId: cause });
    if ('refused' in out) return jsonResult({ error: { code: out.refused, message: automationRefusal[out.refused] } });
    return jsonResult({
      run: out.run, automation: out.automation,
      next: 'Queued. The post goes out under the owner\'s name within ~15s; tell the requester in chat.',
    });
  });

  /**
   * 작업 항목(110, 협업 통합 설계 ①) — **내 주인의** 「내 작업」 보드에 밖의 일을 건다.
   *
   * 주인은 인자로 받지 않는다: `agent_config.owner_account_id` 하나다(`resolveWorkItemOwner`). 남의 보드에
   * 꽂을 길을 열지 않으려는 것이다. avcs intent 는 source=avcs·externalKey=`<repo>/<intent oid>`·이 스레드로
   * 걸고 state 는 주지 않는다 — 상태는 avcs 서버가 정본이다(워크스페이스 규칙 「작업 경과 알리기」).
   */
  server.registerTool('workitem.upsert', {
    description: '내 주인의 「내 작업」 보드에 밖의 일(PR·티켓·avcs intent)을 건다 — 같은 source·externalKey 면 고쳐 쓴다. avcs 는 externalKey=<repo>/<intent oid>, threadRootId 필수, state 생략',
    inputSchema: workItemUpsertSchema,
  }, async (args) => {
    const ownerId = await resolveWorkItemOwner(pool, account);
    if (!ownerId) return jsonResult({ error: { code: 'no_owner', message: WORK_ITEM_REFUSAL_MESSAGE.no_owner } });
    const out = await upsertWorkItem(pool, {
      ownerId, actorId: account.id,
      source: args.source, externalKey: args.externalKey, title: args.title,
      url: args.url ?? null, state: args.state ?? null, threadRootId: args.threadRootId ?? null,
    });
    if ('refused' in out) return jsonResult({ error: { code: out.refused, message: WORK_ITEM_REFUSAL_MESSAGE[out.refused] } });
    emitEvent({ type: 'inbox.updated', accountId: ownerId });
    return jsonResult({ item: out.item });
  });

  server.registerTool('workitem.list', {
    description: '내 주인의 보드에 걸린 작업 항목 가운데 내가 볼 수 있는 스레드에 붙은 것(threadRootId·source 로 좁힘)',
    inputSchema: {
      threadRootId: z.string().uuid().optional(),
      source: z.enum(WORK_ITEM_SOURCES).optional(),
    },
  }, async ({ threadRootId, source }) => {
    const ownerId = await resolveWorkItemOwner(pool, account);
    if (!ownerId) return jsonResult({ error: { code: 'no_owner', message: WORK_ITEM_REFUSAL_MESSAGE.no_owner } });
    return jsonResult({ items: await listWorkItems(pool, ownerId, account, { threadRootId, source }) });
  });

  server.registerTool('workitem.remove', {
    description: '내 주인의 보드에서 작업 항목 하나를 뗀다(source·externalKey)',
    inputSchema: {
      source: z.enum(WORK_ITEM_SOURCES),
      externalKey: z.string().trim().min(1).max(300),
    },
  }, async ({ source, externalKey }) => {
    const ownerId = await resolveWorkItemOwner(pool, account);
    if (!ownerId) return jsonResult({ error: { code: 'no_owner', message: WORK_ITEM_REFUSAL_MESSAGE.no_owner } });
    const removed = await removeWorkItem(pool, ownerId, account, { source, externalKey });
    if (removed) emitEvent({ type: 'inbox.updated', accountId: ownerId });
    return jsonResult({ removed });
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
    description: '나를 나중에 다시 부른다(기다릴 것이 있을 때). 예약은 스레드에 대기 줄로 보인다. 결과를 다른 스레드에 보고하기로 했으면 reportTo 에 그 채널·스레드 id',
    inputSchema: {
      channelId: z.string().uuid(),
      threadRootId: z.string().uuid(),
      notBeforeSec: z.number().int().min(WAKE_MIN_SEC).max(WAKE_MAX_SEC),
      reason: z.string().min(1).max(200),
      /**
       * 결과를 **다른 스레드에** 보고하기로 약속했으면 그 스레드(2026-10-06, 선택). 깨어난 턴의 프롬프트에
       * 그 약속이 실리고, 그 턴이 거기에 말하지 않고 끝나면 러너가 그 스레드에 경고를 남긴다. 옛 서버는
       * 이 키를 모른다 — zod 가 모르는 키를 버리므로 예약은 되고 약속만 빠진다.
       */
      reportTo: z.object({ channelId: z.string().uuid(), threadRootId: z.string().uuid() }).optional(),
    },
  }, async ({ channelId, threadRootId, notBeforeSec, reason, reportTo }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    // 보고처는 **내가 쓸 수 있는 스레드 머리**여야 한다 — 못 쓰는 곳을 약속으로 적어 두면 깨어난 턴이
    // 보고하려다 거절당하고, 러너의 경고도 그 자리에 못 남는다. 앵커와 같으면 뜻이 없어 싣지 않는다.
    let report: { channelId: string; threadRootId: string } | undefined;
    if (reportTo && reportTo.threadRootId !== threadRootId) {
      if (!(await assertChannelVisible(pool, reportTo.channelId, account.id))) {
        return jsonResult({ error: { code: 'forbidden', message: 'reportTo: not a member of that channel' } });
      }
      const head = await pool.query(
        `select 1 from message where id = $1 and channel_id = $2 and thread_root_id is null and deleted_at is null`,
        [reportTo.threadRootId, reportTo.channelId],
      );
      if (!head.rowCount) {
        return jsonResult({ error: { code: 'bad_report_to', message: 'reportTo.threadRootId 는 그 채널의 최상위 글(스레드 머리) id 여야 한다' } });
      }
      report = reportTo;
    }
    const result = await scheduleWake(pool, {
      accountId: account.id, channelId, threadRootId, notBeforeSec, reason,
      ...(report ? { reportTo: report } : {}),
    });
    if (result.refusal) return jsonResult({ error: result.refusal });

    // 대기 줄은 **지금 보여야** 뜻이 있다 — 사람이 "죽었나 기다리나"를 아는 근거다.
    // 그래서 일반 발화와 같은 이벤트를 태운다. inbox 는 만들지 않는다(자기 자신이다).
    const audience = await audienceFor(pool, channelId);
    emitEvent({ type: 'message.created', message: result.message, audience });
    // 보고처에도 "기다리는 것이 생겼다" 신호를 보낸다(신호만 — 값은 그쪽 화면이 자기 권한으로 GET).
    if (report) await announceReportWakes(pool, [report]).catch(() => undefined);
    return jsonResult({ wake: result.wake, message: result.message });
  });

  /**
   * 파일을 읽어 오되 **읽기가 실패하는 두 모양을 응답으로 바꾼다**(#609 에서 한 벌로 합쳤다).
   *
   * 이미지와 텍스트가 같은 두 실패를 만난다: 파일이 DB 가 기억하는 크기보다 크거나
   * (`OversizeError`), 행은 있는데 파일이 없거나(`AttachmentMissingError`, #257).
   * 각 경로가 자기 `try/catch` 를 쓰면 **이 파일이 경고하는 "판정이 두 벌"** 이 그대로
   * 생긴다 — 한쪽만 고친 날에 다른 쪽은 예외로 죽고, 에이전트는 그것을 "서버가 고장났다"로
   * 읽는다. 실제 사실은 "이 첨부를 못 읽는다"이고 대처가 다르다.
   *
   * `limit` 이 경로마다 다르므로 문구도 그 값으로 적는다 — 고정 문자열로 두면 텍스트가
   * 이미지의 숫자를 말한다. `meta` 를 받는 이유도 같다: 실패해도 **무엇이 왔는지**는
   * 알려 줘야 에이전트가 사람에게 그 첨부를 가리킬 수 있다.
   */
  async function readAttachment(
    meta: { id: string; filename: string; contentType: string; sizeBytes: number }, limit: number,
    storageKey: string,
  ): Promise<{ body: Buffer } | { error: ReturnType<typeof jsonResult> }> {
    try {
      return { body: await collect(await storage.read(storageKey), limit) };
    } catch (err) {
      if (err instanceof OversizeError) {
        return {
          error: jsonResult({
            attachment: meta,
            note: `file is larger than its recorded size and exceeds ${limit}B`,
            download: `GET /attachments/${meta.id} (Authorization: Bearer $HARKROOM_PAT)`,
          }),
        };
      }
      if (err instanceof AttachmentMissingError) {
        // 행은 있는데 파일이 없다(#257). REST 와 같은 코드로 답한다 — 찾은 경로는 싣지
        // 않는다(서버 파일시스템 경로를 알려 주는 셈이고, 에이전트가 할 일이 달라지지 않는다).
        return {
          error: jsonResult({
            error: { code: 'attachment_missing', message: 'attachment file not found on the server' },
          }),
        };
      }
      throw err;
    }
  }

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
   * **텍스트도 실린다(#609).** #585 가 이미지만 열어 둔 탓에, 로그·diff·`.json` 을 붙여 준
   * 사람에게 셸 없는 하네스의 에이전트는 여전히 *"파일명은 알지만 내용은 모른다"* 로
   * 답했다 — 고치려던 결함이 절반만 닫혀 있었다. 판정은 `isTextType`·`TEXT_MAX_BYTES`·
   * `decodeUtf8` 주석에 있다.
   *
   * 셋 다 아니거나 크면 **바이트 대신 메타데이터**를 준다(아래 IMAGE_TYPES·
   * IMAGE_MAX_BYTES 주석). 실패가 아니라 "이렇게 받아라"까지 함께 답한다.
   */
  /**
   * 비밀 보관소(PR 2). **이름만** 준다 — 값은 이 도구로도, 다른 어떤 MCP 결과로도 나가지 않는다
   * (MCP 결과는 모델 문맥·transcript·제공사로 간다). 값은 브릿지가 턴 임대로 받아 파일로만 쓴다(PR 3).
   * `channelIds` 의 null 은 "어느 채널에서든"이다.
   */
  server.registerTool('secret.list', {
    description: '내가 쓸 수 있는 비밀의 이름·종류·설명(값은 주지 않는다)',
  }, async () => {
    if (account.kind !== 'agent') return jsonResult({ secrets: [] });
    return jsonResult({ secrets: await listGrantedSecrets(pool, account.id) });
  });

  /**
   * 비밀을 **이 턴 전용 파일**로 받는다(비밀 보관소 PR 3). 실제 일은 오퍼레이터가 한다 — 브릿지가 넘긴
   * 이 호출을 오퍼레이터가 가로채 턴 임대로 값을 받고 파일에 쓴 뒤 경로만 돌려준다(`operator/turnSecrets.ts`).
   * 서버까지 왔다는 것은 오퍼레이터를 거치지 않았거나(PAT 러너) 옛 오퍼레이터라는 뜻이다 — 값은 주지 않는다.
   */
  /**
   * 위임(외부 API 권한 C안 P5). 판정은 전부 서버(`services/apiDelegation.ts`)다 — 받는 범위 ⊆ 준 범위·단계·30일·E1(루트 사람의
   * 에이전트만)·E2(사람 글이 아닌 턴이면 루트 사람 허락 대기). 머지 권한은 위임하지 않는다(v1).
   */
  server.registerTool('grant.delegate', {
    description: '내가 받은 API 권한을 다른 에이전트에게 다시 준다(사람이 「다시 줄 수 있음」을 켠 권한만). 범위는 내 범위 안, 만료 30일 안. 사람 글이 아닌 턴이면 사람이 허락해야 쓰인다',
    inputSchema: {
      to: z.string().min(1).max(64), connector: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      methods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])).min(1).max(5),
      pathPrefix: z.string().min(1).max(300), days: z.number().int().min(1).max(30),
      delegateDepth: z.number().int().min(0).max(1).default(0), writeNeedsHumanCause: z.boolean().optional(),
    },
  }, async ({ to, connector, methods, pathPrefix, days, delegateDepth, writeNeedsHumanCause }) => {
    if (account.kind !== 'agent') return jsonResult({ error: { code: 'not_agent', message: 'only agents delegate' } });
    const r = await delegateApiGrant(pool, {
      fromAgentId: account.id, to, connector, methods, pathPrefix, delegateDepth, writeNeedsHumanCause,
      expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(), causeMessageId: cause,
    });
    return jsonResult(r.ok ? { grantId: r.grantId, pending: r.pending, note: r.pending ? 'waiting for the root person to approve' : 'given — from the next turn' } : { error: { code: r.code, message: r.message ?? r.code } });
  });
  server.registerTool('grant.revoke', {
    description: '내가 다른 에이전트에게 다시 준 API 권한을 거둔다(그 아래로 준 것도 함께 끝난다)',
    inputSchema: { grantId: z.string().uuid() },
  }, async ({ grantId }) => {
    if (account.kind !== 'agent') return jsonResult({ error: { code: 'not_agent', message: 'only agents use this' } });
    const r = await revokeDelegation(pool, { agentId: account.id, grantId });
    return jsonResult(r.ok ? { revoked: true } : { error: { code: r.code ?? 'not_found', message: 'no such grant given by you' } });
  });
  server.registerTool('grant.list', {
    description: '내 API 권한(다시 줄 수 있는 단계 포함)과 내가 다시 준 권한 목록',
    inputSchema: {},
  }, async () => jsonResult(await listDelegations(pool, account.id)));

  server.registerTool('secret.mount', {
    description: '비밀 하나를 이 턴 전용 파일로 받는다 — 값이 아니라 파일 경로를 준다. 이름은 secret.list 에 있다. 파일 내용을 출력·복사하지 마라',
    inputSchema: { name: z.string().min(1).max(64) },
  }, async () => jsonResult({
    error: { code: 'operator_required', message: 'secret.mount is handled by the harkroom operator; this runner is not connected through one that supports it' },
  }));

  /**
   * 에이전트가 비밀을 만든다(102). `secret.mount` 와 같은 모양 — 오퍼레이터가 가로채 턴 임대를 붙여
   * `POST /agent/secrets`·`/agent/secrets/rotate` 로 보낸다. **값 칸은 없다** — 값은 서버가 만들거나(generate)
   * 오퍼레이터가 턴 워크스페이스의 파일에서 읽는다(import). 서버까지 왔다는 것은 오퍼레이터를 거치지 않았다는 뜻이다.
   */
  const genSpec = z.object({ type: z.enum(['password', 'token_hex', 'token_base64url', 'ssh_ed25519']), length: z.number().int().optional() });
  const operatorOnly = (tool: string) => async () => jsonResult({
    error: { code: 'operator_required', message: `${tool} is handled by the harkroom operator; this runner is not connected through one that supports it` },
  });
  server.registerTool('secret.generate', {
    description: '새 비밀을 서버가 만들어 보관소에 넣는다(값은 나에게 오지 않는다). type: password·token_hex·token_base64url·ssh_ed25519(공개키만 돌려준다). 나에게 이 채널로만 부여된다. 바로 써야 하면 mount:true(파일 경로를 준다). 소유자 글이 띄운 턴에서만, 소유자가 켠 에이전트만',
    inputSchema: {
      name: z.string().min(1).max(64), description: z.string().max(500).optional(), type: genSpec.shape.type,
      length: z.number().int().optional(), expiresInDays: z.number().int().min(1).max(365).optional(), mount: z.boolean().optional(),
    },
  }, operatorOnly('secret.generate'));
  server.registerTool('secret.import', {
    description: '턴 워크스페이스 안의 파일 내용을 비밀로 등록한다(값을 인자로 주지 마라 — 출력은 `cmd > file` 로 받아 경로를 준다). 성공하면 원본 파일은 지운다(keepSource:true 면 남김). 이미 화면·문맥에 보인 값은 유출된 것이니 등록하지 말고 사람에게 회전을 부탁하라',
    inputSchema: {
      name: z.string().min(1).max(64), path: z.string().min(1).max(4096), kind: z.enum(['text', 'file']).optional(),
      description: z.string().max(500).optional(), expiresInDays: z.number().int().min(1).max(365).optional(), keepSource: z.boolean().optional(),
    },
  }, operatorOnly('secret.import'));
  server.registerTool('secret.rotate', {
    description: '내가 만든 비밀의 값을 바꾼다(generate 또는 path 중 하나). 소유자가 값을 바꿨거나 다시 부여한 비밀은 못 바꾼다(adopted_by_owner)',
    inputSchema: { name: z.string().min(1).max(64), generate: genSpec.optional(), path: z.string().min(1).max(4096).optional() },
  }, operatorOnly('secret.rotate'));

  /**
   * 파일 올리기(미리보기 PR ③). 실제 일은 오퍼레이터가 한다 — 브릿지가 넘긴 이 호출을 오퍼레이터가 가로채
   * 턴 워크스페이스 안의 파일을 읽어 `/uploads` 에 올리고 첨부 id 를 돌려준다(`operator/turnUploads.ts`).
   * 여기 등록하는 이유는 `tools/list` 에 보이게 하려는 것이다(`secret.mount` 와 같은 모양). 서버까지 왔다는
   * 것은 오퍼레이터를 거치지 않았거나(PAT 러너) 옛 오퍼레이터라는 뜻이다.
   */
  server.registerTool('attachment.upload', {
    description: '턴 워크스페이스 안의 파일(그림·PDF·HTML 등)을 올려 첨부 id 를 받는다 — 아직 글에 붙지 않는다. message.post 의 attachmentIds 나 artifact.publish 의 attachmentId 로 쓴다',
    inputSchema: { path: z.string().min(1).max(4096), filename: z.string().min(1).max(255).optional() },
  }, async () => jsonResult({
    error: { code: 'operator_required', message: 'attachment.upload is handled by the harkroom operator; this runner is not connected through one that supports it' },
  }));

  server.registerTool('attachment.fetch', {
    description: '첨부 바이트 받기 — 이미지는 그림으로(3MiB 를 넘으면 줄인 사본), 텍스트는 글로 실린다. id 는 프롬프트의 [첨부: …] 에 있다',
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

    /**
     * 텍스트 경로(#609). 이미지보다 **먼저** 보지 않는다 — 둘은 겹치지 않으므로 순서가
     * 결과를 바꾸지 않고, 이미지가 이 도구의 원래 계약이라 그쪽을 먼저 읽게 둔다.
     */
    if (isTextType(contentType) && sizeBytes <= TEXT_READ_MAX_BYTES) {
      const bytes = await readAttachment(meta, TEXT_READ_MAX_BYTES, resolved.attachment.storageKey);
      if ('error' in bytes) return bytes.error;

      const decoded = decodeUtf8(bytes.body);
      if (decoded === null) {
        return jsonResult({
          attachment: meta,
          // 무엇이 막았는지 말한다. "텍스트인 줄 알았는데 아니다"는 에이전트가 사람에게
          // 물을 수 있는 사실이고, 그냥 "못 실었다"는 아니다.
          note: 'not valid UTF-8; bytes are not carried as text in this response',
          download: `GET /attachments/${id} (Authorization: Bearer $HARKROOM_PAT)`,
        });
      }

      const cut = truncateText(decoded, TEXT_MAX_BYTES);
      return jsonResult({
        attachment: meta,
        // 자른 것을 **구조로도** 말한다. 본문 안의 표식만 두면 에이전트가 그것을 파일
        // 내용으로 읽을 수 있고, 여기만 두면 사람이 잘린 자리를 못 찾는다. 둘 다 둔다.
        ...(cut ? { truncated: { droppedCharacters: cut.dropped, limitBytes: TEXT_MAX_BYTES } } : {}),
        ...(cut ? { download: `GET /attachments/${id} (Authorization: Bearer $HARKROOM_PAT)` } : {}),
        text: cut ? cut.text : decoded,
      });
    }

    /**
     * 한도를 넘는 그림은 **줄여서** 싣는다(`imageDownscale.ts`). 폰 스크린샷이 그대로 3MiB 를
     * 넘어, 줄이지 않으면 에이전트는 셸 다운로드 안내만 받고 — 그 길은 PAT 가 필요해 auto mode
     * 에서 막힌다. 원본은 그대로 두고 이 응답만 줄인다. 줄였다는 사실과 원본 크기·해상도를
     * 텍스트 줄에 적는다 — 에이전트가 "작은 글씨가 안 보인다"를 원본 탓으로 오해하지 않게.
     */
    if (IMAGE_TYPES.includes(contentType) && sizeBytes > IMAGE_MAX_BYTES && sizeBytes <= DOWNSCALE_READ_MAX_BYTES) {
      const notInlined = (reason: string) => jsonResult({
        attachment: meta,
        note: `too large to inline (${sizeBytes}B > ${IMAGE_MAX_BYTES}B) and could not be downscaled: ${reason}`,
        download: `GET /attachments/${id} (Authorization: Bearer $HARKROOM_PAT) — needs shell/HTTP access; if you have neither, say so and ask the human instead of guessing`,
      });
      // 원본을 읽기 **전에** 자리를 잡는다 — 기다리는 호출이 저마다 32MiB 를 쥐고 쌓이지 않게.
      const release = tryAcquireDownscaleSlot();
      if (!release) return notInlined('busy (too many downscales in flight); try again shortly');
      let small: Awaited<ReturnType<typeof downscaleImage>>;
      try {
        const original = await readAttachment(meta, DOWNSCALE_READ_MAX_BYTES, resolved.attachment.storageKey);
        if ('error' in original) return original.error;
        small = await downscaleImage(original.body, IMAGE_MAX_BYTES);
      } finally {
        release();
      }
      if (small.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                attachment: meta,
                downscaled: {
                  originalBytes: sizeBytes,
                  originalResolution: `${small.original.width}x${small.original.height}`,
                  bytes: small.data.length,
                  resolution: `${small.resized.width}x${small.resized.height}`,
                  mimeType: small.mimeType,
                  ...(small.firstFrameOnly ? { firstFrameOnly: true } : {}),
                  note: 'resized copy for this response only; the stored original is unchanged',
                },
              }),
            },
            { type: 'image' as const, data: small.data.toString('base64'), mimeType: small.mimeType },
          ],
        };
      }
      return notInlined(small.reason);
    }

    if (!IMAGE_TYPES.includes(contentType) || sizeBytes > IMAGE_MAX_BYTES) {
      return jsonResult({
        attachment: meta,
        // 왜 바이트가 없는지 **이유를 말한다.** "빈 응답"으로 두면 에이전트는 받기가
        // 실패한 것과 구별하지 못하고 같은 호출을 다시 한다.
        // 텍스트인데 여기까지 온 것은 **읽기 상한을 넘었다**는 뜻 하나뿐이다(위 분기가
        // 그 조건만으로 갈린다). 그때 `not an inlineable image type` 이라고 답하면 거짓말이다
        // — 에이전트는 타입을 바꿔 다시 올려 달라고 사람에게 말하게 된다.
        note: isTextType(contentType)
          ? `too large to inline as text (${sizeBytes}B > ${TEXT_READ_MAX_BYTES}B)`
          : sizeBytes > IMAGE_MAX_BYTES
            ? `too large to inline (${sizeBytes}B > ${IMAGE_MAX_BYTES}B)`
            : 'not an inlineable image type; bytes are not carried in this response',
        // 셸이 없는 하네스에는 이 경로가 **막힌 길**이라는 것을 말해 준다. 그러지 않으면
        // 에이전트는 이 안내를 만족시키려 시도했다가 조용히 실패하고 같은 자리를 돈다 —
        // 못 여는 것을 아는 것이 사람에게 물어볼 근거가 된다.
        download: `GET /attachments/${id} (Authorization: Bearer $HARKROOM_PAT) — needs shell/HTTP access; if you have neither, say so and ask the human instead of guessing`,
      });
    }

    const image = await readAttachment(meta, IMAGE_MAX_BYTES, resolved.attachment.storageKey);
    if ('error' in image) return image.error;
    const body = image.body;

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
  leakGuard: SecretLeakGuard | null = null,
  operatorHub?: OperatorHub,
): Promise<void> {
  app.post('/mcp', {
    /**
     * 전역 1MB(buildServer)보다 크게 둔다 — `artifact.publish` 의 `html` 인자가 2MB 까지이고, JSON 으로
     * 실리면 따옴표·줄바꿈이 두 글자가 되어 최악에 두 배가 된다. 이 한도에 먼저 걸리면 에이전트는
     * "파일로 올려라"라는 도구의 답 대신 fastify 의 413 을 받는다.
     * 본문을 읽기 **전에** 에이전트가 아닌 요청을 끊는다(아래 onRequest) — 큰 한도를 익명에게 열지 않는다.
     */
    bodyLimit: MCP_BODY_LIMIT_BYTES,
    onRequest: async (req, reply) => {
      if (!req.account || req.account.kind !== 'agent') {
        return reply.code(req.account ? 403 : 401)
          .send({ error: { code: 'agent_only', message: 'MCP surface requires an agent PAT or an operator assignment' } });
      }
    },
  }, async (req, reply) => {
    if (!req.account || req.account.kind !== 'agent') {
      return reply.code(req.account ? 403 : 401)
        .send({ error: { code: 'agent_only', message: 'MCP surface requires an agent PAT or an operator assignment' } });
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
    /*
      턴의 원인(`CAUSE_HEADER`, 러너 → 브릿지 → 오퍼레이터). 연쇄 깊이를 이 메시지에서 물려받는다.
      **믿기 전에 확인한다** — 확인은 `postMessage` 가 한다: 그 메시지가 이 에이전트를 실제로
      깨웠어야(inbox) 원인으로 친다. 아니면 옛 셈(스레드 스캔)으로 간다.
    */
    const rawCause = req.headers[CAUSE_HEADER];
    const cause = typeof rawCause === 'string' && UUID_RE.test(rawCause) ? rawCause : null;
    const server = buildMcpServer(pool, req.account, lifecycle, storage, agentPresence, cause, leakGuard, req.operator?.id ?? null, operatorHub);
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
