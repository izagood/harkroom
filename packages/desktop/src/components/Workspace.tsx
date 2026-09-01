import { useState } from 'react';
import { useAppStore } from '../state/appStore';
import { AgentManager } from './AgentManager';
import { Sidebar } from './Sidebar';
import { ChannelPane } from './ChannelPane';
import { ThreadPanel } from './ThreadPanel';

export function Workspace({ onLogout }: { onLogout: () => void }) {
  const threadRootId = useAppStore((s) => s.threadRootId);
  const [agentsOpen, setAgentsOpen] = useState(false);
  return (
    <div className="flex h-screen text-sm">
      <Sidebar onLogout={onLogout} onManageAgents={() => setAgentsOpen(true)} />
      <ChannelPane />
      {threadRootId && <ThreadPanel />}
      {agentsOpen && <AgentManager onClose={() => setAgentsOpen(false)} />}
    </div>
  );
}
