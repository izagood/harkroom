import { useEffect, useState, type ReactElement } from 'react';
import { createNotifier } from './lib/notify';
import { sessionStore, type StoredCommunity } from './lib/session';
import { useColorMode } from './lib/useColorMode';
import { useZoom } from './lib/useZoom';
import { useNotificationOpen } from './lib/useNotificationOpen';
import { useDockBadge } from './lib/useDockBadge';
import { getActiveEntry } from './state/communities';
import { getController, openNotificationTarget, startCommunitySession, type Controller } from './state/controller';
import { ConnectScreen } from './screens/ConnectScreen';
import { Workspace } from './components/Workspace';
import { SettingsScreen } from './screens/SettingsScreen';
import { WindowDragStrip } from './components/WindowDragStrip';
import { BootNotice, type BootWait } from './components/BootNotice';
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
): Promise<Controller> {
  const entry = await startCommunitySession({
    baseUrl: community.baseUrl,
    token: community.token,
    accountId: community.accountId,
    label: community.label,
    active: true,
    notifier: createNotifier(),
    onSessionLost: (message: string, accountId: string) => onSessionLost(message, accountId),
  });
  return entry.controller!;
}

export default function App() {
  useColorMode();
  useZoom();
  /**
   * OS 알림을 누르면 그 대화로 간다(#542). `phase` 분기보다 **위**에 있는 것이 요점이다 —
   * 알림은 부팅 중에도 오고, 리스너를 `ready` 안쪽에 두면 그때 누른 것이 사라진다.
   *
   * 무엇을 여는지는 `openNotificationTarget` 이 정한다(커뮤니티 전환 → 메시지 열기).
   * 여기서 그 순서를 다시 쓰지 않는다 — 링크 클릭(#178)과 갈릴 자리를 만들지 않는다.
   */
  useNotificationOpen((target) => { void openNotificationTarget(target); });
  /**
   * 독 아이콘의 미읽음 표시. `useNotificationOpen` 과 같은 이유로 **여기**다 — 미읽음은
   * 부팅·접속·설정 화면에서도 늘고 줄어들고, `ready` 안쪽에 두면 그동안 배지가 굳는다.
   */
  useDockBadge();
  const [phase, setPhase] = useState<'boot' | 'connect' | 'ready'>('boot');
  // 설정은 세션 상태(phase)가 아니라 뷰다 — 그래서 별도 상태로 둔다.
  const [connectError, setConnectError] = useState<string | null>(null);
  // #279: `targetId` 는 "설정을 이 대상이 선택된 상태로" 라는 뜻이다. 디렉터리는 여기에
  // 두지 않는다 — `Workspace` 가 자기 안에서 열고 닫는 겹창이고, 여기에 상태를 또 두면
  // 같은 사실이 두 곳에 생긴다(초판이 그렇게 두고 한쪽을 읽지 않았다).
  const [settings, setSettings] = useState<{ section?: SectionId; targetId?: string } | null>(null);
  /**
   * 부팅이 **무엇을 기다리는가**(`#460`). `unknown` 이 기본이고, 그 자리에서 사유를
   * 지어내지 않는다 — `keychain` 은 `sessionStore.load` 가 실제로 키체인을 두드렸을 때만
   * 온다(그 콜백이 유일한 근거다). 그리고 `load` 가 끝나면 **되돌린다**: 대기가 끝났는데
   * 문구가 남아 있으면 그것도 거짓말이고, 사람은 다음 화면을 기다리며 또 헤맨다.
   */
  const [bootWait, setBootWait] = useState<BootWait>('unknown');

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
    let cancelled = false;
    let startedController: Controller | null = null;

    void (async () => {
      // 키체인 접근은 IPC 뒤라 비동기다(lib/session.ts). 부팅 화면이 그 사이를 덮는데,
      // **그 화면이 무엇을 덮고 있는지 말하지 않는 것**이 `#460` 이다(실측 36분).
      // 콜백은 `secret_get` 을 부르기 직전에 온다 — 폴백(`localStorage`) 경로에서는 안 온다.
      const stored = await sessionStore.load(() => {
        if (cancelled) return;
        setBootWait('keychain');
      });
      // **대기가 끝났으면 되돌린다.** 아래 `cancelled` 문지기보다 앞이다: 여기를 지나면
      // 키체인은 이미 답했고, 그 뒤에도 문구가 서 있으면 사람은 없는 대화상자를 찾는다.
      setBootWait('unknown');
      // 개발 모드의 StrictMode 는 effect 를 한 번 정리한 뒤 다시 실행한다. 첫 실행의 IPC가
      // 늦게 끝났다면 여기서 멈춰야 두 번째 세션을 다시 교체하지 않는다.
      if (cancelled) return;
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
        startedController = await startSession(active, handleSessionLost);
        if (cancelled) {
          startedController.stop();
          return;
        }
        setPhase('ready');
      } catch {
        if (cancelled) return;
        await sessionStore.clear();
        if (cancelled) return;
        setConnectError('Your saved session could not be resumed — it expired, or the server was unreachable. Please sign in again.');
        setPhase('connect');
      }
    })();

    return () => {
      cancelled = true;
      startedController?.stop();
    };
  }, []);

  /**
   * #342: `Workspace` 에 닿기 전의 두 화면(`boot`·`connect`)에는 창 손잡이가 없었다.
   * `#270` 이 OS 타이틀바를 없앤 것은 창 전역인데 손잡이는 `Workspace` 안에만 달렸기 때문이다.
   * 두 화면을 같은 띠로 감싸 이 갈래가 늘어나도 손잡이가 따라오게 한다.
   */
  /*
   * 글자 크기는 `Workspace`·`SettingsScreen` 과 **같은 본문단 13px** 이다.
   *
   * 여기에는 크기가 없었고, 그러면 이 두 화면(`boot`·`connect`)만 브라우저 기본값
   * **16px** 로 그려진다 — 앱의 다른 화면은 14px(`Workspace` 의 `text-sm`)이었으니
   * 로그인 화면이 혼자 한 단 크게 서 있었다. 실측으로 발견한 세 번째 뿌리다.
   * 셋을 같은 값으로 맞추면 화면을 넘어가도 본문이 같은 크기로 남는다.
   */
  const withDragStrip = (screen: ReactElement) => (
    <div className="flex h-screen flex-col bg-surface-sunken text-body">
      <WindowDragStrip />
      {/* 띠가 세로를 먹은 만큼 화면이 넘치지 않도록 나머지를 준다. */}
      <div className="min-h-0 flex-1">{screen}</div>
    </div>
  );

  if (phase === 'boot') return withDragStrip(<BootNotice wait={bootWait} />);
  if (phase === 'connect') {
    return withDragStrip(
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
      />,
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
