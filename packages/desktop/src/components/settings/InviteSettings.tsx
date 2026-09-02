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
      setError(e instanceof Error ? e.message : '초대 발급에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-5">
      <h2 className="mb-4 text-base font-bold">Invite</h2>

      <p className="mb-4 text-sm text-zinc-600">
        초대 토큰을 만들어 다른 사람을 이 워크스페이스로 부를 수 있습니다.
        토큰은 발급 직후 한 번만 보이며 다시 볼 수 없습니다. 한 번 쓰면 소진됩니다.
      </p>


      {token && (
        <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3">
          <div className="text-xs font-semibold text-amber-900">
            이 토큰은 지금만 보입니다 — 창을 벗어나면 다시 볼 수 없습니다
          </div>
          <code className="mt-1 block break-all rounded bg-white p-2 text-[11px]">{token}</code>
          <div className="mt-2 text-[11px] text-amber-900">
            받는 사람이 가입할 때 이 토큰이 필요합니다. 지금 복사해 두세요.
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
        // 토큰이 하나 나왔다고 버튼을 잠그지 않는다 — 초대는 여러 사람에게 하는 일이고,
        // 토큰은 한 번 쓰면 소진되므로 두 번째 사람에게는 새 토큰이 필요하다. 다시 누르면
        // 앞 토큰은 화면에서 사라지므로(다시 볼 수 없다) 그 사실을 라벨로 알린다.
        disabled={busy}
        onClick={() => void createInvite()}
      >
        {busy ? '발급 중...' : token ? '새 토큰 발급 (앞 토큰은 화면에서 사라집니다)' : '초대 토큰 발급'}
      </button>
    </div>
  );
}
