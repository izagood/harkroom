import { useAppStore } from '../state/appStore';
import { Sidebar } from './Sidebar';
import { ChannelPane } from './ChannelPane';
import { ThreadPanel } from './ThreadPanel';
import type { SectionId } from './settings/sections';

export function Workspace({ onLogout, onOpenSettings }: {
  onLogout: () => void;
  onOpenSettings: (section?: SectionId) => void;
}) {
  const threadRootId = useAppStore((s) => s.threadRootId);
  return (
    <div className="flex h-screen text-sm">
      <Sidebar onLogout={onLogout} onOpenSettings={onOpenSettings} />
      <ChannelPane />
      {threadRootId && <ThreadPanel />}
    </div>
  );
}
