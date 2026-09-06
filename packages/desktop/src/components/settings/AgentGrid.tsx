import { useMemo, useState } from 'react';
import type { AgentView } from '@murmur/shared';
import { Identity } from '../Identity';
import type { RunnerState } from '../../lib/runnerLauncher';

/**
 * 에이전트 그리드 + 검색(identity 문서 · Task 15-2).
 *
 * ## 카드는 조용하다
 *
 * 남는 것은 **아바타와 이름 둘뿐**이다. 하네스·소유자·마지막 활동은 전부 상세로 내려간다.
 * 전제가 바뀌었기 때문이다 — **에이전트는 계속 늘어난다.** 40개가 되면 카드마다 붙은 두 줄
 * 설명은 정보가 아니라 **벽**이 되고, 찾는 방법은 훑기가 아니라 검색이 된다.
 *
 * 문서의 마지막 경고를 그대로 지킨다: *"이 화면에서는 정보를 더하는 쪽이 항상 지는 쪽이다."*
 *
 * ## 상태는 사진이 말한다
 *
 * 상태 점도 상태 글자도 없다 — **아바타 자체가 세 가지로 갈린다.** 그래서 카드에 줄이 늘지
 * 않는다. 정상이 기본값이므로 정상에는 아무 장식도 붙이지 않는다(40개 중 38개가 그 모습이면
 * 화면이 조용하다).
 *
 * ## 검색은 이름만 훑지 않는다
 *
 * `@handle` 과 **역할 설명**(`instructions`)을 함께 훑는다 — "배포 담당이 누구였더라"를
 * 이름을 모르는 채로 찾을 수 있어야 검색이 목록을 대신한다. 설명은 카드에 안 보이지만
 * 찾을 때는 쓰인다.
 */
export function AgentGrid({
  agents, selectedId, runnerStates, online, connected, onPick, onCreate, canCreate, onRelaunch,
}: {
  agents: AgentView[];
  selectedId: string | null;
  runnerStates: Record<string, RunnerState>;
  /** 지금 붙어 있는 에이전트들. `connected` 가 false 면 이 목록은 '모른다'다. */
  online: string[];
  connected: boolean;
  onPick(agent: AgentView): void;
  onCreate(): void;
  canCreate: boolean;
  /** ▶ · ↻ 가 부르는 것. 없으면 그 자리를 그리지 않는다(권한 없는 사람에게는 문이 없다). */
  onRelaunch?(agent: AgentView): void;
}) {
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? agents.filter((a) =>
        a.handle.toLowerCase().includes(q)
        || a.displayName.toLowerCase().includes(q)
        // 설명은 카드에 안 보이지만 찾을 때는 쓰인다(문서).
        || a.instructions.toLowerCase().includes(q))
      : agents;
    // **가나다 고정**(문서가 정한 것). 상태순으로 정렬하면 켜지고 꺼질 때마다 카드가 자리를
    // 옮겨 위치로 기억하는 것이 불가능해진다 — 상태는 이미 사진이 말하고 있다.
    return [...matched].sort((a, b) => a.handle.localeCompare(b.handle));
  }, [agents, query]);

  return (
    <div className="flex min-h-0 flex-col">
      {/* 검색은 **화면 맨 위 고정**이다 — 목록이 길어져도 찾는 수단이 스크롤 밖으로 나가지 않는다. */}
      <div className="sticky top-0 z-10 bg-surface-raised pb-3">
        <input
          data-testid="agent-search"
          aria-label="에이전트 검색"
          className="w-full rounded border border-border bg-field px-3 py-2 text-sm
                     text-fg placeholder-fg-subtle"
          placeholder="이름이나 하는 일로 찾는다"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div data-testid="agent-grid" className="grid grid-cols-[repeat(auto-fill,86px)] gap-3 overflow-y-auto">
        {/*
          `+` 는 **맨 앞**이다. "그리드의 마지막 칸"으로 두면 40개일 때 그 칸이 스크롤 끝이라
          찾아가야 한다. 맨 앞이면 개수와 무관하게 자리가 고정되고, 검색으로 목록이 비어도
          `+` 는 그대로 있다.
        */}
        {canCreate && (
          <button
            data-testid="agent-create"
            className="flex h-[86px] w-[86px] flex-col items-center justify-center gap-1 rounded-lg
                       border border-dashed border-border text-fg-subtle hover:border-fg-subtle hover:text-fg"
            onClick={onCreate}
          >
            <span aria-hidden="true" className="text-lg leading-none">+</span>
            <span className="text-[11px]">새 에이전트</span>
          </button>
        )}

        {shown.map((a) => {
          const face = faceState(a.id, runnerStates, online, connected);
          return (
            <div key={a.id} className="relative">
              <button
                data-testid={`agent-card-${a.handle}`}
                data-selected={selectedId === a.id}
                data-face={face}
                className={`flex h-[86px] w-[86px] flex-col items-center justify-center gap-1.5 rounded-lg
                            border p-1 ${selectedId === a.id
                              ? 'border-accent bg-accent-surface'
                              : 'border-transparent hover:bg-surface-hover'}`}
                onClick={() => onPick(a)}
              >
                <span
                  className={`relative ${face === 'failed' ? 'rounded-full ring-2 ring-state-stuck' : ''}`}
                >
                  {/* 멈춘 사진은 **색이 빠진다** — 장식을 더하는 것이 아니라 덜어 낸다. */}
                  <span className={face === 'stopped' ? 'block grayscale opacity-60' : 'block'}>
                    <Identity account={a} className="h-10 w-10 text-sm" variant="avatar" />
                  </span>
                </span>
                <span className="w-full truncate text-center text-[11px] text-fg">{a.handle}</span>
              </button>

              {/*
                **▶ · ↻ 는 카드와 다른 동작이다.** 카드를 누르면 설정이 열리고 이것을 누르면
                러너가 뜬다 — 겹쳐 두면 실행이 우연히 눌린다. 그래서 카드 위에 따로 얹는다.
                정상(`running`·`external`)에는 아무것도 없다: 정상이 기본값이므로 표시를
                붙이지 않는다(40개 중 38개가 그 모습이면 화면이 조용하다).
              */}
              {onRelaunch && face !== 'ok' && (
                <button
                  data-testid={`agent-relaunch-${a.handle}`}
                  aria-label={`${a.handle} ${face === 'failed' ? '다시 띄우기' : '실행하기'}`}
                  className={`absolute left-1/2 top-[26px] -translate-x-1/2 rounded-full px-1.5
                              text-[13px] leading-5 ${face === 'failed'
                                ? 'bg-state-stuck text-fg-on-strong'
                                : 'bg-fg text-surface-raised'}`}
                  onClick={(e) => { e.stopPropagation(); onRelaunch(a); }}
                >
                  <span aria-hidden="true">{face === 'failed' ? '\u21bb' : '\u25b6'}</span>
                </button>
              )}
            </div>
          );
        })}

        {/* 검색 결과가 비었을 때. 목록이 비어 있는 것과 **못 찾은 것**은 다른 사실이다. */}
        {shown.length === 0 && (
          <p className="col-span-full py-6 text-center text-xs text-fg-muted">
            {query.trim() ? `"${query.trim()}" 에 맞는 에이전트가 없다` : '아직 에이전트가 없다'}
          </p>
        )}
      </div>

      {/*
        **실패만 글자를 받는다.** 문서: "유일하게 글자가 늘어나는 상태다. #368 이 사이드바에서
        겪었듯 사유가 title 툴팁에만 있으면 사람은 그것을 찾지 못한다. 예외에만 글자를 쓴다."
      */}
      {shown.filter((a) => runnerStates[a.id]?.status === 'failed').map((a) => (
        <p
          key={a.id}
          data-testid={`agent-runner-failed-${a.id}`}
          className="mt-2 whitespace-normal text-[11px] text-danger"
        >
          @{a.handle} 기동 실패{runnerStates[a.id]?.message ? ` — ${runnerStates[a.id]!.message}` : ''}
        </p>
      ))}
    </div>
  );
}

/**
 * 아바타가 갈리는 **세 가지**(문서: "상태는 사진이 말한다").
 *
 * - `ok`      그냥 사진. 정상이 기본값이므로 아무 장식도 없다
 * - `stopped` 색이 빠지고 ▶ — 누르면 그 자리에서 켜진다
 * - `failed`  붉은 테와 ↻, 그리고 **사유 한 줄**(유일하게 글자가 느는 상태)
 *
 * **생존을 모르면 `ok` 로 둔다.** `connected` 가 false 면 presence 는 '아무도 없다'가 아니라
 * '모른다'다(`threadState`·`waitChain` 과 같은 규약) — 소켓이 잠깐 끊긴 동안 40개가 전부
 * 회색으로 가라앉으면 그것도 거짓말이다.
 */
function faceState(
  id: string,
  runnerStates: Record<string, RunnerState>,
  online: string[],
  connected: boolean,
): 'ok' | 'stopped' | 'failed' {
  const st = runnerStates[id]?.status;
  if (st === 'failed' || st === 'needs_reissue') return 'failed';
  if (!connected) return 'ok';
  return online.includes(id) ? 'ok' : 'stopped';
}
