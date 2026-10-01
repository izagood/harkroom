import { useState } from 'react';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { useT } from '../../i18n/useT';
import { hasCapability } from '../../lib/capabilities';
import { hasOperatorLocalSurface, registerLocalOperator } from '../../lib/operatorLocal';
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
export function ThisOperatorSettings() {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const canRegister = hasCapability(me, 'operator.register');
  const localAvailable = hasOperatorLocalSurface();
  const [registered, setRegistered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const registerHere = async () => {
    setError(null); setRegistered(null);
    setBusy(true);
    try {
      const minted = await getController().operatorRegisterCode();
      const baseUrl = getController().api?.baseUrl;
      if (!baseUrl) throw new Error(t('thisOperator.noServer'));
      const out = await registerLocalOperator(baseUrl, minted.code);
      setRegistered(out.name);
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
          {!localAvailable && <p className="text-meta text-fg-muted" data-testid="this-operator-unavailable">{t('thisOperator.unavailable')}</p>}
          {localAvailable && !canRegister && <p className="text-meta text-fg-muted" data-testid="this-operator-no-cap">{t('thisOperator.noCap')}</p>}
          {localAvailable && canRegister && (
            <>
              <p className="mb-3 text-meta text-fg-muted">{t('operators.registerHereNote')}</p>
              {registered && (
                <p className="mb-3 text-meta text-success" data-testid="operator-registered-here">{t('operators.registerHereDone', { name: registered })}</p>
              )}
              <button
                className="rounded bg-accent px-4 py-2 font-medium text-fg-on-strong disabled:opacity-50"
                disabled={busy}
                onClick={() => void registerHere()}
              >
                {busy ? t('operators.registerBusy') : t('operators.registerHere')}
              </button>
            </>
          )}
          {error && <p role="alert" className="mt-3 text-meta text-danger">{error}</p>}
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
