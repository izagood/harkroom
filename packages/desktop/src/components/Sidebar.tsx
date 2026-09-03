import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { sidebarStorage, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } from '../lib/prefs';
import { isMacOS, MAC_TRAFFIC_LIGHT_PL } from '../lib/platform';
import { LeasePanel } from './LeasePanel';
import { Menu } from './Menu';
import { StatusMark } from './Identity';
import { StatusPicker } from './StatusPicker';
import type { SectionId } from './settings/sections';
import type { ChannelRow, NotifyLevel, ChannelPrefRow } from '@murmur/shared';
import { CHANNEL_NAME_PATTERN, NOTIFY_LEVELS, notifyLevelOf, sortChannelsBySection } from '@murmur/shared';
import { Logo } from './Logo';

/** 메뉴에 그리는 이름. 값(`all`/`mentions`/`none`)은 저장·전송용이라 번역하지 않는다. */
const NOTIFY_LEVEL_LABEL: Record<NotifyLevel, string> = {
  all: '전체',
  mentions: '멘션만',
  none: '없음',
};

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

/**
 * 멘션 배지. **`none` 인 채널에서만 뜨지 않는다**(#229, #224) — 알림을 끄면서 빨간 숫자만
 * 남기면 "껐는데 숫자가 남는다"가 되어 여전히 거짓말이다. 다만 새 대화가 있다는 사실 자체는
 * 위의 회색 점(`ChannelUnreadDot`)이 계속 말한다.
 *
 * `mentions` 에서는 배지를 **남긴다**: "덜 알리겠다"는 약속이지 "숫자도 보지 않겠다"가
 * 아니다. 그 채널에서 나를 부른 것은 여전히 알림이 오므로, 배지를 지우면 알림과 화면이
 * 서로 다른 말을 하게 된다.
 *
 * `notifyLevel` 을 스토어에서 직접 읽지 않고 prop 으로 받는다: 채널 행이 이미 pref 를 구해
 * 두고, 같은 값을 두 번 구독하면 두 곳이 갈라질 수 있다. **옵셔널이 아니라 필수 prop 이다** —
 * 기본값을 두면 새 호출자가 이 규칙을 잊어도 타입이 통과해 같은 결함이 다시 생긴다.
 */
function UnreadBadge({ channelId, notifyLevel }: { channelId: string; notifyLevel: NotifyLevel }) {
  const unread = useAppStore((s) => s.unread);
  const count = unread.filter((e) => e.channelId === channelId && !e.readAt).length;
  if (notifyLevel === 'none' || !count) return null;
  return (
    <span data-testid={`unread-${channelId}`}
      className="ml-auto rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">
      {count}
    </span>
  );
}

export function Sidebar({ onLogout, onOpenSettings, onOpenDirectory, onOpenInbox, onOpenSaved, collapsed, onToggleCollapse }: {
  onLogout: () => void;
  onOpenSettings: (section?: SectionId) => void;
  /** 워크스페이스 전체 디렉터리를 연다(#226). 채널 멤버 목록이 아니라 워크스페이스 전체다. */
  onOpenDirectory: () => void;
  onOpenInbox: () => void;
  /**
   * 담아 둔 메시지 패널을 연다(#219). **옵셔널이 아니다** — 기본값을 여기서 공급하면
   * 배선을 잊은 화면에서도 버튼이 그려지고, 눌러도 아무 일이 없는 항목이 남는다(design.md §4).
   */
  onOpenSaved: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const { me, accounts, channels, dms, online, connected, activeChannelId, channelPrefs, channelMembers, messages, savedCount } = useAppStore();
  /**
   * macOS 신호등 여백(#270). 사이드바가 펴져 있으면 브랜드 바가 창의 좌상단이라 여기가
   * 여백을 진다. 접혀 있으면 사이드바는 폭 0 이고 `Workspace` 헤더가 좌상단이 되므로
   * 여백도 그쪽으로 넘어간다 — 두 곳이 동시에 비우면 접었다 펼 때마다 78px 이 두 번 든다.
   */
  const macTrafficLightRoom = useMemo(() => isMacOS() && !collapsed, [collapsed]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelPrivate, setNewChannelPrivate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 멤버 패널. 열려 있는 채널 id 하나만 둔다 — 여러 채널의 패널이 동시에 열리면 어느
  // 목록을 보고 있는지가 화면에서 사라진다(편집 패널과 같은 규칙).
  const [membersChannelId, setMembersChannelId] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [inviteAccountId, setInviteAccountId] = useState('');
  // '마지막 멤버가 나간다'는 되돌릴 수 없는 조작이라 한 번 더 묻는다.
  const [leaveConfirmId, setLeaveConfirmId] = useState<string | null>(null);
  /**
   * 채널 삭제 확인(#155). 확인 단계를 **화면 안에** 둔다 — `window.confirm` 은 Tauri
   * 웹뷰에서 막힐 수 있고, 이 저장소의 선례(`MessageItem` 의 '정말 삭제', 바로 위
   * `leaveConfirmId`)가 이미 인라인 확인이다. 새 확인 컴포넌트를 만들지 않는다.
   *
   * 메시지 수는 **세 상태**다 — null(아직 안 읽음) / 'error'(못 읽음) / 값. 실패를 0 으로
   * 갈아 넣으면 확인 문구가 "메시지 0개를 지운다"고 거짓을 말한다. 못 읽었으면 지우지도
   * 않는다: 규모를 모르는 채로 되돌릴 수 없는 조작을 승인하게 하지 않는다.
   */
  const [deletingChannelId, setDeletingChannelId] = useState<string | null>(null);
  const [deleteCount, setDeleteCount] = useState<number | 'error' | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [editTopic, setEditTopic] = useState('');
  const [editRepo, setEditRepo] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const [width, setWidth] = useState(() => sidebarStorage.loadWidth());
  const isDragging = useRef(false);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, e.clientX));
      setWidth(newWidth);
      sidebarStorage.saveWidth(newWidth);
    };
    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleDragStart = () => {
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const newWidth = Math.max(MIN_SIDEBAR_WIDTH, width - 10);
      setWidth(newWidth);
      sidebarStorage.saveWidth(newWidth);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const newWidth = Math.min(MAX_SIDEBAR_WIDTH, width + 10);
      setWidth(newWidth);
      sidebarStorage.saveWidth(newWidth);
    }
  }, [width]);

  const closeCreate = (): void => {
    setCreateChannelOpen(false);
    setNewChannelName('');
    setNewChannelPrivate(false);
    setCreateError(null);
  };

  const closeMembers = (): void => {
    setMembersChannelId(null);
    setMemberError(null);
    setInviteAccountId('');
    setLeaveConfirmId(null);
  };

  /**
   * 멤버 패널을 연다. **조회 실패를 빈 목록으로 삼키지 않는다** — private 채널에서
   * "멤버 없음" 은 "이 채널은 아무도 볼 수 없다"는 뜻이라 거짓 사실이 나가기 경고까지
   * 지운다. 실패하면 목록을 그리지 않고 오류를 보여 준다.
   */
  const openMembers = async (channelId: string): Promise<void> => {
    setMembersChannelId(channelId);
    setMemberError(null);
    setInviteAccountId('');
    setLeaveConfirmId(null);
    try {
      await getController().loadChannelMembers(channelId);
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : '멤버 목록을 받지 못했다');
    }
  };

  const submitInvite = async (channelId: string): Promise<void> => {
    if (!inviteAccountId) return;
    try {
      await getController().inviteChannelMember(channelId, inviteAccountId);
      setInviteAccountId('');
      setMemberError(null);
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : '초대에 실패했다');
    }
  };

  /**
   * 나가기 요청. 마지막 멤버면 바로 나가지 않고 **그 사실을 알린다** — 나간 뒤에는
   * admin 만 목록에서 볼 수 있는 채널이 되고, 채널 자체는 남는다(삭제는 #155).
   */
  const requestLeave = async (channelId: string): Promise<void> => {
    if (!me) return;
    setMembersChannelId(channelId);
    setMemberError(null);
    setLeaveConfirmId(null);
    let members;
    try {
      members = await getController().loadChannelMembers(channelId);
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : '멤버 목록을 받지 못했다');
      return;
    }
    if (!members.some((m) => m.accountId === me.id)) {
      setMemberError('이 채널의 멤버가 아니다');
      return;
    }
    if (members.length === 1) {
      setLeaveConfirmId(channelId);
      return;
    }
    await confirmLeave(channelId);
  };

  const confirmLeave = async (channelId: string): Promise<void> => {
    if (!me) return;
    try {
      await getController().leaveChannel(channelId, me.id);
      closeMembers();
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : '나가기에 실패했다');
    }
  };

  const startDelete = (channelId: string): void => {
    setDeletingChannelId(channelId);
    setDeleteCount(null);
    setDeleteError(null);
    void getController().channelDeleteInfo(channelId).then(
      (info) => setDeleteCount(info.messageCount),
      (err: unknown) => {
        setDeleteCount('error');
        setDeleteError(err instanceof Error ? err.message : '메시지 수를 읽지 못했다');
      },
    );
  };

  const closeDelete = (): void => {
    setDeletingChannelId(null);
    setDeleteCount(null);
    setDeleteError(null);
  };

  const confirmDelete = async (channelId: string): Promise<void> => {
    try {
      await getController().deleteChannel(channelId);
      closeDelete();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : '삭제에 실패했다');
    }
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
      await getController().createChannel(newChannelName, newChannelPrivate ? 'private' : 'public');
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
        // 배지를 그릴 때가 아니라 목록을 만들 때 구한다 — 렌더 순서에 기대면 배지가
        // 알림 수준을 보지 못하는 자리에 놓이기 쉽다(#229 가 채널 쪽에서 그랬다).
        notifyLevel: notifyLevelOf(channelPrefs[dm.id]),
      };
    }), [dms, accounts, me, online, channelPrefs]);

  const others = Object.values(accounts).filter((a) => a.id !== me?.id);
const row = (active: boolean) =>
    `flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-zinc-700 ${active ? 'bg-zinc-700' : ''}`;

  // 섹션으로 그룹화된 채널 목록을 구한다(#157).
  // 정렬: 섹션(이름순, null 은 맨 아래) → 별표 → sortOrder → 이름.
  const groupedChannels = useMemo(() => {
    const standardChannels = channels.filter((ch) => ch.kind === 'standard' && !ch.archivedAt);
    const withPref = standardChannels.map((ch) => ({ channel: ch, pref: channelPrefs[ch.id] as ChannelPrefRow | null }));
    const sorted = sortChannelsBySection(withPref);

    // 섹션별로 그룹화한다.
    const groups: { section: string | null; channels: typeof withPref }[] = [];
    for (const item of sorted) {
      const section = item.pref?.section ?? null;
      const lastGroup = groups[groups.length - 1];
      if (lastGroup && lastGroup.section === section) {
        lastGroup.channels.push(item);
      } else {
        groups.push({ section, channels: [item] });
      }
    }
    return groups;
  }, [channels, channelPrefs]);

  const archivedChannels = useMemo(() => {
    return channels
      .filter((ch) => ch.kind === 'standard' && ch.archivedAt)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [channels]);

  const channelRow = (ch: ChannelRow) => {
    // pref 는 **배지를 그리기 전에** 구한다. 예전에는 이 계산이 배지 아래에 있어서
    // 음소거가 배지에 닿을 수조차 없었다(#229).
    const pref = channelPrefs[ch.id];
    const notifyLevel = notifyLevelOf(pref);
    const isStarred = !!pref?.starredAt;
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
    if (deletingChannelId === ch.id) {
      return (
        <div key={ch.id} data-testid={`delete-${ch.id}`} className="mt-1 rounded border border-red-700 bg-zinc-800 p-1">
          <div className="mb-1 text-xs text-zinc-400">
            {ch.visibility === 'private' ? '🔒' : '#'}{ch.name} 삭제
          </div>
          {/* 지울 규모를 보여 준다 — 삭제 뒤에는 무엇이 사라졌는지 물을 곳이 없다.
              아직 못 읽었으면 개수를 지어내지 않는다. */}
          {deleteCount === null && <p className="mb-1 text-[10px] text-zinc-500">메시지 수를 읽고 있다…</p>}
          {typeof deleteCount === 'number' && (
            <p className="mb-1 text-[10px] text-amber-400">
              이 채널과 메시지 {deleteCount}개를 영구히 지운다. 되돌릴 수 없다.
            </p>
          )}
          {deleteError && <p role="alert" className="mb-1 text-[10px] text-red-400">{deleteError}</p>}
          <div className="flex gap-1">
            {/* 개수를 모르면 확인 버튼을 만들지 않는다 — 규모를 모르는 채로 되돌릴 수 없는
                조작을 승인하게 하지 않는다. */}
            {typeof deleteCount === 'number' && (
              <button
                className="rounded bg-red-700 px-2 py-0.5 text-xs text-white hover:bg-red-600"
                onClick={() => void confirmDelete(ch.id)}
              >
                정말 삭제
              </button>
            )}
            <button
              className="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700"
              onClick={closeDelete}
            >
              취소
            </button>
          </div>
        </div>
      );
    }
    if (membersChannelId === ch.id) {
      const members = channelMembers[ch.id];
      const memberIds = new Set((members ?? []).map((m) => m.accountId));
      const invitable = Object.values(accounts).filter((a) => !memberIds.has(a.id));
      const isMember = !!me && memberIds.has(me.id);
      /**
       * 초대 가능 여부는 **서버 게이트(`assertChannelVisible`)와 같은 술어**다: public 표준
       * 채널은 누구나, private 은 그 채널의 멤버만이다. 넓게 잡으면 admin 이 자기가 없는
       * private 채널에서 초대를 눌러 403 을 받는다 — 눌러서 실패하는 항목은 "할 수 있다"는
       * 거짓 신호다(docs/design.md §4). 목록을 아직 못 받았으면 판정할 근거가 없으므로
       * 내주지 않는다.
       */
      const canInvite = members !== undefined && (ch.visibility === 'public' || isMember);
      return (
        <div key={ch.id} data-testid={`members-${ch.id}`} className="mt-1 rounded border border-zinc-700 bg-zinc-800 p-1">
          <div className="mb-1 text-xs text-zinc-400">
            {ch.visibility === 'private' ? '🔒' : '#'}{ch.name} 멤버
          </div>
          {/* public 과 private 에서 이 목록의 **뜻이 다르다**. public 채널은 멤버가 아니어도
              읽고 쓸 수 있으므로 여기 적힌 사람들은 "볼 수 있는 사람"이 아니라 구독자다 —
              그 말을 하지 않으면 목록에 없는 사람은 못 본다는 뜻으로 읽힌다. private 은
              반대로 이 목록이 곧 볼 수 있는 사람의 전부다. */}
          <p className="mb-1 text-[10px] text-zinc-500">
            {ch.visibility === 'private'
              ? '이 목록이 이 채널을 볼 수 있는 사람의 전부다.'
              : '누구나 읽고 쓸 수 있는 채널이다 — 이 목록은 구독한 사람이지, 볼 수 있는 사람의 전부가 아니다.'}
          </p>
          {memberError && <p role="alert" className="mb-1 text-[10px] text-red-400">{memberError}</p>}
          {/* 키 자체가 없으면 '아직 못 받았다'다 — 빈 목록으로 그리면 거짓 사실이 된다. */}
          {members === undefined
            ? !memberError && <p className="mb-1 text-[10px] text-zinc-500">불러오는 중…</p>
            : (
              <ul className="mb-1 space-y-0.5">
                {members.length === 0 && <li className="text-[10px] text-zinc-500">멤버가 없다</li>}
                {members.map((m) => {
                  // 디렉터리에 없는 계정은 **아무 종류도 주장하지 않는다** — 모르는 것을
                  // '사람'으로 그리면 에이전트가 사람으로 보이는 거짓 사실이 된다.
                  const account = accounts[m.accountId];
                  return (
                    <li key={m.accountId} className="flex items-center gap-1 text-xs text-zinc-300">
                      <span>@{m.handle}</span>
                      {account && (
                        <span className="rounded bg-zinc-700 px-1 text-[10px] text-zinc-300">
                          {account.kind === 'agent' ? '에이전트' : '사람'}
                        </span>
                      )}
                      {/* 채널 역할이 아니라 **계정 속성**이다 — 채널별 역할은 아직 없다(#183).
                          그래서 'admin' 이 아니라 '워크스페이스 admin' 이라고 적는다. */}
                      {account?.isAdmin && (
                        <span
                          className="rounded bg-zinc-700 px-1 text-[10px] text-amber-300"
                          title="워크스페이스 admin — 채널 역할이 아니다"
                        >
                          워크스페이스 admin
                        </span>
                      )}
                      {me?.isAdmin && m.accountId !== me?.id && (
                        <button
                          className="ml-auto rounded px-1 text-[10px] text-zinc-500 hover:bg-zinc-700 hover:text-red-400"
                          aria-label={`${m.handle} 내보내기`}
                          onClick={() => void getController().leaveChannel(ch.id, m.accountId)
                            .catch((err: unknown) => setMemberError(err instanceof Error ? err.message : '내보내기에 실패했다'))}
                        >
                          내보내기
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          {leaveConfirmId === ch.id && (
            <p role="alert" className="mb-1 text-[10px] text-amber-400">
              나가면 아무도 이 채널을 볼 수 없다 — 마지막 멤버다. 채널은 지워지지 않는다.
            </p>
          )}
          {canInvite && (
            <div className="mb-1 flex items-center gap-1">
              <select
                aria-label="초대할 계정"
                className="flex-1 rounded bg-zinc-900 px-1 py-0.5 text-xs text-zinc-200"
                value={inviteAccountId}
                onChange={(e) => setInviteAccountId(e.target.value)}
              >
                <option value="">계정 선택…</option>
                {invitable.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
              </select>
              <button
                className="rounded bg-indigo-600 px-2 py-0.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-40"
                disabled={!inviteAccountId}
                onClick={() => void submitInvite(ch.id)}
              >
                초대
              </button>
            </div>
          )}
          <div className="flex gap-1">
            {/* 멤버가 아니면 나갈 것이 없다. public 채널에서 비멤버의 '나가기'는 서버가
                200 으로 받아 주지만 아무 일도 일어나지 않는다 — 그런 항목은 만들지 않는다. */}
            {isMember && (
              <button
                className="rounded px-2 py-0.5 text-xs text-red-400 hover:bg-zinc-700"
                onClick={() => void (leaveConfirmId === ch.id ? confirmLeave(ch.id) : requestLeave(ch.id))}
              >
                {leaveConfirmId === ch.id ? '정말 나가기' : '나가기'}
              </button>
            )}
            <button
              className="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700"
              onClick={closeMembers}
            >
              닫기
            </button>
          </div>
        </div>
      );
    }
    const ChannelButton = (
      <button key={ch.id} className={row(ch.id === activeChannelId)}
        onClick={() => void getController().openChannel(ch.id)}>
        {/* private 채널은 '#' 대신 자물쇠다. 여기 이 표시가 없으면 사용자는 자기가 쓰는
            글이 전원에게 가는지 멤버에게만 가는지 화면 어디에서도 알 수 없다. */}
        {ch.visibility === 'private'
          ? <span className="text-zinc-500" aria-label="비공개 채널" title="비공개 채널">🔒</span>
          : <span className="text-zinc-500">#</span>}
        {ch.name}
        {ch.repo && <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{ch.repo}</span>}
        <ChannelUnreadDot channelId={ch.id} name={ch.name ?? ''} />
        <UnreadBadge channelId={ch.id} notifyLevel={notifyLevel} />
      </button>
    );
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

    const isArchived = !!ch.archivedAt;
    // 마지막 메시지 seq. **로드된 메시지에서만 알 수 있다** — 서버는 채널별 최대 seq 를 주지
    // 않는다. 0 이면 보낼 것이 없으므로 항목을 아예 만들지 않는다: 눌러도 아무 일이 없는
    // 항목은 "할 수 있다"는 거짓 신호다(docs/design.md §4).
    const lastSeq = Math.max(0, ...(messages[ch.id] ?? []).map((m) => m.seq));
    // 목록을 아직 못 받았으면 undefined 다 — 그때는 '모른다'이지 '아니다'가 아니다.
    const knownMembers = channelMembers[ch.id];
    const knownMember = knownMembers === undefined || (!!me && knownMembers.some((m) => m.accountId === me.id));
    const menuItems = [
      ...(lastSeq > 0 ? [{
        // 마지막 메시지부터 미읽음 — 결과는 미읽음 1, 즉 "이 채널 다시 보라"는 표시다.
        // 특정 메시지를 골라 그 지점부터 미읽음으로 만드는 것은 #179 다.
        label: '미읽음으로 표시',
        onSelect: () => void getController().markChannelUnread(ch.id, lastSeq),
      }] : []),
      ...(me?.isAdmin ? [{ label: '채널 편집', onSelect: () => startEdit(ch) }] : []),
      ...(me?.isAdmin ? [isArchived
        ? { label: '보관 해제', onSelect: () => void getController().archiveChannel(ch.id, false) }
        : { label: '보관', onSelect: () => void getController().archiveChannel(ch.id, true) }]
      : []),
      /**
       * 삭제(#155). **보관된 채널에만** 만든다 — 서버가 보관되지 않은 채널의 삭제를 409 로
       * 거절하므로, 눌러도 거절되는 항목을 남겨 두면 "할 수 있다"는 거짓 신호가 된다
       * (docs/design.md 4절). DM 은 이 목록(`sortedChannels`)에 없어 애초에 닿지 않는다.
       */
      ...(me?.isAdmin && isArchived
        ? [{ label: '삭제', onSelect: () => startDelete(ch.id) }] : []),
      { label: '멤버 보기', onSelect: () => void openMembers(ch.id) },
      // 초대와 나가기는 **그 채널의 멤버**여야 하는 동작이다(public 채널의 초대는 예외 —
      // 서버 게이트가 누구나 통과시킨다). 메뉴는 목록을 받기 전에도 그려지므로 아직
      // 모르는 것을 '아니다'로 단정하지 않는다: 목록을 받아 아닌 것이 확인된 때만 뺀다.
      ...(ch.visibility === 'public' || knownMember
        ? [{ label: '초대', onSelect: () => void openMembers(ch.id) }] : []),
      ...(knownMember ? [{ label: '나가기', onSelect: () => void requestLeave(ch.id) }] : []),
      { label: '채널명 복사', onSelect: copyChannelName },
      { label: '채널 ID 복사', onSelect: copyChannelId },
      // 음소거 토글 하나가 아니라 세 수준을 나란히 둔다(#224). 켬/끔 스위치와 수준을 같이
      // 두면 "음소거 껐는데 왜 아직 조용하지"가 생긴다 — 여기가 유일한 조작 자리다.
      ...NOTIFY_LEVELS.map((level) => ({
        label: `${notifyLevel === level ? '✓ ' : ''}알림: ${NOTIFY_LEVEL_LABEL[level]}`,
        onSelect: () => void getController().setChannelNotifyLevel(ch.id, level),
      })),
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

  // 접히면 **내용을 아예 그리지 않는다.** 폭만 0 으로 두면 안쪽 컨테이너의
  // `min-w-[180px]` 가 그대로 남아 0 폭 상자 밖으로 넘쳐 본문을 덮고(플렉스 아이템은
  // 기본으로 클리핑하지 않는다), DOM 에 남은 버튼들이 탭 순서에도 그대로 걸려
  // **화면에서 사라진 것을 키보드로 밟게 된다.**
  //
  // jsdom 에는 레이아웃 엔진이 없어 `style.width === '0px'` 만 확인하는 테스트는 이
  // 결함을 통과시킨다 — 그래서 "내용이 그려지지 않는다" 로 확인한다.
  //
  // 펴는 길은 사이드바 밖에 있다: `Workspace` 헤더의 "사이드바 펼치기" 버튼.
  if (collapsed) {
    return (
      <aside
        className="overflow-hidden bg-zinc-900"
        style={{ width: 0 }}
        aria-hidden="true"
      />
    );
  }

  return (
    <aside
      className="relative flex flex-col bg-zinc-900 text-zinc-200"
      style={{ width: collapsed ? 0 : width }}
    >
      {/* 드래그 핸들: 사이드바 우측 가장자리에 위치 */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="사이드바 너비 조절"
          tabIndex={0}
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-indigo-500 focus:bg-indigo-500"
          onMouseDown={handleDragStart}
          onKeyDown={handleKeyDown}
        />
      )}
      <div className="flex min-w-[180px] flex-1 flex-col overflow-hidden">
        {/* 브랜드 바 = 사이드바가 펴져 있을 때 **창의 좌상단**이다(#270). macOS 신호등이
            `titleBarStyle: "Overlay"` 로 콘텐츠 위에 뜨므로 여백을 비우는 자리도, 창을 끄는
            손잡이가 되는 자리도 여기다.

            `data-tauri-drag-region` 은 그 속성이 있는 요소 **자체**를 눌렀을 때만 드래그를
            시작한다 — 접기 버튼을 누르면 이벤트 대상이 버튼이라 창은 움직이지 않는다. 로고는
            `<svg>` 라 그 자체가 대상이 되므로 손잡이를 따로 씌운다(제목 텍스트는 요소가 아닌
            텍스트 노드여서 이 div 가 그대로 대상이 된다). */}
        <div
          data-testid="sidebar-brand"
          data-tauri-drag-region
          className={`flex items-center gap-2 border-b border-zinc-800 py-3 pr-3 font-bold ${
            macTrafficLightRoom ? MAC_TRAFFIC_LIGHT_PL : 'pl-3'
          }`}
        >
          <span data-tauri-drag-region className="flex items-center">
            <Logo size={16} decorative />
          </span>
          murmur
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
            title={connected ? 'connected' : 'disconnected'} />
          <button
            onClick={onToggleCollapse}
            className="ml-auto rounded p-1 hover:bg-zinc-700"
            aria-label="사이드바 접기"
            title="사이드바 접기"
          >
            ←
          </button>
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
                {/* 공개 범위는 **만들 때** 고른다. 만든 뒤 admin 이 바꿀 수 있지만, private
                    으로 시작해야 할 채널을 public 으로 만들면 그 사이에 오간 말은 이미
                    전원이 봤다 — 나중에 닫아도 되돌릴 수 없다. */}
                <label className="mb-1 flex items-center gap-1 text-[11px] text-zinc-400">
                  <input
                    type="checkbox"
                    checked={newChannelPrivate}
                    onChange={(e) => setNewChannelPrivate(e.target.checked)}
                  />
                  비공개 (멤버만 볼 수 있다)
                </label>
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
        {archivedChannels.length > 0 && (
          <div>
            <button
              className="flex w-full items-center gap-1 px-2 pb-1 text-[11px] uppercase tracking-wide text-zinc-500 hover:text-zinc-400"
              onClick={() => setArchivedOpen((v) => !v)}
            >
              <span>{archivedOpen ? '▼' : '▶'}</span>
              Archived ({archivedChannels.length})
            </button>
            {archivedOpen && archivedChannels.map(channelRow)}
          </div>
        )}
        <div>
          {/* 디렉터리는 조회 전용이라 admin 여부를 보지 않는다 — 누가 이 워크스페이스에
              있는지는 모두가 알아야 한다. 계정 관리는 아래 설정 진입점의 몫이다. */}
          {/* 인박스도 디렉터리와 **같은 방식으로** 연다(#185) — 사이드바 항목이 뷰를
              열고, 뷰는 닫혀 있으면 아무것도 그리지 않는다. 화면마다 여는 방식이 다르면
              세 번째 화면을 만들 때 어느 쪽을 따를지 알 수 없다. */}
          <button className={`${row(false)} text-zinc-400`} onClick={onOpenInbox}>
            Inbox
          </button>
          {/* #219: 담아 둔 메시지. 배지의 숫자는 **open 개수**다 — 완료로 옮긴 것까지 세면
              다 처리한 뒤에도 숫자가 남아 할 일이 있다고 거짓을 말한다. */}
          <button className={`${row(false)} text-zinc-400`} onClick={onOpenSaved}>
            Saved
            {savedCount > 0 && (
              <span
                aria-label={`담아 둔 메시지 ${savedCount}개`}
                className="ml-auto rounded-full bg-indigo-600 px-1.5 text-[10px] font-bold text-white"
              >
                {savedCount}
              </span>
            )}
          </button>
          <button className={`${row(false)} text-zinc-400`} onClick={onOpenDirectory}>
            Directory
          </button>
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
                <UnreadBadge channelId={dm.id} notifyLevel={dm.notifyLevel} />
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
      </div>
    </aside>
  );
}
