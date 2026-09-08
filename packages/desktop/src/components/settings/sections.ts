/** 설정 화면의 목차. 새 섹션은 여기에 한 줄 더하고 SettingsScreen 의 렌더 분기에 한 줄 더하면 붙는다.
 *  타입이 화면(SettingsScreen)이 아니라 여기 사는 이유는, Sidebar·App 이 섹션을 지목하면서
 *  화면 컴포넌트를 import 하게 되면 의존 방향이 거꾸로 서기 때문이다. */
/**
 * **`teams` 가 이 유니온에서 사라졌다** (`docs/desktop-agent-cards.html` 4단계).
 *
 * 팀은 `Agents` 화면 안의 묶음이 됐다(`AgentsSettings` 의 `group` 상태). 근거는 문서의
 * 첫 문장이다: *"팀은 에이전트를 묶는 일이다. 묶을 대상이 옆 화면에 있으면 사람은 이름을
 * 외워서 옮겨 적는다."*
 *
 * **값을 유니온에서 지우는 것이 요점이다.** 목차에서만 빼고 `SectionId` 에 남겨 두면
 * 저장된 설정이나 딴 화면의 배선이 `'teams'` 를 들고 올 때 `isSectionId` 가 그것을
 * 통과시키고(그 함수는 목차를 진실로 삼으므로 실제로는 막는다) 타입은 아무 말도 안 한다 —
 * 즉 컴파일러가 낡은 배선을 잡아 주지 못한다. 지우면 `SettingsScreen` 의 렌더 분기와
 * 남은 호출부가 **컴파일에서** 막힌다.
 *
 * `handle-groups` 는 **남는다.** 문서가 그 관계를 *"이 문서가 정하지 않는 열린 결정"* 으로
 * 남겼고, 갈라 두기로 정했다 — 팀은 에이전트를 묶고 집합은 사람을 묶으므로(`#570` 이후
 * 남은 차이가 구성원 종류 하나다: `agent_not_allowed` 대 `not_an_agent`) 쓰는 사람과
 * 목적이 다르다. 에이전트 화면에 사람 묶음이 들어오면 그 화면이 무엇에 관한 것인지
 * 흐려진다.
 *
 * 갈라 두기로 정하면 남는 일이 하나 있다 — 문서가 그 선택지를 적어 뒀다: *"갈라 두고 각
 * 화면이 서로를 가리킬지."* 같은 네임스페이스를 쓰므로 `@release` 를 만들려는 사람이 어느
 * 쪽으로 가야 하는지 화면이 말해야 하고, 목차에서 `Teams` 가 사라진 뒤로는 더 그렇다.
 * 그 한 줄이 **두 화면에 각각** 있다: `TeamDetail` 의 `team-mention-note`(팀 → 집합)와
 * `HandleGroupsSettings` 의 목록 머리(집합 → 팀).
 */
export type SectionId = 'profile' | 'notifications' | 'messages' | 'appearance' | 'connection' | 'communities' | 'agents' | 'agent-defaults' | 'claude-accounts' | 'handle-groups' | 'invite' | 'updates' | 'skills' | 'gallery';

export const SETTINGS_GROUPS: { title: string; items: { id: SectionId; label: string }[] }[] = [
  {
    title: 'Personal',
    items: [
      { id: 'profile', label: 'Profile' },
      { id: 'notifications', label: 'Notifications' },
      { id: 'messages', label: 'Messages' },
      { id: 'appearance', label: 'Appearance' },
      { id: 'connection', label: 'Connection' },
      // #165: 커뮤니티 목록·추가·전환. `Connection` 바로 뒤에 두는 이유는 그 화면이
      // "지금 붙은 서버 하나" 를 말하고 이 화면이 "이 기기가 아는 서버 전부" 를 말해서다.
      { id: 'communities', label: 'Communities' },
    ],
  },
  {
    title: 'App',
    items: [
      { id: 'agents', label: 'Agents' },
      // #171 · identity 문서 원칙 04: **개별 에이전트의 설정이 아니다.** 한 에이전트를
      // 고치는 화면 안에 워크스페이스 전체에 걸리는 값이 앉아 있으면 지금 무엇을 고치고
      // 있는지가 사라진다 — 그래서 목차의 별도 항목으로 두고 Agents 바로 뒤에 세운다.
      { id: 'agent-defaults', label: 'Agent defaults' },
      // 계정 풀은 **기기 로컬 자원**이다 — 이 기기의 디렉터리와 그 안의 자격증명이고,
      // 서버에도 다른 기기에도 없다. Agents 옆에 두는 이유는 러너가 그것을 쓰기 때문이고,
      // Agents 안에 넣지 않는 이유는 개별 에이전트의 설정이 아니기 때문이다
      // (`agent-defaults` 를 별 항목으로 세운 것과 같은 판단이다).
      { id: 'claude-accounts', label: 'Claude accounts' },
      // `Teams` 가 여기 있었다. 지금은 `Agents` 안의 묶음이다 — 근거는 위 `SectionId` 주석.
      { id: 'handle-groups', label: 'Handle Groups' },
      { id: 'invite', label: 'Invite' },
      { id: 'updates', label: 'Updates' },
      { id: 'skills', label: 'Skills' },
      /**
       * 컴포넌트 갤러리(Task 11). **개발자용이라 목록의 맨 끝**에 둔다 — 배포본에서도
       * 보이지만 쓰는 사람이 찾아 들어갈 일이 없는 자리다. 숨기지 않는 이유: 숨긴 화면은
       * 곧 깨지고, 깨진 것을 아무도 모른다(그 화면이 지키려는 것이 어휘 그 자체다).
       */
      { id: 'gallery', label: 'Component gallery' },
    ],
  },
];

/**
 * 문자열이 **정말 목차의 항목인가**. 밖에서 온 값(딴 화면의 배선, 저장된 설정)을
 * 섹션 자리에 앉히기 전에 이것을 통과해야 한다 — 통과 못 한 값이 그대로 앉으면
 * `SettingsScreen` 의 모든 분기가 거짓이 되어 본문이 통째로 빈다(실측 2026-09-07:
 * 투영 띠가 `MouseEvent` 를 흘려 설정 화면에 아무것도 안 나왔다).
 *
 * 목차(`SETTINGS_GROUPS`)를 진실로 삼는다 — 유니온을 손으로 한 벌 더 적으면 항목을
 * 더할 때 한쪽만 고쳐진다.
 */
export function isSectionId(value: unknown): value is SectionId {
  return typeof value === 'string'
    && SETTINGS_GROUPS.some((g) => g.items.some((i) => i.id === value));
}

/** 아무 말도 없을 때 서는 자리. `SettingsScreen` 의 기본값과 **같은 한 벌**이다. */
export const DEFAULT_SECTION: SectionId = 'profile';
