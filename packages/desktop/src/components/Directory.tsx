import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccountView } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { Identity, StatusMark } from './Identity';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 특정 계정으로 열면 해당 행이 강조·스크롤된다. */
  accountId?: string | null;
}

/**
 * 조회 상태를 셋으로 나눈다. 둘(성공/실패)로 두면 **"아직 안 왔다"가 "비었다"로 보인다** —
 * 목록이 비어 보이는 화면이 "이 워크스페이스에 아무도 없다"인지 "물어보는 중"인지
 * 구분되지 않는다.
 */
type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

/**
 * 워크스페이스 전체의 사람·에이전트 디렉터리(#226).
 *
 * **서버 표면을 새로 만들지 않는다** — `GET /accounts`(`requireAccount`)가 이미 계정 전체를
 * 주고 부팅 때 `appStore.accounts` 에 들어와 있다. 없던 것은 데이터가 아니라 화면이다.
 *
 * 보여 주는 것은 `AccountView` 가 주는 것뿐이다: handle, displayName, kind, isAdmin,
 * disabled, 상태. **harness·model·workingDir·소유자·PAT 는 그리지 않는다** — 그것들은
 * `GET /accounts/agents`(`requireAdmin`)의 것이고, 이 화면은 모든 사용자가 본다.
 * `AgentView extends AccountView` 라서 harness 를 가진 객체가 이 자리에 그대로 들어올 수
 * 있다 — 타입이 막아 주지 않으므로 경계는 이 컴포넌트가 지킨다.
 *
 * 검색은 클라이언트에서 한다. 목록이 이미 스토어에 다 있으므로 서버 질의를 새로 만들 이유가
 * 없다. handle 과 displayName **둘 다** 본다 — 사람은 둘 중 아는 쪽으로 친다.
 */
export function Directory({ open, onClose, accountId }: Props) {
  const accounts = useActiveStore((s) => s.accounts);
  const online = useActiveStore((s) => s.online);
  const [query, setQuery] = useState('');
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });

  const account = accountId ? accounts[accountId] : null;
  // 씨앗 검색어는 **handle 문자열**이다. 계정 객체를 아래 효과의 의존성에 걸면 presence·
  // 상태가 바뀔 때마다 객체 신원이 갈려 효과가 다시 돌고, 사람이 치고 있던 검색어를 덮는다
  // (초판이 그랬다). handle 은 만든 뒤 바뀌지 않으므로 문자열이면 그 되풀이가 없다.
  const seedHandle = account?.handle ?? null;

  const reload = useCallback((): (() => void) => {
    let alive = true;
    setLoad({ kind: 'loading' });
    // force 를 켠다. 끄면 5초 스로틀이 걸린 호출이 **묻지도 않고** resolve 되어,
    // 서버가 죽어 있어도 이 화면은 초록으로 보인다.
    getController().refreshAccounts({ force: true }).then(
      () => { if (alive) setLoad({ kind: 'ready' }); },
      (err: unknown) => {
        if (!alive) return;
        setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => { alive = false; };
  }, []);

  /**
   * 열릴 때 한 번 씨앗을 놓고 목록을 새로 받는다.
   *
   * 특정 계정으로 열면(#279) 그 handle 로 검색어를 채운다 — 큰 목록에서 그 행만 남기는
   * 것이 "그 계정으로 열렸다"의 절반이고, 나머지 절반은 아래 `isSelected` 강조·스크롤이다.
   * 씨앗은 **덮어쓸 수 있어야 한다**: 사람이 지우고 다른 이름을 치는 것이 이 화면의 일이다.
   * 그래서 의존성은 열림·대상 뿐이고 계정 객체가 아니다(위 주석).
   */
  useEffect(() => {
    if (!open) return;
    setQuery(seedHandle ?? '');
    return reload();
  }, [open, reload, accountId, seedHandle]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = Object.values(accounts);
    const hit = q
      ? all.filter((a) => a.handle.toLowerCase().includes(q) || a.displayName.toLowerCase().includes(q))
      : all;
    return [...hit].sort((a, b) => a.handle.localeCompare(b.handle));
  }, [accounts, query]);

  const people = matches.filter((a) => a.kind === 'human');
  const agents = matches.filter((a) => a.kind === 'agent');

  if (!open) return null;

  const total = Object.keys(accounts).length;

  const row = (a: AccountView) => {
    const isSelected = accountId === a.id;
    return (
      <li
        key={a.id}
        data-testid={`directory-row-${a.id}`}
        data-selected={String(isSelected)}
        // 강조만 하고 화면 밖에 두면 긴 목록에서는 아무 일도 안 일어난 것과 같다.
        // `scrollIntoView?.` 인 이유: jsdom 에는 그 함수가 없다 — 옵셔널 호출을 빼면 이
        // 화면을 띄우는 테스트가 렌더 도중 터진다(`MessageItem` 도 같은 이유로 그렇다).
        ref={isSelected ? (el: HTMLLIElement | null) => { el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); } : undefined}
        className={`flex items-center gap-2 rounded px-2 py-1.5 ${a.disabled ? 'opacity-60' : ''} ${isSelected ? 'bg-accent-surface ring-2 ring-accent' : ''}`}
      >
      {/* #277: 이 자리는 **거터가 아니다** — 고정폭 열이 아니라 넓어지면 행이 늘어나는
          인라인 칸이고, 디렉터리는 소유자를 보여 주는 것이 일이다(#181·#226). badge 로 둔다. */}
      <Identity account={a} variant="badge" />
      {/* 연결 점은 소켓이 붙어 있는가다. 사람이 고른 상태(StatusMark)와 나란히 둔다 —
          합치면 "연결이 끊긴 사람"과 "방해 금지인 사람"이 한 표시로 뭉친다(#186). */}
      <span
        data-testid={`directory-presence-${a.id}`}
        data-online={String(online.includes(a.id))}
        className={`h-2 w-2 shrink-0 rounded-full ${online.includes(a.id) ? 'bg-success' : 'bg-fg-subtle'}`}
      />
      <span className="font-medium text-fg">{a.displayName}</span>
      <span className="text-fg-muted">@{a.handle}</span>
      <span
        data-testid={`directory-kind-${a.id}`}
        className="rounded bg-surface-sunken px-1 text-[10px] uppercase tracking-wide text-fg-muted"
      >
        {a.kind}
      </span>
      {a.isAdmin && (
        <span className="rounded bg-warning-surface px-1 text-[10px] text-warning">admin</span>
      )}
      <StatusMark account={a} />
      {a.statusText && <span className="truncate text-[11px] text-fg-subtle">{a.statusText}</span>}
      {/* 비활성 계정은 목록에 남기되 **꺼져 있다는 것이 보여야 한다.** 감추면 "이 사람이
          없다"와 "꺼져 있다"가 구분되지 않는다. 흐리게만 두는 것도 부족하다 — 대비를
          못 보는 사람에게는 아무 신호도 아니다. */}
      {a.disabled && (
        <span
          data-testid={`directory-disabled-${a.id}`}
          className="rounded bg-surface-hover px-1 text-[10px] text-fg"
        >
          비활성
        </span>
      )}
    </li>
    );
  };

  const section = (label: string, rows: AccountView[]) => (
    <section aria-label={label} className="mb-4">
      <h3 className="px-2 pb-1 text-[11px] uppercase tracking-wide text-fg-subtle">
        {label} ({rows.length})
      </h3>
      {rows.length === 0
        ? <p className="px-2 text-xs text-fg-subtle">{label} 중 맞는 것이 없다</p>
        : <ul>{rows.map(row)}</ul>}
    </section>
  );

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="디렉터리"
        className="flex max-h-full w-[42rem] flex-col overflow-hidden rounded-lg border border-border bg-surface-raised text-sm text-fg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <div className="flex items-center gap-2 border-b border-border p-3">
          <span className="font-bold">Directory</span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-fg-muted hover:bg-surface-hover"
            aria-label="디렉터리 닫기"
          >
            ✕
          </button>
        </div>
        <div className="border-b border-border p-3">
          <input
            type="text"
            aria-label="디렉터리 검색"
            placeholder="handle 또는 이름으로 검색"
            className="w-full rounded border border-border bg-field px-2 py-1 text-fg placeholder-fg-subtle"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {/* 실패는 목록 위에 남긴다. 실패했는데 빈 목록만 보이면 사람은 "아무도 없다"로
              읽는다 — 조회 실패를 빈 목록으로 삼키지 않는다. */}
          {load.kind === 'error' && (
            <div role="alert" className="mb-3 rounded border border-danger-border bg-danger-surface p-2 text-xs text-danger">
              계정 목록을 불러오지 못했다 — {load.message}
              <button
                onClick={() => { reload(); }}
                className="ml-2 rounded bg-danger px-2 py-0.5 text-fg-on-strong hover:bg-danger-hover"
              >
                다시 시도
              </button>
            </div>
          )}
          {load.kind === 'loading' && total === 0 && (
            <p className="px-2 text-xs text-fg-subtle">불러오는 중…</p>
          )}
          {load.kind === 'ready' && total === 0 && (
            <p className="px-2 text-xs text-fg-subtle">이 워크스페이스에 아직 계정이 없다</p>
          )}
          {total > 0 && (
            <>
              {section('People', people)}
              {section('Agents', agents)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
