import { useState } from 'react';
import { getController } from '../../state/controller';
import { useAppStore } from '../../state/appStore';

export function InviteSettings() {
  const me = useAppStore((s) => s.me);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!me?.isAdmin) {
    return (
      <div className="p-5">
        <h2 className="mb-4 text-base font-bold">Invite</h2>
        <p className="text-zinc-500">이 화면은 관리자만 볼 수 있습니다.</p>
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
      setError(e instanceof Error ? e.message : '초대 발급에 실패했다');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-5">
      <h2 className="mb-4 text-base font-bold">Invite</h2>

      <p className="mb-4 text-sm text-zinc-600">
        초대 토큰을 만들어 다른 사람을 워크스페이스에 초대할 수 있습니다.
        토큰은 생성 직후 한 번만 보여주며, 다시 볼 수 없습니다.
      </p>

      {token && (
        <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3">
          <div className="text-xs font-semibold text-amber-900">
            이 토큰은 지금만 보인다 — 다시는 볼 수 없다
          </div>
          <code className="mt-1 block break-all rounded bg-white p-2 text-[11px]">{token}</code>
          <div className="mt-2 text-[11px] text-amber-900">
            가입 시 이 토큰을 입력하세요.
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 p-3">
          <p className="text-xs text-red-700">{error}</p>
        </div>
      )}

      <button
        className="rounded bg-indigo-600 px-4 py-2 font-medium text-white disabled:opacity-50"
        disabled={busy || !!token}
        onClick={() => void createInvite()}
      >
        {busy ? '발급 중...' : '초대 토큰 발급'}
      </button>
    </div>
  );
}