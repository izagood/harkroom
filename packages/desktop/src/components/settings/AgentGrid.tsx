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
      <div className="sticky top-0 z-10 bg-surface-raised pb-4">
        <div className="relative">
          <span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle">⌕</span>
          <input
            data-testid="agent-search"
            aria-label="에이전트 검색"
            className="w-full rounded-lg border border-border bg-field py-2 pl-8 pr-14 text-sm
                       text-fg placeholder-fg-subtle"
            placeholder="이름으로 찾기"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* 개수는 **검색창 안**이다(목업) — 몇 개를 뒤지고 있는지가 찾기 전에 보여야 한다. */}
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-fg-subtle">
            {shown.length}개
          </span>
        </div>
      </div>

      <div data-testid="agent-grid" className="grid grid-cols-[repeat(auto-fill,86px)] gap-x-6 gap-y-5 overflow-y-auto">
        {/*
          `+` 는 **맨 앞**이다. "그리드의 마지막 칸"으로 두면 40개일 때 그 칸이 스크롤 끝이라
          찾아가야 한다. 맨 앞이면 개수와 무관하게 자리가 고정되고, 검색으로 목록이 비어도
          `+` 는 그대로 있다.
        */}
        {canCreate && (
          <button
            data-testid="agent-create"
            className="group flex w-[86px] flex-col items-center gap-2"
            onClick={onCreate}
          >
            {/* 목업처럼 **점선도 원**이다 — 사각 점선은 옆의 둥근 얼굴들과 다른 종류로 읽힌다. */}
            <span
              className="flex h-14 w-14 items-center justify-center rounded-full border border-dashed
                         border-border text-fg-subtle group-hover:border-fg-subtle group-hover:text-fg"
            >
              <span aria-hidden="true" className="text-lg leading-none">+</span>
            </span>
            <span className="text-[11px] text-fg-muted">새 에이전트</span>
          </button>
        )}

        {shown.map((a) => {
          const face = faceState(a.id, runnerStates, online, connected);
          return (
            <div key={a.id} className="group relative flex flex-col items-center">
              <button
                data-testid={`agent-card-${a.handle}`}
                data-selected={selectedId === a.id}
                data-face={face}
                // **얼굴이 주인공이다**(문서: "얼굴만 남긴다"). 카드 상자를 그리지 않는다 —
                // 목업에는 테두리도 면도 없고 **원과 이름**만 있다. 상자를 두면 26개가 깔릴 때
                // 격자 선이 얼굴보다 먼저 눈에 들어온다.
                className="group flex w-[86px] flex-col items-center gap-2"
                onClick={() => onPick(a)}
              >
                <span
                  className={`relative block rounded-full ${
                    face === 'failed' ? 'ring-2 ring-state-stuck' : ''
                  } ${selectedId === a.id ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface-raised' : ''}`}
                >
                  {/*
                    멈춘 사진은 **색이 빠진다** — 장식을 더하는 것이 아니라 덜어 낸다.
                    `grayscale` 만으로는 부족하다: 어두운 색(예: blue-500)은 회색조로 바꿔도
                    **거의 검정**이 되어 목업의 중간 회색과 달라지고, 흰 글리프가 그 위에서
                    과하게 도드라진다. 그래서 밝기를 함께 올려 **중간 회색**으로 모은다.
                  */}
                  {/* `#443`: `unknown` 도 색이 빠진다 — 초록으로 두는 것이 이 이슈다.
                      `stopped` 와 **같은 회색**인 것은 의도다: 다른 회색을 하나 더 만들면
                      사람이 두 회색을 구분해 외워야 하고, 그 부담은 이 정보의 무게보다 크다.
                      두 상태를 가르는 것은 색이 아니라 **▶ 의 유무와 글자**다(아래). */}
                  <span
                    className={face === 'stopped' || face === 'unknown'
                      ? 'block grayscale brightness-[1.7] contrast-[0.55] opacity-90'
                      : 'block'}
                  >
                    <Identity account={a} className="h-14 w-14 text-lg" variant="avatar" />
                  </span>
                </span>
                <span
                  className={`w-full truncate text-center text-[11px] ${
                    face === 'ok' ? 'text-fg' : 'text-fg-subtle'
                  }`}
                >
                  {a.handle}
                </span>
              </button>

              {/*
                **▶ · ↻ 는 카드와 다른 동작이다.** 카드를 누르면 설정이 열리고 이것을 누르면
                러너가 뜬다 — 겹쳐 두면 실행이 우연히 눌린다. 그래서 카드 위에 따로 얹는다.
                정상(`running`·`external`)에는 아무것도 없다: 정상이 기본값이므로 표시를
                붙이지 않는다(40개 중 38개가 그 모습이면 화면이 조용하다).
              */}
              {/* `#443`: `unknown` 에는 ▶ 를 **달지 않는다.** ▶ 는 "눌러서 켜라"인데,
                  지금 도는지 모르는 것을 켜라고 권하면 이미 도는 러너를 하나 더 띄우게
                  된다 — `#430` 의 중복이 바로 그 모양이었다. 모를 때 화면이 할 일은
                  행동을 권하는 것이 아니라 **모른다고 말하는 것**이다. */}
              {onRelaunch && face !== 'ok' && face !== 'unknown' && (
                /*
                  **글리프는 사진 안에 있다**(문서: "실행하기 버튼도 사라진다 — 사진 안으로
                  들어간다"). 그래서 뱃지가 아니라 얼굴을 덮는 원이고, 평소에는 **옅게** 얹혀
                  사진을 가리지 않는다. 마우스를 올리면 또렷해진다 — 누를 수 있다는 것이
                  그때 분명해지면 충분하고, 26개가 깔린 화면에서 26개의 진한 글리프는 소음이다.

                  카드와 **다른 동작**이라는 것은 그대로다: 카드를 누르면 설정이 열리고
                  이것을 누르면 러너가 뜬다.
                */
                <button
                  data-testid={`agent-relaunch-${a.handle}`}
                  aria-label={`${a.handle} ${face === 'failed' ? '다시 띄우기' : '실행하기'}`}
                  className={`absolute left-1/2 top-0 flex h-14 w-14 -translate-x-1/2 items-center
                              justify-center rounded-full text-xl leading-none opacity-50 transition
                              group-hover:opacity-100 focus-visible:opacity-100 ${
                                face === 'failed' ? 'text-state-stuck' : 'text-fg'
                              }`}
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

      {/*
        `#476`: **하네스가 없어 물러난 러너도 글자를 받는다.**

        `#473` 이 사유 문구를 만들었지만 그것이 닿는 자리는 사이드바 하나였고, 이 격자는
        `needs_harness` 를 `failed` 로도 안 쳐서 얼굴조차 멀쩡했다. **새 사용자의 기본
        상태가 이것이다**(`claude`·`codex` 는 사용자가 직접 설치한다, 2026-09-06 결정) —
        가장 흔한 상태가 화면에서 가장 조용했다.

        `실패`(danger)와 색을 가르는 이유: 이것은 고장이 아니라 **설치가 아직 안 된 것**이고,
        사람이 할 일이 분명하다. `RunnerStatus.tsx` 의 `TONE` 이 같은 판단을 이미 적어 뒀다.
      */}
      {shown.filter((a) => runnerStates[a.id]?.status === 'needs_harness').map((a) => (
        <p
          key={a.id}
          data-testid={`agent-runner-harness-${a.id}`}
          className="mt-2 whitespace-normal text-[11px] text-warning"
        >
          @{a.handle} {runnerStates[a.id]?.message ?? '하네스를 찾을 수 없다'}
        </p>
      ))}

      {/*
        `#443`: **모른다는 것도 글자로 말한다.**

        얼굴에서 색을 빼는 것만으로는 `stopped`(꺼졌다)와 구분되지 않고, 사람은 회색을
        보면 켜려 한다. 무엇을 모르는지, 그리고 **왜 모르는지**를 한 줄로 준다 —
        사유를 알면 사람은 러너를 뒤지는 대신 연결을 본다.

        한 줄로 묶는 이유: 끊기면 남의 러너가 **전부** 이 상태가 된다. 40줄이 깔리면
        그것이 곧 소음이고, 소음은 읽히지 않는다.
      */}
      {(() => {
        const unknown = shown.filter((a) => faceState(a.id, runnerStates, online, connected) === 'unknown');
        if (unknown.length === 0) return null;
        return (
          <p data-testid="agent-presence-unknown" className="mt-2 whitespace-normal text-[11px] text-fg-muted">
            서버와 끊겨 {unknown.length}개 에이전트의 생사를 알 수 없다 — 마지막으로 본 상태이지 지금 상태가 아니다.
            다시 붙으면 갱신된다.
          </p>
        );
      })()}
    </div>
  );
}

/**
 * 아바타가 갈리는 **네 가지**(문서: "상태는 사진이 말한다").
 *
 * - `ok`      그냥 사진. 정상이 기본값이므로 아무 장식도 없다
 * - `stopped` 색이 빠지고 ▶ — 누르면 그 자리에서 켜진다
 * - `failed`  붉은 테와 ↻, 그리고 **사유 한 줄**(유일하게 글자가 느는 상태)
 * - `unknown` **모른다** — `#443` 이 만든 것
 *
 * ## `unknown` 이 왜 생겼나 — `ok` 도 거짓말이었다 (실측 2026-09-06, 릴리즈 `.app`)
 *
 * 앞 판본의 주석은 이렇게 적혀 있었다:
 *
 * > **생존을 모르면 `ok` 로 둔다.** … 소켓이 잠깐 끊긴 동안 40개가 전부 회색으로
 * > 가라앉으면 그것도 거짓말이다.
 *
 * **뒤 문장은 옳고 앞 문장은 틀렸다.** 회색이 거짓말인 것과 똑같이 `ok`(그냥 사진, 초록)
 * 도 거짓말이다 — 서버가 죽은 순간 화면은 이랬다:
 *
 * ```
 * 타이틀 옆 점       🔴 빨강        ← 맞음
 * 에이전트 6개       전부 초록      ← 거짓. 실제로는 알 수 없음
 * ```
 *
 * 두 거짓말 사이에서 하나를 고를 이유가 없었다. **모른다고 말하는 값이 없었을 뿐이다.**
 * 그래서 `#368` 의 규율을 그대로 적용한다: 모르면 모른다고 한다.
 *
 * ## daemon 과 서버가 어긋날 때 — **daemon 이 이긴다. 다만 자기가 아는 것에 한해서**
 *
 * `#482` 이후 두 출처가 같은 질문에 답한다:
 *
 * | 출처 | 무엇을 아는가 | 어떻게 아는가 |
 * |---|---|---|
 * | **daemon** | **자기 장부의 러너**만 | `kill(pid, 0)` — 직접 관측 |
 * | 서버(presence) | 이 계정으로 붙은 러너 전부 | 소켓이 살아 있을 때의 보고 |
 *
 * daemon 은 **자기가 띄운 것만** 장부에 담는다(`#482`: "장부에는 자기가 spawn 한 것만
 * 있으므로 남의 러너에 영향받지 않는다"). 그래서 판정이 두 겹이다:
 *
 * - **내 러너**(`runnerStates` 에 있다) → **daemon 이 이긴다.** `kill(pid,0)` 은 관측이고
 *   presence 는 서버의 보고다. 그리고 결정적으로 **소켓이 끊겨도 daemon 은 안 끊긴다** —
 *   daemon 은 이 앱 옆에 있고 서버는 네트워크 너머에 있다. 끊긴 동안 유일하게 남아 있는
 *   사실이 daemon 의 것이다
 * - **남의 러너**(`runnerStates` 에 없다) → **서버만 안다.** daemon 의 침묵은
 *   "안 돈다"가 아니라 **"내 장부에 없다"** 이므로 그것으로 죽었다고 말할 수 없다.
 *   그래서 서버가 말을 못 하는 동안(`!connected`)은 `unknown` 이다
 *
 * 이 순서가 뒤집히면 `#430` 이 되돌아온다 — 그 이슈가 정확히 "presence 를 판정자로 썼다"
 * 였고, `#482` 가 그것을 daemon 관측으로 옮겼다. 화면만 옛 판정자로 남을 이유가 없다.
 *
 * ## 강조를 쓰지 않는다
 *
 * `unknown` 은 `stopped` 와 **같은 회색조**를 쓰되 ▶ 를 달지 않는다. 강조를 얹지 않는
 * 이유는 `#443` 코멘트에 있다: 연결 끊김은 타이틀 옆 빨간 점이 이미 불러 세우고,
 * 이 얼굴들은 그 사실의 파생이다. 같은 사실로 두 번 붙잡지 않는다.
 *
 * **▶ 를 안 다는 것이 요점이다.** `stopped` 의 ▶ 는 "눌러서 켜라"이고, 지금은 이미 돌고
 * 있을 수도 있는 것을 또 띄우자고 권하는 셈이 된다.
 */
function faceState(
  id: string,
  runnerStates: Record<string, RunnerState>,
  online: string[],
  connected: boolean,
): 'ok' | 'stopped' | 'failed' | 'unknown' {
  const st = runnerStates[id]?.status;
  // `needs_harness` 가 여기 든다(`#476`). 앞 판본에 빠져 있어서, 하네스가 없어 죽은 러너가
  // 격자에서는 **멀쩡한 얼굴**로 보였다 — 사유가 닿는 자리가 사이드바 하나뿐이었다.
  if (st === 'failed' || st === 'needs_reissue' || st === 'needs_harness') return 'failed';

  // ── daemon 이 아는 것이 먼저다 ─────────────────────────────────────────────
  // `running`·`adopted` 는 이 앱의 daemon 이 `kill(pid,0)` 로 확인한 것이고(`#482`),
  // **서버와 끊겨도 그 사실은 안 끊긴다.** 그래서 `connected` 를 보지 않는다.
  if (st === 'running' || st === 'adopted') return 'ok';

  // ── daemon 이 모르는 것은 서버에 묻는다 ────────────────────────────────────
  // 남의 기계에서 뜬 러너가 여기 든다(`design.md` §1 외부 접속형). daemon 의 침묵은
  // "안 돈다"가 아니라 "내 장부에 없다"이므로 그것으로 생사를 말할 수 없다.
  if (!connected) return 'unknown';
  return online.includes(id) ? 'ok' : 'stopped';
}
