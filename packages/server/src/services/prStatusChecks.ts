import type { Pool } from 'pg';
import { repoScope } from '@harkroom/shared';
import { mergeGrantFor } from '../auth/permissions.js';
import { recordAudit } from '../audit.js';
import { readLease } from './mergeGrants.js';

/**
 * `pr.status` 읽기 허락(2026-10-31, `shared/src/prStatus.ts`). 오퍼레이터가 gh 로 PR 상태를 읽기 **전에** 묻는다.
 *
 * 판정은 머지 판정(`mergeGrants.ts::checkMergeByChain`)의 앞 두 단만 쓴다:
 * 1. 턴 임대 — 같은 `readLease`, 같은 조건(에이전트·오퍼레이터가 맞고, 만료·종료되지 않음).
 * 2. grant — 같은 `mergeGrantFor`(정확 `repo:<owner>/<name>` 또는 조직 `repo:<owner>/*`, 만료 제외, 준 사람이 지금 이 채널에서
 *    이 에이전트의 카드를 정할 수 있어야 함). 머지가 읽을 수 있는 저장소와 이 도구가 읽을 수 있는 저장소가 어긋나지 않게 **같은 함수**를 쓴다.
 *
 * 머지 판정과 달리 하지 않는 것: 사람 턴(cause) 판정·위임 사슬·1회 승인·위임 줄(mandate)·거절 기록(`merge_denial`)·카드.
 * 읽기는 상태를 바꾸지 않으므로 사람 턴을 요구하지 않고, 거절이 권한 카드를 세우는 길이 되지 않게 기록을 남기지 않는다.
 *
 * **채널에 묶인 저장소(`channel.repo`)는 근거로 쓰지 않는다**(2026-10-31). 그 칸은 채널 관리자 누구나 적을 수 있는 자유 글이다 —
 * 그것으로 열면 채널 관리자가 저장소 이름 하나 적어 오퍼레이터의 gh 자격으로 아무 저장소나 읽게 만들 수 있다. grant 는
 * 사람이 그 에이전트에게 준 사실이라 이 경계를 지킨다.
 */
export type PrStatusCheckDenial = 'lease_invalid' | 'bad_repo' | 'not_granted';

export type PrStatusCheck =
  | { ok: true; repo: string }
  | { ok: false; code: PrStatusCheckDenial };

export async function checkPrStatus(
  pool: Pool,
  args: { agentId: string; operatorId: string; leaseId: string; token: string; repo: string; number: number; now?: Date },
): Promise<PrStatusCheck> {
  const now = args.now ?? new Date();
  const lease = await readLease(pool, { leaseId: args.leaseId, token: args.token, now });
  const leaseOk = !!lease && lease.agentId === args.agentId && lease.operatorId === args.operatorId
    && !lease.expired && !lease.ended;
  const scope = repoScope(args.repo);

  // 감사에는 저장소(target)와 PR 번호만 — PR 의 내용은 서버가 보지도 않는다.
  const deny = async (code: PrStatusCheckDenial): Promise<PrStatusCheck> => {
    await recordAudit(pool, { action: 'pr.status.denied', actorId: args.agentId, target: scope ?? args.repo.slice(0, 201), detail: { number: args.number, code } });
    return { ok: false, code };
  };

  if (!leaseOk) return deny('lease_invalid');
  if (!scope) return deny('bad_repo');
  const grant = await mergeGrantFor(pool, args.agentId, args.repo, { channelId: lease!.channelId });
  if (!grant) return deny('not_granted');

  await recordAudit(pool, { action: 'pr.status.checked', actorId: args.agentId, target: scope, detail: { number: args.number } });
  return { ok: true, repo: scope.slice('repo:'.length) };
}
