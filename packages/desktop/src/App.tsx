import { useEffect, useState } from 'react';
import { createNotifier } from './lib/notify';
import { sessionStore, type StoredCommunity } from './lib/session';
import { useColorMode } from './lib/useColorMode';
import { getActiveEntry } from './state/communities';
import { getController, startCommunitySession } from './state/controller';
import { ConnectScreen } from './screens/ConnectScreen';
import { Workspace } from './components/Workspace';
import { SettingsScreen } from './screens/SettingsScreen';
import type { SectionId } from './components/settings/sections';

/**
 * #166: 세션을 레지스트리를 거쳐 띄운다. `active: true` 는 "화면이 이 커뮤니티를 본다" 는
 * 뜻이고, 그 커뮤니티의 스토어·컨트롤러 인스턴스가 활성 엔트리에 꽂힌다. 두 번째 커뮤니티를
 * 붙이는 경로(`active: false`)는 여기가 아니라 `CommunitySettings` 의 추가 흐름이다(#165) —
 * 그 흐름은 `phase` 를 건드리지 않는다.
 */
async function startSession(
  community: StoredCommunity,
  onSessionLost: (message: string, accountId: string) => void,
): Promise<void> {
  await startCommunitySession({
    baseUrl: community.baseUrl,
    token: community.token,
    accountId: community.accountId,
    label: community.label,
    active: true,
    notifier: createNotifier(),
    onSessionLost: (message: string, accountId: string) => onSessionLost(message, accountId),
  });
}

export default function App() {
  useColorMode();
  const [phase, setPhase] = useState<'boot' | 'connect' | 'ready'>('boot');
  // 설정은 세션 상태(phase)가 아니라 뷰다 — 그래서 별도 상태로 둔다.
  const [connectError, setConnectError] = useState<string | null>(null);
  // #279: `targetId` 는 "설정을 이 대상이 선택된 상태로" 라는 뜻이다. 디렉터리는 여기에
  // 두지 않는다 — `Workspace` 가 자기 안에서 열고 닫는 겹창이고, 여기에 상태를 또 두면
  // 같은 사실이 두 곳에 생긴다(초판이 그렇게 두고 한쪽을 읽지 않았다).
  const [settings, setSettings] = useState<{ section?: SectionId; targetId?: string } | null>(null);

  // 세션이 실행 중에 죽는 경로(다른 기기에서 로그아웃·PAT 폐기·세션 만료)를 부팅 실패와
  // 같은 표면으로 보낸다. 이것이 없으면 사이드바 빨간 점과 영구 재연결만 보이고 이유를
  // 알 수 없다.
  //
  // #164: 다만 **활성 커뮤니티일 때만** 화면을 바꾼다. 커뮤니티 셋 중 하나의 PAT 가
  // 폐기됐을 때 나머지 둘이 멀쩡한데 앱 전체가 로그인 화면으로 가는 것은 오답이다.
  // 활성이 아닌 것은 보관소에서 빠지고(controller 가 그 커뮤니티만 지운다) 화면은 그대로다 —
  // 그것이 화면에 보이는 자리는 전환기 레일의 타일 상태 표시다(#165).
  //
  // #165: 활성 커뮤니티의 계정 id 를 **레지스트리에서 읽는다**. 예전에는 App 의 지역
  // state 였는데, 이 콜백은 `useEffect([])` 안에서 한 번 넘겨지므로 첫 렌더의 값(null)에
  // 잡혀 있었고, 전환기가 활성을 바꾸면 그 낡음이 그대로 오답이 된다. 같은 사실을 두 곳에
  // 두지 않는 것이 이 저장소의 규칙이기도 하다.
  const handleSessionLost = (message: string, accountId: string) => {
    if (accountId === getActiveEntry().accountId) {
      setConnectError(message);
      setPhase('connect');
    }
  };

  useEffect(() => {
    void (async () => {
      // 키체인 접근은 IPC 뒤라 비동기다(lib/session.ts). 부팅 화면이 그 사이를 덮는다.
      const stored = await sessionStore.load();
      if (!stored || !stored.communities.length) {
        setPhase('connect');
        return;
      }

      const active = stored.active
        ? stored.communities.find((c) => c.accountId === stored.active) ?? stored.communities[0]
        : stored.communities[0];

      if (!active) {
        setPhase('connect');
        return;
      }

      try {
        await startSession(active, handleSessionLost);
        setPhase('ready');
      } catch {
        await sessionStore.clear();
        setConnectError('Your saved session could not be resumed — it expired, or the server was unreachable. Please sign in again.');
        setPhase('connect');
      }
    })();
  }, []);

  if (phase === 'boot') return <div className="p-4 text-fg-muted">Connecting…</div>;
  if (phase === 'connect') {
    return (
      <ConnectScreen
        initialError={connectError}
        onConnected={async (baseUrl, token, accountId, handle) => {
          const stored = (await sessionStore.load()) ?? { active: null, communities: [] };
          const existing = stored.communities.findIndex((c) => c.accountId === accountId);
          if (existing >= 0) {
            // 이름은 **살려 둔다**(#165). 재로그인이 사람이 붙인 꼬리표를 지우면, 이름을
            // 붙인 이유(같은 화면의 서버 둘을 구분한다)가 로그인 한 번에 사라진다.
            stored.communities[existing] = { accountId, baseUrl, token, handle, label: stored.communities[existing]!.label };
          } else {
            stored.communities.push({ accountId, baseUrl, token, handle, label: null });
          }
          stored.active = accountId;
          await sessionStore.save(stored);
          try {
            await startSession(stored.communities.find((c) => c.accountId === accountId)!, handleSessionLost);
            setPhase('ready');
          } catch {
            // 세션을 조용히 지우고 로그인 화면만 띄우면 사용자에겐 이유 없는 로그아웃이 된다.
            // #164: **방금 붙은 커뮤니티만** 뺀다 — clear() 는 다른 커뮤니티의 토큰까지 지운다.
            await sessionStore.remove(accountId);
            setConnectError('Signed in, but starting the session failed. Please try again.');
            setPhase('connect');
          }
        }}
      />
    );
  }
  const signOut = () => {
    getController().logout();
    setSettings(null);
    setPhase('connect');
  };

  if (settings) {
    return (
      <SettingsScreen
        initialSection={settings.section}
        targetId={settings.targetId}
        onBack={() => setSettings(null)}
        onSignOut={signOut}
        // #165: 마지막 커뮤니티를 뺐다 — 그때는 정말 세션이 없으므로 접속 화면으로 돌아간다.
        // 커뮤니티 제거가 이 경로 말고는 `phase` 를 건드리지 않는다.
        onCommunitiesEmpty={() => { setSettings(null); setPhase('connect'); }}
      />
    );
  }
  return (
    <Workspace
      onLogout={() => setPhase('connect')}
      onOpenSettings={(section, targetId) => setSettings({ section, targetId })}
    />
  );
}
