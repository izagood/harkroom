import { useEffect, useState } from 'react';
import { ApiClient } from './lib/api';
import { connectWs } from './lib/ws';
import { sessionStore } from './lib/session';
import { Controller, setController } from './state/controller';
import { ConnectScreen } from './screens/ConnectScreen';

function Workspace() {
  return <div data-testid="workspace" />; // Task 7에서 교체
}

async function startSession(baseUrl: string, token: string): Promise<void> {
  const api = new ApiClient(baseUrl, token);
  const controller = new Controller(api, connectWs, token);
  setController(controller);
  await controller.start();
}

export default function App() {
  const [phase, setPhase] = useState<'boot' | 'connect' | 'ready'>('boot');

  useEffect(() => {
    const stored = sessionStore.load();
    if (!stored) { setPhase('connect'); return; }
    void startSession(stored.baseUrl, stored.token)
      .then(() => setPhase('ready'))
      .catch(() => { sessionStore.clear(); setPhase('connect'); });
  }, []);

  if (phase === 'boot') return <div className="p-4 text-zinc-400">Connecting…</div>;
  if (phase === 'connect') {
    return (
      <ConnectScreen
        onConnected={(baseUrl, token) => {
          sessionStore.save({ baseUrl, token });
          void startSession(baseUrl, token).then(() => setPhase('ready'));
        }}
      />
    );
  }
  return <Workspace />;
}
