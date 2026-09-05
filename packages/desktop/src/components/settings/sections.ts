/** 설정 화면의 목차. 새 섹션은 여기에 한 줄 더하고 SettingsScreen 의 렌더 분기에 한 줄 더하면 붙는다.
 *  타입이 화면(SettingsScreen)이 아니라 여기 사는 이유는, Sidebar·App 이 섹션을 지목하면서
 *  화면 컴포넌트를 import 하게 되면 의존 방향이 거꾸로 서기 때문이다. */
export type SectionId = 'profile' | 'notifications' | 'messages' | 'appearance' | 'connection' | 'communities' | 'agents' | 'agent-defaults' | 'teams' | 'handle-groups' | 'invite' | 'updates' | 'skills' | 'gallery';

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
      { id: 'teams', label: 'Teams' },
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
