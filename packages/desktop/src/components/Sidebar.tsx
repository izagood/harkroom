import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { sidebarStorage, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } from '../lib/prefs';
// `isMacOS`·`MAC_TRAFFIC_LIGHT_PL` 이 여기 있었다 — 신호등 여백은 이제 레일이 진다(아래 주석).
import { TOP_BAR_BG, TOP_BAR_H } from '../lib/platform';
import { LeasePanel } from './LeasePanel';
import { Menu } from './Menu';
// `StatusPicker` 가 여기 있었다 — 계정 행과 함께 `Rail.tsx` 로 갔다.
// `Identity` 가 **돌아왔다**: 합쳐진 DM 목록의 상태를 아바타가 말한다(`dmRow` 주석).
// `StatusMark` 도 남는다 — presence 와 다른 사실이라 아바타가 대신할 수 없다.
import { Identity, StatusMark } from './Identity';
import type { RailPanel } from './Rail';
// 찾기가 맨 위로 갔다(#488 A · 찾기가 맨 위로). 별도 파일인 이유: 이 줄은 **칸과 무관**한
// 공용 껍데기에 사는 유일한 목록이라, 칸별 묶음을 그리는 이 파일의 본문과 섞을 것이 없다.
import { SidebarFind } from './SidebarFind';
// `RunnerStatusDot` 이 **앱에서 완전히 사라졌다**(`docs/desktop-rail.html` 3단계).
// 2단계에서 DM 줄에서 빠지고 에이전트 칸에만 남아 있었는데, 3단계가 그 칸을 얼굴 그리드로
// 바꾸면서 **마지막 호출자**가 없어졌다 — 그래서 컴포넌트 자체도 지웠다(`RunnerStatus.tsx`).
// 이제 사이드바에서 러너 상태를 말하는 것은 **아바타 하나**다(`faceState`): B1 이 없애려던
// "같은 사실이 화면마다 네 가지로 그려진다"가 사이드바 안에서는 이것으로 끝난다.
// `runnerStatusLabel` 은 DM 줄이 쓴다 — 아바타에 실은 상태를 접근 이름으로도 내야 한다.
import { runnerReason, runnerStatusLabel } from './RunnerStatus';
import { AgentGrid } from './settings/AgentGrid';
import { AgentTurns } from './AgentTurns';
import { useAgentTurns } from '../lib/agentTurns';
// 띄울 권한 판정은 `lib/` 하나가 낸다 — 설정 › 에이전트가 같은 판정을 쓴다.
import { canRelaunchAgent } from '../lib/relaunchGate';
// 설정 문의 판정도 한 벌이다(`lib/agentConfigGate.ts`) — 프로필·본문 멘션이 같은 함수를
// 쓴다. 세 곳이 같은 문을 여는데 술어가 세 벌이면 한쪽만 고친 날 문이 어긋난다.
import { canSeeAgentConfig } from '../lib/agentConfigGate';
import { faceState, isFaceGreyed, type FaceState } from '../lib/faceState';
import { anyPresenceView, PRESENCE_LABEL, type PresenceView } from '../lib/presenceView';
import type { SectionId } from './settings/sections';
import type {
  AccountView, AddTeamToChannelResult, AgentTeamRow, ChannelPrefRow, ChannelRow, NotifyLevel,
} from '@murmur/shared';
import { CHANNEL_NAME_PATTERN, NOTIFY_LEVELS, PROJECTION_UNCONFIGURED_NOTICE, notifyLevelOf, sortChannelsBySection } from '@murmur/shared';
import { Logo } from './Logo';
import { SidebarToggleIcon } from './SidebarToggleIcon';
// 화면은 `useT`, `lib/` 성격의 판정(`memberErrorText`)은 `Translate` 를 인자로 받는다 —
// 그 갈림의 근거는 `i18n/index.ts::Translate` 머리말에 있다.
import { useT } from '../i18n/useT';
import type { MessageKey, Translate } from '../i18n';

/**
 * 메뉴에 그리는 이름. 값(`all`/`mentions`/`none`)은 저장·전송용이라 번역하지 않는다.
 *
 * **표가 값 → 키로 바뀌었다.** 예전에는 이 상수가 문구를 들고 있었는데, 그러면 언어를
 * 바꿔도 이 표는 안 바뀐다 — 모듈이 로드될 때 한 번 굳는 값이라 `useT` 가 닿지 않는다.
 * 키만 들고 있으면 그리는 자리에서 `t()` 를 지나므로 언어를 따라온다.
 *
 * **`NotifyLevel` 로 색인된 채로 둔다**(문자열 배열이 아니라): 네 번째 수준이 생기면
 * 여기서 컴파일이 막힌다 — `shared` 가 값을 늘렸는데 화면이 이름을 안 지은 상태로
 * 조용히 통과하지 않는다.
 */
const NOTIFY_LEVEL_KEY: Record<NotifyLevel, MessageKey> = {
  all: 'sidebar.notify.all',
  mentions: 'sidebar.notify.mentions',
  none: 'sidebar.notify.none',
};

/**
 * 채널 미읽음 표시. **멘션 배지와 다른 신호다** — 멘션은 "당신을 불렀다"(빨간 숫자),
 * 이것은 "새 대화가 있다"(작은 점). 여기에 숫자를 붙이면 두 뜻이 섞여 빨간 배지가 의미를
 * 잃는다. 수치는 aria-label 로만 노출한다(스크린리더·테스트가 읽을 수 있게).
 *
 * **오른쪽으로 미는 마진은 이 컴포넌트가 갖지 않는다.** 점과 배지가 각자 `ml-auto` 를
 * 들고 있으면 flex 가 남은 여백을 두 auto 마진에 **똑같이 나눠** 주어, 둘 다 뜨는 줄에서
 * 점이 이름 옆도 배지 옆도 아닌 한가운데에 뜬다. 미는 일은 호출부의 상태 묶음(`ml-auto`
 * 한 번)이 맡고, 여기서는 자기 모양만 그린다.
 */
function ChannelUnreadDot({ channelId, name }: { channelId: string; name: string }) {
  const unread = useActiveStore((s) => s.reads[channelId]?.unread ?? 0);
  const t = useT();
  if (!unread) return null;
  return (
    <span
      aria-label={t('sidebar.channel.unread', { count: unread, name })}
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg-subtle"
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
  const unread = useActiveStore((s) => s.unread);
  const count = unread.filter((e) => e.channelId === channelId && !e.readAt).length;
  if (notifyLevel === 'none' || !count) return null;
  return (
    <span data-testid={`unread-${channelId}`}
      className="shrink-0 rounded-full bg-danger px-1.5 text-meta font-bold text-fg-on-strong">
      {count}
    </span>
  );
}

/**
 * 멤버 패널의 실패 문구(#344). 서버의 사유는 영문이고 이 패널은 그것을 그대로 띄우고 있었다 —
 * 화면에 영어 한 줄이 뜨면 사람은 그것을 오류 코드로 읽는다.
 *
 * 바꿔 적는 것은 **보관 사유 하나뿐**이다. 나머지는 서버 문구를 그대로 남긴다: 여기서 목록을
 * 만들어 두면 서버가 새 사유를 늘릴 때마다 화면이 조용히 원문으로 되돌아가는 자리가 생긴다.
 *
 * 이 문구가 실제로 뜨는 자리는 **멤버 추가와 내보내기**다. 나가기 경로는 `isSelf` 예외(#344)
 * 이후 보관 게이트를 통과하므로 이 사유를 받지 못한다 — 그래도 같은 함수를 통과시키는 이유는
 * 세 자리가 같은 `memberError` 한 칸에 쓰기 때문이다. 그래서 문구도 "나갈 수 없다"가 아니라
 * 남는 두 조작에 참인 것으로 적는다.
 *
 * **번역기를 인자로 받는다**(i18n 구조 판단 (b) — `i18n/index.ts::Translate` 머리말).
 * 이것은 판정이다: 서버 사유 하나를 알아보고 나머지는 그대로 흘린다. 그 판정을 화면 안에
 * 두면 세 호출자가 각자 같은 `if` 를 적게 되고, 서버가 문구를 바꾸는 날 한 곳만 고쳐진다.
 *
 * `fallback` 은 **키가 아니라 이미 번역된 문자열**을 받는다. 자리마다 다른 말이고
 * (초대 · 내보내기 · 나가기), 호출부가 `t()` 를 이미 손에 들고 있어 여기서 다시
 * 키를 풀 이유가 없다.
 */
const memberErrorText = (err: unknown, fallback: string, t: Translate): string => {
  const msg = err instanceof Error ? err.message : fallback;
  return msg === 'archived channels are read-only'
    ? t('sidebar.members.readOnlyArchived')
    : msg;
};

export function Sidebar({
  panel, onOpenDirectory, onOpenChannelDirectory, onOpenInbox, onOpenAgentConfig, onOpenProfile,
  collapsed, onToggleCollapse,
}: {
  /**
   * 레일이 고른 칸(정본 문서 `docs/desktop-rail.html` 1단계). 이 패널은 **그 칸의 묶음만**
   * 그린다 — 문서의 해법이 "레일에서 고른 하나만 넓은 패널이 보여준다"이고, 그래야 각
   * 목록이 세로를 다 쓴다.
   *
   * **옵셔널이 아니다.** 기본값(`'home'`)을 여기서 공급하면 레일을 배선하지 않은 화면도
   * 타입을 통과하면서 DM·에이전트 목록이 **어디에서도 닿지 않는** 상태가 된다 — 이 저장소가
   * 콜백 prop 에 기본값을 두지 않는 이유와 같다(design.md §4).
   */
  panel: RailPanel;
  /*
   * `onLogout`·`onOpenSettings` 가 여기 있었다. **레일로 갔다** — 그 둘을 쓰던 것은 맨 아래
   * 계정 메뉴 하나뿐이고, 문서가 그 메뉴를 레일 맨 아래로 옮기라고 적었다("여기서 달라지는
   * 것은 자리뿐이다"). `⌘,` 배선도 그 메뉴와 같은 컴포넌트에 있어야 하므로 함께 갔다:
   * 메뉴에 적힌 단축키가 참이어야 한다는 규칙(#488 A1)이 그것을 요구한다.
   */
  /** 워크스페이스 전체 디렉터리를 연다(#226). 채널 멤버 목록이 아니라 워크스페이스 전체다. */
  onOpenDirectory: () => void;
  /**
   * 채널 디렉터리 모달을 연다(#180). **옵셔널이 아니다** — 여기서 기본값을 공급하면
   * 배선을 잊은 화면에서도 버튼이 그려지고 눌러도 아무 일이 없다(design.md §4).
   *
   * **부르는 자리가 바뀌었다**(#488 A · 찾기가 맨 위로): `Channels` 라벨 옆 10px 돋보기가
   * 아니라 맨 위 찾기 줄의 "모든 채널에서 찾기" 다. prop 은 그대로 남는다 — 디렉터리가
   * 하는 일(보관 채널 · 생성순 · 아직 안 들어간 채널)은 찾기 줄이 못 한다.
   */
  onOpenChannelDirectory: () => void;
  onOpenInbox: () => void;
  /**
   * 에이전트 칸에서 카드를 누르면 **그 에이전트의 설정**이 열린다(`onPick` 주석에 근거).
   *
   * `onOpenSettings(section, targetId)` 를 그대로 받지 않고 **에이전트 하나로 좁힌** 이유:
   * 이 컴포넌트가 설정에 대해 아는 것은 "에이전트 상세를 연다" 하나뿐이고, 그 위의 주석이
   * 적어 둔 것처럼 일반 설정 진입점은 레일의 일이다(#488 A1). 넓은 신호를 다시 들이면
   * 사이드바에 설정 진입점을 두지 말라는 그 결정이 타입 쪽에서 조용히 풀린다.
   *
   * **옵셔널이 아니다** — 배선을 잊은 화면에서 카드가 눌러도 아무 일이 없게 두지 않는다
   * (design.md §4).
   */
  onOpenAgentConfig: (agentId: string) => void;
  /**
   * 설정을 볼 수 없는 사람이 카드를 눌렀을 때 여는 곳(`onPick` 주석에 근거). 위
   * `onOpenDirectory`(누구를 지목하지 않는 검색 목록)와 **다른 화면**이다 — 디렉터리는
   * "누가 있나", 프로필은 "이 사람이 무엇인가"에 답한다(`Workspace.handleOpenDirectory` 주석).
   */
  onOpenProfile: (accountId: string) => void;
  /*
   * `onOpenSaved` 가 여기 있었다. **레일의 북마크 칸으로 갔다** — 문서: "북마크는 레일에만
   * 둔다. 자기 칸이 있는데 홈에도 한 줄을 세우면 같은 것으로 가는 길이 둘이 되고, 그때부터
   * 사람은 어느 쪽이 맞는지 매번 고른다."
   */
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const { me, accounts, channels, dms, online, connected, activeChannelId, channelPrefs, channelMembers, channelAutoMentions, messages, runnerStates, projectionStatus } = useActiveStore();
  const t = useT();
  /*
   * macOS 신호등 여백(#270)이 여기 있었다. **더 이상 이 바가 창의 좌상단이 아니다** —
   * 레일이 항상 왼쪽에 서므로 좌상단은 레일이고, 여백은 레일이 진다(`Rail.tsx` 의
   * `macTrafficLightRoom`, `CommunityRail` 이 이미 쓰던 방법과 같다).
   *
   * 여백을 여기에 남겨 두면 **78px 이 두 번 든다** — #270 이 접힘 여부로 판정을 갈랐던
   * 이유가 정확히 그것이고, 이제 그 판정의 답이 늘 "레일"이 되었을 뿐이다.
   */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelPrivate, setNewChannelPrivate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 멤버 패널. 열려 있는 채널 id 하나만 둔다 — 여러 채널의 패널이 동시에 열리면 어느
  // 목록을 보고 있는지가 화면에서 사라진다(편집 패널과 같은 규칙).
  const [membersChannelId, setMembersChannelId] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  // 자동 멘션 절(#173)의 실패. 멤버 목록 실패와 자리를 나눈다 — 한 문장에 두 사고를 섞으면
  // 사용자는 어느 쪽을 다시 시도해야 하는지 모른다.
  const [autoMentionError, setAutoMentionError] = useState<string | null>(null);
  const [inviteAccountId, setInviteAccountId] = useState('');
  const [teams, setTeams] = useState<AgentTeamRow[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [teamAddResult, setTeamAddResult] = useState<AddTeamToChannelResult | null>(null);
  // 팀 쪽 실패는 멤버 목록 실패와 **다른 자리**에 적는다 — 한 칸을 나눠 쓰면 어느 쪽이
  // 실패했는지가 화면에서 사라진다.
  const [teamError, setTeamError] = useState<string | null>(null);
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
  // 숨긴 채널 묶음(#376)도 접혀 있는 채로 시작한다 — 치운 것이 열린 채로 보이면 치운 뜻이 없다.
  const [hiddenOpen, setHiddenOpen] = useState(false);

  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [editTopic, setEditTopic] = useState('');
  const [editRepo, setEditRepo] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  /*
   * `⌘,` 배선이 여기 있었다(#488 A1). **레일로 갔다** — 그 단축키를 가르치는 메뉴가
   * 레일 맨 아래로 옮겨졌고, 여는 자리와 배선이 갈라지면 메뉴에 적힌 글자가 언제
   * 거짓이 되는지 아무도 모른다.
   */

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
      // #372: 드래그 도중 언마운트되면 mouseup 을 받을 리스너가 사라져
      // body 의 cursor·userSelect 가 영구히 남는다. 여기서 되돌린다.
      if (isDragging.current) handleMouseUp();
    };
  }, []);

  // #372: preventDefault 와 userSelect 는 서로 다른 것을 막는다 — 둘 다 필요하다.
  // preventDefault 는 mousedown 의 기본 동작인 "선택 시작"을 막고(이미 시작된 선택은
  // userSelect 로도 취소되지 않는다), userSelect: none 은 드래그가 진행되는 동안
  // 다른 경로로 새 선택이 생기는 것을 막는다.
  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
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
    setTeams([]);
    setSelectedTeamId('');
    setTeamAddResult(null);
    setTeamError(null);
  };

  /**
   * 멤버 패널을 연다. **조회 실패를 빈 목록으로 삼키지 않는다** — private 채널에서
   * "멤버 없음" 은 "이 채널은 아무도 볼 수 없다"는 뜻이라 거짓 사실이 나가기 경고까지
   * 지운다. 실패하면 목록을 그리지 않고 오류를 보여 준다.
   */
  const openMembers = async (channelId: string): Promise<void> => {
    setMembersChannelId(channelId);
    setAutoMentionError(null);
    // 자동 멘션 목록(#173)은 멤버 목록과 **별개로** 받는다 — 한쪽 실패가 다른 쪽을 가리면 안 된다.
    void getController().loadChannelAutoMentions(channelId)
      .catch((err: unknown) => setAutoMentionError(err instanceof Error ? err.message : t('sidebar.members.autoMentionListFailed')));
    setMemberError(null);
    setInviteAccountId('');
    setLeaveConfirmId(null);
    setTeams([]);
    setSelectedTeamId('');
    setTeamAddResult(null);
    setTeamError(null);
    try {
      await getController().loadChannelMembers(channelId);
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : t('sidebar.members.listFailed'));
      return;
    }
    /**
     * 팀 목록(#172)은 **따로** 받는다. 한 try 에 묶으면 팀 조회가 실패했을 때 화면이
     * "멤버 목록을 받지 못했다"고 말한다 — 멤버 목록은 방금 받았는데 거짓을 말하는 것이다.
     * 팀 목록이 없으면 "팀으로 추가" 자리만 안 뜨면 되고, 그 사실을 따로 알린다.
     *
     * private 채널에서만 부른다: public 채널에는 멤버십이 없어(#156) 서버가 400 으로
     * 거절한다 — 뜻이 없는 조작의 진입점을 만들지 않는다.
     */
    const channel = channels.find((c) => c.id === channelId);
    if (channel?.visibility === 'private') {
      try {
        setTeams(await getController().listTeams());
      } catch {
        setTeamError(t('sidebar.members.teamListFailed'));
      }
    }
  };

  const submitTeamAdd = async (channelId: string): Promise<void> => {
    if (!selectedTeamId) return;
    setTeamAddResult(null);
    setTeamError(null);
    try {
      const result = await getController().addTeamToChannel(channelId, selectedTeamId);
      setTeamAddResult(result);
      setSelectedTeamId('');
      // 넣은 결과가 멤버 목록에 보여야 한다 — 결과 문구만 갱신하면 바로 아래 목록이
      // 방금 들어온 에이전트를 빼고 그린다.
      await getController().loadChannelMembers(channelId);
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : t('sidebar.members.teamAddFailed'));
    }
  };

  const submitInvite = async (channelId: string): Promise<void> => {
    if (!inviteAccountId) return;
    try {
      await getController().inviteChannelMember(channelId, inviteAccountId);
      setInviteAccountId('');
      setMemberError(null);
    } catch (err) {
      setMemberError(memberErrorText(err, t('sidebar.members.inviteFailed'), t));
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
      setMemberError(err instanceof Error ? err.message : t('sidebar.members.listFailed'));
      return;
    }
    if (!members.some((m) => m.accountId === me.id)) {
      setMemberError(t('sidebar.members.notAMember'));
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
      setMemberError(memberErrorText(err, t('sidebar.members.leaveFailed'), t));
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
        setDeleteError(err instanceof Error ? err.message : t('sidebar.delete.countFailed'));
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
      setDeleteError(err instanceof Error ? err.message : t('sidebar.delete.failed'));
    }
  };

  /**
   * 자동 멘션을 켜고 끈다(#173). admin 만 부를 수 있다 — 화면도 admin 에게만 토글을 내준다.
   * 실패는 그 절 안에 보여 준다: 서버가 400(에이전트 아님·비활성)이나 403 을 줄 수 있고,
   * 그 사유가 조용히 사라지면 사용자는 체크박스가 고장 났다고 여긴다.
   */
  const toggleAutoMention = async (channelId: string, agentAccountId: string, on: boolean): Promise<void> => {
    setAutoMentionError(null);
    try {
      if (on) await getController().setChannelAutoMention(channelId, agentAccountId);
      else await getController().unsetChannelAutoMention(channelId, agentAccountId);
    } catch (err) {
      setAutoMentionError(err instanceof Error ? err.message : t('sidebar.members.autoMentionFailed'));
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
    const original = useActiveStore.getState().channels.find((c) => c.id === editingChannelId);
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
      setEditError(err instanceof Error ? err.message : t('sidebar.edit.failed'));
    }
  };

  /**
   * Enter 와 [만들기] 가 같은 일을 한다 — 두 핸들러에 같은 절차를 각각 적으면 한쪽만 고치는
   * 사고가 난다. 이름 규칙은 `CHANNEL_NAME_PATTERN`(서버의 zod 가 쓰는 그 상수)로 미리 걸러
   * 서버 왕복 없이 안내하되, 최종 판정은 여전히 서버다.
   */
  const submitNewChannel = async (): Promise<void> => {
    if (!new RegExp(CHANNEL_NAME_PATTERN).test(newChannelName)) {
      setCreateError(t('sidebar.channel.createInvalidName'));
      return;
    }
    try {
      await getController().createChannel(newChannelName, newChannelPrivate ? 'private' : 'public');
      closeCreate();
    } catch (err) {
      // 실패를 조용히 삼키면 사용자는 눌렀는데 아무 일도 안 난 것으로 본다.
      setCreateError(err instanceof Error ? err.message : t('sidebar.channel.createFailed'));
    }
  };

  /**
   * DM 한 목록 — **사람과 에이전트를 안 가르고 최근순으로 섞는다**(정본 문서
   * `docs/desktop-rail.html` 2단계).
   *
   * 문서: *"DM 은 사람과 에이전트를 안 가른다. 한 목록에 최근순으로 섞이고 줄 모양이 같다 —
   * 목록만 봐서는 누가 에이전트인지 알 수 없다."* 여기서 하는 일은 그 **최근순**이다.
   * 줄 모양은 아래 `dmRow` 하나가 진다.
   *
   * ## 정렬 근거는 `lastMessageAt` 이고, 화면이 그것을 실시간으로 고친다
   *
   * 서버가 이미 `lastMessageAt desc` 로 준다(`routes/directoryRoutes.ts`). 그런데 그
   * 응답은 **부트스트랩과 `startDm` 때만 온다**(`controller.ts`) — 그 사이에 들어오는
   * `message.created` 는 `dms` 를 갱신하지 않는다. 서버 순서만 믿으면 지금 대화 중인 DM 이
   * 목록에서 안 올라오고, 그것이 이 화면의 존재 이유를 정면으로 부순다.
   *
   * 그래서 **서버가 준 시각과 스토어에 실제로 들어온 마지막 메시지 시각 중 더 늦은 것**을
   * 쓴다. 스토어 쪽만 보면 안 되는 이유: `messages[channelId]` 는 열어 본 채널과 소켓으로
   * 받은 채널에만 있고, 한 번도 안 열어 본 DM 은 비어 있다 — 그것만 보면 오래된 DM 전부가
   * '기록 없음'으로 같은 자리에 뭉친다. 두 사실 중 늦은 쪽이 곧 '내가 아는 가장 최근'이다.
   *
   * `deleted_at`(서버) 과 `removeMessage`(화면) 가 각각 지운 것을 빼므로, 지운 말로 DM 이
   * 위로 올라오는 일은 두 경로 모두에서 막힌다.
   *
   * ## 말이 없는 DM(`null`)은 맨 아래다 — **위가 아니다**
   *
   * `null` 은 '모른다'가 아니라 여기서는 **'대화한 적 없다'** 는 확정된 사실이다(서버가
   * 세어 봤고 0이었다). 최근순 목록에서 대화가 없는 것이 있는 것보다 최근일 수는 없다.
   *
   * 그 대신 **갓 만든 DM 은 실제로 위에 선다** — `startDm` 이 `openChannel` 로 이어져
   * 그 DM 이 활성이 되기 때문이다. 자리가 아니라 활성 표시가 그것을 말한다.
   *
   * 시각이 같을 때는 `id` 로 가른다. 안 그러면 `sort` 가 같은 값들의 순서를 보장하지 않아
   * 렌더마다 줄이 서로 자리를 바꾼다.
   */
  const dmPeers = useMemo(() =>
    dms.map((dm) => {
      const peers = dm.memberIds.filter((id) => id !== me?.id);
      // 스토어에 들어와 있는 마지막 메시지. `upsertMessages` 가 `seq` 오름차순으로
      // 정렬해 두므로 마지막 원소가 곧 가장 최근이다 — 여기서 다시 훑지 않는다.
      const loaded = messages[dm.id];
      const liveAt = loaded?.length ? loaded[loaded.length - 1]!.createdAt : null;
      return {
        id: dm.id,
        label: peers.map((id) => accounts[id]?.handle ?? '…').join(', ') || 'just me',
        // 둘 중 **늦은 것**. 문자열 비교로 충분하다 — 둘 다 서버가 낸 ISO 8601 UTC 라
        // 사전순이 곧 시간순이다(`Date` 로 감싸면 파싱 비용만 늘고 결과는 같다).
        lastAt: dm.lastMessageAt && liveAt
          ? (liveAt > dm.lastMessageAt ? liveAt : dm.lastMessageAt)
          : (liveAt ?? dm.lastMessageAt),
        // `#443`: `some()` 하나로 갈리던 자리다. 소켓이 끊기면 `online` 은 마지막으로 들은
        // 낡은 배열이라 `some` 이 그 위에서 `true` 를 내고 초록이 남았다 — 실측(2026-09-06)
        // 에서 서버가 죽었는데 에이전트 여섯이 전부 초록이었던 자리가 여기다.
        presence: anyPresenceView(peers, online, connected),
        // 1:1 DM 에서만 상태를 그린다. 여러 사람이면 누구의 상태인지 표시가 답하지 못한다.
        peer: peers.length === 1 ? accounts[peers[0]!] : undefined,
        // #250: 이 앱이 띄운 러너의 상태. 1:1 에이전트 DM 에서만 뜻이 있다 — 사람에게는
        // 러너가 없고, 여러 사람이면 누구의 러너인지 표시가 답하지 못한다.
        agentId: peers.length === 1 && accounts[peers[0]!]?.kind === 'agent' ? peers[0]! : undefined,
        // 배지를 그릴 때가 아니라 목록을 만들 때 구한다 — 렌더 순서에 기대면 배지가
        // 알림 수준을 보지 못하는 자리에 놓이기 쉽다(#229 가 채널 쪽에서 그랬다).
        notifyLevel: notifyLevelOf(channelPrefs[dm.id]),
      };
    }).sort((a, b) => {
      if (a.lastAt !== b.lastAt) {
        // 말이 없는 쪽(`null`)이 맨 아래. 위 주석의 이유다.
        if (!a.lastAt) return 1;
        if (!b.lastAt) return -1;
        return a.lastAt < b.lastAt ? 1 : -1;
      }
      return a.id.localeCompare(b.id);
    }), [dms, accounts, me, online, connected, channelPrefs, messages]);

  const others = Object.values(accounts).filter((a) => a.id !== me?.id);

  /**
   * 에이전트 칸이 세우는 얼굴들(`docs/desktop-rail.html` 3단계). **`useMemo` 인 이유**:
   * `AgentGrid` 가 이 배열을 의존성으로 두고 가나다 정렬과 검색 필터를 기억한다
   * (`useMemo([agents, query])`). 렌더마다 새 배열을 넘기면 그 기억이 매번 버려져
   * 40개 격자에서 정렬이 렌더마다 다시 돈다 — 컴포넌트를 재사용하면서 그 안의 최적화를
   * 호출부가 무효화하는 모양이다.
   *
   * **`dmAgentIds` 로 걸러내지 않는다** — 그것이 3단계가 없애는 비대칭이다(아래 주석).
   */
  const panelAgents = useMemo(
    () => Object.values(accounts).filter((a) => a.kind === 'agent'),
    [accounts],
  );

  /*
    지금 도는 턴(Agents 관제 1단계). **이 칸을 보고 있을 때만 묻는다** — 사이드바는 항상
    떠 있고 다른 칸에서 이 요청을 계속 내면 아무도 보지 않는 값을 위해 왕복이 붙는다.
    훅은 조건부로 부를 수 없으므로(리액트 규칙) 조건은 인자로 넘긴다.
  */
  const agentTurns = useAgentTurns(panel === 'agents');

  // "새 섹션…" 을 고른 채널과 입력 중인 이름(#157). `prompt()` 대신 인라인 입력이다.
  const [sectionEditFor, setSectionEditFor] = useState<string | null>(null);
  const [sectionDraft, setSectionDraft] = useState('');
  // 섹션 이름 바꾸기(#323) 를 위한 입력 상태.
  const [sectionRenameFor, setSectionRenameFor] = useState<string | null>(null);
  const [sectionRenameDraft, setSectionRenameDraft] = useState('');

  const row = (active: boolean) =>
    `flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-surface-raised ${active ? 'bg-surface-raised' : ''}`;

  /**
   * 목록에 하나 더하는 `+`(#488 A2). **네 자리가 같은 모양·같은 자리를 쓴다** — 여기 둘
   * (`채널`·`DM`), 설정 › 에이전트의 `+` 카드(`AgentGrid.tsx`), 그리고 그 카드가 여는 폼.
   *
   * 문서의 진단: "`+` 가 다섯 모양". 실측으로도 셋이 서로 달랐다 — 채널은 목록 **끝**의
   * 본문 행, DM 은 섹션 **머리**의 작은 버튼, 에이전트는 nav 한복판의 본문 행이었다.
   *
   * 규칙은 `AgentGrid` 가 이미 세워 둔 것을 그대로 쓴다: **목록의 첫 칸**이다. 끝에 두면
   * 항목이 늘어날수록 자리가 밀려 매번 찾아가야 하고, 검색·필터로 목록이 비면 사라진다.
   * 첫 칸이면 개수와 무관하게 자리가 고정된다.
   *
   * `+` 는 `aria-hidden` 이다 — 접근성 이름은 `label` 이 진다. 스크린리더가 "플러스 새
   * 채널"로 읽으면 글리프가 이름의 일부가 되어 버린다.
   */
  const addRow = (label: string, onClick: () => void, testId: string) => (
    <button data-testid={testId} className={`${row(false)} text-fg-muted`} onClick={onClick}>
      <span aria-hidden="true" className="text-fg-subtle">+</span>
      {label}
    </button>
  );

  /**
   * 이 채널을 내가 치웠는가(#376). **판정이 이 함수 하나다** — 채널 묶음 셋(보이는 것·보관·
   * 숨김)이 같은 답을 봐야 한 채널이 두 묶음에 동시에 나타나거나 어디에도 없어지지 않는다.
   */
  const isHidden = (channelId: string) => !!channelPrefs[channelId]?.hiddenAt;

  /**
   * 즐겨찾기 묶음(정본 문서 「즐겨찾기가 채널 위에 선다」).
   *
   * 문서의 진단을 코드로 확인했다(2026-09-07): 별표는 **없던 것이 아니라 안 보이던 것**이다.
   * `toggleChannelStar` 와 `pref.starredAt` 은 이미 있고, `sortChannelsBySection` 이 별표를
   * "섹션 안에서 먼저"로 정렬한다(#152). 그래서 별표를 켠 채널이 **자기 섹션 안에서만**
   * 위로 가고, 섹션이 여럿이면 즐겨찾기가 목록 곳곳에 흩어진다 — 문서가 요구한 "자주 보는
   * 것이 늘 같은 자리에 고정된다"가 성립하지 않는다. 이 묶음이 그것을 고친다.
   *
   * **비어 있으면 묶음 자체를 그리지 않는다**(문서). 빈 머리글은 "여기 뭔가 있다"는 거짓
   * 신호다. 정렬은 아래 목록과 같은 함수를 통과시킨다 — 두 곳에서 다르게 정렬하면 별표를
   * 켜고 끌 때마다 채널이 예상 못 한 자리로 튄다.
   */
  const starredChannels = useMemo(() => {
    const withPref = channels
      .filter((ch) => ch.kind === 'standard' && !ch.archivedAt && !isHidden(ch.id) && !!channelPrefs[ch.id]?.starredAt)
      .map((ch) => ({ channel: ch, pref: channelPrefs[ch.id] as ChannelPrefRow | null }));
    return sortChannelsBySection(withPref);
  }, [channels, channelPrefs]);

  // 섹션으로 그룹화된 채널 목록을 구한다(#157).
  // 정렬: 섹션(이름순, null 은 맨 아래) → 별표 → sortOrder → 이름.
  const groupedChannels = useMemo(() => {
    const standardChannels = channels.filter(
      // 별표를 켠 것은 **위 묶음에만** 선다 — 두 묶음에 동시에 나타나면 같은 채널이 두 줄이
      // 되고, 어느 줄의 배지가 최신인지 화면이 답하지 못한다(숨김 묶음과 같은 규칙).
      (ch) => ch.kind === 'standard' && !ch.archivedAt && !isHidden(ch.id) && !channelPrefs[ch.id]?.starredAt,
    );
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

  /** 내가 이미 쓴 섹션 이름들(#157). 메뉴가 이것을 항목으로 세운다. */
  const knownSections = useMemo(() => {
    const names = new Set<string>();
    for (const p of Object.values(channelPrefs)) {
      if (p?.section) names.add(p.section);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [channelPrefs]);

  /**
   * "위로/아래로" 메뉴 항목(#157).
   *
   * 같은 섹션 안에서 **이웃과 자리를 바꾼다.** 맨 위/맨 아래에서는 항목을 아예 만들지
   * 않는다 — 눌러도 아무 일이 없는 항목은 "할 수 있다"는 거짓 신호다(docs/design.md §4).
   * 섹션이 없는 채널(맨 아래 묶음)도 순서를 매길 수 있다: 그 묶음도 한 화면의 한 줄이다.
   */
  const sectionMoveItems = (ch: ChannelRow) => {
    const group = groupedChannels.find((g) => g.channels.some((i) => i.channel.id === ch.id));
    if (!group || group.channels.length < 2) return [];
    const idx = group.channels.findIndex((i) => i.channel.id === ch.id);
    const ids = group.channels.map((i) => i.channel.id);
    const swapTo = (target: number) => {
      const next = [...ids];
      const [moved] = next.splice(idx, 1);
      next.splice(target, 0, moved!);
      void getController().reorderChannels(next);
    };
    return [
      ...(idx > 0 ? [{ label: t('sidebar.menu.moveUp'), onSelect: () => swapTo(idx - 1) }] : []),
      ...(idx < ids.length - 1 ? [{ label: t('sidebar.menu.moveDown'), onSelect: () => swapTo(idx + 1) }] : []),
    ];
  };

  const archivedChannels = useMemo(() => {
    return channels
      .filter((ch) => ch.kind === 'standard' && ch.archivedAt && !isHidden(ch.id))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [channels, channelPrefs]);

  /**
   * 내가 치운 채널들(#376). **보관 여부를 보지 않는다** — 보관은 채널 전체의 상태이고 숨김은
   * 내 상태라 독립이다(둘을 곱해 네 칸을 만들면 보관된 채널을 숨겼을 때 어느 묶음에 넣을지
   * 답이 없다). 숨긴 것은 위 두 묶음에서 빠지고 **여기 하나로만** 모인다.
   *
   * 목록을 아예 감추지 않고 접힌 묶음으로 두는 이유: 되돌리는 길이 화면에 있어야 숨김이
   * 나가기와 다른 것이 된다(스스로 되돌린다). 감춰 두면 "치웠는데 어디로 갔나"가 된다.
   */
  const hiddenChannels = useMemo(() => {
    return channels
      .filter((ch) => ch.kind === 'standard' && isHidden(ch.id))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [channels, channelPrefs]);

  /**
   * DM 한 줄 — **사람이든 에이전트든 같은 모양이다**(정본 문서 `docs/desktop-rail.html`
   * 2단계: *"한 목록에 최근순으로 섞이고 줄 모양이 같다 — 목록만 봐서는 누가 에이전트인지
   * 알 수 없다"*).
   *
   * ## 세 표시가 하나로 줄었다 — 그것이 이 작업의 요점이다
   *
   * 합치기 전 이 줄에는 상태 표시가 **셋**이었고 그중 하나는 에이전트에만 붙었다:
   *
   * | 표시 | 무엇을 말했나 | 누구에게 붙었나 |
   * |---|---|---|
   * | presence 점 | 소켓이 붙어 있나 | 모두 |
   * | `StatusMark` | 사람이 선언한 상태 | 사람만 (`kind !== 'human'` 이면 `null`) |
   * | `RunnerStatusDot` | 이 앱이 띄운 러너의 상태 | **에이전트만** |
   *
   * 즉 **줄만 봐도 누가 에이전트인지 알 수 있었다** — 네모난 점이 하나 더 붙은 줄이 곧
   * 에이전트였다. 두 묶음을 합쳐 놓고 이 표시를 그대로 두면 목록이 갈려 있던 때와
   * 똑같이 읽히고, 문서가 고치려던 것이 하나도 안 고쳐진다.
   *
   * 그래서 문서가 정한 대로 **상태를 아바타 하나에 싣는다**(2단계: *"상태 표현은 아바타
   * 규칙을 그대로 쓴다(「나머지 여덟 곳」 B1)"*). 표시는 아바타 **한 칸**이고, 그 칸의
   * 겉모습은 사람과 에이전트가 같다 — `Identity variant="avatar"` 가 이미 둘을 같은
   * `h-5 w-5 rounded-full` 로 그린다(그 컴포넌트 주석: *"대화에서는 '이건 에이전트다'라고
   * 말하지 않는다"*, design doc 2 · #455). 같은 규율이 목록까지 온 것이다.
   *
   * ## 판정을 복제하지 않는다 — `faceState` 를 부른다
   *
   * 세 얼굴 규칙(정상/멈춤/실패, 그리고 `#443` 이 더한 '모른다')은 `lib/faceState.ts` 에
   * 있고 설정 › 에이전트의 격자가 쓰는 그 함수다. 여기서 `runnerStates` 를 다시 훑어
   * 색을 고르면 같은 러너가 두 화면에서 다른 얼굴이 된다 — `#476` 이 그 모양이었다.
   *
   * 회색조 필터도 격자와 **같은 클래스**를 쓴다(`grayscale brightness-[1.7]
   * contrast-[0.55]`). 격자 주석이 그 숫자의 이유를 적어 뒀다: `grayscale` 만으로는
   * 어두운 색이 거의 검정이 되어 중간 회색과 달라진다.
   *
   * ## 사람에게는 presence 가 그 자리를 쓴다
   *
   * 사람에게는 러너가 없다. 그렇다고 사람의 아바타를 늘 또렷하게 두면 **표시가 에이전트에만
   * 있는 상태로 되돌아간다** — 위 표의 세 번째 줄과 같은 결함이다. 그래서 같은 칸에서
   * 사람은 `presenceView` 로 갈린다: 붙어 있으면 또렷, 없으면 흐릿, **모르면**
   * (`connected === false`) 흐릿하되 그 이유를 `title` 이 말한다.
   *
   * 두 판정이 같은 값 집합(`ok`/`stopped`/`unknown`)으로 만나는 것은 우연이 아니라 같은
   * 규약이다 — 이 저장소는 생존을 모르는 것을 '없다'로 쓰지 않는다(`threadState`·
   * `waitChain`·`faceState`·`presenceView` 가 전부 그렇게 한다).
   *
   * ## 실패 사유는 여전히 글자로 남는다
   *
   * `#368` 이 세운 것이다: *"사유가 title 툴팁에만 있으면 사람은 그것을 찾지 못한다."*
   * 격자도 실패에만 글자를 붙인다(*"예외에만 글자를 쓴다"*). 그 규칙을 그대로 쓴다 —
   * 실패한 줄만 두 번째 줄을 얻고, 나머지는 한 줄이다. **줄 모양이 같아야 한다는 것과
   * 어긋나지 않는다**: 이것은 종류(사람/에이전트)가 아니라 **예외 상태**가 얻는 글자이고,
   * 실패는 어차피 드물다.
   */
  const dmRow = (dm: {
    id: string; label: string; presence: PresenceView; peer: AccountView | undefined;
    agentId: string | undefined; notifyLevel: NotifyLevel;
  }) => {
    // 이 줄의 아바타가 무엇을 말할 것인가. **에이전트면 `faceState`, 사람이면
    // `presenceView`** — 값 집합이 겹치므로 아래 그리는 코드는 하나다.
    //
    // 에이전트 쪽에 presence 를 섞지 않는 이유: `faceState` 가 이미 `online` 과
    // `connected` 를 그 안에서 본다(그 함수 주석의 "daemon 이 아는 것이 먼저다"). 여기서
    // 한 번 더 곱하면 daemon 이 확인한 러너를 소켓 상태로 덮어써 `#430` 이 되돌아온다.
    const face: FaceState = dm.agentId
      ? faceState(dm.agentId, runnerStates, online, connected)
      : (dm.presence === 'online' ? 'ok' : dm.presence === 'offline' ? 'stopped' : 'unknown');
    const runner = dm.agentId ? runnerStates[dm.agentId] : undefined;
    // 어떤 상태가 사유를 글자로 받는지는 `runnerReason` 하나가 정한다 — 이 표를 여기서
    // 다시 적으면 상태가 하나 늘 때 이 줄만 조용히 낡는다(`#476` 이 그 모양이었다).
    // `needs_reissue` 가 빠지는 이유도 그 함수 주석에 있다.
    const reason = runnerReason(runner);
    // 색은 스크린리더에 아무 말도 하지 않는다(`#443`). 아바타 한 칸에 상태를 실었으므로
    // 그 칸이 글자로도 같은 말을 해야 한다 — 러너가 있으면 그쪽 문구가 더 구체적이다.
    //
    // **둘 다 이제 사전을 지난다.** 앞 판본의 이 주석은 두 값이 *"아직 한국어"* 라고
    // 적었는데, 그 둘이 모듈 상수로 굳어 있던 것이 이 줄에서 언어가 갈리는 원인이었다
    // (`sidebar.runner.state` 라는 **틀**만 영어가 되고 그 안의 라벨은 한국어로 남았다).
    // 각각 함수와 키 표로 바뀌었고(`RunnerStatus.tsx`·`lib/presenceView.ts` 의 주석에
    // 어느 쪽을 왜 골랐는지 있다), 이 자리는 여전히 **감싸는 틀**만 진다.
    const stateLabel = runner
      ? t('sidebar.runner.state', { label: runnerStatusLabel(runner, t) })
      : t(PRESENCE_LABEL[dm.presence]);
    return (
      <button key={dm.id} className={`${row(dm.id === activeChannelId)} ${reason ? 'flex-col items-start' : ''}`}
        onClick={() => void getController().openChannel(dm.id)}>
        <span className="flex min-w-0 items-center gap-1.5">
          {/*
            **상태를 말하는 칸은 이것 하나다.** `data-face` 로 시험이 판정을 읽는다 —
            격자의 카드가 같은 속성을 쓰므로(`agent-card-*`) 두 화면을 같은 이름으로
            검사할 수 있고, 한쪽만 고치면 시험이 갈린다.
          */}
          <span
            data-testid={`dm-face-${dm.id}`}
            data-face={face}
            title={stateLabel}
            className={`shrink-0 ${face === 'failed' ? 'rounded-full ring-2 ring-state-stuck' : ''}`}
          >
            {/* 회색조 숫자는 격자에서 그대로 가져온 것이다 — 이유는 그쪽 주석에 있다. */}
            {/*
              **`aria-hidden` 이다** — `#365` 가 세운 규율이다. `Identity` 는 접근 이름으로
              `sr-only` 핸들을 낸다. 그것이 옳은 자리(거터·참여자 띠)에서는 이름이 옆에
              없지만, 이 줄에서는 **바로 오른쪽에 같은 핸들이 글자로 서 있다** — 그대로
              두면 스크린리더가 "bot bot" 을 읽는다. `#365` 가 메시지 한 줄에서 고친 것이
              정확히 이 중복이다.
              **상태는 사라지지 않는다**: 바깥 `span` 의 `title`(`stateLabel`)이 그 말을
              하고, 그것은 색이 못 하는 일이라 반드시 글자로 남아야 한다(`#443`).
            */}
            <span aria-hidden="true" className={isFaceGreyed(face)
              ? 'block grayscale brightness-[1.7] contrast-[0.55] opacity-90'
              : 'block'}
            >
              {/*
                `peer` 가 없는 자리(그룹 DM · 나 혼자인 DM)에도 `Identity` 를 세운다 —
                `account` 가 `undefined` 면 그것이 "모른다"를 그리는 `?` 원이고(그 컴포넌트
                주석), 칸을 아예 비우면 줄마다 왼쪽 정렬이 어긋난다.
              */}
              <Identity account={dm.peer} className="h-5 w-5" variant="avatar" />
            </span>
            {/*
              **`title` 만으로는 부족하다.** 위 `span` 이 `aria-hidden` 이라 그 안의 접근
              이름이 사라졌고, `title` 은 마우스를 올려 본 사람에게만 닿는다 — `#368` 이
              사이드바에서 겪은 그 결함이다(*"사유가 사람이 안 보는 곳에만 있다"*).
              그래서 같은 말을 `sr-only` 로도 낸다. 색은 스크린리더에 아무 말도 하지
              않는다는 것이 `#443` 의 요지다.
            */}
            <span className="sr-only">{stateLabel}</span>
          </span>
          {/* 사람이 선언한 상태는 **남는다** — presence 와 다른 사실이다(#186): 앞은 기계가
              파생한 "붙어 있나"이고 이것은 사람이 고른 "지금 말을 걸어도 되나"다. 아바타에
              실은 것은 앞쪽뿐이라 이 표시를 지우면 사람이 적어 둔 말이 사라진다. */}
          <StatusMark account={dm.peer} />
          <span className="truncate">{dm.label}</span>
          {/* 채널 행과 **같은 묶음**이다(위 주석) — DM 에는 미읽음 점이 없어 안이 하나뿐이지만,
              미는 마진의 자리를 두 곳이 다르게 두면 다음에 무언가를 더할 때 또 갈린다. */}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <UnreadBadge channelId={dm.id} notifyLevel={dm.notifyLevel} />
          </span>
        </span>
        {reason && (
          <span data-testid={`runner-reason-${dm.agentId}`}
            className={`whitespace-normal text-left text-meta ${
              runner?.status === 'needs_harness' || runner?.status === 'needs_login' ? 'text-warning' : 'text-danger'}`}>
            {runner?.status === 'needs_harness' || runner?.status === 'needs_login'
              ? reason
              : t('sidebar.runner.launchFailed', { reason })}
          </span>
        )}
      </button>
    );
  };

  const channelRow = (ch: ChannelRow) => {
    // pref 는 **배지를 그리기 전에** 구한다. 예전에는 이 계산이 배지 아래에 있어서
    // 음소거가 배지에 닿을 수조차 없었다(#229).
    const pref = channelPrefs[ch.id];
    const notifyLevel = notifyLevelOf(pref);
    const isStarred = !!pref?.starredAt;
    const isEditing = editingChannelId === ch.id;
    if (isEditing) {
      return (
        <div key={ch.id} className="mt-1 rounded border border-border bg-surface-raised p-1">
          {/*
            **사이드바의 단은 아랫단 11px 이다** — 이 파일이 이미 그렇게 서 있었다: 오류·
            안내·멤버 이름·구획 라벨·미읽음 개수가 전부 11px 이고, 그것은 10px 27곳을
            11px 로 올린 앞 작업이 만든 상태다. 그래서 남아 있던 12px(`text-xs`) 24곳을
            **색으로 가르지 않고 자리로** 11px 에 붙였다: 이 열은 좁고, 한 열 안에 두 단이
            서면 눌러야 할 버튼과 읽어야 할 줄이 눈에서 뒤섞인다.

            **입력칸만 예외로 본문단 13px** 이다 — 14px(`text-sm`) 4곳과 12px 1곳으로
            갈려 있던 것을 하나로 맞췄고, 크기를 안 적어 앱 기본값을 물려받는다. 방금 친
            글자를 다시 읽는 자리다. `SidebarFind.tsx` 에 그 근거를 적어 뒀다.
          */}
          <div className="mb-1 text-meta text-fg-muted">{t('sidebar.edit.title', { name: `#${ch.name}` })}</div>
          <input
            type="text"
            aria-label="Topic"
            className="mb-1 w-full rounded border border-border bg-field px-2 py-1 text-fg placeholder-fg-subtle"
            placeholder={t('sidebar.edit.topicPlaceholder')}
            value={editTopic}
            onChange={(e) => { setEditTopic(e.target.value); setEditError(null); }}
          />
          <div className="mb-1 flex items-center gap-1">
            <input
              type="text"
              aria-label="Repository"
              className="flex-1 rounded border border-border bg-field px-2 py-1 text-fg placeholder-fg-subtle"
              placeholder={t('sidebar.edit.repoPlaceholder')}
              value={editRepo}
              onChange={(e) => { setEditRepo(e.target.value); setEditError(null); }}
            />
          </div>
          {editError && <p role="alert" className="mb-1 text-meta text-danger">{editError}</p>}
          {/*
            repo 를 채워도 아무도 읽지 않는다는 사실을 폼 안에서 말한다(#381). 배지가 뜨는
            것만으로는 바인딩이 살아 있다고 읽히는데, 투영이 꺼져 있으면 `projection.ts`
            말고는 이 값을 읽는 곳이 없다. 문구는 `LeasePanel` 배너와 **같은 상수**다 —
            사본을 만들면 둘이 갈라진다.
          */}
          {editRepo && projectionStatus?.state === 'unconfigured' && (
            <p className="mb-1 text-meta text-warning">{PROJECTION_UNCONFIGURED_NOTICE}</p>
          )}
          <div className="flex gap-1">
            <button
              className="rounded bg-accent px-2 py-0.5 text-meta text-fg-on-strong hover:bg-accent-hover"
              onClick={() => void submitEdit()}
            >
              {t('sidebar.edit.save')}
            </button>
            <button
              className="rounded px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-hover"
              onClick={closeEdit}
            >
              {t('sidebar.edit.cancel')}
            </button>
          </div>
        </div>
      );
    }
    if (deletingChannelId === ch.id) {
      return (
        <div key={ch.id} data-testid={`delete-${ch.id}`} className="mt-1 rounded border border-danger bg-surface-raised p-1">
          <div className="mb-1 text-meta text-fg-muted">
            {t('sidebar.delete.title', { name: `${ch.visibility === 'private' ? '🔒' : '#'}${ch.name}` })}
          </div>
          {/* 지울 규모를 보여 준다 — 삭제 뒤에는 무엇이 사라졌는지 물을 곳이 없다.
              아직 못 읽었으면 개수를 지어내지 않는다. */}
          {deleteCount === null && <p className="mb-1 text-meta text-fg-subtle">{t('sidebar.delete.counting')}</p>}
          {typeof deleteCount === 'number' && (
            <p className="mb-1 text-meta text-warning">
              {t('sidebar.delete.scope', { count: deleteCount })}
            </p>
          )}
          {deleteError && <p role="alert" className="mb-1 text-meta text-danger">{deleteError}</p>}
          <div className="flex gap-1">
            {/* 개수를 모르면 확인 버튼을 만들지 않는다 — 규모를 모르는 채로 되돌릴 수 없는
                조작을 승인하게 하지 않는다. */}
            {typeof deleteCount === 'number' && (
              <button
                className="rounded bg-danger px-2 py-0.5 text-meta text-fg-on-strong hover:bg-danger-hover"
                onClick={() => void confirmDelete(ch.id)}
              >
                {t('sidebar.delete.confirm')}
              </button>
            )}
            <button
              className="rounded px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-hover"
              onClick={closeDelete}
            >
              {t('sidebar.delete.cancel')}
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
        <div key={ch.id} data-testid={`members-${ch.id}`} className="mt-1 rounded border border-border bg-surface-raised p-1">
          <div className="mb-1 text-meta text-fg-muted">
            {t('sidebar.members.title', { name: `${ch.visibility === 'private' ? '🔒' : '#'}${ch.name}` })}
          </div>
          {/* public 과 private 에서 이 목록의 **뜻이 다르다**. public 채널은 멤버가 아니어도
              읽고 쓸 수 있으므로 여기 적힌 사람들은 "볼 수 있는 사람"이 아니라 구독자다 —
              그 말을 하지 않으면 목록에 없는 사람은 못 본다는 뜻으로 읽힌다. private 은
              반대로 이 목록이 곧 볼 수 있는 사람의 전부다. */}
          <p className="mb-1 text-meta text-fg-subtle">
            {ch.visibility === 'private'
              ? t('sidebar.members.scopePrivate')
              : t('sidebar.members.scopePublic')}
          </p>
          {memberError && <p role="alert" className="mb-1 text-meta text-danger">{memberError}</p>}
          {/* 키 자체가 없으면 '아직 못 받았다'다 — 빈 목록으로 그리면 거짓 사실이 된다. */}
          {members === undefined
            ? !memberError && <p className="mb-1 text-meta text-fg-subtle">{t('sidebar.members.loading')}</p>
            : (
              <ul className="mb-1 space-y-0.5">
                {members.length === 0 && <li className="text-meta text-fg-subtle">{t('sidebar.members.empty')}</li>}
                {members.map((m) => {
                  // 디렉터리에 없는 계정은 **아무 종류도 주장하지 않는다** — 모르는 것을
                  // '사람'으로 그리면 에이전트가 사람으로 보이는 거짓 사실이 된다.
                  const account = accounts[m.accountId];
                  return (
                    <li key={m.accountId} className="flex items-center gap-1 text-meta text-fg-muted">
                      <span>@{m.handle}</span>
                      {account && (
                        <span className="rounded bg-surface-raised px-1 text-meta text-fg">
                          {account.kind === 'agent' ? t('sidebar.members.kindAgent') : t('sidebar.members.kindHuman')}
                        </span>
                      )}
                      {/* 채널 역할이 아니라 **계정 속성**이다 — 채널별 역할은 아직 없다(#183).
                          그래서 'admin' 이 아니라 '워크스페이스 admin' 이라고 적는다. */}
                      {account?.isAdmin && (
                        <span
                          className="rounded bg-surface-raised px-1 text-meta text-warning"
                          title={t('sidebar.members.adminBadgeTitle')}
                        >
                          {t('sidebar.members.adminBadge')}
                        </span>
                      )}
                      {me?.isAdmin && m.accountId !== me?.id && (
                        <button
                          className="ml-auto rounded px-1 text-meta text-fg-subtle hover:bg-surface-hover hover:text-danger"
                          aria-label={t('sidebar.members.removeAction', { handle: m.handle })}
                          onClick={() => void getController().leaveChannel(ch.id, m.accountId)
                            .catch((err: unknown) => setMemberError(memberErrorText(err, t('sidebar.members.removeFailed'), t)))}
                        >
                          {t('sidebar.members.remove')}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          {/* 자동 멘션(#173). 채널 설정 화면이 따로 없어 채널의 관리 표면인 이 패널에 둔다 —
              admin 전용 편집 폼에 두면 admin 이 아닌 사람은 "이 채널이 누구를 자동으로 부르나"를
              어디에서도 볼 수 없다. admin 은 토글, 나머지는 읽기 전용이다: 서버가 403 을 줄
              조작을 화면이 내주면 "할 수 있다"는 거짓 신호다(docs/design.md §4). */}
          {(() => {
            const autoRows = channelAutoMentions[ch.id];
            const onIds = new Set((autoRows ?? []).map((r) => r.agentAccountId));
            // admin 은 켤 수 있는 에이전트 전부(비활성은 이미 켜져 있을 때만 — 끄는 길은 있어야
            // 한다)를, 나머지는 켜진 것만 본다. 서버가 비활성 에이전트의 추가를 400 으로
            // 막으므로, 그 토글을 내주면 눌러서 실패하는 항목이 된다.
            const agents = Object.values(accounts)
              .filter((a) => a.kind === 'agent' && (me?.isAdmin ? (!a.disabled || onIds.has(a.id)) : onIds.has(a.id)))
              .sort((a, b) => a.handle.localeCompare(b.handle));
            return (
              <div data-testid={`auto-mentions-${ch.id}`} className="mb-1 border-t border-border pt-1">
                <div className="mb-0.5 text-meta text-fg-muted">{t('sidebar.members.autoMentionHeading')}</div>
                <p className="mb-1 text-meta text-fg-subtle">
                  {/*
                    **두 문장이 따로 있다.** 뒤엣것은 admin 이 아닌 사람에게만 붙는 조건절이고,
                    한 키로 합치면 두 경우가 각각 한 문장씩 필요해져 사전 항목이 둘로 늘어난다
                    (그리고 앞 문장이 두 곳에 복제된다). 이어 붙이는 것은 화면의 일이다 —
                    `WaitChainSection` 이 `·` 를 화면에 남긴 것과 같은 규칙이다.
                  */}
                  {t('sidebar.members.autoMentionNote')}
                  {!me?.isAdmin && t('sidebar.members.autoMentionNoteReadOnly')}
                </p>
                {autoMentionError && <p role="alert" className="mb-1 text-meta text-danger">{autoMentionError}</p>}
                {/* 키가 없으면 '아직 못 받았다' — 빈 목록으로 그리면 "아무도 안 부른다"는 거짓 사실이 된다. */}
                {autoRows === undefined
                  ? !autoMentionError && <p className="mb-1 text-meta text-fg-subtle">{t('sidebar.members.loading')}</p>
                  : (
                    <ul className="mb-1 space-y-0.5">
                      {agents.length === 0 && (
                        <li className="text-meta text-fg-subtle">
                          {me?.isAdmin
                            ? t('sidebar.members.autoMentionEmptyAdmin')
                            : t('sidebar.members.autoMentionEmptyReader')}
                        </li>
                      )}
                      {agents.map((a) => (
                        <li key={a.id} className="flex items-center gap-1 text-meta text-fg-muted">
                          {me?.isAdmin ? (
                            <label className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                aria-label={t('sidebar.members.autoMentionCheckbox', { handle: a.handle })}
                                checked={onIds.has(a.id)}
                                onChange={(e) => void toggleAutoMention(ch.id, a.id, e.target.checked)}
                              />
                              <span>@{a.handle}</span>
                            </label>
                          ) : (
                            <span>@{a.handle}</span>
                          )}
                          {/* 배지는 **켜진 행에만** 붙는다. admin 목록에는 꺼진 에이전트도 서므로
                              무조건 붙이면 체크가 비어 있는 줄에 '자동' 이라고 적힌다 — 화면이
                              체크박스와 반대되는 말을 한다. */}
                          {onIds.has(a.id) && (
                            <span className="rounded bg-accent-surface px-1 text-meta text-accent">{t('sidebar.members.autoMentionBadge')}</span>
                          )}
                          {a.disabled && <span className="rounded bg-surface-hover px-1 text-meta text-fg-muted">{t('sidebar.members.agentDisabled')}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
              </div>
            );
          })()}
          {leaveConfirmId === ch.id && (
            <p role="alert" className="mb-1 text-meta text-warning">
              {t('sidebar.members.lastMemberWarning')}
            </p>
          )}
          {canInvite && (
            <div className="mb-1 flex items-center gap-1">
              <select
                aria-label={t('sidebar.members.inviteSelect')}
                className="flex-1 rounded border border-border bg-field px-1 py-0.5 text-fg"
                value={inviteAccountId}
                onChange={(e) => setInviteAccountId(e.target.value)}
              >
                <option value="">{t('sidebar.members.invitePick')}</option>
                {invitable.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
              </select>
              <button
                className="rounded bg-accent px-2 py-0.5 text-meta text-fg-on-strong hover:bg-accent-hover disabled:opacity-40"
                disabled={!inviteAccountId}
                onClick={() => void submitInvite(ch.id)}
              >
                {t('sidebar.members.invite')}
              </button>
            </div>
          )}
          {/*
            팀 추가(#172): **private 채널에서만.** public 채널에는 멤버십이 없어(#156)
            서버가 400 으로 거절하므로 뜻이 없는 진입점을 만들지 않는다.

            admin 게이트를 걸지 **않는다**: 서버의 게이트는 `#156` 의 초대와 같은
            `assertChannelVisible` 이라 그 채널의 멤버면 누구나 넣을 수 있다. 화면만
            admin 으로 좁히면 할 수 있는 조작이 화면에서 사라진다 — 그것도 화면이
            서버와 다른 말을 하는 것이다.

            팀이 하나도 없으면 고를 것이 없으니 자리도 없다. 다만 목록을 **못 받은**
            것은 다른 사실이라 `teamError` 로 따로 말한다.
          */}
          {ch.visibility === 'private' && teamError && (
            <p role="alert" className="mb-1 text-meta text-warning">{teamError}</p>
          )}
          {ch.visibility === 'private' && teams.length > 0 && (
            <div className="mb-1 space-y-1">
              <div className="text-meta text-fg-subtle">{t('sidebar.members.teamHeading')}</div>
              <div className="flex items-center gap-1">
                <select
                  aria-label={t('sidebar.members.teamSelect')}
                  className="flex-1 rounded border border-border bg-field px-1 py-0.5 text-fg"
                  value={selectedTeamId}
                  onChange={(e) => { setSelectedTeamId(e.target.value); setTeamAddResult(null); }}
                >
                  <option value="">{t('sidebar.members.teamPick')}</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <button
                  className="rounded bg-accent px-2 py-0.5 text-meta text-fg-on-strong hover:bg-accent-hover disabled:opacity-40"
                  disabled={!selectedTeamId}
                  onClick={() => void submitTeamAdd(ch.id)}
                >
                  {t('sidebar.members.teamAdd')}
                </button>
              </div>
              {teamAddResult && (
                <div className="text-meta text-fg-muted">
                  {teamAddResult.added.length > 0 && <span>{t('sidebar.members.teamAdded', { names: teamAddResult.added.join(', ') })}</span>}
                  {teamAddResult.skipped.length > 0 && <span className="ml-1 text-warning">{t('sidebar.members.teamSkipped', { names: teamAddResult.skipped.join(', ') })}</span>}
                  {teamAddResult.alreadyMember.length > 0 && <span className="ml-1">{t('sidebar.members.teamAlready', { names: teamAddResult.alreadyMember.join(', ') })}</span>}
                </div>
              )}
            </div>
          )}
          <div className="flex gap-1">
            {/* 멤버가 아니면 나갈 것이 없다. public 채널에서 비멤버의 '나가기'는 서버가
                200 으로 받아 주지만 아무 일도 일어나지 않는다 — 그런 항목은 만들지 않는다. */}
            {isMember && (
              <button
                className="rounded px-2 py-0.5 text-meta text-danger hover:bg-surface-raised"
                onClick={() => void (leaveConfirmId === ch.id ? confirmLeave(ch.id) : requestLeave(ch.id))}
              >
                {leaveConfirmId === ch.id ? t('sidebar.members.leaveConfirm') : t('sidebar.members.leave')}
              </button>
            )}
            <button
              className="rounded px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-hover"
              onClick={closeMembers}
            >
              {t('sidebar.members.close')}
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
          ? <span className="text-fg-subtle" aria-label={t('sidebar.channel.private')} title={t('sidebar.channel.private')}>🔒</span>
          : <span className="text-fg-subtle">#</span>}
        {ch.name}
        {ch.repo && <span className="rounded bg-surface-raised px-1 text-meta text-fg-muted">{ch.repo}</span>}
        {/* 오른쪽 상태 묶음. `ml-auto` 는 **여기 한 번만** 있다 — 안의 둘이 각자 갖고
            있으면 남은 여백이 둘로 갈려 점이 줄 한가운데에 선다(`ChannelUnreadDot` 주석). */}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <ChannelUnreadDot channelId={ch.id} name={ch.name ?? ''} />
          <UnreadBadge channelId={ch.id} notifyLevel={notifyLevel} />
        </span>
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
        label: t('sidebar.menu.markUnread'),
        onSelect: () => void getController().markChannelUnread(ch.id, lastSeq),
      }] : []),
      ...(me?.isAdmin ? [{ label: t('sidebar.menu.edit'), onSelect: () => startEdit(ch) }] : []),
      ...(me?.isAdmin ? [isArchived
        ? { label: t('sidebar.menu.unarchive'), onSelect: () => void getController().archiveChannel(ch.id, false) }
        : { label: t('sidebar.menu.archive'), onSelect: () => void getController().archiveChannel(ch.id, true) }]
      : []),
      /**
       * 삭제(#155). **보관된 채널에만** 만든다 — 서버가 보관되지 않은 채널의 삭제를 409 로
       * 거절하므로, 눌러도 거절되는 항목을 남겨 두면 "할 수 있다"는 거짓 신호가 된다
       * (docs/design.md 4절). DM 은 이 목록(`sortedChannels`)에 없어 애초에 닿지 않는다.
       */
      ...(me?.isAdmin && isArchived
        ? [{ label: t('sidebar.menu.delete'), onSelect: () => startDelete(ch.id) }] : []),
      { label: t('sidebar.menu.members'), onSelect: () => void openMembers(ch.id) },
      // 초대와 나가기는 **그 채널의 멤버**여야 하는 동작이다(public 채널의 초대는 예외 —
      // 서버 게이트가 누구나 통과시킨다). 메뉴는 목록을 받기 전에도 그려지므로 아직
      // 모르는 것을 '아니다'로 단정하지 않는다: 목록을 받아 아닌 것이 확인된 때만 뺀다.
      ...(ch.visibility === 'public' || knownMember
        ? [{ label: t('sidebar.menu.invite'), onSelect: () => void openMembers(ch.id) }] : []),
      ...(knownMember ? [{ label: t('sidebar.menu.leave'), onSelect: () => void requestLeave(ch.id) }] : []),
      /*
       * 숨기기(#376). **나가기 바로 옆에 둔다** — 두 항목이 같은 자리에 있어야 "관심 없다"를
       * 표현하는 길이 나가기 하나뿐이 아니라는 것이 보인다. 멤버십을 보지 않는다: 멤버가
       * 아닌 public 채널도 사이드바에 있으므로 치울 수 있어야 하고, 숨김은 멤버십을 건드리지
       * 않으므로 게이트가 필요 없다. 확인 절차도 없다 — 되돌리는 값이 클릭 한 번이다.
       */
      isHidden(ch.id)
        ? { label: t('sidebar.menu.unhide'), onSelect: () => void getController().setChannelHidden(ch.id, false) }
        : { label: t('sidebar.menu.hide'), onSelect: () => void getController().setChannelHidden(ch.id, true) },
      { label: t('sidebar.menu.copyName'), onSelect: copyChannelName },
      { label: t('sidebar.menu.copyId'), onSelect: copyChannelId },
      // 음소거 토글 하나가 아니라 세 수준을 나란히 둔다(#224). 켬/끔 스위치와 수준을 같이
      // 두면 "음소거 껐는데 왜 아직 조용하지"가 생긴다 — 여기가 유일한 조작 자리다.
      ...NOTIFY_LEVELS.map((level) => ({
        // `✓ ` 는 **화면의 것이다** — 사전에 넣으면 켠 것과 안 켠 것이 각각 사전 항목이
        // 되어 항목 수가 두 배가 된다(그리고 두 항목이 갈라진다).
        label: t('sidebar.notify.item', {
          check: notifyLevel === level ? '✓ ' : '',
          level: t(NOTIFY_LEVEL_KEY[level]),
        }),
        onSelect: () => void getController().setChannelNotifyLevel(ch.id, level),
      })),
      { label: isStarred ? t('sidebar.menu.unstar') : t('sidebar.menu.star'), onSelect: () => void getController().toggleChannelStar(ch.id) },
      /*
       * 섹션 이동(#157). DM 은 섹션을 가질 수 없다 — kind 로 거르고, 서버도 400 을 준다.
       *
       * **이미 쓴 섹션을 항목으로 세운다.** 이름을 매번 다시 치게 하면 오타 하나로
       * 같은 뜻의 섹션이 둘 생기고, 그 둘을 합칠 길은 이 화면에 없다.
       * 새 이름은 사이드바 안 인라인 입력으로 받는다 — `prompt()` 는 창을 막고,
       * Electron 에서 꺼져 있으면 아무 일도 일어나지 않는 죽은 항목이 된다.
       */
      ...(ch.kind === 'standard' ? [
        ...knownSections
          .filter((name) => name !== pref?.section)
          .map((name) => ({
            label: t('sidebar.menu.section', { name }),
            onSelect: () => void getController().setChannelSection(ch.id, name),
          })),
        {
          label: t('sidebar.menu.sectionNew'),
          onSelect: () => { setSectionEditFor(ch.id); setSectionDraft(''); },
        },
        ...(pref?.section ? [
          { label: t('sidebar.menu.sectionClear'), onSelect: () => void getController().setChannelSection(ch.id, null) },
        ] : []),
      ] : []),
      /*
       * 섹션 안 순서 조절(#157).
       *
       * **이웃과 자리를 바꾼다** — `sortOrder ± 1` 이 아니다. 그 방식은 아무것도 하지
       * 않는다: 같은 섹션의 다른 채널들은 `sortOrder` 가 null 이라 비교 자체가 이름순으로
       * 떨어지고, 눌러도 순서가 그대로다(실측). 자리를 바꾼 뒤 그 섹션 전체에 0..n-1 을
       * 다시 매겨 순서를 명시로 만든다 — 절반만 값을 가지면 "안 매김"이 섞여 다음 클릭이
       * 또 아무 일도 하지 않는다.
       */
      ...(ch.kind === 'standard' ? sectionMoveItems(ch) : []),
    ];
    const submitSection = () => {
      const name = sectionDraft.trim();
      setSectionEditFor(null);
      setSectionDraft('');
      // 빈 값은 "섹션에서 빼기"와 같다 — 서버도 빈 문자열을 null 로 저장한다.
      void getController().setChannelSection(ch.id, name === '' ? null : name);
    };
    return (
      <div key={ch.id} className="relative w-full">
      {sectionEditFor === ch.id && (
        <div className="mb-1 rounded border border-border bg-surface-raised p-1">
          <input
            type="text"
            autoFocus
            aria-label={t('sidebar.section.name')}
            maxLength={40}
            className="w-full rounded border border-border bg-field px-2 py-1 text-fg placeholder-fg-subtle"
            placeholder={t('sidebar.section.movePlaceholder')}
            value={sectionDraft}
            onChange={(e) => setSectionDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSection();
              // 취소는 되돌리기다 — 아무것도 저장하지 않는다.
              if (e.key === 'Escape') { setSectionEditFor(null); setSectionDraft(''); }
            }}
          />
          <div className="mt-1 flex gap-1">
            <button
              className="rounded bg-accent px-2 py-0.5 text-meta text-fg-on-strong hover:bg-accent-hover"
              onClick={submitSection}
            >
              {t('sidebar.section.moveSubmit')}
            </button>
            <button
              className="rounded px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-raised"
              onClick={() => { setSectionEditFor(null); setSectionDraft(''); }}
            >
              {t('sidebar.section.cancel')}
            </button>
          </div>
        </div>
      )}
      <div className="relative flex w-full items-center">
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
                className="ml-auto rounded px-1 text-fg-subtle hover:bg-surface-raised hover:text-fg"
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
        className="overflow-hidden bg-surface-sunken"
        style={{ width: 0 }}
        aria-hidden="true"
      />
    );
  }

  return (
    <aside
      className="relative flex flex-col bg-surface-sunken text-fg"
      style={{ width: collapsed ? 0 : width }}
    >
      {/* 드래그 핸들: 사이드바 우측 가장자리에 위치 */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('sidebar.resize.handle')}
          tabIndex={0}
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent focus:bg-accent"
          onMouseDown={handleDragStart}
          onKeyDown={handleKeyDown}
        />
      )}
      <div className="flex min-w-[180px] flex-1 flex-col overflow-hidden">
        {/* 브랜드 바(#270). **신호등 여백은 더 이상 여기가 아니다** — 레일이 항상 왼쪽에
            서므로 창의 좌상단은 레일이다. 창을 끄는 손잡이는 그대로 남는다: 이 바는 여전히
            타이틀바 높이의 빈 띠라 사람이 창을 옮길 때 잡는 자리다.

            `data-tauri-drag-region` 은 그 속성이 있는 요소 **자체**를 눌렀을 때만 드래그를
            시작한다 — 접기 버튼을 누르면 이벤트 대상이 버튼이라 창은 움직이지 않는다. 로고는
            `<svg>` 라 그 자체가 대상이 되므로 손잡이를 따로 씌운다(제목 텍스트는 요소가 아닌
            텍스트 노드여서 이 div 가 그대로 대상이 된다). */}
        <div
          data-testid="sidebar-brand"
          data-tauri-drag-region
          /*
            **`select-none` 이 있어야 한다**(실측 2026-09-07). 이 줄은 창을 끄는 손잡이
            (`data-tauri-drag-region`)인데, 안의 `murmur` 는 그냥 텍스트 노드라 끌면
            **창이 움직이는 대신 글자가 선택**됐다. 손잡이로 쓰는 자리의 글자는 고를
            대상이 아니다 — 복사할 값이 아니라 앱 이름이다.
          */
          /*
            **면 색을 `TOP_BAR_BG` 에서 받는다**(사용자 요청 4, 2026-09-08 — "타이틀바의
            색상을 통일해줘"). 앞 판은 면을 아예 적지 않아 사이드바(`sunken`)를 물려받았고,
            바로 오른쪽에 붙은 `Workspace` 헤더는 `raised` 였다 — 한 줄처럼 보이는 두 조각이
            서로 다른 색이라 창 위쪽에 이유 없는 세로 이음선이 생겼다. 높이를 한 상수가 정하는
            것과 같은 이유로(`TOP_BAR_H`) 색도 한 상수가 정한다.
          */
          className={`flex ${TOP_BAR_H} select-none items-center gap-2 border-b border-border
                      ${TOP_BAR_BG} pl-3 pr-3 font-bold`}
        >
          {/*
            **글자를 되돌렸다**(실측 2026-09-08, 사용자가 화면에서 지적 — "murmur 텍스트가
            안 나와"). 앞 판은 *"레일이 커뮤니티 마크를 드니 앱 이름을 여기서 또 적으면 같은
            자리에서 두 번 말하는 셈"* 이라며 글자를 뺐다(2026-09-07). 그 판단이 틀렸던
            지점은 **레일의 마크는 커뮤니티 이름이지 앱 이름이 아니라는 것**이다 — 글자를
            빼자 창 왼쪽 위에 남은 것은 파형 하나뿐이고, 그것이 무엇의 로고인지는 이미 아는
            사람만 안다. 앱 이름을 적는 자리는 이 창에 여기 하나뿐이다.

            **이름을 지는 쪽은 글자다.** 그래서 로고는 `decorative` 로 둔다 — `#191` 의
            회귀선(`test/logo.test.tsx`)이 지키는 것은 *"접근 가능한 이름 murmur 는 하나뿐"*
            이고, 로고와 글자가 둘 다 이름을 내면 스크린리더가 앱 이름을 두 번 읽는다.
          */}
          <span data-tauri-drag-region className="flex items-center gap-1.5">
            {/*
              **28px 이다**(실측 2026-09-08, 사용자가 화면에서 고른 안). 이 바는
              `TOP_BAR_H` = `h-9` = 36px 인데 16px 로는 바 높이의 44% 밖에 차지하지 않아
              브랜드가 아니라 부스러기로 보였다. 28px 은 위아래 4px 을 남긴다 — 바를 꽉
              채우지 않는 마지막 크기다.
            */}
            <Logo size={28} decorative />
            {/*
              **15px(이름줄)이다**(`test/typeScale.test.ts` 의 4단). 앱 이름은 화면 제목
              (17px)이 아니라 이름이고, 본문단 13px 로 적으면 28px 로 키운 로고 옆에서
              글자가 다시 부스러기가 된다.

              **색을 여기서 못 박는다.** 이 줄은 `font-bold` 만 들고 색은 위에서
              상속받는데, 상속의 출처가 한 번 바뀌면 브랜드 글자가 조용히 흐려진다.
              `text-fg` 면 라이트·다크 양쪽에서 이 줄이 화면에서 가장 진한 글자로 남는다 —
              모드별 값은 `index.css` 한 곳이 정한다.
            */}
            <span className="text-name leading-none tracking-tight text-fg">murmur</span>
          </span>
          {/* `#443`: 이 점은 실측에서 **유일하게 맞았던** 표시다(끊긴 순간 빨강). 고치는 것은
              색이 아니라 **말**이다 — `disconnected` 한 단어는 그 뒤에 따라오는 사실
              (아래 점들이 전부 '알 수 없음'이 된다)을 말하지 않는다. 사람이 아래에서 보게 될
              것을 여기서 미리 말해 둔다. */}
          <span data-testid="connection-dot" data-connected={String(connected)}
            className={`h-2 w-2 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`}
            title={connected ? t('sidebar.brand.connected') : t('sidebar.brand.disconnected')} />
          <button
            onClick={onToggleCollapse}
            className="ml-auto rounded p-1 hover:bg-surface-raised"
            aria-label={t('sidebar.brand.collapse')}
            title={t('sidebar.brand.collapse')}
          >
            <SidebarToggleIcon />
          </button>
        </div>
      {/*
        찾기가 **맨 위**다(정본 문서 `docs/desktop-remaining-gaps.html` 「A · 찾기가 맨 위로」).

        **칸 분기 밖이자 `nav` 밖이다.** 두 이유가 각각 문서의 한 문장에 대응한다:

        - `nav` **밖** — 그 상자가 `overflow-y-auto` 다. 안에 두면 채널이 서른일 때 찾기가
          스크롤 위로 사라지고, 그것이 #479 가 에이전트 설정에서 고친 결함이다.
        - 칸 분기 **밖** — 문서는 *"채널·사람·에이전트가 한 입력으로"* 를 요구한다. 한
          칸(예: 홈)에만 두면 DM 칸에서 사람을 찾으려고 홈으로 돌아가야 하고, 그 순간
          "한 입력으로" 가 "칸을 옮긴 다음 한 입력으로" 가 된다.

        왜 레일이 아니라 여기인지는 `SidebarFind.tsx` 주석에 있다(레일 문서가 다섯째 칸을
        막았고, 찾기는 애초에 칸이 아니다).
      */}
      <SidebarFind onOpenChannelDirectory={onOpenChannelDirectory} />
      {/*
        `aria-label` 이 붙었다. 이 화면에는 이제 `nav` 가 둘이다(레일의 `주 목록`) — 이름
        없는 랜드마크가 섞여 있으면 스크린리더의 랜드마크 목록에 "navigation" 이 두 개
        나오고 어느 쪽이 무엇인지 알 수 없다. 찾기 줄이 이 상자 밖으로 나갔는지를 재는
        시험도 이 이름으로 상자를 집는다.
      */}
      <nav aria-label={t('sidebar.brand.nav')} className="flex-1 space-y-4 overflow-y-auto p-2">
        {/*
          **레일이 고른 칸의 묶음만 그린다**(정본 문서 1단계). 이 `nav` 는 여전히
          `overflow-y-auto` 이지만, 이제 한 번에 한 목록만 담으므로 그 목록이 세로를 다 쓴다 —
          문서의 진단이 "셋 중 하나가 길어지면 나머지 둘이 화면 밖으로 나간다"였고, 밀려나는
          쪽이 하필 DM 과 에이전트였다.

          **`hidden` 이 아니라 아예 그리지 않는다.** 폭 0 사이드바가 같은 실수를 이미 한 번
          했다(이 파일 위쪽 `collapsed` 주석): DOM 에 남은 버튼은 탭 순서에 그대로 걸려
          **화면에서 사라진 것을 키보드로 밟게 된다.**

          Inbox 가 홈 **맨 위 한 줄**이다(문서). 배지는 여기 없다 — 레일의 홈 칸이 대신 받아
          어느 칸에 있든 계속 보인다. 여기에도 숫자를 달면 같은 사실이 두 곳에 유지된다.
        */}
        {panel === 'home' && (
        <>
        <div>
          {/* 디렉터리는 조회 전용이라 admin 여부를 보지 않는다 — 누가 이 워크스페이스에
              있는지는 모두가 알아야 한다. 계정 관리는 설정 진입점(레일 맨 아래)의 몫이다.

              인박스도 디렉터리와 **같은 방식으로** 연다(#185) — 사이드바 항목이 뷰를 열고,
              뷰는 닫혀 있으면 아무것도 그리지 않는다. */}
          <button className={`${row(false)} text-fg-muted`} onClick={onOpenInbox}>
            Inbox
          </button>
          <button className={`${row(false)} text-fg-muted`} onClick={onOpenDirectory}>
            Directory
          </button>
          {/*
            `Saved` 한 줄이 여기 있었다. **레일의 북마크 칸으로 갔다** — 문서: "북마크는
            레일에만 둔다. 자기 칸이 있는데 홈에도 한 줄을 세우면 같은 것으로 가는 길이
            둘이 되고, 그때부터 사람은 어느 쪽이 맞는지 매번 고른다."

            `+ Add or edit agents` 도 여기 있었다(#488 A2에서 뺐다) — 이 묶음은 *이동*인데
            그 한 줄만 *설정*이었다. 설정으로 가는 길은 레일 맨 아래 계정 메뉴가 갖는다.
          */}
        </div>
        {/*
          즐겨찾기가 **채널 위**에 선다(문서). 채널이 서른이면 매일 보는 셋과 반년째 안 본
          스물일곱이 같은 무게로 줄 서 있고, 이 묶음이 그것을 가른다 — 그 아래는 "가끔 뒤지는
          서랍"이 되어 길어지는 것이 더 이상 문제가 아니다. 비어 있으면 그리지 않는다.
        */}
        {starredChannels.length > 0 && (
          <div>
            <div className="flex items-center gap-1 px-2 pb-1 text-meta uppercase tracking-wide text-fg-subtle">
              {t('sidebar.channel.favorites')}
            </div>
            {starredChannels.map((item) => channelRow(item.channel))}
          </div>
        )}
        <div>
          {/*
            **10px 돋보기가 여기 있었다.** 문서가 그것을 결함으로 적었다: *"지금은 `CHANNELS`
            라벨 옆 10px 돋보기 하나다."* 크기만 문제가 아니었다 — 그 버튼이 여는
            `ChannelDirectory` 는 **채널만** 나오므로, 사이드바에서 사람·에이전트를 찾는 길이
            아예 없었다.

            찾기는 위의 `SidebarFind` 한 줄로 갔고, 디렉터리로 가는 길은 그 줄 **안**에
            들어갔다(디렉터리는 지우지 않았다 — 보관·생성순·아직 안 들어간 채널은 그쪽만
            할 수 있다). 그래서 여기에 돋보기를 남기지 않는다: 남기면 사이드바에서 찾기를
            시작하는 자리가 둘이 되고, 문서가 북마크에서 이미 판정한 결함(*"같은 것으로
            가는 길이 둘이 되고, 그때부터 사람은 어느 쪽이 맞는지 매번 고른다"*)을 찾기에서
            되풀이한다.
          */}
          <div className="flex items-center gap-1 px-2 pb-1 text-meta uppercase tracking-wide text-fg-subtle">
            {t('sidebar.channel.heading')}
          </div>
          {/*
            `+` 는 목록의 **첫 칸**이다(#488 A2) — 예전에는 채널 목록 **끝**이라 채널이
            스무 개면 스크롤 끝까지 내려가야 닿았고, 보관·숨김 묶음이 그 아래 또 붙어
            자리가 계속 밀렸다. 설정 › 에이전트의 `+` 카드와 같은 규칙이다.
          */}
          {me?.isAdmin && (
            createChannelOpen ? (
              <div className="mb-1 rounded border border-border bg-surface-raised p-1">
                <input
                  type="text"
                  aria-label="New channel name"
                  className="mb-1 w-full rounded border border-border bg-field px-2 py-1 text-fg placeholder-fg-subtle"
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
                <label className="mb-1 flex items-center gap-1 text-meta text-fg-muted">
                  <input
                    type="checkbox"
                    checked={newChannelPrivate}
                    onChange={(e) => setNewChannelPrivate(e.target.checked)}
                  />
                  {t('sidebar.channel.privateOption')}
                </label>
                {createError && <p role="alert" className="mb-1 text-meta text-danger">{createError}</p>}
                <div className="flex gap-1">
                  <button
className="rounded bg-accent px-2 py-0.5 text-meta text-fg-on-strong hover:bg-accent-hover"
                    onClick={() => void submitNewChannel()}
                  >
                    {t('sidebar.channel.createSubmit')}
                  </button>
                  <button
className="rounded px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-raised"
                    onClick={closeCreate}
                  >
                    {t('sidebar.channel.cancel')}
                  </button>
                </div>
              </div>
            ) : addRow(t('sidebar.channel.create'), () => setCreateChannelOpen(true), 'add-channel')
          )}
          {/* 섹션(#157)으로 묶어 그린다. 섹션 없는 것들은 맨 아래 무제목 묶음이다. */}
          {groupedChannels.map((group) => {
            const sectionName = group.section;
            const isRenaming = sectionRenameFor === sectionName;
            const sectionHeader = isRenaming ? (
              <div className="mb-1 rounded border border-border bg-surface-raised p-1 ml-2 mr-2">
                <input
                  type="text"
                  autoFocus
                  aria-label={t('sidebar.section.renameName')}
                  maxLength={40}
                  className="w-full rounded border border-border bg-field px-2 py-1 text-fg placeholder-fg-subtle"
                  placeholder={t('sidebar.section.renamePlaceholder')}
                  value={sectionRenameDraft}
                  onChange={(e) => setSectionRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const newName = sectionRenameDraft.trim();
                      setSectionRenameFor(null);
                      setSectionRenameDraft('');
                      if (sectionName) {
                        void getController().renameSection(sectionName, newName || null);
                      }
                    }
                    if (e.key === 'Escape') { setSectionRenameFor(null); setSectionRenameDraft(''); }
                  }}
                />
                <div className="mt-1 flex gap-1">
                  <button
                    className="rounded bg-accent px-2 py-0.5 text-meta text-fg-on-strong hover:bg-accent-hover"
                    onClick={() => {
                      const newName = sectionRenameDraft.trim();
                      setSectionRenameFor(null);
                      setSectionRenameDraft('');
                      if (sectionName) {
                        void getController().renameSection(sectionName, newName || null);
                      }
                    }}
                  >
                    {t('sidebar.section.renameSubmit')}
                  </button>
                  <button
                    className="rounded px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-raised"
                    onClick={() => { setSectionRenameFor(null); setSectionRenameDraft(''); }}
                  >
                    {t('sidebar.section.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <Menu
                renderTrigger={(props) => (
                  <div
                    data-testid={`section-header-${sectionName}`}
                    className="group px-2 py-1 text-meta font-medium text-fg-muted hover:bg-surface-raised cursor-pointer"
                    {...props}
                  >
                    {sectionName}
                  </div>
                )}
                items={[
                  {
                    label: t('sidebar.section.rename'),
                    onSelect: () => { if (sectionName) { setSectionRenameFor(sectionName); setSectionRenameDraft(sectionName); } },
                  },
                ]}
                openOnContextMenu
              />
            );
            return (
              <div key={sectionName ?? 'other'}>
                {sectionName !== null && sectionHeader}
                {group.channels.map((item) => channelRow(item.channel))}
              </div>
            );
          })}
        </div>
        {archivedChannels.length > 0 && (
          <div>
            <button
              className="flex w-full items-center gap-1 px-2 pb-1 text-meta uppercase tracking-wide text-fg-subtle hover:text-fg-muted"
              onClick={() => setArchivedOpen((v) => !v)}
            >
              <span>{archivedOpen ? '▼' : '▶'}</span>
              {t('sidebar.channel.archived', { count: archivedChannels.length })}
            </button>
            {archivedOpen && archivedChannels.map(channelRow)}
          </div>
        )}
        {/* 숨긴 채널(#376). 보관 묶음과 나란히 둔다 — 같은 성질(사이드바에서 치워진 것)이고,
            펼치면 '숨김 해제'가 있는 같은 메뉴가 나온다. */}
        {hiddenChannels.length > 0 && (
          <div>
            <button
              className="flex w-full items-center gap-1 px-2 pb-1 text-meta uppercase tracking-wide text-fg-subtle hover:text-fg-muted"
              onClick={() => setHiddenOpen((v) => !v)}
            >
              <span>{hiddenOpen ? '▼' : '▶'}</span>
              {t('sidebar.channel.hidden', { count: hiddenChannels.length })}
            </button>
            {hiddenOpen && hiddenChannels.map(channelRow)}
          </div>
        )}
        </>
        )}
        {/*
          DM 한 목록 — **`DIRECT MESSAGES` 와 `AGENTS` 가 합쳐졌다**(정본 문서
          `docs/desktop-rail.html` 2단계).

          문서: *"DM 은 사람과 에이전트를 안 가른다. 한 목록에 최근순으로 섞이고 줄 모양이
          같다 — 목록만 봐서는 누가 에이전트인지 알 수 없다. '사람끼리 일하듯'이 컨셉이면
          대화 목록이 그것을 가장 먼저 보여주는 자리다."*

          **머리글이 없어졌다.** `DIRECT MESSAGES` 라는 묶음 이름은 그 아래가 `AGENTS` 와
          갈려 있을 때만 뜻이 있었다 — 묶음이 하나면 이름은 아무것도 구분하지 않고, 레일의
          `DM` 칸이 이미 같은 말을 하고 있다. 같은 말을 두 번 하는 자리를 남기면 그것이
          곧 문서가 없애려던 "두 묶음"의 흔적이다.

          정렬은 `dmPeers` 가 하고(그 주석에 근거), 줄 모양은 `dmRow` 하나가 진다.
        */}
        {panel === 'dm' && (
        <div>
          {/*
            DM 의 `+` 도 목록의 **첫 칸**이다(#488 A2). 예전에는 섹션 머리 오른쪽 끝의 작은
            버튼이라 채널의 `+` 와 모양도 자리도 달랐다 — 같은 일을 하는 것이 목록마다 다르게
            생기면 사람은 매번 새로 찾는다.
          */}
          {addRow(t('sidebar.dm.new'), () => setPickerOpen((v) => !v), 'add-dm')}
          {pickerOpen ? (
            <div className="mb-1 rounded border border-border bg-surface-raised p-1">
              {others.map((a) => (
                <button key={a.id} className={row(false)}
                  onClick={() => { setPickerOpen(false); void getController().startDm(a.id); }}>
                  {a.handle}
                  <span className="text-meta text-fg-subtle">{a.kind}</span>
                </button>
              ))}
            </div>
          ) : (
            dmPeers.map(dmRow)
          )}
        </div>
        )}
        {/*
          **얼굴 그리드** — 정본 문서 `docs/desktop-rail.html` 3단계.

          문서: *"에이전트는 대화가 아니라 인력이다. 그래서 목록이 아니라 얼굴 그리드 —
          설정 › 에이전트와 같은 카드 컴포넌트를 쓴다. 아직 DM 이 없는 에이전트도 여기서는
          자리를 갖고, 멈춘 것은 ▶ 로 여기서 바로 켠다. 지금은 DM 이 있는 쪽만 상태가 보이고
          없는 쪽은 아무 표시도 못 받는데, 그 비대칭이 사라진다."*

          ## 진단을 코드로 확인한 결과 (실측 2026-09-07)

          문서의 세 문장 중 **하나가 코드와 어긋났다.** 남겨 둔다 — 이 저장소에서 문서가
          코드보다 뒤처진 사례가 여러 번 있었다.

          | 문서 | 코드 | |
          |---|---|---|
          | 목록이지 그리드가 아니다 | `row()` 버튼을 세로로 쌓았다 | 맞다 |
          | *"아직 DM 이 없는 에이전트도 여기서는 자리를 갖고"* | **거꾸로였다** — `dmAgentIds` 필터가 DM 이 **있는** 쪽을 뺐다 | 어긋난다 |
          | *"없는 쪽은 아무 표시도 못 받는다"* | `RunnerStatusDot` 이 `state` 가 없으면 `null` 을 낸다 | 맞다 |

          문서가 그 문장을 쓴 시점(1단계 이전)에는 이 칸이 **모든** 에이전트를 세우면서
          DM 이 없는 쪽에만 표시가 없었다. 2단계(#528)가 DM 목록을 합치면서 반대로 뒤집었다 —
          DM 이 있는 쪽을 DM 칸으로 보내고 여기에는 없는 쪽만 남겼다. 그러니까 **비대칭의
          방향이 바뀌었을 뿐 비대칭은 그대로 있었다**: 같은 워크스페이스의 에이전트가 두
          칸에서 서로 다른 어휘로 그려졌고(여기는 네모난 러너 점 + `@handle`, DM 칸은 아바타
          얼굴), 러너를 아직 한 번도 안 띄운 에이전트는 그 점조차 못 받았다.

          이번에 사라지는 것이 그것이다. **`dmAgentIds` 필터가 없다** — 이 칸은 이제
          `kind === 'agent'` 전부를 세운다.

          ## DM 칸과 겹치는 것을 두려워하지 않는다

          2단계 주석이 겹침을 근거로 필터를 남겼다: *"같은 것으로 가는 길이 둘이 되고,
          그때부터 사람은 어느 쪽이 맞는지 매번 고른다."* **그 문장이 여기에 걸리지 않는
          이유가 문서 안에 있다.** 두 칸이 답하는 질문이 다르다 — DM 칸은 *"최근에 누구와
          무슨 말을 했나"*(대화)이고 이 칸은 *"우리 팀에 누가 있고 지금 일할 수 있나"*(인력)다.
          문서가 이 칸을 만든 첫 문장이 정확히 그 구분이다. 북마크가 홈에 서면 안 되는 이유는
          두 자리가 **같은 질문**에 답했기 때문이고, 여기는 아니다.

          ## `runner-reason-{id}` 충돌이 없어진 방식

          2단계 주석이 이 위험을 미리 적었다: *"필터를 떼면 같은 testid 가 둘이 되어 시험의
          `getByTestId` 가 깨진다."* 그 이름을 **이 칸이 더 이상 쓰지 않는 것**으로 푼다 —
          사유는 격자가 `agent-runner-failed-{id}` 로 내고, `dmRow` 의 이름과 겹치지 않는다.
          한 번에 한 패널만 그려지므로 화면에서 부딪히는 일도 없지만, 이름이 갈려 있어야
          시험이 두 칸을 구별할 수 있다.
        */}
        {panel === 'agents' && (
          <AgentTurns
            snapshot={agentTurns}
            /*
              handle 은 스토어의 계정에서 읽는다. 없는 계정(방금 지워졌거나 아직 안 온 것)은
              **id 를 그대로 보인다** — 빈 자리를 그리면 어느 에이전트인지 잃는다.
            */
            handleOf={(id) => accounts[id]?.handle ?? id}
            channelLabel={(id) => {
              const ch = channels.find((c) => c.id === id);
              return ch ? `${ch.visibility === 'private' ? '🔒' : '#'}${ch.name}` : id;
            }}
            /*
              이동은 `openMessage` 에 맡긴다 — 스레드 루트도 메시지이므로 그 경로가
              채널 전환 · 스레드 패널 · 실패 통지를 이미 다 한다(퍼머링크와 같은 길).
            */
            onOpenThread={(rootId) => { void getController().openMessage(rootId); }}
            /*
              중단(3단계). 줄·스레드·전부가 **한 경로**로 간다 — 묶음 판정은 화면의 일이고
              (`AgentTurns` 의 `onCancelTurns` 주석), 실패 통지를 하나로 묶는 것은
              컨트롤러의 일이다(같은 원인을 네 번 읽히지 않게).
            */
            onCancelTurns={(turns) => {
              void getController().cancelAgentTurns(turns.map((turn) => turn.sessionId));
            }}
          />
        )}
        {panel === 'agents' && (
          <AgentGrid
            /*
              **스토어의 계정 목록을 그대로 넘긴다.** `listAgents()` 를 여기서 다시 부르지
              않는다 — 같은 에이전트 목록이 두 곳에 유지되기 시작하면 한쪽만 낡는다.
              그 대가로 `instructions`(역할 설명)가 없어 검색이 이름만 훑는데, 그것은
              `AgentGrid` 가 옵셔널로 받는다(`AgentCardSubject` 주석).

              `disabled` 를 걸러내지 않는다: `AccountView.disabled` 주석이 *"디렉터리에서
              빼지 않고 표시만 한다"* 고 정했고, 여기서 빼면 비활성 에이전트가 화면에서
              통째로 사라져 되살릴 길이 설정뿐이 된다.
            */
            agents={panelAgents}
            /*
              **고른 것을 표시하지 않는다.** 설정에서 이 값은 "지금 상세를 열어 둔 카드"이고,
              여기서 카드를 누르면 화면이 **설정으로 넘어가므로**(아래 `onPick`) 이 격자는
              그 순간 언마운트된다 — 표시할 "열어 둔 카드"가 이 칸에는 남지 않는다.
              활성 DM 을 여기에 대입하면 강조가 두 곳에서 같은 사실을 말한다 — DM 칸이
              이미 활성 줄을 면으로 표시한다.
            */
            selectedId={null}
            runnerStates={runnerStates}
            online={online}
            connected={connected}
            /*
              **카드를 누르면 그 에이전트의 설정이 열린다.**

              전 판본은 `startDm` 이었고 근거로 *"옛 목록이 이미 `startDm` 이었다"* 와
              문서의 *"인력"* 을 들었다. **그 근거가 뒤집혔다**(jaebin, 2026-09-08):
              *"이미 메시지를 보내는 건 DM 으로 보낼 수 있잖아."*

              이 칸이 DM 을 열면 **같은 것으로 가는 길이 둘**이 된다 — 바로 위 DM 칸이
              이미 대화 목록이고, 거기에 이 에이전트의 줄이 (없으면 `New` 로) 선다.
              2단계 주석이 필터를 남길 때 쓴 그 문장이 여기에 되돌아온 것이고, 3단계가
              그 문장을 비켜 간 근거는 *"두 칸이 답하는 물음이 다르다"* 였다:
              DM 칸은 *"최근에 누구와 무슨 말을 했나"*, 이 칸은 *"우리 팀에 누가 있고 지금
              일할 수 있나"*. **누르는 동작도 그 물음을 따라야** 두 칸이 진짜로 갈린다 —
              인력을 누르는 것은 그 사람의 **자리를 보는 것**이다(하네스·모델·역할·러너).

              레일을 한 번 더 누른 대가는 그대로 남는다: 이 칸은 설정 화면이 못 하는 일을
              한다 — 격자에서 얼굴로 상태를 훑고, 멈춘 것은 ▶ 로 여기서 바로 켠다.
            */
            onPick={(a) => {
              /*
                **설정을 볼 수 없는 사람은 프로필로 보낸다.** 판정은 `canSeeAgentConfig`
                하나가 갖고(그 주석에 근거), 그 문을 못 여는 사람에게 설정을 열면
                `GET /accounts/agents` 가 403 을 내어 "목록을 받지 못했다"만 남는다 —
                갈 수 있는데 할 수 있는 것이 없는 곳을 만들지 않는다(design.md §4).

                프로필을 고른 것은 **본문 멘션의 선례와 같게** 두기 위해서다
                (`MessageBody` 의 `target`): admin·소유자는 설정, 그 외는 프로필. 프로필에는
                `DM 열기`가 서 있으므로 대화로 가는 길도 여기서 끊기지 않는다.
              */
              if (canSeeAgentConfig(a, me)) { onOpenAgentConfig(a.id); return; }
              onOpenProfile(a.id);
            }}
            /*
              **만들기 문을 이 칸에 두지 않는다.** A2 가 정한 것을 그대로 따른다:
              *"설정으로 가는 `+ Add or edit agents` 는 nav 에서 사라진다(이동 사이에 설정이
              끼어 있었다)."* 만들기는 설정의 일이고 그 문은 이미 `+ Create agent` 로 서
              있다. 여기에 `+` 를 두면 A2 가 없앤 것 — 목록 사이에 낀 설정 진입점 — 이
              모양만 카드로 바꿔 되돌아온다.

              `onCreate` 는 `canCreate` 가 false 면 불릴 수 없지만 옵셔널이 아니다.
              **눌러도 아무 일이 없는 함수를 넘기지 않는다**(design.md §4): 두 값이 갈리는
              날 조용히 죽은 버튼이 생기는 대신 여기서 명시적으로 던진다.
            */
            // 던지는 말은 **화면 문자열이 아니다** — 개발자가 스택 트레이스에서 읽는 것이라
            // 사전에 넣지 않는다(사전이 사람에게 보이지 않는 말을 지고 있게 된다).
            onCreate={() => { throw new Error('사이드바에서는 에이전트를 만들지 않는다 — 설정의 일이다'); }}
            canCreate={false}
            /*
              **멈춘 것은 ▶ 로 여기서 바로 켠다**(문서). 이 칸이 3단계에서 얻는 새 능력이다 —
              옛 목록에서는 사유를 읽을 수는 있어도 켤 수는 없었다.

              권한 판정은 **설정 화면과 같은 것**이다(`canRelaunchAgent`): 관리자이거나
              내가 소유한 에이전트. 다만 그쪽은 콜백 **안에서** 걸러 눌러도 아무 일이 없게
              두는데, 여기서는 `canRelaunch` 술어로 **그 자리를 아예 그리지 않는다** —
              `AgentGrid` 주석이 정한 규칙이 그것이다(*"권한 없는 사람에게는 문이 없다"*).
              누를 수 없는 것을 그리지 않는 쪽이 이 저장소의 규율이고(design.md §4),
              설정 화면의 모양은 그 술어를 안 넘김으로써 그대로 둔다.
            */
            onRelaunch={(a) => void getController().reissueRunnerPat(a.id)}
            canRelaunch={(a) => canRelaunchAgent(a, me)}
            place="sidebar"
          />
        )}
        {/*
          **대기 사슬이 여기 있었다**(#488 A3-b). 인박스로 옮겼다 — 이 `nav` 는
          `overflow-y-auto` 이고 이 자리는 채널·DM·에이전트 **다음**이라, 채널이 몇 개만
          늘어도 스크롤 밖으로 밀린다. "지금 무엇이 막혀 있는가"를 말하는 구획이
          **정작 그것을 알아야 할 때 안 보이는** 자리였다.
        */}
        <LeasePanel />
        </nav>
        {/*
          **내 자리가 여기 있었다**(#488 A1). 레일 맨 아래로 갔다 — 정본 문서
          `docs/desktop-rail.html` 「레일 맨 아래 · 나」: *"내 얼굴이 레일 맨 아래로 내려온다.
          … 커뮤니티와 나는 패널이 무엇을 보여주든 자리가 안 변한다 — 레일에서 그 둘만
          고정이다."* 그리고 *"여기서 달라지는 것은 자리뿐이다 — 사이드바 맨 아래에서
          레일 맨 아래로."*

          그래서 계정 행의 설계(#113 의 "행 자체가 진입점" · 톱니 없음 · 상태를 메뉴 안에서
          고른다)는 `Rail.tsx` 로 **그대로** 옮겼고, 이 자리에는 아무것도 남기지 않는다.
          두 곳에 얼굴을 세우면 "지금 이게 누구인가"가 두 곳에 유지된다.
        */}
      </div>
    </aside>
  );
}
