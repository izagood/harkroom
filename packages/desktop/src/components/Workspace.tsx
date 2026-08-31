import { useAppStore } from '../state/appStore';
import { Sidebar } from './Sidebar';
import { ChannelPane } from './ChannelPane';
import { ThreadPanel } from './ThreadPanel';

export function Workspace({ onLogout }: { onLogout: () => void }) {
  const threadRootId = useAppStore((s) => s.threadRootId);
  return (
    <div className="flex h-screen text-sm">
      <Sidebar onLogout={onLogout} />
      <ChannelPane />
      {threadRootId && <ThreadPanel />}
    </div>
  );
}
