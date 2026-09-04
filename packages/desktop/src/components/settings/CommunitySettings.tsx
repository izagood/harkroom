import { useState } from 'react';
import { useStore } from 'zustand';
import { createNotifier } from '../../lib/notify';
import { sessionStore } from '../../lib/session';
import {
  communityLabel, useCommunityRegistry, type CommunityEntry,
} from '../../state/communities';
import {
  removeCommunity, setCommunityLabel, startCommunitySession, switchCommunity,
} from '../../state/controller';
import { ConnectScreen } from '../../screens/ConnectScreen';
import { SettingsGroup, SettingsPage } from './primitives';

/**
 * 커뮤니티 목록·추가·제거·이름(#165 결정 6).
 *
 * **이 저장소에서 처음으로 쓰기가 있는 설정 패널이다.** 그래서 입력·검증·저장 중 표시·실패
 * 문구를 여기 한 곳에 모으고, 확인 단계는 이미 있는 모양(`Sidebar` 의 채널 삭제, `MessageItem`
 * 의 '정말 삭제')을 따른 **인라인 확인**이다 — `window.confirm` 은 Tauri 웹뷰에서 막힐 수
 * 있어 이 저장소가 쓰지 않는다.
 *
 * **낙관적 갱신을 하지 않는다.** 추가는 로그인 왕복 + WS 연결이고 실패가 흔하다. 먼저 목록에
 * 넣고 나중에 지우면, 실패한 커뮤니티가 잠깐 정상으로 보였다가 이유 없이 사라진다.
 */
export function CommunitySettings({ onCommunitiesEmpty }: {
  /**
   * 마지막 커뮤니티를 뺐다 — 그때는 정말 세션이 없으므로 `App` 이 `phase` 를 `connect` 로
   * 돌린다. **옵셔널이 아니다**: 기본값을 여기서 공급하면 배선을 잊은 화면에서 마지막
   * 커뮤니티를 뺀 사람이 아무것도 없는 워크스페이스에 갇힌다.
   */
  onCommunitiesEmpty(): void;
}) {
  const entries = useCommunityRegistry((r) => r.entries);
  const activeId = useCommunityRegistry((r) => r.activeId);

  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // 이름 편집·제거 확인은 **한 번에 하나씩만** 연다. 여럿을 동시에 열면 어느 커뮤니티를
  // 고치고 있는지가 화면에서 사라진다(`Sidebar` 의 멤버 패널과 같은 규칙).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  /** 저장 중인 커뮤니티 id. 왕복이 있는 조작은 눌린 뒤 무엇이 도는지 보여야 한다. */
  const [busyId, setBusyId] = useState<string | null>(null);

  const message = (err: unknown, fallback: string): string =>
    err instanceof Error && err.message ? err.message : fallback;

  const startRename = (entry: CommunityEntry): void => {
    setRenamingId(entry.id);
    // 저장된 이름이 없으면 **빈 칸으로 시작한다** — 호스트명을 미리 채우면 사람이 아무것도
    // 고치지 않고 저장했을 때 그 호스트명이 고정 이름으로 굳는다(기본값이 사라진다).
    setLabelDraft(entry.label ?? '');
    setRenameError(null);
  };

  const saveRename = async (entry: CommunityEntry): Promise<void> => {
    setBusyId(entry.id);
    setRenameError(null);
    try {
      await setCommunityLabel(entry.id, labelDraft);
      setRenamingId(null);
    } catch (err) {
      setRenameError(message(err, 'Could not save the name.'));
    } finally {
      setBusyId(null);
    }
  };

  const confirmRemove = async (entry: CommunityEntry): Promise<void> => {
    setBusyId(entry.id);
    setRemoveError(null);
    try {
      const { empty } = await removeCommunity(entry.id);
      setRemovingId(null);
      if (empty) onCommunitiesEmpty();
    } catch (err) {
      setRemoveError(message(err, 'Could not remove this community.'));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 추가 성공. **`phase` 를 건드리지 않는다** — `active: false` 로 띄우므로 보고 있는
   * 커뮤니티도 바뀌지 않는다(추가는 전환이 아니다). 보관본의 `active` 도 그대로 둔다.
   *
   * 순서가 중요하다: 세션을 **먼저** 띄우고 그 다음에 보관한다. 거꾸로 하면 로그인이
   * 실패한 커뮤니티의 토큰이 키체인에 남는다.
   */
  const handleAdded = async (
    baseUrl: string, token: string, accountId: string, handle: string,
  ): Promise<void> => {
    setAddError(null);
    // 같은 계정을 두 번 등록하면 목록에 같은 커뮤니티가 둘이 서고 WS 도 둘이 붙는다.
    // 조용히 지나가지 않고 말한다 — 사용자는 자기가 무엇을 눌렀는지 알아야 한다.
    if (entries.some((e) => e.accountId === accountId)) {
      setAddError('This community is already on this device.');
      return;
    }
    try {
      await startCommunitySession({
        baseUrl, token, accountId, label: null, active: false, notifier: createNotifier(),
      });
    } catch (err) {
      setAddError(message(err, 'Signed in, but starting the session failed.'));
      return;
    }
    const stored = (await sessionStore.load()) ?? { active: null, communities: [] };
    stored.communities.push({ accountId, baseUrl, token, handle, label: null });
    await sessionStore.save(stored);
    setAddOpen(false);
  };

  return (
    <SettingsPage
      title="Communities"
      description="The murmur servers this device knows. Each one keeps its own channels, messages and connection."
    >
      <SettingsGroup>
        {entries.map((entry) => (
          <CommunityRow
            key={entry.id}
            entry={entry}
            active={entry.id === activeId}
            busy={busyId === entry.id}
            renaming={renamingId === entry.id}
            labelDraft={labelDraft}
            renameError={renamingId === entry.id ? renameError : null}
            removing={removingId === entry.id}
            removeError={removingId === entry.id ? removeError : null}
            onStartRename={() => startRename(entry)}
            onLabelDraft={setLabelDraft}
            onSaveRename={() => void saveRename(entry)}
            onCancelRename={() => { setRenamingId(null); setRenameError(null); }}
            onSwitch={() => { void switchCommunity(entry.id); }}
            onStartRemove={() => { setRemovingId(entry.id); setRemoveError(null); }}
            onConfirmRemove={() => void confirmRemove(entry)}
            onCancelRemove={() => { setRemovingId(null); setRemoveError(null); }}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup>
        <div className="flex items-center gap-4 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-fg">Add a community</span>
            <span className="mt-0.5 block text-fg-subtle">
              Sign in to another murmur server. The communities you are already in stay connected.
            </span>
          </span>
          <button
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-surface"
            onClick={() => { setAddOpen(true); setAddError(null); }}
          >
            Add community
          </button>
        </div>
        {/* 겹창이 열려 있는 동안은 여기 적지 않는다 — 겹창이 이 자리를 덮으므로, 로그인에
            성공했는데 화면에 아무 일도 일어나지 않은 것처럼 보인다. 그때의 자리는 겹창 안이다. */}
        {addError && !addOpen && (
          <p role="alert" className="px-4 py-2 text-danger">{addError}</p>
        )}
      </SettingsGroup>

      {/* 접속 화면을 **겹창 안에서** 재사용한다(#165 결정 3). `phase` 를 `connect` 로
          되돌려 같은 화면을 띄우면 다른 커뮤니티들의 라이브 연결이 화면과 함께 사라진다 —
          `phase` 는 세션 상태이지 뷰가 아니다(docs/design.md §설정). */}
      {addOpen && (
        <div
          className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 p-8"
          onClick={() => setAddOpen(false)}
        >
          <div
            role="dialog"
            aria-label="커뮤니티 추가"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape') setAddOpen(false); }}
          >
            <ConnectScreen
              mode="add"
              onAdded={handleAdded}
              onCancel={() => setAddOpen(false)}
            />
            {/* 추가가 **폼 밖에서** 막힌 경우(이미 이 기기에 있는 커뮤니티, 세션 시작 실패)를
                겹창 안에서 말한다. 폼 안의 오류(로그인 실패)는 `ConnectScreen` 이 자기가
                적는다 — 두 오류의 자리가 다른 것은 원인이 다르기 때문이다. */}
            {addError && (
              <p role="alert" className="mt-2 rounded bg-surface-raised px-4 py-2 text-danger">{addError}</p>
            )}
          </div>
        </div>
      )}
    </SettingsPage>
  );
}

/**
 * 커뮤니티 한 줄. 연결 상태는 **자기 스토어에서** 읽는다 — 활성 커뮤니티의 값을 모든 줄에
 * 쓰면 "셋 중 하나가 끊겼다" 가 목록 전체에 대한 거짓말이 된다(#166 이 커뮤니티별
 * `connected` 를 만든 이유).
 */
function CommunityRow(props: {
  entry: CommunityEntry;
  active: boolean;
  busy: boolean;
  renaming: boolean;
  labelDraft: string;
  renameError: string | null;
  removing: boolean;
  removeError: string | null;
  onStartRename(): void;
  onLabelDraft(next: string): void;
  onSaveRename(): void;
  onCancelRename(): void;
  onSwitch(): void;
  onStartRemove(): void;
  onConfirmRemove(): void;
  onCancelRemove(): void;
}) {
  const { entry, active, busy } = props;
  const connected = useStore(entry.store, (s) => s.connected);
  const label = communityLabel(entry);

  return (
    <div className="px-4 py-3" data-testid={`community-row-${entry.id}`}>
      <div className="flex items-center gap-4">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 font-medium text-fg">
            {label}
            {active && (
              <span className="rounded bg-accent-surface px-1 text-[10px] text-accent">Viewing</span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-fg-subtle">
            <span className="min-w-0 truncate font-mono text-xs">{entry.baseUrl || '—'}</span>
            <span className={`h-2 w-2 shrink-0 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`} />
            <span data-testid={`community-state-${entry.id}`}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </span>
        </span>
        {!active && (
          <button
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-surface"
            onClick={props.onSwitch}
          >
            Switch to
          </button>
        )}
        <button
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-surface"
          onClick={props.onStartRename}
        >
          Rename
        </button>
        <button
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 font-medium text-danger hover:bg-surface"
          onClick={props.onStartRemove}
        >
          Remove
        </button>
      </div>

      {props.renaming && (
        <div className="mt-2">
          <label className="block text-fg-subtle" htmlFor={`community-name-${entry.id}`}>
            Display name on this device. Leave it empty to use the server host name.
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id={`community-name-${entry.id}`}
              className="min-w-0 flex-1 rounded border border-border bg-field px-2 py-1"
              value={props.labelDraft}
              placeholder={entry.baseUrl || 'community'}
              onChange={(e) => props.onLabelDraft(e.target.value)}
            />
            <button
              className="shrink-0 rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-surface disabled:opacity-50"
              disabled={busy}
              onClick={props.onSaveRename}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              className="shrink-0 rounded-lg px-3 py-1.5 text-fg-muted hover:bg-surface"
              onClick={props.onCancelRename}
            >
              Cancel
            </button>
          </div>
          {props.renameError && (
            <p role="alert" className="mt-1 text-danger">{props.renameError}</p>
          )}
        </div>
      )}

      {/* 확인 단계. **확인 전에는 아무 일도 일어나지 않는다** — 제거는 이 기기의 목록에서만
          빼는 일이지만, 다시 넣으려면 서버 주소와 자격증명이 다시 필요하다. */}
      {props.removing && (
        <div className="mt-2 rounded-lg border border-border bg-surface p-3">
          <p className="text-fg">
            Remove {label} from this device? It stays on the server — your session there is not
            signed out, and other devices keep working. You will need to sign in again to add it back.
          </p>
          {props.removeError && (
            <p role="alert" className="mt-1 text-danger">{props.removeError}</p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              className="rounded-lg border border-border px-3 py-1.5 font-medium text-danger hover:bg-surface-hover disabled:opacity-50"
              disabled={busy}
              onClick={props.onConfirmRemove}
            >
              {busy ? 'Removing…' : 'Remove from this device'}
            </button>
            <button
              className="rounded-lg px-3 py-1.5 text-fg-muted hover:bg-surface-hover"
              onClick={props.onCancelRemove}
            >
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
