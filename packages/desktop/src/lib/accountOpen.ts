import type { AccountView } from '@murmur/shared';
import type { Translate } from '../i18n';
import type { SectionId } from '../components/settings/sections';
import { canSeeAgentConfig } from './agentConfigGate';

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
  // 번역기를 **맨 뒤에 필수로** 받는다 — 기본값을 주면 부르는 화면이 안 넘겨도 컴파일이
  // 통과하고 그 화면의 접근 이름만 한 언어로 굳는다(`lastTurnAgo`·`inboxRow` 와 같은 규약).
  t: Translate,
): AccountOpen | null {
  if (!account) return null;

  /*
    **판정은 `agentConfigGate` 하나가 낸다.** 여기 인라인으로 두면 같은 물음("이 사람이 이
    에이전트의 설정을 볼 수 있는가")이 이 파일과 프로필(`Profile.canSeeConfig`) · 레일의
    에이전트 격자(`Sidebar` 의 `onPick`)에 세 벌로 살게 된다 — 이 파일 머리 주석이 멘션과
    이름줄에 대해 경고한 것과 **같은 형태**의 결함이다. 목적지(이 함수)와 술어(그 모듈)는
    다른 물음이라 나뉘어 있는 것이고, 술어가 필요한 자리는 목적지가 필요하지 않다:
    프로필은 갈 곳이 아니라 **버튼을 그릴지**를 묻는다.

    옮기면서 한 가지가 함께 고쳐진다 — `ownerAccountId === viewer.id` 는 부트스트랩 전
    (`viewer.id === null`)이면서 소유자가 없는 에이전트(`ownerAccountId === null`)를
    '내 것'으로 읽었다. `#181` 이 정한 규칙(*"추측 소유자는 소유자가 아니다"*)을 그
    모듈이 지킨다.
  */
  if (canSeeAgentConfig(account, viewer) && onOpenSettings) {
    return {
      run: () => onOpenSettings('agents', account.id),
      label: t('accountOpen.agentConfig', { handle: account.handle }),
    };
  }
  if (onOpenDirectory) {
    return {
      run: () => onOpenDirectory(account.id),
      label: t('accountOpen.profile', { handle: account.handle }),
    };
  }
  return null;
}
