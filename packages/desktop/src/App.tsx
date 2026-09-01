import { useEffect, useState } from 'react';
import { ApiClient } from './lib/api';
import { connectWs } from './lib/ws';
import { createNotifier } from './lib/notify';
import { sessionStore } from './lib/session';
import { Controller, getController, setController } from './state/controller';
import { ConnectScreen } from './screens/ConnectScreen';
import { Workspace } from './components/Workspace';
import { SettingsScreen } from './screens/SettingsScreen';
import type { SectionId } from './components/settings/sections';

async function startSession(
  baseUrl: string, token: string, onSessionLost: (message: string) => void,
): Promise<void> {
  const api = new ApiClient(baseUrl, token);
  const controller = new Controller(api, connectWs, createNotifier(), onSessionLost);
  setController(controller);
  await controller.start();
}

export default function App() {
  const [phase, setPhase] = useState<'boot' | 'connect' | 'ready'>('boot');
  const [connectError, setConnectError] = useState<string | null>(null);
  // 설정은 세션 상태(phase)가 아니라 뷰다 — 그래서 별도 상태로 둔다.
  const [settings, setSettings] = useState<{ section?: SectionId } | null>(null);

  // 세션이 실행 중에 죽는 경로(다른 기기에서 로그아웃·PAT 폐기·세션 만료)를 부팅 실패와 같은
  // 표면으로 보낸다. 이것이 없으면 사이드바 빨간 점과 영구 재연결만 보이고 이유를 알 수 없다.
  const handleSessionLost = (message: string) => {
    setConnectError(message);
    setPhase('connect');
  };

  useEffect(() => {
    // 키체인 접근은 IPC 뒤라 비동기다(lib/session.ts). 부팅 화면이 그 사이를 덮는다.
    void (async () => {
      const stored = await sessionStore.load();
      if (!stored) { setPhase('connect'); return; }
      try {
        await startSession(stored.baseUrl, stored.token, handleSessionLost);
        setPhase('ready');
      } catch {
        // 세션을 조용히 지우고 로그인 화면만 띄우면 사용자에겐 이유 없는 로그아웃이 된다.
        await sessionStore.clear();
        setConnectError('Your saved session could not be resumed — it expired, or the server was unreachable. Please sign in again.');
        setPhase('connect');
      }
    })();
  }, []);

  if (phase === 'boot') return <div className="p-4 text-zinc-400">Connecting…</div>;
  if (phase === 'connect') {
    return (
      <ConnectScreen
        initialError={connectError}
        onConnected={(baseUrl, token) => {
          void sessionStore.save({ baseUrl, token });
          void startSession(baseUrl, token, handleSessionLost)
            .then(() => setPhase('ready'))
            .catch(() => {
              void sessionStore.clear();
              setConnectError('Signed in, but starting the session failed. Please try again.');
              setPhase('connect');
            });
        }}
      />
    );
  }
  const signOut = () => { getController().logout(); setSettings(null); setPhase('connect'); };

  if (settings) {
    return (
      <SettingsScreen
        initialSection={settings.section}
        onBack={() => setSettings(null)}
        onSignOut={signOut}
      />
    );
  }
  return (
    <Workspace
      onLogout={() => setPhase('connect')}
      onOpenSettings={(section) => setSettings({ section })}
    />
  );
}
