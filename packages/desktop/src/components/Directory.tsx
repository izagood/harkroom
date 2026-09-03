import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccountView } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
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
  const accounts = useAppStore((s) => s.accounts);
  const online = useAppStore((s) => s.online);
  const [query, setQuery] = useState('');
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });

  const account = accountId ? accounts[accountId] : null;

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

  useEffect(() => {
    if (!open) return;
    setLoad({ kind: 'loading' });
    // accountId 가 있으면 해당 계정의 handle 로 검색한다.
    setQuery(account ? account.handle : '');
    return reload();
  }, [open, reload, account]);

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
        ref={isSelected ? (el: HTMLLIElement | null) => { el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); } : undefined}
        className={`flex items-center gap-2 rounded px-2 py-1.5 ${a.disabled ? 'opacity-60' : ''} ${isSelected ? 'bg-indigo-950 ring-2 ring-indigo-500' : ''}`}
      >
      {/* #277: 이 자리는 **거터가 아니다** — 고정폭 열이 아니라 넓어지면 행이 늘어나는
          인라인 칸이고, 디렉터리는 소유자를 보여 주는 것이 일이다(#181·#226). badge 로 둔다. */}
      <Identity account={a} variant="badge" />
      {/* 연결 점은 소켓이 붙어 있는가다. 사람이 고른 상태(StatusMark)와 나란히 둔다 —
          합치면 "연결이 끊긴 사람"과 "방해 금지인 사람"이 한 표시로 뭉친다(#186). */}
      <span
        data-testid={`directory-presence-${a.id}`}
        data-online={String(online.includes(a.id))}
        className={`h-2 w-2 shrink-0 rounded-full ${online.includes(a.id) ? 'bg-green-500' : 'bg-zinc-600'}`}
      />
      <span className="font-medium text-zinc-100">{a.displayName}</span>
      <span className="text-zinc-400">@{a.handle}</span>
      <span
        data-testid={`directory-kind-${a.id}`}
        className="rounded bg-zinc-800 px-1 text-[10px] uppercase tracking-wide text-zinc-400"
      >
        {a.kind}
      </span>
      {a.isAdmin && (
        <span className="rounded bg-amber-900 px-1 text-[10px] text-amber-200">admin</span>
      )}
      <StatusMark account={a} />
      {a.statusText && <span className="truncate text-[11px] text-zinc-500">{a.statusText}</span>}
      {/* 비활성 계정은 목록에 남기되 **꺼져 있다는 것이 보여야 한다.** 감추면 "이 사람이
          없다"와 "꺼져 있다"가 구분되지 않는다. 흐리게만 두는 것도 부족하다 — 대비를
          못 보는 사람에게는 아무 신호도 아니다. */}
      {a.disabled && (
        <span
          data-testid={`directory-disabled-${a.id}`}
          className="rounded bg-zinc-700 px-1 text-[10px] text-zinc-200"
        >
          비활성
        </span>
      )}
    </li>
    );
  };

  const section = (label: string, rows: AccountView[]) => (
    <section aria-label={label} className="mb-4">
      <h3 className="px-2 pb-1 text-[11px] uppercase tracking-wide text-zinc-500">
        {label} ({rows.length})
      </h3>
      {rows.length === 0
        ? <p className="px-2 text-xs text-zinc-500">{label} 중 맞는 것이 없다</p>
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
        className="flex max-h-full w-[42rem] flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 text-sm text-zinc-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 p-3">
          <span className="font-bold">Directory</span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-zinc-400 hover:bg-zinc-700"
            aria-label="디렉터리 닫기"
          >
            ✕
          </button>
        </div>
        <div className="border-b border-zinc-800 p-3">
          <input
            type="text"
            aria-label="디렉터리 검색"
            placeholder="handle 또는 이름으로 검색"
            className="w-full rounded bg-zinc-800 px-2 py-1 text-zinc-100 placeholder-zinc-500"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {/* 실패는 목록 위에 남긴다. 실패했는데 빈 목록만 보이면 사람은 "아무도 없다"로
              읽는다 — 조회 실패를 빈 목록으로 삼키지 않는다. */}
          {load.kind === 'error' && (
            <div role="alert" className="mb-3 rounded border border-red-800 bg-red-950 p-2 text-xs text-red-200">
              계정 목록을 불러오지 못했다 — {load.message}
              <button
                onClick={() => { reload(); }}
                className="ml-2 rounded bg-red-800 px-2 py-0.5 text-red-100 hover:bg-red-700"
              >
                다시 시도
              </button>
            </div>
          )}
          {load.kind === 'loading' && total === 0 && (
            <p className="px-2 text-xs text-zinc-500">불러오는 중…</p>
          )}
          {load.kind === 'ready' && total === 0 && (
            <p className="px-2 text-xs text-zinc-500">이 워크스페이스에 아직 계정이 없다</p>
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
