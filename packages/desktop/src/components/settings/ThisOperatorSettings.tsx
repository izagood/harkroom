import { useCallback, useEffect, useState } from 'react';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { useT } from '../../i18n/useT';
import { hasCapability } from '../../lib/capabilities';
import { hasOperatorLocalSurface, listLocalAgents, registerLocalOperator } from '../../lib/operatorLocal';
import type { SectionId } from './sections';
import { SettingsGroup, SettingsPage } from './primitives';

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
  | { kind: 'unknown' }
  | { kind: 'none' }
  | { kind: 'registered'; name: string | null; online: boolean | null };

export function ThisOperatorSettings({ onOpenSection }: {
  /** 같은 설정 화면 안의 다른 줄로 간다(오퍼레이터 목록). 없으면 링크 대신 글로만 적는다. */
  onOpenSection?: (id: SectionId) => void;
} = {}) {
  const t = useT();
  const me = useActiveStore((s) => s.me);
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
    if (!baseUrl) { setStatus({ kind: 'unknown' }); return; }
    try {
      const local = await listLocalAgents();
      const mine = local.communities.find((c) => c.baseUrl === baseUrl);
      if (!mine?.registered) { setStatus({ kind: 'none' }); return; }
      // 등록 기록은 있는데 id 를 모른다(한 번도 못 붙은 옛 설정) — 등록됨만 말하고 이름은 지어내지 않는다.
      if (!mine.operatorId) { setStatus({ kind: 'registered', name: null, online: null }); return; }
      const list = await getController().operators().catch(() => null);
      const op = list?.find((o) => o.id === mine.operatorId) ?? null;
      setStatus({ kind: 'registered', name: op?.name ?? null, online: op ? op.online : null });
    } catch {
      setStatus({ kind: 'unknown' });
    }
  }, []);
  useEffect(() => { if (localAvailable) void loadStatus(); }, [localAvailable, loadStatus]);
  const isRegistered = status.kind === 'registered';
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
      setError(t('operators.registerHereFailed', { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage section="this-operator" description={t('settings.desc.this-operator')}>
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
                  {status.kind === 'checking' && t('thisOperator.statusChecking')}
                  {status.kind === 'unknown' && t('thisOperator.statusUnknown')}
                  {status.kind === 'none' && t('thisOperator.statusNone')}
                  {status.kind === 'registered' && [
                    t('thisOperator.statusRegistered'),
                    status.name,
                    status.online === null ? null : status.online ? t('operators.online') : t('operators.offline'),
                  ].filter(Boolean).join(' · ')}
                </span>
              </p>
              <p className="mb-3 text-meta text-fg-muted">{t('operators.registerHereNote')}</p>
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
                {/* 이미 등록돼 있으면 **다시 등록** 으로 낮춘다(회색 테두리) — 같은 머신을 두 번 등록하지 않게. */}
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
    </SettingsPage>
  );
}
