import { useMemo, useState } from 'react';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { LeasePanel } from './LeasePanel';
import { Menu } from './Menu';
import { StatusMark } from './Identity';
import { StatusPicker } from './StatusPicker';
import type { SectionId } from './settings/sections';
import type { ChannelRow } from '@murmur/shared';
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
  const { me, accounts, channels, dms, online, connected, activeChannelId, channelPrefs } = useAppStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [editTopic, setEditTopic] = useState('');
  const [editRepo, setEditRepo] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const closeCreate = (): void => {
    setCreateChannelOpen(false);
    setNewChannelName('');
    setCreateError(null);
  };

  const closeEdit = (): void => {
    setEditingChannelId(null);
    setEditTopic('');
    setEditRepo('');
    setEditError(null);
  };

  const startEdit = (channel: ChannelRow): void => {
    setEditingChannelId(channel.id);
    setEditTopic(channel.topic);
    setEditRepo(channel.repo ?? '');
    setEditError(null);
  };

  const submitEdit = async (): Promise<void> => {
    if (!editingChannelId) return;
    const original = useAppStore.getState().channels.find((c) => c.id === editingChannelId);
    const input: { topic?: string; repo?: string | null } = {};
    if (editTopic !== original?.topic) {
      input.topic = editTopic;
    }
    // repo 는 **키 부재(변경 없음)와 null(바인딩 해제)를 구분**해야 한다. 그래서 원래
    // 값과 다를 때만 키를 넣는다 — topic 만 고칠 때 repo 키가 따라가면 바인딩이 조용히
    // 끊긴다.
    //
    // 필드를 비운 것은 **해제 의사**로 읽는다. 필드가 이 채널의 바인딩을 표현하는 유일한
    // 곳이므로, 바인딩이 남아 있는데 필드가 비어 보이는 상태를 만들면 안 된다. 예전에는
    // 이 자리에 `editRepo || undefined` 가 있었는데, 그러면 키는 들어가지만 값이
    // undefined 라 JSON 에서 사라진다 — 사용자가 필드를 비우고 저장했는데 아무 일도
    // 일어나지 않고 안내도 없었다.
    if (editRepo !== (original?.repo ?? '')) {
      input.repo = editRepo === '' ? null : editRepo;
    }
    try {
      await getController().updateChannel(editingChannelId, input);
      closeEdit();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : '채널 편집에 실패했다');
    }
  };

  /**
   * Enter 와 [만들기] 가 같은 일을 한다 — 두 핸들러에 같은 절차를 각각 적으면 한쪽만 고치는
   * 사고가 난다. 이름 규칙은 `CHANNEL_NAME_PATTERN`(서버의 zod 가 쓰는 그 상수)로 미리 걸러
   * 서버 왕복 없이 안내하되, 최종 판정은 여전히 서버다.
   */
  const submitNewChannel = async (): Promise<void> => {
    if (!new RegExp(CHANNEL_NAME_PATTERN).test(newChannelName)) {
      setCreateError('이름은 영문 소문자·숫자·`-`·`_` 만 쓸 수 있다 (1~48자)');
      return;
    }
    try {
      await getController().createChannel(newChannelName);
      closeCreate();
    } catch (err) {
      // 실패를 조용히 삼키면 사용자는 눌렀는데 아무 일도 안 난 것으로 본다.
      setCreateError(err instanceof Error ? err.message : '채널 생성에 실패했다');
    }
  };

  const dmPeers = useMemo(() =>
    dms.map((dm) => {
      const peers = dm.memberIds.filter((id) => id !== me?.id);
      return {
        id: dm.id,
        label: peers.map((id) => accounts[id]?.handle ?? '…').join(', ') || 'just me',
        online: peers.some((id) => online.includes(id)),
        // 1:1 DM 에서만 상태를 그린다. 여러 사람이면 누구의 상태인지 표시가 답하지 못한다.
        peer: peers.length === 1 ? accounts[peers[0]!] : undefined,
      };
    }), [dms, accounts, me, online]);

  const others = Object.values(accounts).filter((a) => a.id !== me?.id);
  const row = (active: boolean) =>
    `flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-zinc-700 ${active ? 'bg-zinc-700' : ''}`;

  const sortedChannels = useMemo(() => {
    const withPref = channels.map((ch) => ({ channel: ch, pref: channelPrefs[ch.id] }));
    const sorted = [...withPref].sort((a, b) => {
      if (a.pref?.starredAt && !b.pref?.starredAt) return -1;
      if (!a.pref?.starredAt && b.pref?.starredAt) return 1;
      return (a.channel.name ?? '').localeCompare(b.channel.name ?? '');
    });
    return sorted.map((x) => x.channel);
  }, [channels, channelPrefs]);

  const channelRow = (ch: ChannelRow) => {
    const isEditing = editingChannelId === ch.id;
    if (isEditing) {
      return (
        <div key={ch.id} className="mt-1 rounded border border-zinc-700 bg-zinc-800 p-1">
          <div className="mb-1 text-xs text-zinc-400">#{ch.name} 편집</div>
          <input
            type="text"
            aria-label="Topic"
            className="mb-1 w-full rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-200 placeholder-zinc-500"
            placeholder="topic (선택)"
            value={editTopic}
            onChange={(e) => { setEditTopic(e.target.value); setEditError(null); }}
          />
          <div className="mb-1 flex items-center gap-1">
            <input
              type="text"
              aria-label="Repository"
              className="flex-1 rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-200 placeholder-zinc-500"
              placeholder="repo (비우면 해제)"
              value={editRepo}
              onChange={(e) => { setEditRepo(e.target.value); setEditError(null); }}
            />
          </div>
          {editError && <p role="alert" className="mb-1 text-[10px] text-red-400">{editError}</p>}
          <div className="flex gap-1">
            <button
              className="rounded bg-indigo-600 px-2 py-0.5 text-xs text-white hover:bg-indigo-500"
              onClick={() => void submitEdit()}
            >
              저장
            </button>
            <button
              className="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700"
              onClick={closeEdit}
            >
              취소
            </button>
          </div>
        </div>
      );
    }
    const ChannelButton = (
      <button key={ch.id} className={row(ch.id === activeChannelId)}
        onClick={() => void getController().openChannel(ch.id)}>
        <span className="text-zinc-500">#</span>{ch.name}
        {ch.repo && <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{ch.repo}</span>}
        <ChannelUnreadDot channelId={ch.id} name={ch.name ?? ''} />
        <UnreadBadge channelId={ch.id} />
      </button>
    );
    const pref = channelPrefs[ch.id];
    const isMuted = !!pref?.mutedAt;
    const isStarred = !!pref?.starredAt;

    const copyChannelName = async () => {
      try {
        await navigator.clipboard.writeText(ch.name ?? '');
      } catch (err) {
        console.error('채널명 복사 실패:', err);
      }
    };
    const copyChannelId = async () => {
      try {
        await navigator.clipboard.writeText(ch.id);
      } catch (err) {
        console.error('채널 ID 복사 실패:', err);
      }
    };

    const menuItems = [
      ...(me?.isAdmin ? [{ label: '채널 편집', onSelect: () => startEdit(ch) }] : []),
      { label: '채널명 복사', onSelect: copyChannelName },
      { label: '채널 ID 복사', onSelect: copyChannelId },
      { label: isMuted ? '음소거 해제' : '음소거', onSelect: () => void getController().toggleChannelMute(ch.id) },
      { label: isStarred ? '즐겨찾기 해제' : '즐겨찾기', onSelect: () => void getController().toggleChannelStar(ch.id) },
    ];
    return (
      <div key={ch.id} className="relative flex w-full items-center">
        <Menu
          renderTrigger={(props) => (
            <div
              className="flex flex-1 items-center"
              onContextMenu={(e) => { props.onContextMenu?.(e); }}
            >
              {ChannelButton}
              {/* props 를 그대로 펼친다 — ref 와 aria-haspopup/aria-expanded 가 여기
                  붙어야 한다. Menu.tsx 주석이 그 계약을 적어 뒀고, 빼먹어도 타입은
                  통과한다(초판이 그렇게 접근성 속성과 포커스 복귀를 잃었다). */}
              <button
                {...props}
                onClick={(e) => { e.stopPropagation(); props.onClick(); }}
                className="ml-auto rounded px-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
              >
                ⋯
              </button>
            </div>
          )}
          items={menuItems}
          placement="bottom"
          openOnContextMenu
        />
      </div>
    );
  };

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
          {sortedChannels.map(channelRow)}
          {me?.isAdmin && (
            createChannelOpen ? (
              <div className="mt-1 rounded border border-zinc-700 bg-zinc-800 p-1">
                <input
                  type="text"
                  aria-label="New channel name"
                  className="mb-1 w-full rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-200 placeholder-zinc-500"
                  placeholder="channel-name"
                  value={newChannelName}
                  onChange={(e) => { setNewChannelName(e.target.value); setCreateError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitNewChannel();
                    if (e.key === 'Escape') closeCreate();
                  }}
                  autoFocus
                />
                {createError && <p role="alert" className="mb-1 text-[10px] text-red-400">{createError}</p>}
                <div className="flex gap-1">
                  <button
                    className="rounded bg-indigo-600 px-2 py-0.5 text-xs text-white hover:bg-indigo-500"
                    onClick={() => void submitNewChannel()}
                  >
                    만들기
                  </button>
                  <button
                    className="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700"
                    onClick={closeCreate}
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
                {/* 연결 점과 상태 표시는 **둘 다** 남는다. 점은 소켓이 붙어 있는가(기계가
                    파생), 상태는 지금 말을 걸어도 되는가(사람이 선언)다 — 하나로 합치면
                    "연결이 끊긴 사람"과 "방해 금지인 사람"이 뭉친다(#186). */}
                <span data-testid={`presence-${dm.id}`} data-online={String(dm.online)}
                  className={`h-2 w-2 rounded-full ${dm.online ? 'bg-green-500' : 'bg-zinc-600'}`} />
                <StatusMark account={dm.peer} />
                {dm.label}
                <UnreadBadge channelId={dm.id} />
              </button>
            ))
          )}
        </div>
        <LeasePanel />
      </nav>
      <div className="relative flex items-center gap-2 border-t border-zinc-800 p-3 text-xs">
        {/* 계정 행 자체가 진입점이다 — gear 아이콘이 아니라(#113). 트리거 요소는 소비자가
            만들고 접근성 속성·ref 는 Menu 가 준다(그래야 #111 이 우클릭 트리거로 같은
            프리미티브를 쓸 수 있다). */}
        <Menu
          renderTrigger={(props) => (
            <button {...props} className="font-medium">
              @{me?.handle}
            </button>
          )}
          items={[
            { label: 'Settings', onSelect: () => onOpenSettings() },
            { label: 'Sign out', onSelect: () => { getController().logout(); onLogout(); } },
          ]}
        />
        <StatusPicker />
      </div>
    </aside>
  );
}
