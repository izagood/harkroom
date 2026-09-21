import { useCallback, useEffect, useState } from 'react';
import type { OperatorView } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { useT } from '../../i18n/useT';
import { hasCapability } from '../../lib/capabilities';
import { SettingsGroup, SettingsPage } from './primitives';

/**
 * 설정 › Operators — 스펙 2026-09-20 §3.
 *
 * 앱은 러너를 띄우지 않는다. 러너를 띄우는 것은 어느 머신에 상주하는 **오퍼레이터**이고,
 * 사람이 앱에서 하는 일은 그것을 **등록**(1회용 코드 → 그 머신의 `harkroom-operator
 * register`)하고, 등록된 것을 보고, 더 안 쓰는 것을 폐기하는 것뿐이다. 에이전트를 어느
 * 오퍼레이터에서 돌릴지는 에이전트 상세의 배정이 정한다 — 이 화면은 그 목록의 출처다.
 *
 * ## 코드는 한 번만 보인다
 *
 * 등록 코드는 서버가 메모리에만 5분 들고 있고 한 번 쓰면 사라진다. 그래서 초대 토큰과
 * 같은 규율로 그린다(`InviteSettings`): 지금 안 옮기면 다시 못 본다는 말을 코드 옆에 둔다.
 */
export function OperatorsSettings() {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const canRegister = hasCapability(me, 'operator.register');
  const [operators, setOperators] = useState<OperatorView[] | 'error' | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void getController().operators().then(setOperators).catch(() => setOperators('error'));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const issue = async () => {
    setError(null);
    setBusy(true);
    try {
      setCode(await getController().operatorRegisterCode());
    } catch (e) {
      setError(e instanceof Error ? e.message : t('operators.registerFailed'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (op: OperatorView) => {
    setError(null);
    try {
      await getController().revokeOperator(op.id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('operators.revokeFailed'));
    }
  };

  return (
    <SettingsPage title="Operators" description={t('operators.description')}>
      <SettingsGroup>
        {operators === null && <p className="px-4 py-3 text-meta text-fg-muted">{t('operators.loading')}</p>}
        {operators === 'error' && <p role="alert" className="px-4 py-3 text-meta text-danger">{t('operators.listFailed')}</p>}
        {Array.isArray(operators) && operators.length === 0 && (
          <p className="px-4 py-3 text-meta text-fg-subtle">{t('operators.none')}</p>
        )}
        {Array.isArray(operators) && operators.map((op) => (
          <div key={op.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-fg">{op.name}</span>
              <span className="mt-0.5 block text-meta text-fg-subtle" data-testid={`operator-online-${op.id}`}>
                {/* 연결은 **지금의 사실**이다(허브가 든다) — 저장된 값이 아니라 목록을 읽은
                    순간의 값이고, 끊긴 오퍼레이터의 배정은 서버가 오프라인으로 그린다. */}
                <span className={`mr-1 inline-block h-2 w-2 rounded-full ${op.online ? 'bg-success' : 'bg-fg-subtle'}`} />
                {op.online ? t('operators.online') : t('operators.offline')}
                {op.lastSeenAt && !op.online && ` · ${t('operators.lastSeen', { at: new Date(op.lastSeenAt).toLocaleString() })}`}
              </span>
            </span>
            <button
              className="shrink-0 rounded border border-border px-2 py-1 text-meta text-fg hover:bg-surface-sunken"
              aria-label={t('operators.revokeAction', { name: op.name })}
              onClick={() => void revoke(op)}
            >
              {t('operators.revoke')}
            </button>
          </div>
        ))}
      </SettingsGroup>

      {error && (
        <div className="mb-4 rounded border border-danger-border bg-danger-surface p-3">
          <p role="alert" className="text-meta text-danger">{error}</p>
        </div>
      )}

      {canRegister && (
        <SettingsGroup>
          <div className="px-4 py-3">
            <p className="mb-3 text-meta text-fg-muted">{t('operators.registerNote')}</p>
            {code && (
              <div className="mb-3 rounded border border-warning-border bg-warning-surface p-3">
                <div className="font-semibold text-warning">{t('operators.codeWarning')}</div>
                <code className="mt-1 block break-all rounded bg-surface-raised p-2 text-meta">{code.code}</code>
                {/* 다음에 할 일이 화면에 있어야 한다 — 코드만 주고 어디에 넣는지 말하지 않으면
                    사람은 문서를 찾으러 간다. 명령은 셸에 그대로 들어가는 값이라 번역하지 않는다. */}
                <pre
                  data-testid="operator-register-command"
                  className="mt-2 overflow-x-auto rounded bg-surface-raised p-2 font-mono text-meta text-fg"
                >
                  {`harkroom-operator register ${getController().api?.baseUrl ?? '<server>'} ${code.code}`}
                </pre>
                <div className="mt-2 text-meta text-warning">{t('operators.codeNextStep')}</div>
              </div>
            )}
            <button
              className="rounded bg-accent px-4 py-2 font-medium text-fg-on-strong disabled:opacity-50"
              disabled={busy}
              onClick={() => void issue()}
            >
              {busy ? t('operators.registerBusy') : code ? t('operators.registerAgain') : t('operators.register')}
            </button>
          </div>
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
