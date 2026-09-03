import { useRef, useState } from 'react';
import { useAppStore } from '../../state/appStore';
import { getController } from '../../state/controller';
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
          이 저장소의 다른 오류 표면과 같은 모양을 쓴다(`Composer.tsx` 의 업로드 오류). */}
      {error && <p role="alert" className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

export function ProfileSettings({ onSignOut }: { onSignOut(): void }) {
  const me = useAppStore((s) => s.me);

  return (
    <SettingsPage title="Profile" description="Who you are signed in as on this server.">
      <SettingsGroup>
        <AvatarRow />
        <ReadonlyRow label="Handle" value={me ? `@${me.handle}` : '—'} />
        <ReadonlyRow label="Display name" value={me?.displayName ?? '—'} />
        <ReadonlyRow label="Account type" value={me?.kind === 'agent' ? 'Agent' : 'Person'} />
        {me?.isAdmin && <ReadonlyRow label="Role" value="Administrator" />}
      </SettingsGroup>

      <p data-testid="profile-readonly-note" className="-mt-6 mb-8 text-zinc-500">
        Your profile photo is the only thing you can change here. Your handle and display name are
        set when the account is created and cannot be changed from the app yet.
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
