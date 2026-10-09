import type { Pool } from 'pg';
import { ASK_BUNDLE_MAX_ITEMS, isAskOpen, readAskBundleMeta, readAskMeta, type AskBundleItem, type MessageRow } from '@harkroom/shared';
import { assertChannelVisible, audienceFor } from './channels.js';
import { emitEvent } from '../events.js';
import {
  askBundleItemFor, checkAskMirror, COLS, getMessageById, postMessage, readAskRow, recordAskAnswer, syncAskMirrors, wakeAsker,
  type AskMirrorRefusal, type PostMessageResult,
} from './messages.js';

/**
 * # 묶음 카드(선택 카드 P1, 2026-10-10, 스레드 596146cc)
 *
 * 관리 에이전트(task_manager)가 여러 에이전트의 **사람 앞 카드**를 자기 스레드의 카드 한 장에 줄로 모은다.
 * 거울 카드(`mirrorOf`)를 줄마다 세우면 카드 수만큼 글이 생기고 🙋·Inbox 가 카드마다 따로 선다 — 묶음은 그것을
 * 한 장으로 줄인다. 규칙은 거울과 같다:
 *
 * - **정본은 원본이다.** 줄은 원본을 가리킬 뿐 상태를 싣지 않는다. 답은 원본에 **누른 사람 이름으로** 적고
 *   (`recordAskAnswer`), 원본이 바뀌면 묶음에 알린다(`syncAskBundles`).
 * - **줄마다 거울 검사**를 한다(`checkAskMirror`) — 원본이 보이는가·거울이 아닌가·사람 앞인가·열렸는가.
 * - **답할 권리는 원본에서 다시 본다** — 누른 사람이 원본 채널을 볼 수 있어야 하고, 원본의 수신자 규칙
 *   (사람 앞 물음은 사람만)을 그대로 거친다.
 * - **권한 요청 카드는 링크 줄**이다 — 소유자가 원 스레드에서만 정한다(111).
 * - 「추천대로 일괄」은 **되돌릴 수 없는 줄을 서버가 뺀다**(`isIrreversible`). 화면이 빼는 것을 믿지 않는다.
 * - 묶음 스레드에 쓴 사람 글은 줄을 자동으로 닫지 않는다(어느 줄에 대한 글인지 갈린다). 관리 에이전트가 읽고
 *   `askBundleResolve` 로 그 줄을 닫는다 — 닫는 이름은 **그 글을 쓴 사람**이다.
 */

export type AskBundleRefusal =
  | AskMirrorRefusal
  | 'bundle_not_found' | 'bundle_not_yours' | 'bundle_other_thread' | 'bundle_full' | 'bundle_empty'
  | 'bundle_item_not_found' | 'bundle_item_link' | 'bundle_item_resolved'
  | 'bundle_reply_invalid';

export const ASK_BUNDLE_REFUSAL_MESSAGE: Record<AskBundleRefusal, string> = {
  mirror_not_found: 'no such choice request, or you cannot see its channel',
  mirror_of_mirror: 'that card is itself a mirror — bundle the original card',
  mirror_not_human: 'only cards addressed to humans can be bundled',
  mirror_options_mismatch: 'option ids do not match the original card',
  mirror_resolved: 'that card is already answered or closed',
  bundle_not_found: 'no such bundle card',
  bundle_not_yours: 'only the agent that posted the bundle can change it',
  bundle_other_thread: 'the bundle lives in another channel or thread',
  bundle_full: `a bundle holds at most ${ASK_BUNDLE_MAX_ITEMS} rows — open a new bundle`,
  bundle_empty: 'give at least one card to bundle',
  bundle_item_not_found: 'that card is not a row of this bundle',
  bundle_item_link: 'a permission request is decided in its own thread by the owner',
  bundle_item_resolved: 'that row is already answered or closed',
  bundle_reply_invalid: 'replyMessageId must be a human message in this bundle thread, from someone who may answer the card',
};

type BundleRow = { id: string; channelId: string; threadRootId: string | null; authorId: string | null; items: AskBundleItem[] };

async function readBundle(pool: Pool, bundleId: string): Promise<BundleRow | null> {
  const res = await pool.query(
    `select id, meta, channel_id as "channelId", thread_root_id as "threadRootId", author_id as "authorId"
       from message where id = $1 and deleted_at is null`,
    [bundleId],
  );
  const row = res.rows[0] as { id: string; meta: Record<string, unknown>; channelId: string; threadRootId: string | null; authorId: string | null } | undefined;
  const bundle = row ? readAskBundleMeta(row.meta) : null;
  if (!row || !bundle) return null;
  return { id: row.id, channelId: row.channelId, threadRootId: row.threadRootId, authorId: row.authorId, items: bundle.items };
}

/** 줄로 담을 원본들을 검사하고 사본을 만든다. 하나라도 거절이면 아무것도 담지 않는다(일부만 담기면 무엇이 빠졌는지 모른다). */
async function prepareItems(
  pool: Pool, callerId: string, rootIds: string[],
): Promise<{ ok: true; items: AskBundleItem[] } | { ok: false; code: AskBundleRefusal; rootId: string }> {
  const items: AskBundleItem[] = [];
  for (const rootId of rootIds) {
    const root = await readAskRow(pool, rootId);
    if (!root) return { ok: false, code: 'mirror_not_found', rootId };
    // 거울 검사 그대로 — 원본의 선택지 id 로 부르므로 `mirror_options_mismatch` 는 나지 않는다.
    const refusal = await checkAskMirror(pool, { rootId, callerId, optionIds: root.ask.options.map((o) => o.id) });
    if (refusal) return { ok: false, code: refusal, rootId };
    const item = await askBundleItemFor(pool, rootId);
    if (!item) return { ok: false, code: 'mirror_not_found', rootId };
    items.push(item);
  }
  return { ok: true, items };
}

/**
 * `message.askBundle` — 묶음 카드를 새로 세우거나(`bundleId` 없음) 있던 묶음에 줄을 더한다. 같은 원본을 다시 주면
 * 그 줄의 사본(물음·선택지)만 새로 고친다. 있던 묶음은 **내가 세운 것, 같은 채널·스레드**여야 한다.
 */
export async function upsertAskBundle(pool: Pool, args: {
  callerId: string; channelId: string; threadRootId: string; body: string; rootIds: string[]; bundleId?: string;
  meta?: Record<string, unknown>; causeMessageId?: string | null;
}): Promise<{ ok: true; message: MessageRow; posted?: PostMessageResult } | { ok: false; code: AskBundleRefusal | 'post_failed'; rootId?: string; posted?: PostMessageResult }> {
  const rootIds = [...new Set(args.rootIds)];
  if (rootIds.length === 0) return { ok: false, code: 'bundle_empty' };
  let existing: BundleRow | null = null;
  if (args.bundleId) {
    existing = await readBundle(pool, args.bundleId);
    if (!existing) return { ok: false, code: 'bundle_not_found' };
    if (existing.authorId !== args.callerId) return { ok: false, code: 'bundle_not_yours' };
    if (existing.channelId !== args.channelId || (existing.threadRootId ?? existing.id) !== args.threadRootId) {
      return { ok: false, code: 'bundle_other_thread' };
    }
  }
  const prepared = await prepareItems(pool, args.callerId, rootIds);
  if (!prepared.ok) return prepared;

  if (!existing) {
    if (prepared.items.length > ASK_BUNDLE_MAX_ITEMS) return { ok: false, code: 'bundle_full' };
    const posted = await postMessage(pool, {
      causeMessageId: args.causeMessageId ?? null,
      channelId: args.channelId, authorId: args.callerId, body: args.body, threadRootId: args.threadRootId,
      meta: { ...(args.meta ?? {}), kind: 'askBundle', askBundle: { items: prepared.items } },
    });
    if (posted.failure) return { ok: false, code: 'post_failed', posted };
    return { ok: true, message: posted.message, posted };
  }

  const byRoot = new Map(existing.items.map((i) => [i.rootId, i] as const));
  for (const item of prepared.items) byRoot.set(item.rootId, item);
  const items = [...byRoot.values()];
  if (items.length > ASK_BUNDLE_MAX_ITEMS) return { ok: false, code: 'bundle_full' };
  const updated = (await pool.query(
    `update message set meta = jsonb_set(meta::jsonb, '{askBundle,items}', $2::jsonb)
      where id = $1 and deleted_at is null returning ${COLS}`,
    [existing.id, JSON.stringify(items)],
  )).rows[0] as MessageRow | undefined;
  if (!updated) return { ok: false, code: 'bundle_not_found' };
  emitEvent({ type: 'message.updated', message: updated, audience: await audienceFor(pool, updated.channelId) });
  return { ok: true, message: updated };
}

/**
 * **되돌릴 수 없는 결정인가**(머지·배포·비밀·권한). 「추천대로 일괄」에서 서버가 빼는 판정이다 — 넉넉하게 뺀다:
 * 잘못 빼면 사람이 한 번 더 누르면 되지만, 잘못 넣으면 사람이 보지 않은 머지가 나간다.
 *
 * - 권한 요청 카드·머지 거절 카드는 meta 로 안다.
 * - 물어본 쪽이 `irreversible: true` 를 실었으면 그대로 믿는다.
 * - 그 밖에는 물음·본문·선택지 글자에 그 낱말이 있으면 뺀다(에이전트가 표시를 잊어도 막히게).
 */
const IRREVERSIBLE_WORDS = /머지|병합|merge|배포|deploy|릴리스|릴리즈|release|롤아웃|rollout|비밀|secret|토큰|token|자격|credential|권한|permission|grant|삭제|delete|drop|force[- ]?push/i;

export function isIrreversible(meta: Record<string, unknown>, body: string): boolean {
  if (meta.permissionRequest || meta.mergeDenial) return true;
  const ask = readAskMeta(meta);
  if (!ask) return true;
  if (ask.irreversible === true) return true;
  const text = [body, ask.prompt ?? '', ...ask.options.flatMap((o) => [o.label, o.hint ?? ''])].join('\n');
  return IRREVERSIBLE_WORDS.test(text);
}

export type BundleAnswerResult =
  | { ok: true; bundle: MessageRow }
  | { ok: false; status: number; code: string; message: string };

/**
 * 묶음의 한 줄에 답한다 — **원본에 누른 사람 이름으로** 적는다. 원본의 규칙(수신자·사람만·권한 카드 불가·
 * superseded 거절)은 `recordAskAnswer` 가 그대로 본다. 여기서 더 보는 것은 묶음이 거울처럼 **다른 채널의 물음을
 * 정하는 자리**라는 점이다: 누른 사람이 원본 채널을 못 보면 거절한다.
 */
export async function answerBundleItem(pool: Pool, args: {
  bundleId: string; channelId: string; rootId: string; optionId: string; actorId: string;
}): Promise<BundleAnswerResult> {
  const bundle = await readBundle(pool, args.bundleId);
  if (!bundle || bundle.channelId !== args.channelId) return { ok: false, status: 404, code: 'not_found', message: ASK_BUNDLE_REFUSAL_MESSAGE.bundle_not_found };
  const item = bundle.items.find((i) => i.rootId === args.rootId);
  if (!item) return { ok: false, status: 404, code: 'bundle_item_not_found', message: ASK_BUNDLE_REFUSAL_MESSAGE.bundle_item_not_found };
  if (item.link) return { ok: false, status: 403, code: 'bundle_item_link', message: ASK_BUNDLE_REFUSAL_MESSAGE.bundle_item_link };
  const root = await readAskRow(pool, args.rootId);
  if (!root) return { ok: false, status: 404, code: 'not_found', message: 'the original card is gone' };
  if (!(await assertChannelVisible(pool, root.channelId, args.actorId))) {
    return { ok: false, status: 403, code: 'forbidden', message: 'you cannot see the channel of the original card' };
  }
  // 줄을 모을 때는 원본이 사람 앞 원본이었다. 그 뒤로 바뀌었을 수는 없지만, 거울이면 정본이 둘이 되니 다시 막는다.
  if (root.ask.mirrorOf) return { ok: false, status: 403, code: 'forbidden', message: ASK_BUNDLE_REFUSAL_MESSAGE.mirror_of_mirror };
  const result = await recordAskAnswer(pool, { messageId: args.rootId, actorId: args.actorId, optionId: args.optionId });
  if (result === 'not_found') return { ok: false, status: 404, code: 'not_found', message: 'no such choice request' };
  if (result === 'forbidden') return { ok: false, status: 403, code: 'forbidden', message: 'this choice is addressed to someone else' };
  if (result === 'unknown_option') return { ok: false, status: 400, code: 'unknown_option', message: 'no such option in this request' };
  if (result === 'already_answered') return { ok: false, status: 409, code: 'already_answered', message: 'this choice is already answered' };
  emitEvent({ type: 'message.updated', message: result, audience: await audienceFor(pool, result.channelId) });
  const fresh = await getMessageById(pool, args.bundleId);
  if (!fresh) return { ok: false, status: 404, code: 'not_found', message: ASK_BUNDLE_REFUSAL_MESSAGE.bundle_not_found };
  return { ok: true, bundle: fresh };
}

export type AcceptOutcome =
  | 'answered' | 'resolved' | 'skipped_irreversible' | 'skipped_link' | 'skipped_no_recommendation' | 'failed';

/**
 * 「남은 n개 추천대로」. 열린 줄마다 **추천이 하나뿐이고 되돌릴 수 없는 결정이 아닐 때만** 그 추천으로 답한다.
 * 줄마다 결과를 따로 돌려준다 — 일부만 성공할 수 있고(경합·권리), 화면은 무엇이 남았는지 말해야 한다.
 */
export async function acceptRecommended(pool: Pool, args: {
  bundleId: string; channelId: string; actorId: string;
}): Promise<{ ok: true; bundle: MessageRow; results: { rootId: string; outcome: AcceptOutcome; code?: string }[] } | { ok: false; status: number; code: string; message: string }> {
  const bundle = await readBundle(pool, args.bundleId);
  if (!bundle || bundle.channelId !== args.channelId) return { ok: false, status: 404, code: 'not_found', message: ASK_BUNDLE_REFUSAL_MESSAGE.bundle_not_found };
  const results: { rootId: string; outcome: AcceptOutcome; code?: string }[] = [];
  for (const item of bundle.items) {
    if (item.link) { results.push({ rootId: item.rootId, outcome: 'skipped_link' }); continue; }
    const found = await pool.query(`select meta, body from message where id = $1 and deleted_at is null`, [item.rootId]);
    const row = found.rows[0] as { meta: Record<string, unknown>; body: string } | undefined;
    const ask = row ? readAskMeta(row.meta) : null;
    if (!row || !ask || !isAskOpen(ask)) { results.push({ rootId: item.rootId, outcome: 'resolved' }); continue; }
    if (isIrreversible(row.meta, row.body)) { results.push({ rootId: item.rootId, outcome: 'skipped_irreversible' }); continue; }
    // 추천은 **원본의** 선택지에서 읽는다 — 묶음의 사본은 모을 때의 것이라 그 뒤 바뀐 것을 모른다.
    const recommended = ask.options.filter((o) => o.recommended === true);
    if (recommended.length !== 1) { results.push({ rootId: item.rootId, outcome: 'skipped_no_recommendation' }); continue; }
    const answered = await answerBundleItem(pool, {
      bundleId: args.bundleId, channelId: args.channelId, rootId: item.rootId, optionId: recommended[0]!.id, actorId: args.actorId,
    });
    results.push(answered.ok ? { rootId: item.rootId, outcome: 'answered' } : { rootId: item.rootId, outcome: 'failed', code: answered.code });
  }
  const fresh = await getMessageById(pool, args.bundleId);
  if (!fresh) return { ok: false, status: 404, code: 'not_found', message: ASK_BUNDLE_REFUSAL_MESSAGE.bundle_not_found };
  return { ok: true, bundle: fresh, results };
}

/**
 * `message.askBundleResolve` — 사람이 묶음 스레드에 **글로** 한 줄에 답했을 때, 관리 에이전트가 그 글을 읽고 그 줄을
 * 닫는다. 원본은 `replied` 로 닫히고 **닫은 이름은 그 글을 쓴 사람**이다(에이전트가 사람의 결정을 지어내지 못하게 —
 * 근거가 되는 사람 글이 그 묶음 스레드에 실제로 있어야 하고, 그 사람이 원본에 답할 수 있는 사람이어야 한다).
 *
 * 묶음 스레드의 글은 원 스레드에 없으므로 원 에이전트가 깨어나도 그 글을 읽지 못한다 — 그래서 요지를
 * `replyNote` 로 원본에 싣고 `ask_closed` 로 깨운다.
 */
export async function resolveBundleItem(pool: Pool, args: {
  callerId: string; bundleId: string; rootId: string; replyMessageId: string; note?: string;
}): Promise<{ ok: true; bundle: MessageRow } | { ok: false; code: AskBundleRefusal }> {
  const bundle = await readBundle(pool, args.bundleId);
  if (!bundle) return { ok: false, code: 'bundle_not_found' };
  if (bundle.authorId !== args.callerId) return { ok: false, code: 'bundle_not_yours' };
  const item = bundle.items.find((i) => i.rootId === args.rootId);
  if (!item) return { ok: false, code: 'bundle_item_not_found' };
  if (item.link) return { ok: false, code: 'bundle_item_link' };

  const bundleRoot = bundle.threadRootId ?? bundle.id;
  const reply = (await pool.query(
    `select m.id, m.author_id as "authorId" from message m join account a on a.id = m.author_id
      where m.id = $1 and m.deleted_at is null and a.kind = 'human'
        and m.channel_id = $2 and (m.thread_root_id = $3 or m.id = $3)`,
    [args.replyMessageId, bundle.channelId, bundleRoot],
  )).rows[0] as { id: string; authorId: string } | undefined;
  if (!reply) return { ok: false, code: 'bundle_reply_invalid' };

  const root = await readAskRow(pool, args.rootId);
  if (!root) return { ok: false, code: 'mirror_not_found' };
  if (!isAskOpen(root.ask)) return { ok: false, code: 'bundle_item_resolved' };
  // 글을 쓴 사람이 원본에 답할 수 있어야 그 글이 원본의 답이다(`recordAskAnswer` 의 수신자 규칙과 같다).
  const mayAnswer = root.ask.to.kind === 'human' || (root.ask.to.kind === 'account' && root.ask.to.accountId === reply.authorId);
  if (!mayAnswer || !(await assertChannelVisible(pool, root.channelId, reply.authorId))) return { ok: false, code: 'bundle_reply_invalid' };

  const note = (args.note ?? '').trim().slice(0, 1000);
  const closed = (await pool.query(
    `update message
        set meta = jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(meta::jsonb, '{ask,closedAt}', to_jsonb(now())),
                    '{ask,closedBy}', to_jsonb($2::text)),
                  '{ask,closedReason}', to_jsonb('replied'::text)),
                '{ask,replyMessageId}', to_jsonb($3::text)),
              '{ask,replyNote}', to_jsonb($4::text))
      where id = $1
        and deleted_at is null
        and meta->'ask'->>'answeredWith' is null
        and meta->'ask'->>'closedAt' is null
        and not (meta ? 'permissionRequest')
        and not (meta ? 'mergeDenial')
      returning ${COLS}`,
    [args.rootId, reply.authorId, reply.id, note],
  )).rows[0] as MessageRow | undefined;
  if (!closed) return { ok: false, code: 'bundle_item_resolved' };
  emitEvent({ type: 'message.updated', message: closed, audience: await audienceFor(pool, closed.channelId) });
  // 원 스레드에는 사람 글이 없으니 `thread_reply` 로 깨지 않는다 — 여기서 깨운다.
  await wakeAsker(pool, closed.authorId, reply.authorId, closed.id, 'ask_closed');
  await syncAskMirrors(pool, args.rootId);
  const fresh = await getMessageById(pool, args.bundleId);
  if (!fresh) return { ok: false, code: 'bundle_not_found' };
  return { ok: true, bundle: fresh };
}
