import { useState, useEffect } from 'react';
import { useAppStore } from '../state/appStore';
import { Sidebar } from './Sidebar';
import { ChannelPane } from './ChannelPane';
import { ThreadPanel } from './ThreadPanel';
import { SearchPalette } from './SearchPalette';
import type { SectionId } from './settings/sections';

export function Workspace({ onLogout, onOpenSettings }: {
  onLogout: () => void;
  onOpenSettings: (section?: SectionId) => void;
}) {
  const threadRootId = useAppStore((s) => s.threadRootId);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex h-screen text-sm">
      <Sidebar onLogout={onLogout} onOpenSettings={onOpenSettings} />
      <ChannelPane />
      {threadRootId && <ThreadPanel />}
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
