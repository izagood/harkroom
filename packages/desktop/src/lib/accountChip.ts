import { isAccountRank, isPoolRank } from '@harkroom/shared';
import type { Translate } from '../i18n';

/**
 * 러너가 실어 온 **풀·계정 순번**으로 계정 칩의 글·툴팁을 만든다(계정 칩 ①, designer A1).
 * 턴 줄 칩(`AgentTurns`)과 설정의 「그 머신에서 최근 턴」 줄(`PoolGateBand`)이 같은 글을 쓰도록 한 곳에 둔다.
 *
 * 이름은 받지 않는다 — 계정·풀 이름은 서버로 오지 않는다(#1039). `account` 는 숫자=순번,
 * `null`=확인된 시스템 기본 로그인, 그 밖(옛 러너·claude 가 아닌 턴)=모름. 모르는데 풀 순번도 2 미만이면
 * 단언할 것이 없으므로 `null` 을 돌려준다(그리지 않는다).
 */
export interface AccountChip {
  label: string;
  title: string;
  /** 1번 풀이 아니라 아래 풀로 내려와 돈다 — 주황·「↓」. */
  fell: boolean;
}

export function accountChipOf(t: Translate, poolRaw: unknown, accountRaw: unknown): AccountChip | null {
  const pool = isPoolRank(poolRaw) ? poolRaw : null;
  const known = accountRaw === null || isAccountRank(accountRaw);
  const fell = pool !== null && pool > 1;
  if (!known && !fell) return null;
  if (!known) return { label: t('agentTurns.poolFallback', { n: pool! }), title: t('agentTurns.poolFallbackTitle', { n: pool! }), fell };
  const acct = accountRaw as number | null;
  const base = acct === null ? t('agentTurns.accountDefault')
    : pool !== null ? t('agentTurns.accountChip', { pool, account: acct })
    : t('agentTurns.accountChipRoot', { account: acct });
  const title = acct === null ? t('agentTurns.accountTitleDefault')
    : pool !== null ? t('agentTurns.accountTitle', { pool, account: acct })
    : t('agentTurns.accountTitleRoot', { account: acct });
  // 내려왔으면 「↓」를 붙이고(기본 로그인이어도 — designer n2), 툴팁은 주황을 띤 까닭부터 읽히게 앞에 둔다(designer n1).
  return fell
    ? { label: `↓ ${base}`, title: `${t('agentTurns.poolFallbackTitle', { n: pool! })} · ${title}`, fell }
    : { label: base, title, fell };
}
