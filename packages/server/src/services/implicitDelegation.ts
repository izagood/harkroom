import type { PoolClient } from 'pg';
import { headMentionRunEnd, type PlanDoc } from '@harkroom/shared';
import { createDelegation, delegationV2Enabled, DELEGATION_DEADLINE_DEFAULT_SEC, DELEGATION_MAX_AGE_SEC } from './delegations.js';

/**
 * 위임 재설계 v1 P4 — **암묵 위임.** 에이전트가 에이전트를 맨 앞 멘션으로 부르면 그 부름이 곧 위임이다(소유자 결정 2026-11-09).
 * 습관(`message.delegate` 를 쓰느냐 멘션으로 부르느냐)과 상관없이 위임자를 깨우는 길이 하나가 되게 하려는 것이다.
 *
 * - 반대 방향 위임이 열려 있으면 열지 않는다 — 담당이 위임자를 부른 것은 답장이다(`reply`).
 * - 같은 방향 위임이 이미 열려 있으면 새로 열지 않는다 — 이어지는 말이다(`existing`). 새로 열면 P3 의 대체(superseded)가
 *   앞 위임을 닫아 버린다.
 * - 계획판 단계의 담당을 부르면 그 단계 id 를 단다.
 *
 * ## 모드(`HARKROOM_DELEGATION_IMPLICIT`, `HARKROOM_DELEGATION_V2` 가 켜졌을 때만 읽는다)
 * - `shadow`(기본): 판정만 `delegation_implicit_log` 에 적는다. 위임 행·깨우기·update 는 없다 — 첫 1주 동안 위임자 턴이 얼마나
 *   늘지(암묵 위임 수/일, 짧은 질문 비율)를 잰다.
 * - `on`: 판정이 `open` 이면 진짜 위임 행(kind=mention)을 연다. 담당의 `mention` inbox 는 그대로 둔다.
 * - `off`: 아무것도 하지 않는다.
 */
export type ImplicitDelegationMode = 'off' | 'shadow' | 'on';

export function implicitDelegationMode(env: NodeJS.ProcessEnv = process.env): ImplicitDelegationMode {
  if (!delegationV2Enabled(env)) return 'off';
  const v = (env.HARKROOM_DELEGATION_IMPLICIT ?? '').trim().toLowerCase();
  if (v === 'on' || v === '1' || v === 'true') return 'on';
  if (v === 'off' || v === '0' || v === 'false') return 'off';
  return 'shadow';
}

/** 짧은 질문의 길이 상한(머리 멘션을 뺀 본문의 글자 수). */
export const SHORT_QUESTION_MAX_CHARS = 200;

/**
 * 지표용 — 머리 멘션 런을 뺀 본문의 길이와 「짧은 질문」 여부. 판정에는 쓰지 않는다(그림자 1주 동안 비율을 잰다).
 * 받는 본문은 정규화된 본문(`<@id>`)이다.
 */
export function implicitBodyFacts(normalizedBody: string): { bodyChars: number; shortQuestion: boolean } {
  const rest = normalizedBody.slice(headMentionRunEnd(normalizedBody)).trim();
  const bodyChars = [...rest].length;
  return { bodyChars, shortQuestion: bodyChars <= SHORT_QUESTION_MAX_CHARS && /[?？]/.test(rest) };
}

/**
 * 계획판에서 이 담당이 맡은 단계. 본문에 이 스레드의 단계 링크(`harkroom://plan/<스레드>/<단계>`)가 있으면 그것을, 없으면
 * 진행 중(active) 단계가 하나뿐일 때 그것을, 아니면 끝나지 않은 단계가 하나뿐일 때 그것을 고른다. 애매하면 달지 않는다.
 */
export function planStepFor(doc: Pick<PlanDoc, 'steps'>, args: { threadRootId: string; delegateId: string; body: string }): string | null {
  const mine = doc.steps.filter((s) => s.assigneeId === args.delegateId && s.state !== 'done');
  if (!mine.length) return null;
  const linked = new Set<string>();
  for (const m of args.body.matchAll(/harkroom:\/\/plan\/([0-9a-f-]{36})\/(s[1-9][0-9]{0,3})\b/gi)) {
    if (m[1]!.toLowerCase() === args.threadRootId.toLowerCase()) linked.add(m[2]!);
  }
  const byLink = mine.filter((s) => linked.has(s.id));
  if (byLink.length === 1) return byLink[0]!.id;
  const active = mine.filter((s) => s.state === 'active');
  if (active.length === 1) return active[0]!.id;
  return mine.length === 1 ? mine[0]!.id : null;
}

type Verdict = 'open' | 'reply' | 'existing';

/**
 * (위임자 → 담당) 한 쌍의 판정. 열린 진짜 위임(열림·보고됨)을 먼저 보고, 그림자 모드에서는 그림자가 「열었을」 위임도 본다 —
 * 그림자는 닫히지 않으므로 최대 수명(24시간) 안의 것만 열린 것으로 친다. 그래야 그림자 수치가 `on` 의 수치에 가깝다.
 */
async function verdictFor(
  client: PoolClient, args: { threadRootId: string; from: string; to: string },
): Promise<Verdict> {
  const r = await client.query<{ dir: 'reverse' | 'same' }>(
    `select case when d.lead_account_id = $2 then 'same' else 'reverse' end as dir
       from team_delegation d
       join team_delegation_item i on i.delegation_id = d.id
      where d.thread_root_id = $1
        and (i.outcome is null or i.outcome = 'reported')
        and ((d.lead_account_id = $3 and i.delegate_account_id = $2)
          or (d.lead_account_id = $2 and i.delegate_account_id = $3))
     union all
     select case when l.delegator_account_id = $2 then 'same' else 'reverse' end
       from delegation_implicit_log l
      where l.thread_root_id = $1 and l.verdict = 'open' and l.mode = 'shadow'
        and l.created_at > now() - make_interval(secs => $4)
        and ((l.delegator_account_id = $3 and l.delegate_account_id = $2)
          or (l.delegator_account_id = $2 and l.delegate_account_id = $3))`,
    [args.threadRootId, args.from, args.to, DELEGATION_MAX_AGE_SEC],
  );
  // 반대 방향이 하나라도 열려 있으면 답장이다 — 서로 넘긴 상태에서도 답장이 이긴다(루프를 만들지 않는 쪽).
  if (r.rows.some((x) => x.dir === 'reverse')) return 'reply';
  if (r.rows.length) return 'existing';
  return 'open';
}

/**
 * `postMessage` 안에서, 멘션 팬아웃 **뒤에** 같은 트랜잭션으로 부른다. `calleeIds` 는 이 글로 실제로 `mention` inbox 가 간
 * 에이전트(작성자 제외)다 — 막힌·상한 걸린 부름은 위임도 아니다. 머리 런 판정은 `splitMentionCalls` 가 이미 했다
 * (에이전트 글에서 에이전트에 대한 부름은 머리 런 안의 것뿐이다).
 *
 * 돌려주는 것은 적은 판정 수(시험·관측용).
 */
export async function recordImplicitDelegations(
  client: PoolClient,
  args: {
    mode: Exclude<ImplicitDelegationMode, 'off'>;
    messageId: string; channelId: string; threadRootId: string; authorId: string;
    calleeIds: string[]; normalizedBody: string;
  },
): Promise<number> {
  const targets = [...new Set(args.calleeIds)].filter((id) => id !== args.authorId);
  if (!targets.length) return 0;
  const facts = implicitBodyFacts(args.normalizedBody);
  // 판정 순서가 동시 글끼리 갈리지 않게 이 스레드에서 줄을 세운다(같은 스레드의 두 에이전트가 서로를 동시에 부르는 경우).
  await client.query(`select pg_advisory_xact_lock(hashtext('delegation_implicit:' || $1::text))`, [args.threadRootId]);
  const plan = (await client.query<{ doc: PlanDoc }>(
    `select doc from thread_plan where root_id = $1 and flag_reason is null`, [args.threadRootId],
  )).rows[0]?.doc ?? null;
  let n = 0;
  for (const to of targets) {
    const verdict = await verdictFor(client, { threadRootId: args.threadRootId, from: args.authorId, to });
    const planStepId = plan ? planStepFor(plan, { threadRootId: args.threadRootId, delegateId: to, body: args.normalizedBody }) : null;
    let delegationId: string | null = null;
    if (args.mode === 'on' && verdict === 'open') {
      delegationId = await createDelegation(client, {
        messageId: args.messageId, channelId: args.channelId, threadRootId: args.threadRootId,
        teamId: null, leadAccountId: args.authorId, delegateIds: [to],
        deadlineAt: new Date(Date.now() + DELEGATION_DEADLINE_DEFAULT_SEC * 1000),
        kind: 'mention', planStepId,
      });
    }
    await client.query(
      `insert into delegation_implicit_log
         (message_id, channel_id, thread_root_id, delegator_account_id, delegate_account_id, verdict, mode,
          plan_step_id, short_question, body_chars, delegation_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [args.messageId, args.channelId, args.threadRootId, args.authorId, to, verdict, args.mode,
       planStepId, facts.shortQuestion, facts.bodyChars, delegationId],
    );
    n++;
  }
  return n;
}
