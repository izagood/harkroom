import { useMemo, useState } from 'react';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { LeasePanel } from './LeasePanel';
import type { SectionId } from './settings/sections';
import { CHANNEL_NAME_PATTERN } from '@murmur/shared';

/**
 * 채널 미읽음 표시. **멘션 배지와 다른 신호다** — 멘션은 "당신을 불렀다"(빨간 숫자),
 * 이것은 "새 대화가 있다"(작은 점). 여기에 숫자를 붙이면 두 뜻이 섞여 빨간 배지가 의미를
 * 잃는다. 수치는 aria-label 로만 노출한다(스크린리더·테스트가 읽을 수 있게).
 */
function ChannelUnreadDot({ channelId, name }: { channelId: string; name: string }) {
  const unread = useAppStore((s) => s.reads[channelId]?.unread ?? 0);
  if (!unread) return null;
  return (
    <span
      aria-label={`${unread} unread in ${name}`}
      className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400"
    />
  );
}

function UnreadBadge({ channelId }: { channelId: string }) {
  const unread = useAppStore((s) => s.unread);
  const count = unread.filter((e) => e.channelId === channelId && !e.readAt).length;
  if (!count) return null;
  return (
    <span data-testid={`unread-${channelId}`}
      className="ml-auto rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">
      {count}
    </span>
  );
}

export function Sidebar({ onLogout, onOpenSettings }: {
  onLogout: () => void;
  onOpenSettings: (section?: SectionId) => void;
}) {
  const { me, accounts, channels, dms, online, connected, activeChannelId } = useAppStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const channelRegex = new RegExp(CHANNEL_NAME_PATTERN);

  const dmPeers = useMemo(() =>
    dms.map((dm) => {
      const peers = dm.memberIds.filter((id) => id !== me?.id);
      return {
        id: dm.id,
        label: peers.map((id) => accounts[id]?.handle ?? '…').join(', ') || 'just me',
        online: peers.some((id) => online.includes(id)),
      };
    }), [dms, accounts, me, online]);

  const others = Object.values(accounts).filter((a) => a.id !== me?.id);
  const row = (active: boolean) =>
    `flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-zinc-700 ${active ? 'bg-zinc-700' : ''}`;

  return (
    <aside className="flex w-60 flex-col bg-zinc-900 text-zinc-200">
      <div className="flex items-center gap-2 border-b border-zinc-800 p-3 font-bold">
        murmur
        <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
          title={connected ? 'connected' : 'disconnected'} />
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto p-2">
        <div>
          <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-zinc-500">Channels</div>
          {channels.map((ch) => (
            <button key={ch.id} className={row(ch.id === activeChannelId)}
              onClick={() => void getController().openChannel(ch.id)}>
              <span className="text-zinc-500">#</span>{ch.name}
              {ch.repo && <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{ch.repo}</span>}
              <ChannelUnreadDot channelId={ch.id} name={ch.name ?? ''} />
              <UnreadBadge channelId={ch.id} />
            </button>
          ))}
          {me?.isAdmin && (
            createChannelOpen ? (
              <div className="mt-1 rounded border border-zinc-700 bg-zinc-800 p-1">
                <input
                  type="text"
                  className="mb-1 w-full rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-200 placeholder-zinc-500"
                  placeholder="channel-name"
                  value={newChannelName}
                  onChange={(e) => { setNewChannelName(e.target.value); setCreateError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newChannelName) {
                      void (async () => {
                        if (!channelRegex.test(newChannelName)) {
                          setCreateError('이름은 영문 소문자, 숫자, -, _ 만 가능 (1-48자)');
                          return;
                        }
                        try {
                          const ch = await getController().api.createChannel({ name: newChannelName });
                          useAppStore.getState().set({
                            channels: [...useAppStore.getState().channels, ch],
                          });
                          setCreateChannelOpen(false);
                          setNewChannelName('');
                          setCreateError(null);
                          void getController().openChannel(ch.id);
                        } catch (err) {
                          setCreateError(err instanceof Error ? err.message : '채널 생성 실패');
                        }
                      })();
                    }
                    if (e.key === 'Escape') { setCreateChannelOpen(false); setNewChannelName(''); setCreateError(null); }
                  }}
                  autoFocus
                />
                {createError && <p className="mb-1 text-[10px] text-red-400">{createError}</p>}
                <div className="flex gap-1">
                  <button
                    className="rounded bg-indigo-600 px-2 py-0.5 text-xs text-white hover:bg-indigo-500"
                    onClick={() => {
                      if (!channelRegex.test(newChannelName)) {
                        setCreateError('이름은 영문 소문자, 숫자, -, _ 만 가능 (1-48자)');
                        return;
                      }
                      void (async () => {
                        try {
                          const ch = await getController().api.createChannel({ name: newChannelName });
                          useAppStore.getState().set({
                            channels: [...useAppStore.getState().channels, ch],
                          });
                          setCreateChannelOpen(false);
                          setNewChannelName('');
                          setCreateError(null);
                          void getController().openChannel(ch.id);
                        } catch (err) {
                          setCreateError(err instanceof Error ? err.message : '채널 생성 실패');
                        }
                      })();
                    }}
                  >
                    만들기
                  </button>
                  <button
                    className="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700"
                    onClick={() => { setCreateChannelOpen(false); setNewChannelName(''); setCreateError(null); }}
                  >
                    취소
                  </button>
                </div>
              </div>
            ) : (
              <button className={`${row(false)} text-zinc-400`} onClick={() => setCreateChannelOpen(true)}>
                + Create channel
              </button>
            )
          )}
        </div>
        <div>
          <button className={`${row(false)} text-zinc-400`} onClick={() => onOpenSettings('agents')}>
            + Add or edit agents
          </button>
        </div>
        <div>
          <div className="flex items-center px-2 pb-1 text-[11px] uppercase tracking-wide text-zinc-500">
            Direct messages
            <button className="ml-auto rounded px-1 hover:bg-zinc-700" onClick={() => setPickerOpen((v) => !v)}>
              + New
            </button>
          </div>
          {pickerOpen ? (
            <div className="mb-1 rounded border border-zinc-700 bg-zinc-800 p-1">
              {others.map((a) => (
                <button key={a.id} className={row(false)}
                  onClick={() => { setPickerOpen(false); void getController().startDm(a.id); }}>
                  {a.handle}
                  <span className="text-[10px] text-zinc-500">{a.kind}</span>
                </button>
              ))}
            </div>
          ) : (
            dmPeers.map((dm) => (
              <button key={dm.id} className={row(dm.id === activeChannelId)}
                onClick={() => void getController().openChannel(dm.id)}>
                <span data-testid={`presence-${dm.id}`} data-online={String(dm.online)}
                  className={`h-2 w-2 rounded-full ${dm.online ? 'bg-green-500' : 'bg-zinc-600'}`} />
                {dm.label}
                <UnreadBadge channelId={dm.id} />
              </button>
            ))
          )}
        </div>
        <LeasePanel />
      </nav>
      <div className="flex items-center gap-2 border-t border-zinc-800 p-3 text-xs">
        <span className="font-medium">@{me?.handle}</span>
        <button
          className="ml-auto rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
          aria-label="Settings"
          onClick={() => onOpenSettings()}
        >
          <span aria-hidden>⚙</span>
        </button>
        <button className="text-zinc-400 underline"
          onClick={() => { getController().logout(); onLogout(); }}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
