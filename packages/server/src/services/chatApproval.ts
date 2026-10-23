import type { Pool } from 'pg';
import type { MessageRow } from '@harkroom/shared';
import { emitPosted } from '../events.js';
import { assertChannelVisible, audienceFor } from './channels.js';
import { postMessage } from './messages.js';
import { decide, isGenuinePermissionMirror, resolveDecision, type DecideInput } from './decisions.js';
import type { PermissionKind } from './permissionRequests.js';
import { systemI18n } from './systemI18n.js';

/**
 * 소유자가 **글로** 권한 요청을 승인한다(스레드 795a9663, jaebin B 「명시적으로 승인하면 승인이 되어야 해」, 10-14).
 *
 * 카드 버튼과 같은 결정이다 — 요청마다 `decidePermissionRequest` 를 그대로 부르므로 7일·`allow_agent_cause=false`·
 * 요청 행의 소유자 대조·만료/이미 결정됨 판정·카드에 답을 달아 에이전트를 깨우는 것까지 버튼과 같다. 다른 점은 무엇을
 * 승인했는지를 서버가 **글의 꼴**에서 정한다는 것 하나라, 그 꼴을 좁게 둔다(security 기준 1~20):
 *
 * - 글쓴이는 요청한 에이전트의 소유자 본인, 앱에 로그인한 사람 세션(REST)만 — 부르는 쪽(글 올리기 라우트)이 거른다.
 *   에이전트·PAT·MCP·자동화·위임·거울 글은 이 라우트를 타지 않거나 거기서 걸러진다.
 * - 글은 문장이어도 된다(P4). 승인 낱말(G2: 승인·허락·머지해·진행해·approve 와 그 활용)만 승인으로 본다. 인용(`>`)·코드는
 *   지우고 읽는다. 부정·거부·보류(말고·하지 마·보류·취소·잠깐·기다려·아니·못·금지·불가·거부·중지·나중…)나 물음(`?`, 또는 「될까」·「되나」·「해도 돼」 같은 물음 끝)이 있으면 정하지 않고 안내만 단다. 「바이패스」는
 *   승인하지 않는다. 거절(거절·deny)은 카드 링크가 있을 때만(G3).
 * - 어느 요청인지는 **구조로만** 정한다: 본문의 `harkroom://message/<카드 id>` 링크(1~5개, 어느 채널이든, 거울은 원본으로 —
 *   `resolveDecision`), 링크가 없으면 같은 스레드에 글보다 먼저 있던, 이 사람이 정할 수 있는 열린 카드가 딱 하나일 때 그 카드
 *   (머지 거절 카드 포함 — head 는 카드가 보여 준 값으로 묶고 CI 실패 카드는 「CI 무시」가 있어야 한다), 그 스레드에 권한 카드가
 *   없으면 소유자의 에이전트들이 글보다 먼저 낸 기다리는 요청이 딱 하나일 때 그것(T3, 카드 077fa790). 선택지 카드는 글로 답하지 않는다.
 * - 올린 순간의 본문만 본다(수정은 다시 판정하지 않는다). 승인했으면 글 아래에 요청 행에서 그린 확인 줄을, 승인 낱말인데
 *   어느 요청인지 몰랐으면 그렇다는 안내 줄을 단다 — 조용히 넘기지 않는다(사례 ①).
 */

export const CHAT_APPROVAL_MAX_CARDS = 5;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MENTION_TOKEN = new RegExp(`<@${UUID}>`, 'gi');
const MESSAGE_LINK = new RegExp(`harkroom://message/(${UUID})`, 'gi');
/** 마크다운 링크 `[이름표](harkroom://message/<id>)` — 이름표는 에이전트가 건넨 글일 수 있어 판정에 쓰지 않는다. */
const MD_MESSAGE_LINK = new RegExp(`\\[[^\\]\\n]{0,200}\\]\\(\\s*harkroom://message/(${UUID})\\s*\\)`, 'gi');

/**
 * 승인 낱말(G2 — 명시적인 것만, 활용형 포함). 「승인」·「허락」은 뒤에 명사가 붙어 다른 뜻이 되는 꼴(승인 요청·승인 대기·승인받다·
 * 승인을…)과 앞에 「미」·「무」가 붙은 꼴은 뺀다. 「머지」·「진행」은 동사 활용(해·했·하자·합…)일 때만.
 */
const APPROVE_KO = /(?<![미무불])(?:승인|허락)(?!\s*(?:요청|대기|받|을|된|되|필요|버튼|기다|여부|권한|카드|건|전에|후에))|(?:머지|진행)\s*(?:해|했|하자|합|할게|하세요|시켜)/;
const APPROVE_EN = /\b(?:approve|approved|approves)\b/;
const DENY = /거절|\b(?:deny|denied|denies)\b/;
const BYPASS = /바이패스|\bbypass/;
/**
 * 부정·거부·보류·미루기(「말고」·「하지 마」·「보류」·「취소」·「잠깐」·「기다려」·「아니」·「못」·「금지」·「불가」·「거부」·「중지」·
 * 「멈춰」·「나중」·「이따」·「다음에」) — 「안 해」·「않」 같은 부정 활용도 같이 막는다. 넓게 잡는다 — 잘못 막으면 카드에서 정하면
 * 되지만, 잘못 승인하면 되돌릴 수 없다(fail closed).
 */
const NEGATION = /말고|하지\s*마|보류|취소|잠깐|기다려|아니|못|금지|불가|거부|중지|멈춰|멈춤|나중|이따|다음에|안\s*(?:해|함|돼|할|한|합)|않|\b(?:don'?t|do not|not|no|wait|hold|cancel|stop|never|later)\b/;
const QUESTION = /[?？]/;
/**
 * 물음표 없는 한국어 물음 — 문장·마디 끝의 「까·나·니·냐·는지」(「될까」·「되나」·「했니」·「하냐」·「됐는지」)와
 * 「해도 돼/될/되」(허락을 묻는 꼴). 「승인합니다」·「승인해」처럼 「다」·「해」로 끝나는 말은 걸리지 않는다.
 */
const QUESTION_KO = /(?:까|나|니|냐|는지)(?=\s*(?:$|[.,;:!~…\n]|ㅋ|ㅎ|ㅠ|ㅜ))|해도\s*(?:돼|될|되)/m;
const CI_WORD = /ci\s*무시|ignore\s*(?:the\s*)?ci\b/;

export type ChatBlock = 'negated' | 'question' | 'bypass' | 'conflict';
export type ChatApprovalParse = {
  /** 본문에서 뽑은 카드 링크 id(중복 제거, 순서 유지). */
  cardIds: string[];
  /** 승인·거절 낱말. 둘 다 없으면 null(링크만 있는 글). */
  action: 'approve' | 'deny' | null;
  /** 낱말이 있어도 정하지 않는 까닭 — 있으면 아무것도 정하지 않고 안내 줄만 단다. */
  block: ChatBlock | null;
  /** 「CI 무시」·"ignore CI" 가 있는가 — CI 실패 카드는 이것이 있어야 승인한다. */
  ciWord: boolean;
};
/** 어떻게 가리켰나 — T1 카드 링크 · T2 카드 스레드 안의 맨 글 · T3 카드 없는 스레드의 맨 글(소유자 요청이 하나뿐). 감사에 남는다. */
export type ChatTarget = 'T1' | 'T2' | 'T3';

/**
 * 글이 결정과 관계있는가를 **순수하게** 읽는다(P4). 승인·거절·바이패스 낱말도 카드 링크도 없으면 null.
 * 인용(`>` 줄)·코드(``` 블록·`인라인`)는 남의 글이거나 지어낼 수 있는 글이라 지우고 본다 — 거기 든 낱말·링크는 세지 않는다.
 */
export function parseChatApproval(body: string): ChatApprovalParse | null {
  if (body.length > 2000) return null;
  const stripped = body
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`?/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ');
  const ids: string[] = [];
  const take = (_: string, id: string) => { ids.push(id.toLowerCase()); return ' '; };
  const rest = stripped
    .replace(MD_MESSAGE_LINK, take)
    .replace(MESSAGE_LINK, take)
    .replace(MENTION_TOKEN, ' ')
    .toLowerCase();
  const approve = APPROVE_KO.test(rest) || APPROVE_EN.test(rest);
  const deny = DENY.test(rest);
  const bypass = BYPASS.test(rest);
  const cardIds = [...new Set(ids)];
  if (!approve && !deny && !bypass && cardIds.length === 0) return null;
  let block: ChatBlock | null = null;
  if (approve || deny || bypass) {
    if (bypass) block = 'bypass';
    else if (QUESTION.test(rest)) block = 'question';
    else if (NEGATION.test(rest)) block = 'negated';
    else if (QUESTION_KO.test(rest)) block = 'question';
    else if (approve && deny) block = 'conflict';
  }
  return { cardIds, action: approve ? 'approve' : deny ? 'deny' : null, block, ciWord: CI_WORD.test(rest) };
}

/** 안내 줄의 까닭(`system.chatApproval.<까닭>` 키와 같다). 본문은 한국어로 남고, 새 앱은 표지로 그린다. */
const REASON_KO = {
  negated: '부정·보류하는 말이 있어 아무것도 정하지 않았다.',
  question: '물음표가 있어 질문으로 보고 정하지 않았다. 승인하려면 물음표 없이 다시 쓴다.',
  bypass: '「바이패스」는 글로 승인하지 않는다. 카드에서 정한다.',
  conflict: '승인과 거절 낱말이 함께 있어 정하지 않았다.',
  denyNeedsLink: '글로 거절하려면 카드 링크를 붙인다.',
  noWord: '카드 링크는 있지만 승인 낱말(승인·허락·머지해·진행해·approve)이 없다.',
  tooMany: '한 글로는 카드를 5장까지만 정한다. 나눠서 다시 쓴다.',
  noCard: '링크한 글 중에 정할 수 있는 카드가 없다.',
  askCard: '선택지 카드는 아직 글로 답하지 않는다. 카드에서 고른다.',
  hidden: '볼 수 없는 채널의 카드다.',
  headChanged: '카드가 선 뒤 PR head 가 바뀌었다. 카드를 다시 확인하고 정한다.',
  ciWord: 'CI 실패를 무시하는 카드는 글에 「CI 무시」(ignore CI)가 있어야 승인한다.',
  settled: '이 스레드의 카드는 이미 정해졌거나 만료됐다. 다른 카드는 링크를 붙여 다시 쓴다.',
  noRequest: '이 글보다 먼저 온 기다리는 요청이 없다. 카드 링크를 붙여 다시 쓴다.',
  notBefore: '카드가 이 글보다 나중에 섰다. 카드에서 정하거나 링크를 붙여 다시 쓴다.',
  decided: '이미 정해진 카드다.',
  expired: '만료된 카드다.',
  onceOnCard: '이 머지 카드는 카드 스레드에서 쓰거나 링크를 붙여 정한다.',
  failed: '결정하지 못했다. 카드에서 다시 시도한다.',
} as const;
export type ChatRefusal = keyof typeof REASON_KO;

type Candidate = {
  cardMessageId: string; requestId: string; agentId: string; agentHandle: string; kind: PermissionKind; target: string;
  channelId: string; channelName: string | null; status: string; expired: boolean; denialId: string | null;
  ownerAccountId: string | null; cardSeq: number; cardCreatedAt: Date; once: OnceMeta | null;
};
type OnceMeta = { number?: unknown; headSha?: unknown; reason?: unknown; failedChecks?: unknown };

const CANDIDATE_SQL = `
  select p.card_message_id as "cardMessageId", p.id as "requestId", p.agent_id as "agentId", a.handle as "agentHandle",
         p.kind, p.target, p.channel_id as "channelId", ch.name as "channelName", p.status, p.expires_at <= now() as expired,
         p.denial_id as "denialId", c.owner_account_id as "ownerAccountId", m.seq as "cardSeq", m.created_at as "cardCreatedAt",
         m.meta->'permissionRequest'->'once' as once
    from permission_request p
    join message m on m.id = p.card_message_id and m.deleted_at is null
    join account a on a.id = p.agent_id
    left join agent_config c on c.account_id = p.agent_id
    left join channel ch on ch.id = p.channel_id`;

type Outcome = { c: Candidate; ok: true; grantExpiresAt: string | null; grantMode?: 'once' | 'hour'; denied?: true } | { c: Candidate; ok: false; why: ChatRefusal; hidden?: true };

/**
 * 사람이 앱에서 올린 글 하나를 보고, 결정하는 글이면 가리킨 요청을 정한다. 부르는 쪽(글 올리기 라우트)이
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

const isOpen = (c: Candidate) => c.status === 'pending' && !c.expired;

async function approveFromMessage(pool: Pool, message: MessageRow, actorId: string, parsed: ChatApprovalParse): Promise<void> {
  const threadRootId = message.threadRootId ?? message.id;
  const hasWord = parsed.action !== null || parsed.block !== null;
  let targets: Candidate[];
  let target: ChatTarget = 'T1';
  if (parsed.cardIds.length > 0) {
    if (parsed.cardIds.length > CHAT_APPROVAL_MAX_CARDS) return refuse(pool, message, actorId, 'tooMany');
    // 링크마다 `resolveDecision` 으로 푼다 — 거울은 **서버가 세운 진짜 거울**(`isGenuinePermissionMirror`)일 때만 원본으로 센다.
    // 아니면 그 링크는 아무 요청도 가리키지 않는다(fail closed).
    const resolved: string[] = [];
    let askCards = 0;
    for (const id of parsed.cardIds) {
      const ref = await resolveDecision(pool, id);
      if (ref?.kind === 'permission' && ref.cardMessageId) {
        if (ref.mirrorMessageId && !(await isGenuinePermissionMirror(pool, ref.mirrorMessageId, ref.cardMessageId, ref.agentId))) continue;
        resolved.push(ref.cardMessageId);
      }
      else if (ref?.kind === 'ask') askCards += 1;
    }
    const rows = resolved.length > 0 ? (await pool.query<Candidate>(`${CANDIDATE_SQL} where p.card_message_id = any($1::uuid[])`, [resolved])).rows : [];
    targets = [...new Set(resolved)].map((id) => rows.find((r) => r.cardMessageId === id)).filter((r): r is Candidate => !!r);
    if (targets.length === 0) {
      // 선택지 카드는 이번엔 글로 답하지 않는다(P5). 결정 낱말이 있을 때만 안내한다 — 링크만 있는 글은 흔하다.
      if (askCards > 0 && hasWord) return refuse(pool, message, actorId, 'askCard');
      if (hasWord && (await ownsPendingRequest(pool, actorId))) return refuse(pool, message, actorId, 'noCard');
      return;
    }
    const mineLinked = targets.filter((c) => c.ownerAccountId === actorId);
    // 남의 카드만 링크했으면 아무 줄도 남기지 않는다 — 남의 에이전트 요청을 글로 들춰 보이지 않는다.
    if (mineLinked.length === 0) return;
    if (parsed.block) return refuse(pool, message, actorId, parsed.block);
    if (parsed.action === null) {
      if (mineLinked.some(isOpen)) return refuse(pool, message, actorId, 'noWord');
      return;
    }
  } else {
    if (parsed.action === null && parsed.block !== 'bypass') return;
    if (parsed.action === 'deny') {
      // 거절은 링크가 있을 때만(G3).
      if (await ownsPendingRequest(pool, actorId)) return refuse(pool, message, actorId, parsed.block ?? 'denyNeedsLink');
      return;
    }
    // T2 — 글이 카드 스레드 안이면 그 스레드만 본다. 이 스레드의 거울 카드는 **진짜 거울**일 때만 원본으로 센다.
    // 상태와 관계없이 이 스레드의 권한 카드를 다 읽는다 — 하나라도 있으면 T3 로 넘기지 않는다(security F3).
    const direct = (await pool.query<Candidate>(
      `${CANDIDATE_SQL}
        where m.channel_id = $1 and (m.id = $2 or m.thread_root_id = $2) and m.seq < $3
        order by m.created_at`,
      [message.channelId, threadRootId, message.seq])).rows;
    const mirrors = (await pool.query<{ id: string; rootId: string }>(
      `select mm.id, mm.meta->'ask'->>'mirrorOf' as "rootId" from message mm
        where mm.channel_id = $1 and (mm.id = $2 or mm.thread_root_id = $2) and mm.seq < $3 and mm.deleted_at is null
          and mm.meta->'ask' ? 'mirrorOf'`,
      [message.channelId, threadRootId, message.seq])).rows;
    const mirrored = mirrors.length > 0
      ? (await pool.query<Candidate>(`${CANDIDATE_SQL} where p.card_message_id::text = any($1::text[]) order by m.created_at`,
        [mirrors.map((x) => x.rootId)])).rows
      : [];
    const genuine: Candidate[] = [];
    let fakeMirror = false;
    for (const c of mirrored) {
      let ok = false;
      for (const x of mirrors.filter((y) => y.rootId === c.cardMessageId)) {
        if (await isGenuinePermissionMirror(pool, x.id, c.cardMessageId, c.agentId)) { ok = true; break; }
      }
      if (ok) genuine.push(c); else fakeMirror = true;
    }
    const inThread = dedupe([...direct, ...genuine].sort((a, b) => a.cardCreatedAt.getTime() - b.cardCreatedAt.getTime()));
    // 권한 카드를 가리키는 가짜 거울만 있는 스레드는 T3(소유자의 하나뿐인 요청)로 넘기지 않는다 — 그 글은 그 거울에 대한 답이다.
    if (inThread.length === 0 && fakeMirror) return;
    const mineInThread = inThread.filter((c) => c.ownerAccountId === actorId);
    const open = mineInThread.filter(isOpen);
    if (inThread.length > 0) {
      // 남의 카드만 있는 스레드에서 쓴 낱말에는 안내를 달지 않는다 — 그 사람이 정할 수 있는 카드가 아니다.
      if (mineInThread.length === 0) return;
      if (parsed.block) return refuse(pool, message, actorId, parsed.block);
      if (open.length > 1) {
        await notice(pool, message, actorId, `승인 안 됨: 이 스레드에 기다리는 카드가 ${open.length}장이라 어느 것인지 모른다. 정할 카드의 링크를 붙여 다시 써라:`, open);
        return;
      }
      if (open.length === 0) return refuse(pool, message, actorId, 'settled');
      targets = open;
      target = 'T2';
    } else {
      // T3 — 권한 카드가 하나도 없는 스레드의 맨 글(카드 077fa790). 이 소유자의 에이전트들이 낸 요청 가운데 글보다 먼저 생기고
      // 아직 기다리는 것이 **정확히 하나**일 때만. 머지 거절 카드·볼 수 없는 채널의 요청도 후보로 세고 결정 단계에서 거절한다.
      const mine = (await pool.query<Candidate>(
        `${CANDIDATE_SQL}
          where c.owner_account_id = $1 and p.status = 'pending' and p.expires_at > now() and m.created_at < $2
          order by m.created_at`,
        [actorId, message.createdAt])).rows;
      if (mine.length === 0) {
        if (await ownsPendingRequest(pool, actorId)) return refuse(pool, message, actorId, parsed.block ?? 'noRequest');
        return;
      }
      if (parsed.block) return refuse(pool, message, actorId, parsed.block);
      if (mine.length > 1) {
        await notice(pool, message, actorId, `승인 안 됨: 기다리는 권한 요청이 ${mine.length}개라 어느 것인지 모른다. 정할 카드의 링크를 붙여 다시 써라:`, mine);
        return;
      }
      targets = mine;
      target = 'T3';
    }
  }

  const outcomes: Outcome[] = [];
  for (const c of targets) outcomes.push(await decideOne(pool, message, actorId, c, target, parsed));
  const mine = outcomes.filter((o) => o.c.ownerAccountId === actorId);
  if (mine.length === 0) return;
  // 하나뿐이고 정하지 못했으면 한 줄 안내(번역 표지 포함). 여럿이면 카드별 목록.
  if (mine.length === 1 && !mine[0]!.ok) return refuse(pool, message, actorId, mine[0]!.why);
  await confirm(pool, message, actorId, mine);
}

function dedupe(rows: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.requestId) ? false : (seen.add(r.requestId), true)));
}

const REFUSAL_BY_CODE: Record<string, ChatRefusal> = {
  card_stale: 'headChanged', already_decided: 'decided', superseded: 'decided', request_expired: 'expired', denial_expired: 'expired',
  denial_used: 'decided', pr_closed: 'decided', relax_required: 'ciWord',
};

async function decideOne(pool: Pool, message: MessageRow, actorId: string, c: Candidate, target: ChatTarget, parsed: ChatApprovalParse): Promise<Outcome> {
  if (c.ownerAccountId !== actorId) return { c, ok: false, why: 'noCard' };
  if (!(await assertChannelVisible(pool, c.channelId, actorId))) return { c, ok: false, why: 'hidden', hidden: true };
  // 카드가 글보다 먼저 있었어야 한다 — 같은 채널이면 seq, 다른 채널이면 시각으로 본다.
  const before = c.channelId === message.channelId ? c.cardSeq < message.seq : c.cardCreatedAt.getTime() <= new Date(message.createdAt).getTime();
  if (!before) return { c, ok: false, why: 'notBefore' };
  if (c.status !== 'pending') return { c, ok: false, why: 'decided' };
  if (c.expired) return { c, ok: false, why: 'expired' };
  let option: string;
  let once: DecideInput['once'];
  if (parsed.action === 'deny') {
    option = 'deny';
  } else if (c.denialId) {
    // 머지 거절 카드 — 이번 한 번 머지. 카드 스레드(T2)·링크(T1)로만, 맨 글(T3)은 지금처럼 카드에서.
    if (target === 'T3') return { c, ok: false, why: 'onceOnCard' };
    const o = c.once;
    if (!o || typeof o.number !== 'number' || typeof o.headSha !== 'string') return { c, ok: false, why: 'failed' };
    const ci = o.reason === 'ci_not_green';
    // CI 실패 카드의 뜻은 「CI 무시하고 한 번」 — 글에 그 말이 있어야 한다.
    if (ci && !parsed.ciWord) return { c, ok: false, why: 'ciWord' };
    const failedChecks = Array.isArray(o.failedChecks) ? o.failedChecks.filter((x): x is string => typeof x === 'string') : [];
    // head 는 카드가 보여 준 값으로 묶는다 — 거절 기록의 head 가 바뀌었으면 decide 가 card_stale 로 막는다.
    // gh 계정은 비워 둔다 — 오퍼레이터가 그 저장소용 계정을 고른다(G1).
    option = 'approve_once';
    once = { ghUser: null, relaxChecks: ci, number: o.number, headSha: o.headSha, ...(ci ? { failedChecks } : {}) };
  } else {
    // 정확한 명령은 가장 좁게 — 이번 한 번만. 1시간은 카드 버튼에서만 준다.
    option = c.kind === 'command' ? 'approve_once' : 'approve';
  }
  const out = await decide(pool, { kind: 'permission', agentId: c.agentId, requestId: c.requestId, cardMessageId: c.cardMessageId }, actorId, {
    option, via: 'chat', chat: { messageId: message.id, target }, ...(once ? { once } : {}),
  });
  if (out.kind !== 'permission') return { c, ok: false, why: 'failed' };
  if (!out.ok) return { c, ok: false, why: REFUSAL_BY_CODE[out.code] ?? 'failed' };
  const d = out.result;
  return { c, ok: true, grantExpiresAt: d.grantExpiresAt, ...(d.grantMode ? { grantMode: d.grantMode } : {}), ...(option === 'deny' ? { denied: true as const } : {}) };
}

/** 소유자의 에이전트 중 기다리는 권한 요청이 하나라도 있는가 — 없으면 낱말만 있는 글에 안내를 달지 않는다(그 낱말은 흔하다). */
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
    if (!o.ok && o.hidden) return `- ✗ ${REASON_KO[o.why]}`;
    const what = `${plain(o.c.agentHandle)} · ${o.c.kind === 'merge' ? '머지' : '명령'} \`${plain(o.c.target)}\` · #${plain(o.c.channelName ?? '?')}`;
    if (!o.ok) return `- ✗ ${what} — ${REASON_KO[o.why]}`;
    if (o.denied) return `- ✓ ${what} — 거절`;
    const until = o.grantMode === 'once' || o.c.denialId ? '이번 한 번' : o.grantExpiresAt ? `${o.grantExpiresAt.slice(0, 16).replace('T', ' ')} UTC 까지` : '';
    return `- ✓ ${what} — ${until}`;
  });
  const anyOk = outcomes.some((o) => o.ok && !o.denied);
  const anyDone = outcomes.some((o) => o.ok);
  const head = anyDone ? (anyOk ? '✅ 이 글로 권한 요청을 정했다(카드와 같은 효과).' : '이 글로 권한 요청을 거절했다(카드와 같은 효과).') : '이 글로는 아무 권한 요청도 정하지 않았다.';
  const tail = anyOk ? '\n거두려면 설정 › 에이전트 › 할 수 있는 일에서 지우거나, 그 에이전트에게 「그 권한 거둬」라고 하라.' : '';
  await post(pool, message, actorId, `${head}\n${lines.join('\n')}${tail}`, {
    chatApproval: {
      messageId: message.id,
      results: outcomes.map((o) => (!o.ok && o.hidden ? { ok: false, why: o.why } : { requestId: o.c.requestId, cardMessageId: o.c.cardMessageId, ok: o.ok, ...(o.ok ? {} : { why: o.why }) })),
    },
  });
}

/** 「승인 안 됨: <까닭>」 한 줄 — 본문은 한국어, 새 앱은 표지(`system.chatApproval.<까닭>`)로 앱 언어로 그린다. 카드 id·내용은 싣지 않는다. */
async function refuse(pool: Pool, message: MessageRow, actorId: string, why: ChatRefusal): Promise<void> {
  // 거절하려던 글에는 「거절 안 됨」으로 시작한다(designer n1).
  const head = why === 'denyNeedsLink' ? '거절 안 됨' : '승인 안 됨';
  await post(pool, message, actorId, `⚠️ ${head}: ${REASON_KO[why]}`, {
    chatApproval: { messageId: message.id, results: [], reason: why },
    i18n: systemI18n(`system.chatApproval.${why}`, {}),
  });
}

async function notice(pool: Pool, message: MessageRow, actorId: string, text: string, candidates: Candidate[] = []): Promise<void> {
  // 후보 목록은 링크**만** 싣는다(security F2) — 후보에는 글쓴이가 볼 수 없는 채널의 요청도 있을 수 있다.
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
