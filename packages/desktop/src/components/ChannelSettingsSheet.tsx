import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useAppWindows } from '../lib/appWindows';
import { NOTIFY_LEVELS, notifyLevelOf, type NotifyLevel } from '@harkroom/shared';
import { Overlay } from './Overlay';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useT } from '../i18n/useT';
import type { MessageKey } from '../i18n';
import { hasCapability } from '../lib/capabilities';
import { ChannelEditForm } from './ChannelEditForm';
import { ChannelMembersPanel } from './ChannelMembersPanel';
import { errorText } from '../lib/errorText';

const NOTIFY_KEY: Record<NotifyLevel, MessageKey> = {
  all: 'sidebar.notify.all',
  mentions: 'sidebar.notify.mentions',
  none: 'sidebar.notify.none',
};

export type ChannelSheetTab = 'info' | 'members' | 'notify' | 'agents';
type Tab = ChannelSheetTab;
const TABS: Tab[] = ['info', 'members', 'notify', 'agents'];

/**
 * 채널 설정 시트(UX ⑦b-1, designer 사양 ⑦). 채널 머리의 "# 이름 ⌄" 과 사이드바 메뉴의 "채널 설정…" 이
 * 같은 것을 연다(`channelSheetId`).
 *
 * 탭은 넷이다(⑦b-2): 정보(+ 편집 `ChannelEditForm`) · 멤버 N · 알림 · 에이전트. 멤버·에이전트 탭은 사이드바에
 * 있던 멤버 패널(`ChannelMembersPanel`)을 몫으로 나눠 그린다 — 목록·초대·팀 / 자동 멘션. 사이드바의
 * 인라인 편집·멤버 자리는 없앴다: 같은 조작이 두 자리에 살지 않는다.
 *
 * 어느 탭으로 여는가는 `channelSheetTab` 이 정한다(메뉴의 "멤버 보기"·"초대" 는 멤버 탭, "나가기" 는
 * **정보 탭에서** 나가기 절차를 바로 시작 — 나가기와 마지막 멤버 확인은 시트에 한 곳이다, designer #1049).
 *
 * 규칙은 사이드바의 나가기와 같다(그 자리 주석이 근거다):
 * - 나가기 전에 멤버 목록을 받아 **마지막 멤버면 한 번 묻는다**. 조회 실패를 빈 목록으로 삼키지 않는다.
 * - 보관·편집은 `channel.manage` 능력이 있을 때만 낸다(`hasCapability` — 서버 `PATCH /channels/:id` 의 그 능력과 같다).
 */
/**
 * `onlyFor` 를 주면 **그 채널의 시트만** 그린다 — 채널 창이 자기 안에 띄울 때다(판 3 C2: 창에서 연 시트는 그 창에).
 * 메인은 안 준다. 대신 그 채널이 새 창에 떠 있으면 메인은 그리지 않는다 — 같은 시트가 두 창에 뜨면 안 된다.
 */
export function ChannelSettingsSheet({ onlyFor }: { onlyFor?: string } = {}) {
  const t = useT();
  const sheetId = useActiveStore((s) => s.channelSheetId);
  const poppedOut = useAppWindows((s) => s.entries.some((e) => e.target.kind === 'channel' && e.target.channelId === sheetId));
  const mine = onlyFor ? sheetId === onlyFor : !poppedOut;
  const channelId = useActiveStore((s) => s.channelSheetId);
  const channel = useActiveStore((s) => s.channels.find((c) => c.id === s.channelSheetId));
  const me = useActiveStore((s) => s.me);
  const pref = useActiveStore((s) => (s.channelSheetId ? s.channelPrefs[s.channelSheetId] : undefined));
  const knownMembers = useActiveStore((s) => (s.channelSheetId ? s.channelMembers[s.channelSheetId] : undefined));
  const openTab = useActiveStore((s) => s.channelSheetTab);
  const [tab, setTab] = useState<Tab>('info');
  const [startLeave, setStartLeave] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  // 조회·요청이 도는 동안 버튼을 잠근다 — 느린 서버에서 두 번 누르지 않게(designer #1041).
  const [busy, setBusy] = useState(false);

  // 다른 채널로 열리면 처음부터 — 앞 채널의 나가기 확인이 남으면 엉뚱한 채널을 떠난다.
  useEffect(() => {
    // "나가기" 는 **정보 탭**에서 그 자리의 나가기 절차를 바로 시작한다(designer #1049 — 나가기는 시트에 한 곳).
    setTab(openTab === 'leave' || !openTab ? 'info' : openTab);
    setStartLeave(openTab === 'leave');
    setError(null); setLeaveConfirm(false); setBusy(false); setEditing(false);
  }, [channelId, openTab]);

  // 메뉴 "나가기" 로 열렸으면 정보 탭의 나가기 절차를 한 번 시작한다. 절차(`leave`)는 아래(채널이 있을 때)에서
  // 정의되므로 ref 로 넘긴다 — 효과는 렌더가 끝난 뒤에 돌아 그때는 ref 가 채워져 있다.
  const leaveRef = useRef<((confirmed: boolean) => Promise<void>) | null>(null);
  useEffect(() => {
    if (!startLeave || !channel) return;
    setStartLeave(false);
    void leaveRef.current?.(false);
  }, [startLeave, channel]);

  if (!mine || !channelId || !channel) return null;
  const close = () => useActiveStore.getState().set({ channelSheetId: null, channelSheetTab: null });
  const canManage = hasCapability(me, 'channel.manage');
  const isArchived = channel.archivedAt != null;
  const level = notifyLevelOf(pref);
  // 사이드바 메뉴와 **같은 규칙**(designer #1041): 목록을 아직 못 받았으면 '모른다'라 버튼을 둔다.
  // 받은 목록에 내가 없을 때만 뺀다 — 눌러도 "멤버가 아니다" 로 끝나는 버튼은 거짓 신호다(design.md §4).
  const knownMember = knownMembers === undefined || (!!me && knownMembers.some((m) => m.accountId === me.id));

  const archive = async () => {
    setError(null); setBusy(true);
    try { await getController().archiveChannel(channel.id, !isArchived); }
    catch (err) { setError(errorText(err, t, t('channelSheet.archiveFailed'))); }
    finally { setBusy(false); }
  };

  const leave = async (confirmed: boolean) => {
    if (!me) return;
    setError(null); setBusy(true);
    try {
      if (!confirmed) {
        let members;
        try { members = await getController().loadChannelMembers(channel.id); }
        catch (err) { setError(errorText(err, t, t('sidebar.members.listFailed'))); return; }
        if (!members.some((m) => m.accountId === me.id)) { setError(t('sidebar.members.notAMember')); return; }
        if (members.length === 1) { setLeaveConfirm(true); return; }
      }
      try { await getController().leaveChannel(channel.id, me.id); close(); }
      catch (err) { setError(errorText(err, t, t('sidebar.members.leaveFailed'))); }
    } finally { setBusy(false); }
  };

  /**
   * 탭 목록은 WAI-ARIA 탭 패턴이다(designer #1041): 탭마다 `aria-controls` 로 패널을 가리키고, 고른 탭만
   * Tab 순서에 서며(`tabIndex`), ←/→ 로 옮긴다(끝에서 돌아간다).
   */
  leaveRef.current = leave;

  const tabId = (id: Tab) => `channel-sheet-tab-${id}`;
  const panelId = (id: Tab) => `channel-sheet-panel-${id}`;
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, id: Tab) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = TABS[(TABS.indexOf(id) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
    setTab(next); setStartLeave(false); setError(null);
    document.getElementById(tabId(next))?.focus();
  };
  const tabButton = (id: Tab, label: string) => (
    <button
      role="tab"
      id={tabId(id)}
      aria-selected={tab === id}
      aria-controls={panelId(id)}
      tabIndex={tab === id ? 0 : -1}
      data-testid={`channel-sheet-tab-${id}`}
      onClick={() => { setTab(id); setStartLeave(false); setError(null); }}
      onKeyDown={(e) => onTabKey(e, id)}
      className={`border-b-2 px-3 py-2 ${tab === id ? 'border-accent font-semibold text-fg' : 'border-transparent text-fg-muted hover:text-fg'}`}
    >
      {label}
    </button>
  );

  return (
    <Overlay label={t('channelSheet.label', { name: channel.name ?? '' })} onClose={close} className="w-[32rem]">
      <div data-testid="channel-sheet" className="flex flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 pt-3">
          <span className="text-name font-semibold">#{channel.name}</span>
          <button onClick={close} aria-label={t('channelSheet.close')} className="ml-auto rounded-row px-2 py-1 text-fg-muted hover:bg-surface-hover">✕</button>
        </div>
        <div role="tablist" className="flex border-b border-border px-2">
          {tabButton('info', t('channelSheet.tab.info'))}
          {/* 숫자는 **아는 때만** — 못 받았으면 "멤버" 만(0 은 "아무도 없다" 로 읽힌다, #1034 와 같은 규칙). */}
          {tabButton('members', knownMembers ? t('channelSheet.tab.membersCount', { count: String(knownMembers.length) }) : t('channelSheet.tab.members'))}
          {tabButton('notify', t('channelSheet.tab.notify'))}
          {tabButton('agents', t('channelSheet.tab.agents'))}
        </div>

        <div className="p-4">
          {error && <p role="alert" className="mb-3 rounded-row border border-danger-border bg-danger-surface p-2 text-danger">{error}</p>}

          {tab === 'info' && editing && (
            <div role="tabpanel" id={panelId('info')} aria-labelledby={tabId('info')}>
              <ChannelEditForm channel={channel} onDone={() => setEditing(false)} />
            </div>
          )}

          {tab === 'info' && !editing && (
            <div data-testid="channel-sheet-info" role="tabpanel" id={panelId('info')} aria-labelledby={tabId('info')}>
              <dl className="grid grid-cols-[6rem_1fr] gap-y-2">
                <dt className="text-fg-subtle">{t('channelSheet.info.topic')}</dt>
                <dd className="text-fg">{channel.topic || <span className="text-fg-subtle">{t('channelSheet.info.none')}</span>}</dd>
                <dt className="text-fg-subtle">{t('channelSheet.info.visibility')}</dt>
                <dd className="text-fg">{channel.visibility === 'private' ? t('channelSheet.info.private') : t('channelSheet.info.public')}</dd>
                <dt className="text-fg-subtle">{t('channelSheet.info.repo')}</dt>
                <dd className="text-fg">{channel.repo ?? <span className="text-fg-subtle">{t('channelSheet.info.none')}</span>}</dd>
                {isArchived && <><dt className="text-fg-subtle">{t('channelSheet.info.state')}</dt><dd className="text-fg">{t('channel.header.archived')}</dd></>}
              </dl>
              {canManage && (
                <button data-testid="channel-sheet-edit" onClick={() => setEditing(true)} className="mt-3 rounded-row border border-border px-3 py-1 text-fg-muted hover:bg-surface-hover">
                  {t('channelSheet.edit')}
                </button>
              )}
              {leaveConfirm ? (
                <div className="mt-6 rounded-row border border-warning-border bg-warning-surface p-3">
                  <p className="text-warning">{t('channelSheet.leaveLast')}</p>
                  <div className="mt-2 flex gap-2">
                    <button disabled={busy} onClick={() => void leave(true)} className="rounded-row bg-danger px-3 py-1 text-fg-on-strong hover:bg-danger-hover">{t('channelSheet.leaveAnyway')}</button>
                    <button autoFocus onClick={() => setLeaveConfirm(false)} className="rounded-row border border-border px-3 py-1 text-fg-muted hover:bg-surface-hover">{t('channelSheet.cancel')}</button>
                  </div>
                </div>
              ) : (
                <div className="mt-6 flex gap-2 border-t border-border pt-4">
                  {canManage && (
                    <button data-testid="channel-sheet-archive" disabled={busy} onClick={() => void archive()} className="rounded-row border border-border px-3 py-1 text-fg-muted hover:bg-surface-hover disabled:opacity-50">
                      {isArchived ? t('sidebar.menu.unarchive') : t('sidebar.menu.archive')}
                    </button>
                  )}
                  {/* 되돌리기 어려운 쪽이라 빨강이다(designer ⑦: [채널 나가기(빨강)]). */}
                  {knownMember && (
                    <button data-testid="channel-sheet-leave" disabled={busy} onClick={() => void leave(false)} className="rounded-row border border-danger-border px-3 py-1 text-danger hover:bg-danger-surface disabled:opacity-50">
                      {t('channelSheet.leave')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'members' && (
            <div role="tabpanel" id={panelId('members')} aria-labelledby={tabId('members')}>
              <ChannelMembersPanel channel={channel} part="members" />
            </div>
          )}

          {tab === 'agents' && (
            <div role="tabpanel" id={panelId('agents')} aria-labelledby={tabId('agents')}>
              <ChannelMembersPanel channel={channel} part="agents" />
            </div>
          )}

          {tab === 'notify' && (
            <fieldset data-testid="channel-sheet-notify" role="tabpanel" id={panelId('notify')} aria-labelledby={tabId('notify')} className="flex flex-col gap-2">
              <legend className="mb-2 text-fg-subtle">{t('channelSheet.notify.legend')}</legend>
              {NOTIFY_LEVELS.map((l) => (
                <label key={l} className="flex items-center gap-2 text-fg">
                  <input
                    type="radio"
                    name="channel-notify"
                    checked={level === l}
                    onChange={() => { setError(null); void getController().setChannelNotifyLevel(channel.id, l).catch((err: unknown) => setError(errorText(err, t, t('channelSheet.notify.failed')))); }}
                  />
                  {t(NOTIFY_KEY[l])}
                </label>
              ))}
            </fieldset>
          )}
        </div>
      </div>
    </Overlay>
  );
}
