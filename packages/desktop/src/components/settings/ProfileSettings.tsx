import { useRef, useState } from 'react';
import { useAppStore } from '../../state/appStore';
import { getController } from '../../state/controller';
import { ApiError } from '../../lib/api';
import { Identity } from '../Identity';
import { ReadonlyRow, SettingsGroup, SettingsPage } from './primitives';

/**
 * 프로필 사진 행(#159). **이 화면에 처음 들어오는 쓰기 경로다** — 나머지 항목은 서버에
 * 변경 엔드포인트가 없어 전부 읽기 전용이고, 아래 안내 문구도 그 사실을 말한다. 사진만
 * 바꿀 수 있으므로 그 문구도 함께 좁혔다(아바타까지 못 바꾼다고 말하면 거짓이 된다).
 *
 * 미리보기를 `Identity` 로 그린다. 여기서 `<img>` 를 따로 두면 아바타 표시가 두 곳이 되고,
 * 그게 바로 `Identity` 주석이 못박은 "하나의 사실이 두 곳에 유지된다"다.
 */
function AvatarRow() {
  const me = useAppStore((s) => s.me);
  const pick = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(file: File | null) {
    setBusy(true);
    setError(null);
    try {
      await getController().setAvatar(file);
    } catch {
      // 서버가 거절하는 가장 흔한 경우는 이미지가 아닌 파일이다(매직 바이트로 판정한다).
      // 확장자를 믿고 통과시키지 않으므로 `.png` 라는 이름만으로는 걸리지 않는다.
      setError('이미지 파일만 프로필 사진으로 쓸 수 있습니다.');
    } finally {
      setBusy(false);
      // 같은 파일을 다시 고를 수 있게 값을 비운다 — 안 비우면 change 가 안 난다.
      if (pick.current) pick.current.value = '';
    }
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-4">
        <span className="font-medium text-zinc-900">Profile photo</span>
        <span className="ml-auto flex items-center gap-3">
          <Identity account={me ?? undefined} className="h-10 w-10 text-base" variant="avatar" />
          <input
            ref={pick}
            type="file"
            data-testid="avatar-file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void apply(f); }}
          />
          <button
            className="rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            disabled={busy}
            onClick={() => pick.current?.click()}
          >
            Upload
          </button>
          {me?.avatarAttachmentId && (
            <button
              className="rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              disabled={busy}
              onClick={() => void apply(null)}
            >
              Remove
            </button>
          )}
        </span>
      </div>
      {/* 눈에 보이게 낸다. `sr-only` 로만 두면 스크린리더가 아닌 사람에게는 **아무 일도
          일어나지 않은 것**과 구분되지 않는다 — 버튼이 잠깐 눌렸다 풀리고 사진은 그대로다.
          이 저장소의 다른 오류 표면과 같은 모양을 쓴다(Composer.tsx 의 업로드 오류). */}
      {error && <p role="alert" className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

function HandleRow() {
  const me = useAppStore((s) => s.me);
  const [editing, setEditing] = useState(false);
  const [newHandle, setNewHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const startEdit = () => {
    setNewHandle(me?.handle ?? '');
    setEditing(true);
    setError(null);
    setConfirming(false);
  };

  const cancelEdit = () => {
    setEditing(false);
    setNewHandle('');
    setError(null);
    setConfirming(false);
  };

  const requestConfirm = () => {
    if (newHandle === me?.handle) {
      setError('새 이름을 입력하세요.');
      return;
    }
    if (newHandle.length < 2 || newHandle.length > 32) {
      setError('2~32자로 입력하세요.');
      return;
    }
    // 서버와 **같은 문자 집합**이다(`accountRoutes.ts` 의 `^[a-z0-9_-]{2,32}$`). 여기서
    // 대문자를 통과시키면 서버가 400 을 주고, 사람은 "잘못된 이름입니다" 만 보게 된다 —
    // 무엇이 잘못됐는지는 화면 어디에도 없다. 판정을 넓게 두는 쪽이 더 나쁜 거짓말이다.
    if (!/^[a-z0-9_-]+$/.test(newHandle)) {
      setError('소문자와 숫자, 밑줄, 하이픈만 사용할 수 있습니다.');
      return;
    }
    setConfirming(true);
  };

  async function apply() {
    if (!newHandle || newHandle === me?.handle) return;
    setBusy(true);
    setError(null);
    try {
      await getController().setHandle(newHandle);
      setEditing(false);
      setConfirming(false);
      setNewHandle('');
    } catch (e) {
      // 서버가 준 **코드**로 가른다. 문구를 문자열로 뒤지면(`msg.includes('409')`) 서버가
      // 문구를 다듬는 순간 조용히 "변경에 실패했습니다" 로 뭉개진다 — 실제로 400 가지는
      // 그 방식으로는 한 번도 맞지 않았다(오류 메시지에 상태 코드가 들어 있지 않다).
      if (e instanceof ApiError && e.code === 'handle_taken') {
        setError('이 이름은 이미 쓰고 있습니다.');
      } else if (e instanceof ApiError && e.status === 400) {
        setError('쓸 수 없는 이름입니다.');
      } else {
        setError('변경에 실패했습니다.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-4 px-4 py-3">
        <span className="font-medium text-zinc-900">불리는 이름</span>
        <span className="ml-auto min-w-0 truncate text-zinc-600">@{me?.handle ?? '—'}</span>
        <button
          className="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-50"
          onClick={startEdit}
        >
          바꾸기
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center gap-4">
        <span className="font-medium text-zinc-900">불리는 이름</span>
        <div className="ml-auto flex items-center gap-2">
          <input
            type="text"
            value={newHandle}
            onChange={(e) => setNewHandle(e.target.value)}
            className="w-40 rounded-lg border border-zinc-300 px-2 py-1 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none"
            placeholder="새 이름"
          />
          {!confirming ? (
            <>
              <button
                className="rounded-lg border border-zinc-300 px-3 py-1 font-medium text-zinc-700 hover:bg-zinc-50"
                onClick={cancelEdit}
              >
                취소
              </button>
              <button
                className="rounded-lg bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-700"
                onClick={requestConfirm}
              >
                확인
              </button>
            </>
          ) : (
            <>
              <button
                className="rounded-lg border border-zinc-300 px-3 py-1 font-medium text-zinc-700 hover:bg-zinc-50"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                취소
              </button>
              <button
                className="rounded-lg bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                onClick={apply}
                disabled={busy}
              >
                {busy ? '...' : '적용'}
              </button>
            </>
          )}
        </div>
      </div>
      {confirming && (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          <p className="font-medium">과거 메시지의 멘션도 새 이름으로 표시됩니다.</p>
          <p className="mt-1 text-amber-700">이 변경은 되돌릴 수 없습니다.</p>
        </div>
      )}
      {error && <p role="alert" className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

export function ProfileSettings({ onSignOut }: { onSignOut(): void }) {
  const me = useAppStore((s) => s.me);

  return (
    <SettingsPage title="Profile" description="Who you are signed in as on this server.">
      <SettingsGroup>
        <AvatarRow />
        <HandleRow />
        <ReadonlyRow label="Display name" value={me?.displayName ?? '—'} />
        <ReadonlyRow label="Account type" value={me?.kind === 'agent' ? 'Agent' : 'Person'} />
        {me?.isAdmin && <ReadonlyRow label="Role" value="Administrator" />}
      </SettingsGroup>

      <p data-testid="profile-readonly-note" className="-mt-6 mb-8 text-zinc-500">
        Your profile photo is the only thing you can change here.
      </p>

      <SettingsGroup>
        <div className="flex items-center gap-4 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-zinc-900">Sign out</span>
            <span className="mt-0.5 block text-zinc-500">
              Ends this session on this device only. Your other devices stay signed in.
            </span>
          </span>
          <button
            className="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 font-medium text-red-600 hover:bg-red-50"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}