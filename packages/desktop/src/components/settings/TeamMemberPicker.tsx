import { useMemo, useState } from 'react';
import type { AgentView } from '@murmur/shared';
import { Identity } from '../Identity';
import type { RunnerState } from '../../lib/runnerLauncher';
import { faceState, isFaceGreyed } from '../../lib/faceState';

/**
 * 팀원 고르기 — **얼굴로 고른다** (`docs/desktop-agent-cards.html` 4단계).
 *
 * ## 네이티브 `select` 가 없어진 자리다
 *
 * 문서의 진단이 이 컴포넌트의 존재 이유 전부다:
 *
 * > *"추가가 네이티브 `select` — B3 에서 없애기로 한 바로 그것이고, 고르면서 얼굴을 볼 수
 * > 없다."*
 *
 * 그 `select` 는 `TeamsSettings.tsx` 에 있었고 `<option>@{handle}</option>` 을 나열했다.
 * 옆 화면이 얼굴 그리드인데 **같은 에이전트가 여기서는 얼굴이 없었다** — 그래서 사람이
 * 팀에 넣을 에이전트를 고르려면 이름을 외워서 옮겨 적어야 했다.
 *
 * ## 후보는 `listAgents()` 하나에서 온다 — **등록된 전부**
 *
 * 문서가 그 지점을 「무엇부터」의 1번으로 따로 세워 뒀다(*"팀 후보를 `listAgents()` 로 —
 * 몇 줄. 화면을 하나도 안 고치고 '왜 forge 만 보이나' 가 먼저 사라진다. 결함이지 디자인이
 * 아니므로 디자인을 기다릴 이유가 없다"*).
 *
 * 앞 화면은 후보를 **스토어의 `accounts`** 에서 뽑았다(`Object.values(accounts).filter(kind
 * === 'agent')`). 스토어의 계정 목록은 `GET /accounts` 가 채우는데, 그것이 담는 것은 이
 * 화면이 필요한 것과 다르다 — 말을 걸어 본 적 있는 계정들이다. 그래서 등록은 됐지만 아직
 * 아무 채널에도 없는 에이전트가 후보에서 조용히 빠졌다.
 *
 * `listAgents()` 는 **등록된 에이전트 전부**를 준다. 그 왕복은 이 화면이 이미 하고 있다
 * (`AgentsSettings` 가 격자를 그리려고 부른다) — 새 왕복이 아니라 **이미 손에 든 것을
 * 넘기는 것**이고, 그래서 후보 목록이 에이전트 격자와 같은 목록이 된다. 같아야 하는 이유가
 * 문서의 그 문장이다: 옆 묶음에 보이는 얼굴이 여기서 안 보이면 그것이 결함이다.
 *
 * ## 멈춘 에이전트도 고를 수 있다 (문서)
 *
 * > *"팀에 넣는 것과 지금 도는 것은 다른 일이다."*
 *
 * 얼굴은 **상태를 그대로 지닌다** — 회색이면 회색으로 그린다. 그런데 `disabled` 를 걸지
 * 않는다: 팀은 저장된 의도 기록이고(`AgentTeamRow` 주석: *"이름을 붙여 남기는 운영자의
 * 의도 기록"*), 지금 러너가 도는지는 그 의도와 무관하다. 회색 얼굴을 못 누르게 하면
 * 사람이 팀을 짜기 전에 러너를 다 띄워야 하고, 그것은 아무도 요구하지 않은 순서다.
 *
 * **비활성 계정도 고를 수 있다.** 같은 이유이고 근거가 한 겹 더 있다 — 비활성 에이전트는
 * 팀에 **남는다**(`036_agent_team.sql`, `AgentTeamMemberRow.disabled` 의 주석). 이미
 * 남는 것을 넣지 못하게 막으면 화면이 서버보다 좁아지고, 그것도 거짓 신호다(design.md §4).
 *
 * ## 검색은 에이전트 격자와 **같은 검색**이다 (문서)
 *
 * *"이름과 설명을 함께 훑는다"* — `AgentGrid.shown` 이 하는 그 판정이다. 같아야 하는 이유가
 * 그 주석에 있다: *"배포 담당이 누구였더라"* 를 이름을 모르는 채로 찾을 수 있어야 한다.
 * 두 자리가 다르게 훑으면 격자에서 찾아낸 방법이 여기서 안 통한다.
 *
 * ## 왜 `AgentGrid` 를 그대로 부르지 않았나
 *
 * `TeamGrid` 가 같은 질문에 답한 것과 **같은 이유**이고(그 파일의 「왜 재사용하지 않았나」),
 * 여기서는 한 겹 더 분명하다: 이 격자의 카드는 **누르면 팀에 들어간다.** `AgentGrid` 의
 * `onPick` 은 상세를 여는 문이고(그 컴포넌트 주석: *"카드를 누르면 설정이 열린다"*), 같은
 * 손잡이가 두 자리에서 다른 일을 하면 사람이 어느 쪽인지 카드만 봐서는 알 수 없다.
 * 그리고 이 자리에는 정보 세 줄도 `▶`·`■`·`↻` 도 `+` 카드도 필요 없다 — 고르는 화면에
 * 새 에이전트를 만드는 문이 서면 그것이 이 겹창이 답할 수 없는 질문이 된다.
 *
 * 대신 **틀은 따른다**: 얼굴 · 이름 한 줄 · 가나다 고정 · 검색 한 줄. 크기만 갈린다(아래).
 */
export function TeamMemberPicker({ candidates, runnerStates, online, connected, onAdd, busy }: {
  /** 후보. **`listAgents()` 의 전부에서 이미 팀원인 것만 뺀 목록**을 호출부가 넘긴다. */
  candidates: AgentView[];
  runnerStates: Record<string, RunnerState>;
  online: string[];
  connected: boolean;
  onAdd(accountId: string): void;
  busy: boolean;
}) {
  const [query, setQuery] = useState('');

  /** `AgentGrid.shown` 과 **같은 판정**이다 — 이름·표시이름·설명을 훑고 가나다로 세운다. */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? candidates.filter((a) =>
        a.handle.toLowerCase().includes(q)
        || a.displayName.toLowerCase().includes(q)
        || (a.instructions ?? '').toLowerCase().includes(q))
      : candidates;
    return [...matched].sort((a, b) => a.handle.localeCompare(b.handle));
  }, [candidates, query]);

  return (
    <div data-testid="team-member-picker">
      <div className="relative">
        <span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle">⌕</span>
        <input
          data-testid="team-candidate-search"
          aria-label="팀원 후보 검색"
          className="w-full rounded-lg border border-border bg-field py-2 pl-8 pr-3
                     text-fg placeholder-fg-subtle"
          placeholder="이름 · 설명으로 찾기"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/*
        ## 트랙 72px — **격자의 164px 이 여기서는 안 맞는다**

        설정 격자의 트랙이 164px 인 것은 정보 세 줄의 가장 넓은 값(뒤처진 버전 칩 94px)이
        요구한 폭에서 나왔다(`AgentGrid` 의 `PLACE` 표). **이 자리에는 그 세 줄이 없다** —
        담는 것이 얼굴과 이름 한 줄뿐이고, 그러면 그 근거가 그대로 사라진다.

        담는 것이 얼굴과 이름뿐인 자리의 값은 이 저장소에 이미 있다: 사이드바의 64px 트랙 +
        40px 얼굴이다(`PLACE.sidebar`). 그 값을 따르되 한 단 키운다 — 이 격자는 상세 패널
        안(`max-w-2xl`)에 서므로 사이드바의 164~224px 제약이 없고, 44px 얼굴을 쓰면 **팀
        카드의 겹친 얼굴과 같은 크기**가 된다. 고르는 화면의 얼굴과 그 결과가 카드에 서는
        얼굴이 같은 크기인 것이 이 짝의 값이다.

        44 + 좌우 여유 14×2 = 72px 이고, 그 여유가 사이드바의 40/64(좌우 12px)와 같은
        비율이다 — 그 표가 그 값을 고른 이유가 *"`ring-2` 선택 테가 옆 카드에 닿지 않게"*
        였고, 이 격자에도 `focus-visible` 링이 선다.
      */}
      <div
        data-testid="team-candidate-grid"
        className="mt-2 grid max-h-64 grid-cols-[repeat(auto-fill,72px)] gap-x-3 gap-y-3
                   overflow-y-auto rounded-lg bg-surface-sunken p-3"
      >
        {shown.map((a) => {
          const face = faceState(a.id, runnerStates, online, connected);
          return (
            <button
              key={a.id}
              data-testid={`team-candidate-${a.handle}`}
              data-face={face}
              /*
                접근 이름이 **하는 일을 말한다.** 얼굴과 이름만으로는 이 카드가 무엇을 하는
                것인지 스크린리더에 아무 말도 하지 않고, 격자의 카드(상세를 여는 문)와
                구분되지 않는다 — 이 파일 머리 주석이 그것을 같은 손잡이의 위험으로 적었다.
              */
              aria-label={`팀에 넣기: ${a.handle}`}
              disabled={busy}
              className="flex w-[72px] flex-col items-center gap-1 rounded-lg p-1
                         hover:bg-surface-hover disabled:opacity-50"
              onClick={() => onAdd(a.id)}
            >
              {/* 회색조 필터는 격자·팀 카드와 **같은 값**이다(`isFaceGreyed`) — 같은 러너를
                  세 자리가 다른 회색으로 그리면 사람이 그 차이를 뜻으로 읽는다. */}
              <span
                className={isFaceGreyed(face)
                  ? 'block grayscale brightness-[1.7] contrast-[0.55] opacity-90'
                  : 'block'}
              >
                <Identity account={a} className="h-11 w-11 text-[15px]" variant="avatar" />
              </span>
              <span className="block w-full truncate text-center text-meta text-fg-muted">
                {a.handle}
              </span>
            </button>
          );
        })}
        {shown.length === 0 && (
          <p className="col-span-full py-4 text-center text-meta text-fg-muted">
            {query.trim()
              ? `"${query.trim()}" 에 맞는 에이전트가 없다`
              : '넣을 수 있는 에이전트가 없다 — 등록된 에이전트가 모두 이 팀에 있다'}
          </p>
        )}
      </div>
    </div>
  );
}
