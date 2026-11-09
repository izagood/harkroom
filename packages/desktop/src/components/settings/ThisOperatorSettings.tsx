import { useCallback, useEffect, useState } from 'react';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { useT } from '../../i18n/useT';
import { hasCapability } from '../../lib/capabilities';
import { hasOperatorLocalSurface, listLocalAgents, registerLocalOperator } from '../../lib/operatorLocal';
import type { SectionId } from './sections';
import { SettingsGroup, SettingsPage, Toggle } from './primitives';
import { getLoginItemSurface, setLoginItem, useLoginItem, type LoginItemView } from '../../lib/loginItem';
import { operatorNameOf } from '../../lib/operatorName';
import { errorText } from '../../lib/errorText';
import { getFdaSurface, useFdaStatus, type FdaStatus } from '../../lib/fullDiskAccess';
import { FullDiskAccessDialog } from '../FullDiskAccessDialog';

/**
 * 설정 › 이 기기 › **이 머신의 오퍼레이터**(UX ⑥b-2).
 *
 * 오퍼레이터 페이지(에이전트 묶음)에 있던 "이 머신을 등록" 묶음을 그대로 옮겨 왔다. 그 페이지는
 * 워크스페이스에 등록된 **모든** 머신의 목록이고, 이 버튼은 **이 기기 하나**에만 걸린다 — 묶음
 * 기준("누구에게 적용되나", ⑥a)으로 보면 사는 곳이 다르다.
 *
 * 보이는 값은 옮기기 전과 같다: 안내 한 줄, 버튼, 등록된 뒤의 **오퍼레이터 이름**(사람이 지은 이름,
 * 오퍼레이터가 등록 응답으로 돌려준 것) 하나. 머신 경로·runnerId·토큰은 화면에 오지 않는다 —
 * 등록 코드는 이 화면을 거치지 않고 Tauri 명령(`operator_register`)으로 곧장 오퍼레이터에 간다.
 */
/**
 * 이 머신이 **지금 등록돼 있는가**(designer #1016 검토). 목록이 다른 페이지로 갔으므로 이 페이지가
 * 스스로 말해야 한다 — 안 그러면 이미 등록한 사람에게도 [이 머신을 등록] 만 보여 같은 머신을 두 번
 * 등록하게 된다.
 *
 * 근거는 `AgentsSettings` 의 기본 배정과 같은 길이다: 오퍼레이터 로컬 설정
 * (`operator_agents_list`)의 **지금 서버 주소**에 해당하는 칸의 `registered`·`operatorId` →
 * `GET /operators` 에서 **그 id**(이름으로 고르지 않는다 — 같은 이름의 기기가 둘일 수 있다).
 * 모르면 "알 수 없다" 고 말한다 — 지어내지 않는다.
 */
type LocalStatus =
  | { kind: 'checking' }
  | { kind: 'unknown'; reason: string | null }
  | { kind: 'none' }
  | { kind: 'registered'; name: string | null; online: boolean | null };

export function ThisOperatorSettings({ onOpenSection }: {
  /** 같은 설정 화면 안의 다른 줄로 간다(오퍼레이터 목록). 없으면 링크 대신 글로만 적는다. */
  onOpenSection?: (id: SectionId) => void;
} = {}) {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  // 앱 기동 때 오퍼레이터를 못 세웠거나 등록하지 못한 사유(`controller.ts::ensureOperatorAndRegister`).
  const startupIssue = useActiveStore((s) => s.operatorStartupIssue);
  const canRegister = hasCapability(me, 'operator.register');
  const localAvailable = hasOperatorLocalSurface();
  const [registered, setRegistered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<LocalStatus>({ kind: 'checking' });
  /**
   * 다시 등록의 결과. `replaced` 면 서버가 옛 등록을 폐기하고 배정을 옮겼다. `kept` 면 폐기하지
   * 않았다 — `replaces` 를 모르는 옛 서버다(남의 id 였을 때도 서버는 같은 답을 준다). 그때는
   * 옛 등록이 토큰째 살아 있으므로 직접 지우라고 말한다.
   */
  const [again, setAgain] = useState<{ kind: 'replaced'; moved: number } | { kind: 'kept' } | null>(null);

  const loadStatus = useCallback(async (): Promise<void> => {
    const baseUrl = getController().api?.baseUrl ?? null;
    if (!baseUrl) { setStatus({ kind: 'unknown', reason: null }); return; }
    try {
      const local = await listLocalAgents();
      const mine = local.communities.find((c) => c.baseUrl === baseUrl);
      if (!mine?.registered) { setStatus({ kind: 'none' }); return; }
      // 등록 기록은 있는데 id 를 모른다(한 번도 못 붙은 옛 설정) — 등록됨만 말하고 이름은 지어내지 않는다.
      if (!mine.operatorId) { setStatus({ kind: 'registered', name: null, online: null }); return; }
      const list = await getController().operators().catch(() => null);
      const op = list?.find((o) => o.id === mine.operatorId) ?? null;
      setStatus({ kind: 'registered', name: operatorNameOf(op) ?? null, online: op ? op.online : null });
    } catch (e) {
      // 사유를 버리지 않는다 — 「알 수 없다」만으로는 사람이 할 일이 없다(오퍼레이터가 안 떴는지, 소켓이 막혔는지).
      setStatus({ kind: 'unknown', reason: errorText(e, t) });
    }
  }, [t]);
  useEffect(() => { if (localAvailable) void loadStatus(); }, [localAvailable, loadStatus]);
  const isRegistered = status.kind === 'registered';
  // 오퍼레이터가 **아예 안 떴다**(designer #2) — 등록은 그 뒤의 일이다. 머리·버튼을 「다시 시도」로 바꾼다.
  const startFailed = startupIssue?.kind === 'start' && !isRegistered;
  // 확인 중에는 어느 쪽 버튼인지 아직 모른다 — 누르게 두면 등록된 머신을 확인 창 없이 한 번 더 등록한다.
  const checking = status.kind === 'checking';

  const registerHere = async () => {
    const wasRegistered = isRegistered;
    setError(null); setRegistered(null); setAgain(null);
    setBusy(true);
    try {
      const minted = await getController().operatorRegisterCode();
      const baseUrl = getController().api?.baseUrl;
      if (!baseUrl) throw new Error(t('thisOperator.noServer'));
      const out = await registerLocalOperator(baseUrl, minted.code);
      setRegistered(out.name);
      if (out.replaced) setAgain({ kind: 'replaced', moved: out.replaced.movedAssignments });
      else if (wasRegistered) setAgain({ kind: 'kept' });
      void loadStatus();
    } catch (e) {
      setError(t('operators.registerHereFailed', { reason: errorText(e, t) }));
    } finally {
      setBusy(false);
    }
  };

  const retryStart = async () => {
    setError(null);
    setBusy(true);
    try {
      await getController().ensureOperatorAndRegister();
      void loadStatus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage section="this-operator" description={t('settings.desc.this-operator')} layout="form">
      <SettingsGroup>
        <div className="px-4 py-3">
          {/* 쓸 수 없는 사정을 **말한다** — 버튼을 그냥 숨기면 왜 없는지 모른다. */}
          {!localAvailable && (
            <>
              <p className="text-meta text-fg-muted" data-testid="this-operator-unavailable">{t('thisOperator.unavailable')}</p>
              {onOpenSection && (
                <button className="mt-2 rounded-row px-2 py-1 text-meta text-accent hover:bg-surface-sunken" onClick={() => onOpenSection('operators')}>
                  {t('thisOperator.openList')}
                </button>
              )}
            </>
          )}
          {localAvailable && !canRegister && <p className="text-meta text-fg-muted" data-testid="this-operator-no-cap">{t('thisOperator.noCap')}</p>}
          {localAvailable && canRegister && (
            <>
              {/* 지금 상태 한 줄(designer) — "등록됨 · 이름 · 연결됨" / "아직 등록 안 됨" / 모름. */}
              <p className="mb-3 flex items-center gap-2 font-medium text-fg" data-testid="this-operator-status" data-state={status.kind}>
                {/* 연결됨·끊김 앞의 점(designer) — 사이드바의 연결 점과 같은 뜻의 색. */}
                {status.kind === 'registered' && status.online !== null && (
                  <span aria-hidden data-testid="this-operator-dot" className={`h-2 w-2 shrink-0 rounded-full ${status.online ? 'bg-success' : 'bg-fg-subtle'}`} />
                )}
                <span>
                  {startFailed && t('operatorStartup.banner.start')}
                  {!startFailed && status.kind === 'checking' && t('thisOperator.statusChecking')}
                  {!startFailed && status.kind === 'unknown' && (status.reason ?? startupIssue?.reason
                    ? t('thisOperator.statusUnknownReason', { reason: status.reason ?? startupIssue?.reason ?? '' })
                    : t('thisOperator.statusUnknown'))}
                  {!startFailed && status.kind === 'none' && t('thisOperator.statusNone')}
                  {status.kind === 'registered' && [
                    t('thisOperator.statusRegistered'),
                    status.name,
                    status.online === null ? null : status.online ? t('operators.online') : t('operators.offline'),
                  ].filter(Boolean).join(' · ')}
                </span>
                {/* 이름은 Operators 에서만 바꾼다(designer) — 같은 조작을 두 자리에 두지 않고 그리로 보낸다. */}
                {status.kind === 'registered' && status.name && onOpenSection && (
                  <button
                    data-testid="this-operator-rename"
                    className="rounded-row px-1 text-meta font-normal text-accent hover:bg-surface-sunken"
                    onClick={() => onOpenSection('operators')}
                  >
                    {t('thisOperator.renameInList')}
                  </button>
                )}
              </p>
              {/* 기동 때의 실패를 여기서도 말한다 — 띠를 닫았어도 이 화면에 오면 사유가 보여야 한다. */}
              {/* 시작 실패: 머리가 이미 그 말을 하므로 여기엔 사유 전문만(PATH 가 카드를 뚫지 않게 break-all). */}
              {startFailed && startupIssue && (
                <p className="mb-3 break-all text-meta text-warning" data-testid="this-operator-startup-issue">
                  {startupIssue.reason}
                </p>
              )}
              {startupIssue?.kind === 'register' && !isRegistered && (
                <p className="mb-3 text-meta text-warning" data-testid="this-operator-startup-issue">
                  {t('operatorStartup.banner.register')} {startupIssue.reason}
                </p>
              )}
              {/* 「이 머신에는 오퍼레이터가 돈다」는 시작 실패와 반대 말이다 — 그때는 숨긴다. */}
              {!startFailed && <p className="mb-3 text-meta text-fg-muted">{t('operators.registerHereNote')}</p>}
              {registered && (
                <p className="mb-3 text-meta text-success" data-testid="operator-registered-here">{t('operators.registerHereDone', { name: registered })}</p>
              )}
              {again?.kind === 'replaced' && (
                <p className="mb-3 text-meta text-fg-muted" data-testid="this-operator-replaced">{t('thisOperator.replacedDone', { n: again.moved })}</p>
              )}
              {again?.kind === 'kept' && (
                <p role="alert" className="mb-3 text-meta text-danger" data-testid="this-operator-kept">{t('thisOperator.replacedKept')}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {/* 시작 실패면 등록 대신 **다시 시도** — 오퍼레이터가 없으면 등록도 같은 이유로 실패한다. 등록은 성공 뒤 자동으로 이어진다. */}
                {startFailed ? (
                  <button
                    data-testid="this-operator-retry-start"
                    className="rounded-row bg-accent px-4 py-2 font-medium text-fg-on-strong disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void retryStart()}
                  >
                    {busy ? t('operatorStartup.retrying') : t('operatorStartup.retry')}
                  </button>
                ) : (
                // 이미 등록돼 있으면 **다시 등록** 으로 낮춘다(회색 테두리) — 같은 머신을 두 번 등록하지 않게.
                <button
                  data-testid="this-operator-register"
                  className={isRegistered || checking
                    ? 'rounded-row border border-border px-4 py-2 font-medium text-fg hover:bg-surface-sunken disabled:opacity-50'
                    : 'rounded-row bg-accent px-4 py-2 font-medium text-fg-on-strong disabled:opacity-50'}
                  disabled={busy || checking}
                  onClick={() => void registerHere()}
                >
                  {busy ? t('operators.registerBusy') : isRegistered ? t('thisOperator.registerAgain') : t('operators.registerHere')}
                </button>
                )}
                {/* 등록된 머신 목록은 에이전트 › 오퍼레이터에 있다 — 글로만 적지 않고 그리로 간다. */}
                {onOpenSection && (
                  <button
                    data-testid="this-operator-open-list"
                    className="rounded-row px-2 py-2 text-meta text-accent hover:bg-surface-sunken"
                    onClick={() => onOpenSection('operators')}
                  >
                    {t('thisOperator.openList')}
                  </button>
                )}
              </div>
              {isRegistered && (
                <p className="mt-2 text-meta text-fg-muted" data-testid="this-operator-again-note">{t('thisOperator.registerAgainNote')}</p>
              )}
            </>
          )}
          {error && <p role="alert" className="mt-3 text-meta text-danger">{error}</p>}
        </div>
      </SettingsGroup>
      <LoginItemGroup />
      <FullDiskAccessGroup />
    </SettingsPage>
  );
}

/**
 * 「macOS 권한」 묶음 — 전체 디스크 접근 한 줄(시안 v2 ③). 권한은 이 맥에만 걸리고 영향을 받는 것이 이 맥에서 도는
 * 에이전트라 이 페이지에 산다. 안내 창을 거절한 뒤 **다시 여는 길은 여기 하나**다(소유자 결정 #2). 창에 포커스가
 * 돌아올 때마다 다시 확인한다. macOS 14 미만·데스크톱 밖이면 묶음째 숨긴다.
 */
function FullDiskAccessGroup() {
  const t = useT();
  const { status } = useFdaStatus();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (status === null || status === 'unsupported') return null;

  const chip: Record<Exclude<FdaStatus, 'unsupported'>, { label: string; under: string; cls: string }> = {
    on: { label: t('fda.chip.on'), under: t('fda.row.on'), cls: 'bg-success-surface text-success' },
    off: { label: t('fda.chip.off'), under: t('fda.row.off'), cls: 'border border-border bg-surface-sunken text-fg-muted' },
    restart: { label: t('fda.chip.restart'), under: t('fda.row.restart'), cls: 'bg-warning-surface text-warning' },
    unknown: { label: t('fda.chip.unknown'), under: t('fda.row.unknown'), cls: 'border border-border bg-surface-sunken text-fg-muted' },
  };
  const c = chip[status];
  const act = (fn: () => Promise<void>) => {
    setError(null);
    fn().catch((e) => setError(t('fda.actionFailed', { reason: errorText(e, t) })));
  };

  return (
    <SettingsGroup title={t('fda.group')}>
      <div className="flex items-start gap-4 px-4 py-3" data-testid="fda-row" data-state={status}>
        <div className="min-w-0">
          <p className="font-medium text-fg">{t('fda.rowLabel')}</p>
          <p className="mt-0.5 text-meta text-fg-muted">{c.under}</p>
          {error && <p role="alert" className="mt-1 text-meta text-danger">{error}</p>}
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
          <span data-testid="fda-chip" className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-meta font-semibold ${c.cls}`}>
            {status === 'on' && <span aria-hidden className="h-2 w-2 rounded-full bg-success" />}
            {c.label}
          </span>
          {status === 'on' && (
            <button data-testid="fda-turn-off" className="rounded-row px-1 text-meta text-link hover:bg-surface-sunken" onClick={() => act(() => getFdaSurface().openSettings())}>
              {t('fda.turnOffInSettings')}
            </button>
          )}
          {status === 'off' && (
            <button data-testid="fda-how-to" className="rounded-row border border-border px-3 py-1 text-fg hover:bg-surface-sunken" onClick={() => setOpen(true)}>
              {t('fda.howTo')}
            </button>
          )}
          {status === 'restart' && (
            <button data-testid="fda-row-restart" className="rounded-row border border-border px-3 py-1 text-fg hover:bg-surface-sunken" onClick={() => act(() => getFdaSurface().relaunch())}>
              {t('fda.restart')}
            </button>
          )}
        </div>
      </div>
      {open && <FullDiskAccessDialog status={status} onClose={() => setOpen(false)} />}
    </SettingsGroup>
  );
}

/**
 * 「시작」 묶음 — 로그인할 때 자동으로 시작 한 줄(designer 시안 2절). 등록 카드와 「macOS 권한」 사이에 선다: 영향을 받는
 * 것이 이 맥에서 도는 에이전트라 이 페이지에 산다. macOS 13 미만·데스크톱 밖이면 묶음째 숨긴다.
 *
 * 다섯 상태: 꺼짐·켜짐은 스위치만. 승인 대기는 스위치 켜진 채 주의 칩 + [시스템 설정 열기]. 켜지 못함은 스위치를 꺼짐으로
 * 되돌리고(거짓으로 켜져 보이지 않게) 위험색 사유 + [다시 시도]. 시스템 설정에서 꺼짐은 회색 설명만.
 */
function LoginItemGroup() {
  const t = useT();
  const { view, failure } = useLoginItem();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (view === 'hidden') return null;

  // 켜기 실패는 줄의 「켜지 못함」이 사유째 말한다 — 같은 사유를 두 번 쓰지 않는다. 끄기 실패만 아래 한 줄로.
  const toggle = (next: boolean) => {
    setError(null);
    setBusy(true);
    setLoginItem(next)
      .catch((e) => { if (!next) setError(t('loginItem.actionFailed', { reason: errorText(e, t) })); })
      .finally(() => setBusy(false));
  };
  const openSystem = () => {
    setError(null);
    getLoginItemSurface().openSettings().catch((e) => setError(t('loginItem.actionFailed', { reason: errorText(e, t) })));
  };

  const under: Record<Exclude<LoginItemView, 'hidden'>, { text: string; cls?: string }> = {
    off: { text: t('loginItem.row.off') },
    on: { text: t('loginItem.row.on') },
    approval: { text: t('loginItem.row.approval'), cls: 'text-warning' },
    failed: { text: t('loginItem.row.failed', { reason: failure ?? '' }), cls: 'break-all text-danger' },
    system: { text: t('loginItem.row.system') },
  };
  const chipCls = 'inline-flex items-center rounded-full bg-warning-surface px-2 py-0.5 text-meta font-semibold text-warning';
  const btnCls = 'rounded-row border border-border px-3 py-1 text-fg hover:bg-surface-sunken disabled:opacity-50';
  const side = view === 'approval' ? (
    <>
      <span data-testid="login-item-chip" className={chipCls}>{t('loginItem.chip.approval')}</span>
      <button type="button" data-testid="login-item-open-system" className={btnCls} onClick={openSystem}>{t('loginItem.openSystem')}</button>
    </>
  ) : view === 'failed' ? (
    <>
      <span data-testid="login-item-chip" className={chipCls}>{t('loginItem.chip.failed')}</span>
      <button type="button" data-testid="login-item-retry" className={btnCls} disabled={busy} onClick={() => toggle(true)}>{t('loginItem.retry')}</button>
    </>
  ) : undefined;

  return (
    <SettingsGroup title={t('loginItem.group')}>
      <div data-testid="login-item-row" data-state={view}>
        <Toggle
          label={t('loginItem.label')}
          description={under[view].text}
          descriptionClassName={under[view].cls}
          checked={view === 'on' || view === 'approval'}
          disabled={busy}
          onChange={toggle}
          side={side}
          testId="login-item-switch"
        />
        {error && <p role="alert" className="px-4 pb-3 text-meta text-danger">{error}</p>}
      </div>
    </SettingsGroup>
  );
}
