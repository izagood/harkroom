import { useAppStore } from '../state/appStore';
import { Sidebar } from './Sidebar';
import { ChannelPane } from './ChannelPane';

export function Workspace({ onLogout }: { onLogout: () => void }) {
  const threadRootId = useAppStore((s) => s.threadRootId);
  void threadRootId; // Task 9에서 ThreadPanel 조건 렌더로 사용
  return (
    <div className="flex h-screen text-sm">
      <Sidebar onLogout={onLogout} />
      <ChannelPane />
    </div>
  );
}
