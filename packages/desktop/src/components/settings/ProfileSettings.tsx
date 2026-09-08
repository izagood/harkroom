import { useCallback, useState } from 'react';
import { useActiveStore } from '../../state/communities';
import { getController } from '../../state/controller';
import { ApiError } from '../../lib/api';
import { Identity } from '../Identity';
import { ReadonlyRow, SettingsGroup, SettingsPage } from './primitives';
import { AvatarStatus, useAvatarEdit } from './avatarEdit';

/**
 * 프로필 사진 행(#159). **이 화면에 처음 들어오는 쓰기 경로다** — 나머지 항목은 서버에
 * 변경 엔드포인트가 없어 전부 읽기 전용이고, 아래 안내 문구도 그 사실을 말한다. 사진만
 * 바꿀 수 있으므로 그 문구도 함께 좁혔다(아바타까지 못 바꾼다고 말하면 거짓이 된다).
 *
 * 미리보기를 `Identity` 로 그린다. 여기서 `<img>` 를 따로 두면 아바타 표시가 두 곳이 되고,
 * 그게 바로 `Identity` 주석이 못박은 "하나의 사실이 두 곳에 유지된다"다.
 */
function AvatarRow() {
  const me = useActiveStore((s) => s.me);
  const apply = useCallback(
    (file: File | null, onProgress?: (f: number) => void) => getController().setAvatar(file, onProgress),
    [],
  );
  const edit = useAvatarEdit(apply, '이미지 파일만 프로필 사진으로 쓸 수 있습니다.');

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-4">
        <span className="font-medium text-fg">Profile photo</span>
        <span className="ml-auto flex items-center gap-3">
          <Identity account={me ?? undefined} className="h-10 w-10 text-base" variant="avatar" />
          <input
            ref={edit.pickRef}
            type="file"
            data-testid="avatar-file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
            className="hidden"
            onChange={edit.onPicked}
          />
          <button
            className="rounded-lg border border-border px-3 py-1.5 font-medium text-fg hover:bg-surface disabled:opacity-50"
            disabled={edit.busy}
            onClick={edit.openPicker}
          >
            Upload
          </button>
          {/*
            지우기는 **두 걸음**이다. 한 걸음이던 동안은 실수로 스친 클릭 하나가 사진을
            지웠고, 지운 뒤에도 아무 말이 없어 눌린 것조차 알 수 없었다. 이 저장소가
            비활성화(`AgentsSettings` 의 `confirmingDisable`)에서 이미 쓰는 모양이다.
          */}
          {me?.avatarAttachmentId && (edit.confirmingRemove ? (
            <>
              <button
                className="rounded-lg border border-danger-border bg-danger-surface px-3 py-1.5 font-medium text-danger hover:bg-danger-surface-strong disabled:opacity-50"
                disabled={edit.busy}
                onClick={edit.confirmRemove}
              >
                정말 지우기
              </button>
              <button
                className="rounded-lg border border-border px-3 py-1.5 font-medium text-fg-muted hover:bg-surface"
                onClick={edit.cancelRemove}
              >
                취소
              </button>
            </>
          ) : (
            <button
              className="rounded-lg border border-border px-3 py-1.5 font-medium text-danger hover:bg-danger-surface disabled:opacity-50"
              disabled={edit.busy}
              onClick={edit.askRemove}
            >
              Remove
            </button>
          ))}
        </span>
      </div>
      <div className="flex justify-end">
        <AvatarStatus phase={edit.phase} />
      </div>
    </div>
  );
}

function HandleRow() {
  const me = useActiveStore((s) => s.me);
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
        <span className="font-medium text-fg">불리는 이름</span>
        <span className="ml-auto min-w-0 truncate text-fg-muted">@{me?.handle ?? '—'}</span>
        <button
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-surface"
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
        <span className="font-medium text-fg">불리는 이름</span>
        <div className="ml-auto flex items-center gap-2">
          <input
            type="text"
            value={newHandle}
            onChange={(e) => setNewHandle(e.target.value)}
            className="w-40 rounded-lg border border-border bg-field px-2 py-1 text-fg focus:border-accent focus:outline-none"
            placeholder="새 이름"
          />
          {!confirming ? (
            <>
              <button
                className="rounded-lg border border-border px-3 py-1 font-medium hover:bg-surface"
                onClick={cancelEdit}
              >
                취소
              </button>
              <button
                className="rounded-lg bg-accent px-3 py-1 font-medium text-fg-on-strong hover:bg-accent-hover"
                onClick={requestConfirm}
              >
                확인
              </button>
            </>
          ) : (
            <>
              <button
                className="rounded-lg border border-border px-3 py-1 font-medium hover:bg-surface"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                취소
              </button>
              <button
                className="rounded-lg bg-accent px-3 py-1 font-medium text-fg-on-strong hover:bg-accent-hover disabled:opacity-50"
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
        <div className="rounded-lg border border-warning-border bg-warning-surface p-3 text-warning">
          <p className="font-medium">과거 메시지의 멘션도 새 이름으로 표시됩니다.</p>
          <p className="mt-1 text-warning">이 변경은 되돌릴 수 없습니다.</p>
        </div>
      )}
      {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

export function ProfileSettings({ onSignOut }: { onSignOut(): void }) {
  const me = useActiveStore((s) => s.me);

  return (
    <SettingsPage title="Profile" description="Who you are signed in as on this server.">
      <SettingsGroup>
        <AvatarRow />
        <HandleRow />
        <ReadonlyRow label="Display name" value={me?.displayName ?? '—'} />
        <ReadonlyRow label="Account type" value={me?.kind === 'agent' ? 'Agent' : 'Person'} />
        {me?.isAdmin && <ReadonlyRow label="Role" value="Administrator" />}
      </SettingsGroup>

      {/* #271 로 handle 은 바꿀 수 있게 됐다 — main 의 문구("handle 과 display name 은
          만들 때 정해지고 앱에서 바꿀 수 없다")는 이제 사실이 아니다. 무엇이 바뀌고
          무엇이 안 바뀌는지를 그대로 적는다: 로그인 ID 는 v1 불변이다. */}
      <p data-testid="profile-readonly-note" className="-mt-6 mb-8 text-fg-subtle">
        You can change your profile photo and your handle here. Your display name and login ID are
        set when the account is created and cannot be changed from the app yet.
      </p>

      <SettingsGroup>
        <div className="flex items-center gap-4 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-fg">Sign out</span>
            <span className="mt-0.5 block text-fg-subtle">
              Ends this session on this device only. Your other devices stay signed in.
            </span>
          </span>
          <button
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 font-medium text-danger hover:bg-danger-surface"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}