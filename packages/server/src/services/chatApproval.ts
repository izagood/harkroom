import type { Pool } from 'pg';
import type { MessageRow } from '@harkroom/shared';
import { emitPosted } from '../events.js';
import { assertChannelVisible, audienceFor } from './channels.js';
import { postMessage } from './messages.js';
import { decide } from './decisions.js';
import type { PermissionDecision, PermissionKind } from './permissionRequests.js';

/**
 * 소유자가 **글로** 권한 요청을 승인한다(스레드 795a9663, jaebin B 「명시적으로 승인하면 승인이 되어야 해」, 10-14).
 *
 * 카드 버튼과 같은 결정이다 — 요청마다 `decidePermissionRequest` 를 그대로 부르므로 7일·`allow_agent_cause=false`·
 * 요청 행의 소유자 대조·만료/이미 결정됨 판정·카드에 답을 달아 에이전트를 깨우는 것까지 버튼과 같다. 다른 점은 무엇을
 * 승인했는지를 서버가 **글의 꼴**에서 정한다는 것 하나라, 그 꼴을 좁게 둔다(security 기준 1~20):
 *
 * - 글쓴이는 요청한 에이전트의 소유자 본인, 앱에 로그인한 사람 세션(REST)만 — 부르는 쪽(글 올리기 라우트)이 거른다.
 *   에이전트·PAT·MCP·자동화·위임·거울 글은 이 라우트를 타지 않거나 거기서 걸러진다.
 * - 글 전체가 승인 낱말 하나 + (멘션·카드 링크) 뿐이어야 한다. 인용(`>`)·코드가 섞이면 보지 않는다. 문장 속 낱말로는
 *   판정하지 않으므로 「승인 말고 기다려」 같은 부정·의문은 처음부터 맞지 않는다. 거절은 글로 받지 않는다.
 * - 어느 요청인지는 **구조로만** 정한다: 본문의 `harkroom://message/<카드 id>` 링크(1~5개, 어느 채널이든), 링크가 없으면
 *   같은 스레드에 글보다 먼저 있던 열린 권한 카드가 딱 하나일 때 그 카드, 그 스레드에 권한 카드가 없으면 소유자의 에이전트들이 글보다
 *   먼저 낸 기다리는 요청이 딱 하나일 때 그것(T3 — jaebin 이 경쟁 위험을 알고 골랐다, 카드 077fa790). 둘 이상이면 승인하지 않는다.
 * - 올린 순간의 본문만 본다(수정은 다시 판정하지 않는다). 승인했으면 글 아래에 요청 행에서 그린 확인 줄을, 승인 낱말인데
 *   어느 요청인지 몰랐으면 그렇다는 안내 줄을 단다 — 조용히 넘기지 않는다(사례 ①).
 */

export const CHAT_APPROVAL_MAX_CARDS = 5;

/** 글 전체가 이것들 중 하나여야 한다(앞뒤 공백·마침표·느낌표만 허용). */
const APPROVAL_WORDS = new Set(['승인', '승인함', '승인해', '승인합니다', '허락', '허락함', 'approve', 'approved']);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MENTION_TOKEN = new RegExp(`<@${UUID}>`, 'gi');
const MESSAGE_LINK = new RegExp(`harkroom://message/(${UUID})`, 'gi');
/** 마크다운 링크 `[이름표](harkroom://message/<id>)` — 이름표는 에이전트가 건넨 글일 수 있어 판정에 쓰지 않는다. */
const MD_MESSAGE_LINK = new RegExp(`\\[[^\\]\\n]{0,200}\\]\\(\\s*harkroom://message/(${UUID})\\s*\\)`, 'gi');

export type ChatApprovalParse = { cardIds: string[] };
/** 어떻게 가리켰나 — T1 카드 링크 · T2 카드 스레드 안의 맨 글 · T3 카드 없는 스레드의 맨 글(소유자 요청이 하나뿐). 감사에 남는다. */
export type ChatTarget = 'T1' | 'T2' | 'T3';

/**
 * 본문이 「명시적 승인」 꼴인가. 아니면 null. 맞으면 본문에서 뽑은 카드 id(중복 제거, 순서 유지)를 준다 — 빈 배열이면 링크 없는 승인.
 * 인용·코드·카드 아닌 링크·다른 낱말이 하나라도 있으면 null 이다.
 */
export function parseChatApproval(body: string): ChatApprovalParse | null {
  if (body.length > 2000) return null;
  // 인용·코드는 남의 글이거나 지어낼 수 있는 글이다 — 섞이면 아예 보지 않는다.
  if (/^\s*>/m.test(body) || body.includes('`')) return null;
  const ids: string[] = [];
  const take = (_: string, id: string) => { ids.push(id.toLowerCase()); return ' '; };
  const rest = body
    .replace(MD_MESSAGE_LINK, take)
    .replace(MESSAGE_LINK, take)
    .replace(MENTION_TOKEN, ' ')
    .replace(/[\s.!。！]+/g, ' ')
    .trim()
    .toLowerCase();
  if (!APPROVAL_WORDS.has(rest)) return null;
  return { cardIds: [...new Set(ids)] };
}

type Candidate = {
  cardMessageId: string; requestId: string; agentId: string; agentHandle: string; kind: PermissionKind; target: string;
  channelId: string; channelName: string | null; status: string; expired: boolean; denialId: string | null;
  ownerAccountId: string | null; cardSeq: number; cardCreatedAt: Date;
};

const CANDIDATE_SQL = `
  select p.card_message_id as "cardMessageId", p.id as "requestId", p.agent_id as "agentId", a.handle as "agentHandle",
         p.kind, p.target, p.channel_id as "channelId", ch.name as "channelName", p.status, p.expires_at <= now() as expired,
         p.denial_id as "denialId", c.owner_account_id as "ownerAccountId", m.seq as "cardSeq", m.created_at as "cardCreatedAt"
    from permission_request p
    join message m on m.id = p.card_message_id and m.deleted_at is null
    join account a on a.id = p.agent_id
    left join agent_config c on c.account_id = p.agent_id
    left join channel ch on ch.id = p.channel_id`;

type Outcome = { c: Candidate; ok: true; grantExpiresAt: string | null; grantMode?: 'once' | 'hour' } | { c: Candidate; ok: false; why: string; hidden?: true };

/**
 * 사람이 앱에서 올린 글 하나를 보고, 「명시적 승인」이면 가리킨 권한 요청을 승인한다. 부르는 쪽(글 올리기 라우트)이
 * `kind=human`·`authVia=session` 을 이미 확인했다. 실패해도 던지지 않는다 — 글은 이미 올라갔다.
 */
export async function applyChatApproval(pool: Pool, message: MessageRow): Promise<void> {
  if (!message.authorId) return;
  const parsed = parseChatApproval(message.body);
  if (!parsed) return;
  try {
    await approveFromMessage(pool, message, message.authorId, parsed);
  } catch (err) {
    console.error('[chat_approval] 글 승인 판정 실패(글은 올라갔다):', err);
  }
}

async function approveFromMessage(pool: Pool, message: MessageRow, actorId: string, parsed: ChatApprovalParse): Promise<void> {
  const threadRootId = message.threadRootId ?? message.id;
  let targets: Candidate[];
  let target: ChatTarget = 'T1';
  if (parsed.cardIds.length > 0) {
    if (parsed.cardIds.length > CHAT_APPROVAL_MAX_CARDS) {
      await notice(pool, message, actorId, `한 글로는 권한 카드를 ${CHAT_APPROVAL_MAX_CARDS}장까지 승인한다 — 아무것도 승인하지 않았다. 나눠서 다시 써라.`);
      return;
    }
    const rows = (await pool.query<Candidate>(`${CANDIDATE_SQL} where p.card_message_id = any($1::uuid[])`, [parsed.cardIds])).rows;
    // 링크가 권한 카드가 아니면(일반 글·없는 id) 그 링크는 무시한다 — 셋 다 카드가 아니면 아래 안내로 간다.
    targets = parsed.cardIds.map((id) => rows.find((r) => r.cardMessageId === id)).filter((r): r is Candidate => !!r);
    if (targets.length === 0) {
      if (await ownsPendingRequest(pool, actorId)) {
        await notice(pool, message, actorId, '링크한 글 중에 권한 요청 카드가 없다 — 아무것도 승인하지 않았다. 권한 카드의 링크를 붙여 다시 써라.');
      }
      return;
    }
  } else {
    // T2 — 글이 권한 카드의 스레드 안이면 그 스레드만 본다: 글보다 먼저 있던 열린 권한 카드가 딱 하나일 때.
    // 상태와 관계없이 이 스레드의 권한 카드를 다 읽는다 — 하나라도 있으면 T3 로 넘기지 않는다(security F3: 버튼으로 정한 뒤 같은
    // 스레드에 쓴 「승인」이 다른 스레드의 관계없는 요청을 승인하면 안 된다).
    const inThread = (await pool.query<Candidate>(
      `${CANDIDATE_SQL}
        where m.channel_id = $1 and (m.id = $2 or m.thread_root_id = $2) and m.seq < $3
        order by m.seq`,
      [message.channelId, threadRootId, message.seq])).rows;
    const open = inThread.filter((c) => c.status === 'pending' && !c.expired);
    if (open.length > 1) {
      // 남의 카드만 있는 스레드에서 쓴 「승인」에는 안내를 달지 않는다 — 그 사람이 정할 수 있는 카드가 아니다.
      if (open.some((c) => c.ownerAccountId === actorId)) await notice(pool, message, actorId, `이 스레드에 기다리는 권한 카드가 ${open.length}장이라 어느 것인지 몰라 승인하지 않았다. 승인할 카드의 링크를 붙여 다시 써라:`, open);
      return;
    }
    if (open.length === 1) {
      targets = open;
      target = 'T2';
    } else if (inThread.length > 0) {
      if (inThread.some((c) => c.ownerAccountId === actorId)) {
        await notice(pool, message, actorId, '이 스레드의 권한 카드는 이미 정해졌거나 만료돼 승인할 것이 없다. 다른 요청을 승인하려면 그 카드의 링크를 붙여 다시 써라.');
      }
      return;
    } else {
      // T3 — 권한 카드가 (상태와 관계없이) 하나도 없는 스레드의 맨 글(jaebin 카드 077fa790: 「맨 글도 인정, 경쟁 위험 감수」). 이 소유자의 에이전트들이 낸
      // 요청 가운데 글보다 먼저 생기고 아직 기다리는 것이 **정확히 하나**일 때만. 머지 거절 카드·볼 수 없는 채널의 요청도 후보로 세고
      // (그래야 「하나뿐」이 거짓이 되지 않는다) 결정 단계에서 거절한다.
      const mine = (await pool.query<Candidate>(
        `${CANDIDATE_SQL}
          where c.owner_account_id = $1 and p.status = 'pending' and p.expires_at > now() and m.created_at < $2
          order by m.created_at`,
        [actorId, message.createdAt])).rows;
      if (mine.length !== 1) {
        if (mine.length > 1) {
          await notice(pool, message, actorId, `기다리는 권한 요청이 ${mine.length}개라 어느 것인지 몰라 승인하지 않았다. 승인할 카드의 링크를 붙여 다시 써라:`, mine);
        } else if (await ownsPendingRequest(pool, actorId)) {
          await notice(pool, message, actorId, '이 글보다 먼저 온 권한 요청이 없어 승인하지 않았다. 승인할 카드의 링크(harkroom://message/…)를 붙여 다시 써라.');
        }
        return;
      }
      targets = mine;
      target = 'T3';
    }
  }

  const outcomes: Outcome[] = [];
  for (const c of targets) outcomes.push(await decideOne(pool, message, actorId, c, target));
  // 이 사람의 것이 아닌 카드만 링크했으면 아무 줄도 남기지 않는다 — 남의 에이전트 요청을 글로 들춰 보이지 않는다.
  const mine = outcomes.filter((o) => o.c.ownerAccountId === actorId);
  if (mine.length === 0) return;
  await confirm(pool, message, actorId, mine);
}

async function decideOne(pool: Pool, message: MessageRow, actorId: string, c: Candidate, target: ChatTarget): Promise<Outcome> {
  if (c.ownerAccountId !== actorId) return { c, ok: false, why: '이 에이전트의 소유자가 아니다' };
  if (!(await assertChannelVisible(pool, c.channelId, actorId))) return { c, ok: false, why: '볼 수 없는 채널의 카드 — 승인하지 않았다', hidden: true };
  // 카드가 글보다 먼저 있었어야 한다 — 같은 채널이면 seq, 다른 채널이면 시각으로 본다.
  const before = c.channelId === message.channelId ? c.cardSeq < message.seq : c.cardCreatedAt.getTime() <= new Date(message.createdAt).getTime();
  if (!before) return { c, ok: false, why: '글보다 나중에 선 카드다' };
  // 머지 거절에서 온 카드(1회 머지는 ghUser·head 대조가 필요하다)는 카드에서만 정한다.
  if (c.denialId) return { c, ok: false, why: '머지 거절 카드는 카드에서 직접 정한다' };
  if (c.status !== 'pending') return { c, ok: false, why: '이미 정해진 요청이다' };
  if (c.expired) return { c, ok: false, why: '만료된 요청이다' };
  // 정확한 명령은 가장 좁게 — 이번 한 번만. 1시간은 카드 버튼에서만 준다.
  const decision: PermissionDecision = c.kind === 'command' ? 'approve_once' : 'approve';
  // 소유자는 위에서 대조했다 — ref 에 ownerAccountId 를 싣지 않는다.
  const out = await decide(pool, { kind: 'permission', agentId: c.agentId, requestId: c.requestId, cardMessageId: c.cardMessageId }, actorId, {
    option: decision, via: 'chat', chat: { messageId: message.id, target },
  });
  if (out.kind !== 'permission') return { c, ok: false, why: '권한 요청이 아니다' };
  if (!out.ok) return { c, ok: false, why: out.message };
  const d = out.result;
  return { c, ok: true, grantExpiresAt: d.grantExpiresAt, ...(d.grantMode ? { grantMode: d.grantMode } : {}) };
}

/** 소유자의 에이전트 중 기다리는 권한 요청이 하나라도 있는가 — 없으면 「승인」이라는 글에 안내를 달지 않는다(그 낱말은 흔하다). */
async function ownsPendingRequest(pool: Pool, actorId: string): Promise<boolean> {
  const r = await pool.query(
    `select 1 from permission_request p join agent_config c on c.account_id = p.agent_id
      where c.owner_account_id = $1 and p.status = 'pending' and p.expires_at > now() limit 1`, [actorId]);
  return (r.rowCount ?? 0) > 0;
}

/** 본문에 넣는 에이전트 이름 — `@` 를 바꿔 멘션이 되지 않게 한다. */
const plain = (s: string) => s.replace(/@/g, '＠').replace(/`/g, "'");

async function confirm(pool: Pool, message: MessageRow, actorId: string, outcomes: Outcome[]): Promise<void> {
  const lines = outcomes.map((o) => {
    // 볼 수 없는 채널의 카드는 내용을 적지 않는다(security F1) — 규칙 원문·채널 이름이 글 쓴 채널에 새지 않게.
    if (!o.ok && o.hidden) return `- ✗ ${o.why}`;
    const what = `${plain(o.c.agentHandle)} · ${o.c.kind === 'merge' ? '머지' : '명령'} \`${plain(o.c.target)}\` · #${plain(o.c.channelName ?? '?')}`;
    if (!o.ok) return `- ✗ ${what} — ${o.why}`;
    const until = o.grantMode === 'once' ? '이번 한 번' : o.grantExpiresAt ? `${o.grantExpiresAt.slice(0, 16).replace('T', ' ')} UTC 까지` : '';
    return `- ✓ ${what} — ${until}`;
  });
  const anyOk = outcomes.some((o) => o.ok);
  const head = anyOk ? '✅ 이 글로 권한 요청을 승인했다(카드와 같은 효과).' : '이 글로는 아무 권한 요청도 승인하지 않았다.';
  const tail = anyOk ? '\n거두려면 설정 › 에이전트 › 할 수 있는 일에서 지우거나, 그 에이전트에게 「그 권한 거둬」라고 하라.' : '';
  await post(pool, message, actorId, `${head}\n${lines.join('\n')}${tail}`, {
    chatApproval: {
      messageId: message.id,
      results: outcomes.map((o) => (!o.ok && o.hidden ? { ok: false, why: o.why } : { requestId: o.c.requestId, cardMessageId: o.c.cardMessageId, ok: o.ok, ...(o.ok ? {} : { why: o.why }) })),
    },
  });
}

async function notice(pool: Pool, message: MessageRow, actorId: string, text: string, candidates: Candidate[] = []): Promise<void> {
  // 후보 목록은 링크로 싣는다 — 소유자가 「승인 <링크>」로 바로 풀 수 있게.
  // 링크**만** 싣는다(security F2) — 후보에는 글쓴이가 볼 수 없는 채널의 요청도 있을 수 있어서, 규칙·채널 이름을 적으면 그대로 샌다.
  // 링크는 열 때 볼 수 있는지 다시 판정한다.
  const list = candidates.slice(0, 10).map((c) => `\n- harkroom://message/${c.cardMessageId}`).join('');
  const more = candidates.length > 10 ? `\n- …그 밖 ${candidates.length - 10}개` : '';
  await post(pool, message, actorId, `⚠️ ${text}${list}${more}`, {
    chatApproval: { messageId: message.id, results: [], candidates: candidates.slice(0, 10).map((c) => c.cardMessageId) },
  });
}

async function post(pool: Pool, message: MessageRow, actorId: string, body: string, meta: Record<string, unknown>): Promise<void> {
  const posted = await postMessage(pool, {
    channelId: message.channelId, threadRootId: message.threadRootId ?? message.id, authorId: actorId, body, kind: 'system', serverNotice: true,
    meta: { accountId: actorId, ...meta },
  });
  if (!posted.failure && !posted.replayed) emitPosted(posted, await audienceFor(pool, message.channelId));
}
