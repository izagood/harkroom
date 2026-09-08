import { useState } from 'react';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { useT } from '../../i18n/useT';

export function InviteSettings() {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!me?.isAdmin) {
    return (
      <div className="p-5">
        <h2 className="mb-4 text-name font-bold">Invite</h2>
        <p className="text-fg-subtle">{t('invite.notAdmin')}</p>
      </div>
    );
  }

  const createInvite = async () => {
    setError(null);
    setToken(null);
    setBusy(true);
    try {
      const newToken = await getController().createInvite();
      setToken(newToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('invite.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-5">
      <h2 className="mb-4 text-name font-bold">Invite</h2>

      <p className="mb-4 text-fg-muted">
        {t('invite.note')}
      </p>


      {token && (
        <div className="mb-4 rounded border border-warning-border bg-warning-surface p-3">
          {/* 크기를 안 적어 본문단 13px 을 물려받는다 — "지금 안 적으면 다시 못 본다"는
              **놓치면 되돌릴 수 없는** 문장이다. 아래 토큰 자체는 등폭 11px 이라 이 경고와
              값이 두 단으로 갈린다. */}
          <div className="font-semibold text-warning">
            {t('invite.tokenWarning')}
          </div>
          <code className="mt-1 block break-all rounded bg-surface-raised p-2 text-meta">{token}</code>
          <div className="mt-2 text-meta text-warning">
            {t('invite.tokenNextStep')}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded border border-danger-border bg-danger-surface p-3">
          <p className="text-meta text-danger">{error}</p>
        </div>
      )}

      <button
        className="rounded bg-accent px-4 py-2 font-medium text-fg-on-strong disabled:opacity-50"
        // 토큰이 하나 나왔다고 버튼을 잠그지 않는다 — 초대는 여러 사람에게 하는 일이고,
        // 토큰은 한 번 쓰면 소진되므로 두 번째 사람에게는 새 토큰이 필요하다. 다시 누르면
        // 앞 토큰은 화면에서 사라지므로(다시 볼 수 없다) 그 사실을 라벨로 알린다.
        disabled={busy}
        onClick={() => void createInvite()}
      >
        {busy ? t('invite.busy') : token ? t('invite.createAgain') : t('invite.create')}
      </button>
    </div>
  );
}
