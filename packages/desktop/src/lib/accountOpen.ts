import type { AccountView } from '@murmur/shared';
import type { SectionId } from '../components/settings/sections';

/**
 * 계정을 눌렀을 때 갈 곳(#279 → #6xx).
 *
 * **판정이 한 곳에 있는 것이 요점이다.** 이 규칙은 `MessageBody` 의 멘션 칩 안에 인라인으로
 * 살고 있었는데, 이름줄·아바타에서도 같은 곳으로 가야 한다는 요구가 생기면서 같은 조건문이
 * 두 벌이 될 참이었다 — 이 저장소가 반복해서 겪은 결함 형태다(`Identity.tsx` 머리 주석).
 * 조건이 갈리면 "@fizz 는 설정으로 가는데 이름줄의 fizz 는 디렉터리로 간다" 같은,
 * 사람이 원인을 짚을 수 없는 화면이 남는다.
 *
 * 함께 고쳐진 것: 예전 코드는 **갈 곳**과 **접근 가능한 이름**을 각각 계산했다. 그래서
 * `onOpenSettings` 가 없는 자리(채널 문서 패널 등)에서 admin 이 에이전트 멘션을 보면
 * 실제로는 디렉터리로 가면서 이름만 "에이전트 설정 열기" 였다. 여기서는 둘이 **같은
 * 분기에서 함께** 나오므로 갈라질 수가 없다.
 */
export interface AccountOpeners {
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
}

/** 지금 보고 있는 사람. 스토어를 직접 읽지 않는다 — 순수 함수라 테스트가 값만 주면 된다. */
export interface Viewer {
  id: string | null;
  isAdmin: boolean;
}

export interface AccountOpen {
  /** 실제로 여는 동작. */
  run: () => void;
  /** 접근 가능한 이름 — `@handle` 이 아니라 **무엇을 하는지**다. */
  label: string;
}

/**
 * `null` 이면 **누를 것이 없다.** 호출자는 그때 버튼을 그리지 않는다 — 눌러도 아무 일이
 * 없는 컨트롤은 없는 것보다 나쁘다(`MessageBody` 의 원래 주석).
 *
 * 에이전트는 admin·소유자면 설정으로 간다(#299). `GET /accounts/agents` 가 소유자에게
 * 열린 뒤의 규칙이다 — 그 전에는 소유자가 403 을 받고 빈 화면을 봤다.
 */
export function accountOpen(
  account: AccountView | undefined,
  viewer: Viewer,
  { onOpenDirectory, onOpenSettings }: AccountOpeners,
): AccountOpen | null {
  if (!account) return null;

  const isOwner = account.kind === 'agent' && account.ownerAccountId === viewer.id;
  if (account.kind === 'agent' && (viewer.isAdmin || isOwner) && onOpenSettings) {
    return {
      run: () => onOpenSettings('agents', account.id),
      label: `${account.handle} 에이전트 설정 열기`,
    };
  }
  if (onOpenDirectory) {
    return {
      run: () => onOpenDirectory(account.id),
      label: `${account.handle} 프로필 열기`,
    };
  }
  return null;
}
