/** 설정 화면의 목차. 새 섹션은 여기에 한 줄 더하고 SettingsScreen 의 렌더 분기에 한 줄 더하면 붙는다.
 *  타입이 화면(SettingsScreen)이 아니라 여기 사는 이유는, Sidebar·App 이 섹션을 지목하면서
 *  화면 컴포넌트를 import 하게 되면 의존 방향이 거꾸로 서기 때문이다. */
export type SectionId = 'profile' | 'notifications' | 'messages' | 'connection' | 'agents' | 'handle-groups' | 'invite' | 'updates';

export const SETTINGS_GROUPS: { title: string; items: { id: SectionId; label: string }[] }[] = [
  {
    title: 'Personal',
    items: [
      { id: 'profile', label: 'Profile' },
      { id: 'notifications', label: 'Notifications' },
      { id: 'messages', label: 'Messages' },
      { id: 'connection', label: 'Connection' },
    ],
  },
  {
    title: 'App',
    items: [
      { id: 'agents', label: 'Agents' },
      { id: 'handle-groups', label: 'Handle Groups' },
      { id: 'invite', label: 'Invite' },
      { id: 'updates', label: 'Updates' },
    ],
  },
];
