import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { hasOperatorLocalSurface, listLocalAgents, onLocalAgentsChanged } from '../lib/operatorLocal';
import { fdaPromptStorage, shouldPrompt, useFdaStatus } from '../lib/fullDiskAccess';
import { getLoginItemSurface, loginItemStorage, setLoginItem, shouldAskLoginItem, useLoginItem } from '../lib/loginItem';
import { OPERATOR_STARTUP_SECTION } from './OperatorStartupBanner';
import type { SectionId } from './settings/sections';

/**
 * 작업 화면 위의 「로그인할 때 자동으로 시작」 자리(designer 시안 3·4절).
 *
 * - **한 번 묻는 띠(파랑)**: 이 맥이 오퍼레이터로 등록된 뒤, 꺼져 있고 아직 안 물었으면 한 번만 묻는다(B안). 기본은 꺼짐.
 *   전체 디스크 접근 첫 창이 떠 있거나 곧 뜰 차례면 그 뒤에 선다. 띄우는 순간 「물었음」을 적는다 — 어떻게 닫든 다시 묻지 않는다.
 * - **주의 띠**: 켰는데 macOS 승인을 기다리거나 켜지 못했을 때만. 모양·닫기는 `OperatorStartupBanner` 와 같다
 *   (주의색, 고치는 문이 띠 안, [나중에]는 사유별). 오퍼레이터 시작 실패 띠가 서 있으면 그쪽 하나만 보인다(더 급하다).
 *   사람이 시스템 설정에서 직접 끈 것은 사람이 고른 것이라 띠 없이 설정 줄에만 적는다.
 */
export function LoginItemHost({ fdaDialogOpen, onOpenSettings }: {
  fdaDialogOpen: boolean;
  onOpenSettings?: (section?: SectionId) => void;
}) {
  const t = useT();
  const { status, view, failure, wanted } = useLoginItem();
  const { status: fda } = useFdaStatus();
  const startupIssue = useActiveStore((s) => s.operatorStartupIssue);
  const [registered, setRegistered] = useState(false);
  const [ask, setAsk] = useState<'ask' | 'done' | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);

  // 묻기 전에만 등록 여부를 본다 — 묻고 나면 다시 읽을 까닭이 없다.
  const askable = status === 'off' && !wanted && !loginItemStorage.wasAsked();
  useEffect(() => {
    if (!askable || startupIssue || !hasOperatorLocalSurface()) return;
    const baseUrl = getController().api?.baseUrl;
    if (!baseUrl) return;
    let live = true;
    const read = () => {
      listLocalAgents(baseUrl)
        .then((local) => { if (live) setRegistered(!!local.communities.find((c) => c.baseUrl === baseUrl)?.registered); })
        .catch(() => {});
    };
    read();
    // 첫 실행은 이 자리가 먼저 서고 자동 등록이 뒤에 끝난다 — 등록이 끝나면 다시 읽는다.
    const off = onLocalAgentsChanged(read);
    return () => { live = false; off(); };
  }, [askable, startupIssue]);

  // FDA 첫 창이 **뜰 차례**(상태를 아직 모르거나, 꺼져 있고 안 물었음)거나 떠 있으면 비킨다.
  const fdaBusy = fdaDialogOpen || fda === null || shouldPrompt(fda, fdaPromptStorage.wasShown());
  useEffect(() => {
    if (ask === null && shouldAskLoginItem({ status, asked: loginItemStorage.wasAsked(), wanted, registered, fdaBusy })) {
      loginItemStorage.markAsked();
      setAsk('ask');
    }
  }, [ask, status, wanted, registered, fdaBusy]);

  const turnOn = () => {
    setBusy(true);
    // 실패면 아래 주의 띠(켜지 못함)가 말한다 — 묻는 띠는 내린다.
    setLoginItem(true).then((s) => setAsk(s === 'on' ? 'done' : null), () => setAsk(null)).finally(() => setBusy(false));
  };

  if (ask === 'ask' || ask === 'done') {
    return (
      <div role="status" data-testid="login-item-ask" className="flex items-start gap-2 border-b border-border bg-accent-surface px-4 py-2 text-body text-fg">
        {ask === 'ask' ? (
          <>
            <div className="min-w-0 flex-1">
              <p className="break-keep">{t('loginItem.ask.body')}</p>
              <p className="text-meta opacity-80">{t('loginItem.ask.sub')}</p>
            </div>
            <button data-testid="login-item-ask-on" disabled={busy} className="shrink-0 rounded-row bg-accent px-2 py-0.5 font-medium text-fg-on-strong hover:bg-accent-hover disabled:opacity-50" onClick={turnOn}>
              {t('loginItem.ask.on')}
            </button>
            <button data-testid="login-item-ask-no" className="shrink-0 rounded-row border border-border px-2 py-0.5 hover:bg-surface-sunken" onClick={() => setAsk(null)}>
              {t('loginItem.ask.no')}
            </button>
          </>
        ) : (
          <>
            <p className="min-w-0 flex-1 break-keep" data-testid="login-item-ask-done">{t('loginItem.row.on')}</p>
            <button data-testid="login-item-ask-close" aria-label={t('fda.close')} className="shrink-0 rounded-sm px-1 hover:bg-surface-sunken" onClick={() => setAsk(null)}>×</button>
          </>
        )}
      </div>
    );
  }

  if (view !== 'approval' && view !== 'failed') return null;
  if (startupIssue) return null;
  const key = view === 'approval' ? 'approval' : `failed:${(failure ?? '').split('(')[0]!.trim().slice(0, 120)}`;
  if (dismissed === key) return null;
  return (
    <div role="alert" data-testid="login-item-band" data-state={view} className="flex items-start gap-2 border-b border-warning-border bg-warning-surface px-4 py-2 text-body text-warning">
      <div className="min-w-0 flex-1">
        <p className="break-keep">{view === 'approval' ? t('loginItem.band.approval') : t('loginItem.band.failed')}</p>
        {view === 'failed' && failure && (
          <span className="block truncate text-meta opacity-80" title={failure} data-testid="login-item-band-reason">{failure}</span>
        )}
      </div>
      {view === 'approval' ? (
        <button data-testid="login-item-band-system" className="shrink-0 rounded-row px-2 py-0.5 underline hover:bg-warning-surface-strong" onClick={() => { void getLoginItemSurface().openSettings().catch(() => {}); }}>
          {t('loginItem.openSystem')}
        </button>
      ) : onOpenSettings && (
        <button data-testid="login-item-band-settings" className="shrink-0 rounded-row px-2 py-0.5 underline hover:bg-warning-surface-strong" onClick={() => onOpenSettings(OPERATOR_STARTUP_SECTION)}>
          {t('operatorStartup.banner.openSettings')}
        </button>
      )}
      <button data-testid="login-item-band-dismiss" aria-label={t('operatorStartup.banner.dismiss')} className="shrink-0 rounded-sm px-1 hover:bg-warning-surface-strong" onClick={() => setDismissed(key)}>
        {t('operatorStartup.banner.dismiss')} ×
      </button>
    </div>
  );
}
