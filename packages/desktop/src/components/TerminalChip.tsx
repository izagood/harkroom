import type { AccountView } from '@murmur/shared';
import { useAppStore } from '../state/appStore';

/**
 * 진행 중인 에이전트 터미널로 들어가는 진입점(#141 Phase 2, 스펙 §5 "소유자").
 *
 * **소유자가 아니면 칩 자체가 없다 — 비활성이 아니라 부재다.** 스펙의 원 요구가
 * "에이전트 작업은 기본은 안 보여야 맞다"이므로, 눌러도 안 되는 버튼을 보여 주는 것은
 * 그 요구를 반쯤 어긴다: 남의 러너 셸이 여기 있다는 사실 자체가 새고, 사람은 권한을
 * 달라고 물을 대상을 찾게 된다. 서버도 같은 판정으로 403 을 주지만(그쪽이 진짜 게이트다),
 * 화면은 그 판정을 **미리 반영**해서 없는 문을 그리지 않는다.
 *
 * admin 도 허용한다 — 서버의 `checkOwnerOrAdmin` 과 같은 판정이어야 한다. 화면이 더
 * 좁으면 admin 이 열 수 있는 문을 못 찾고, 더 넓으면 눌러서 403 을 받는다.
 *
 * 소유자가 `null` 인 에이전트에는 admin 에게만 뜬다: `008` 마이그레이션이 backfill 을
 * 넣지 않은 것은 의도였고(#181), 그래서 `null` 은 "아무나"가 아니라 "아직 아무도"다.
 */
export function TerminalChip({ account }: { account: AccountView | undefined }) {
  const me = useAppStore((s) => s.me);
  const set = useAppStore((s) => s.set);

  if (!account || account.kind !== 'agent' || !me) return null;
  // `ownerAccountId === null` 은 `me.id` 와 결코 같아지지 않으므로 이 비교만으로도
  // admin 전용이 되지만, 판정의 근거를 비교의 부산물로 두지 않는다 —
  // `auth/plugin.ts::checkOwnerOrAdmin` 이 같은 이유로 null 분기를 명시한다.
  const isOwner = account.ownerAccountId !== null && account.ownerAccountId === me.id;
  if (!me.isAdmin && !isOwner) return null;

  return (
    <button
      onClick={() => set({ terminalAgentId: account.id })}
      className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-700"
      title={`@${account.handle} 의 진행 중인 터미널을 본다`}
    >
      터미널 보기
    </button>
  );
}
