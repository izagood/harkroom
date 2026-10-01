import { useEffect, useState } from 'react';
import { NOTIFY_LEVELS, notifyLevelOf, type NotifyLevel } from '@harkroom/shared';
import { Overlay } from './Overlay';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useT } from '../i18n/useT';
import type { MessageKey } from '../i18n';

const NOTIFY_KEY: Record<NotifyLevel, MessageKey> = {
  all: 'sidebar.notify.all',
  mentions: 'sidebar.notify.mentions',
  none: 'sidebar.notify.none',
};

type Tab = 'info' | 'notify';

/**
 * 채널 설정 시트(UX ⑦b-1, designer 사양 ⑦). 채널 머리의 "# 이름 ⌄" 과 사이드바 메뉴의 "채널 설정…" 이
 * 같은 것을 연다(`channelSheetId`).
 *
 * 이 조각은 **정보 · 알림** 두 탭이다. 사양의 멤버 · 에이전트 탭은 지금 사이드바 안의 멤버 패널(초대·팀 추가·
 * 자동 멘션)을 통째로 옮기는 일이라 ⑦b-2 로 나눴다 — 반쯤 옮기면 같은 조작이 두 자리에 산다.
 *
 * 이름·주제·저장소 **편집**도 아직 사이드바 인라인 폼에 남는다(투영 경고·회귀선 17개가 그 폼에 걸려 있다) —
 * ⑦b-2 에서 멤버 패널과 함께 옮긴다. 이 시트는 그 값을 **보여 주기만** 한다.
 *
 * 규칙은 사이드바의 나가기와 같다(그 자리 주석이 근거다):
 * - 나가기 전에 멤버 목록을 받아 **마지막 멤버면 한 번 묻는다**. 조회 실패를 빈 목록으로 삼키지 않는다.
 * - 보관은 admin 에게만 낸다(서버도 같은 판정을 한다).
 */
export function ChannelSettingsSheet() {
  const t = useT();
  const channelId = useActiveStore((s) => s.channelSheetId);
  const channel = useActiveStore((s) => s.channels.find((c) => c.id === s.channelSheetId));
  const me = useActiveStore((s) => s.me);
  const pref = useActiveStore((s) => (s.channelSheetId ? s.channelPrefs[s.channelSheetId] : undefined));
  const [tab, setTab] = useState<Tab>('info');
  const [error, setError] = useState<string | null>(null);
  const [leaveConfirm, setLeaveConfirm] = useState(false);

  // 다른 채널로 열리면 처음부터 — 앞 채널의 나가기 확인이 남으면 엉뚱한 채널을 떠난다.
  useEffect(() => { setTab('info'); setError(null); setLeaveConfirm(false); }, [channelId]);

  if (!channelId || !channel) return null;
  const close = () => useActiveStore.getState().set({ channelSheetId: null });
  const isArchived = channel.archivedAt != null;
  const level = notifyLevelOf(pref);

  const archive = async () => {
    setError(null);
    try { await getController().archiveChannel(channel.id, !isArchived); }
    catch (err) { setError(err instanceof Error ? err.message : t('channelSheet.archiveFailed')); }
  };

  const leave = async (confirmed: boolean) => {
    if (!me) return;
    setError(null);
    if (!confirmed) {
      let members;
      try { members = await getController().loadChannelMembers(channel.id); }
      catch (err) { setError(err instanceof Error ? err.message : t('sidebar.members.listFailed')); return; }
      if (!members.some((m) => m.accountId === me.id)) { setError(t('sidebar.members.notAMember')); return; }
      if (members.length === 1) { setLeaveConfirm(true); return; }
    }
    try { await getController().leaveChannel(channel.id, me.id); close(); }
    catch (err) { setError(err instanceof Error ? err.message : t('sidebar.members.leaveFailed')); }
  };

  const tabButton = (id: Tab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === id}
      data-testid={`channel-sheet-tab-${id}`}
      onClick={() => setTab(id)}
      className={`border-b-2 px-3 py-2 ${tab === id ? 'border-accent font-semibold text-fg' : 'border-transparent text-fg-muted hover:text-fg'}`}
    >
      {label}
    </button>
  );

  return (
    <Overlay label={t('channelSheet.label', { name: channel.name ?? '' })} onClose={close} className="w-[32rem]">
      <div data-testid="channel-sheet" className="flex flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 pt-3">
          <span className="text-name font-bold">#{channel.name}</span>
          <button onClick={close} aria-label={t('channelSheet.close')} className="ml-auto rounded px-2 py-1 text-fg-muted hover:bg-surface-hover">✕</button>
        </div>
        <div role="tablist" className="flex border-b border-border px-2">
          {tabButton('info', t('channelSheet.tab.info'))}
          {tabButton('notify', t('channelSheet.tab.notify'))}
        </div>

        <div className="p-4">
          {error && <p role="alert" className="mb-3 rounded border border-danger-border bg-danger-surface p-2 text-danger">{error}</p>}

          {tab === 'info' && (
            <div data-testid="channel-sheet-info">
              <dl className="grid grid-cols-[6rem_1fr] gap-y-2">
                <dt className="text-fg-subtle">{t('channelSheet.info.topic')}</dt>
                <dd className="text-fg">{channel.topic || <span className="text-fg-subtle">{t('channelSheet.info.none')}</span>}</dd>
                <dt className="text-fg-subtle">{t('channelSheet.info.visibility')}</dt>
                <dd className="text-fg">{channel.visibility === 'private' ? t('channelSheet.info.private') : t('channelSheet.info.public')}</dd>
                <dt className="text-fg-subtle">{t('channelSheet.info.repo')}</dt>
                <dd className="text-fg">{channel.repo ?? <span className="text-fg-subtle">{t('channelSheet.info.none')}</span>}</dd>
                {isArchived && <><dt className="text-fg-subtle">{t('channelSheet.info.state')}</dt><dd className="text-fg">{t('channel.header.archived')}</dd></>}
              </dl>
              {leaveConfirm ? (
                <div className="mt-6 rounded border border-warning-border bg-warning-surface p-3">
                  <p className="text-warning">{t('channelSheet.leaveLast')}</p>
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => void leave(true)} className="rounded bg-danger px-3 py-1 text-fg-on-strong hover:bg-danger-hover">{t('channelSheet.leaveAnyway')}</button>
                    <button autoFocus onClick={() => setLeaveConfirm(false)} className="rounded border border-border px-3 py-1 text-fg-muted hover:bg-surface-hover">{t('channelSheet.cancel')}</button>
                  </div>
                </div>
              ) : (
                <div className="mt-6 flex gap-2 border-t border-border pt-4">
                  {me?.isAdmin && (
                    <button data-testid="channel-sheet-archive" onClick={() => void archive()} className="rounded border border-border px-3 py-1 text-fg-muted hover:bg-surface-hover">
                      {isArchived ? t('sidebar.menu.unarchive') : t('sidebar.menu.archive')}
                    </button>
                  )}
                  {/* 되돌리기 어려운 쪽이라 빨강이다(designer ⑦: [채널 나가기(빨강)]). */}
                  <button data-testid="channel-sheet-leave" onClick={() => void leave(false)} className="rounded border border-danger-border px-3 py-1 text-danger hover:bg-danger-surface">
                    {t('channelSheet.leave')}
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === 'notify' && (
            <fieldset data-testid="channel-sheet-notify" className="flex flex-col gap-2">
              <legend className="mb-2 text-fg-subtle">{t('channelSheet.notify.legend')}</legend>
              {NOTIFY_LEVELS.map((l) => (
                <label key={l} className="flex items-center gap-2 text-fg">
                  <input
                    type="radio"
                    name="channel-notify"
                    checked={level === l}
                    onChange={() => { setError(null); void getController().setChannelNotifyLevel(channel.id, l).catch((err: unknown) => setError(err instanceof Error ? err.message : t('channelSheet.notify.failed'))); }}
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
