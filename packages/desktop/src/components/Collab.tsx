import { useState, type ReactElement } from 'react';
import type { CollabProposal, CollabProposalState, CollabRepoView } from '@harkroom/shared';
import { useT } from '../i18n/useT';
import type { Translate } from '../i18n';
import { countFor, filterRepos, type CollabFilter, type CollabSnapshot } from '../lib/collabProposals';

/**
 * 협업 탭 — 레일 다섯째 칸(정본 `docs/desktop-collab.html`, 설계 `docs/hub-seat.md`).
 *
 * ## 이 칸이 avcshub 웹의 `/[org]/[repo]/proposals` 를 대신한다
 *
 * 제안은 **머무는 것**이다. 채널 메시지로 흘려보내면 스크롤과 함께 사라지고, 상태 축
 * (열림·결정 필요·승인)이 없어 거를 수도 없다(#534 가 그 투영을 걷어낸 이유). 그래서 자리를
 * 하나 세우고, 그 자리는 avcs 를 직접 읽는다.
 *
 * ## 줄이 말하는 넷 — 인박스와 같은 규칙
 *
 * **누가**(얼굴) · **무슨 제안**(`intent.title`) · **무엇을 건드리나**(`effects`) ·
 * **언제·어느 저장소**. 두 목록이 같은 물음("내가 무엇을 해야 하나")에 답하므로 규칙을 같이 쓴다.
 *
 * ## 정렬은 서버가 한다
 *
 * 막는 순(결정 필요 → 검증 실패 → 열림 → 승인·거부)은 `avcs/proposals.ts` 가 이미 접어서
 * 준다. 화면에서 한 번 더 정렬하면 같은 규칙이 두 곳에 있게 되고, 한쪽만 고치는 날이 온다.
 *
 * ## 잠금은 그리지 않는다
 *
 * "누가 어느 파일을 잡았다"(lease)는 제안을 읽는 사람이 묻는 것이 아니다 — 겹침이 실제로
 * 문제가 되면 **결정 필요**로 나타나고, 그때 이 칸이 말한다.
 */
export function Collab({ snapshot, filter, onFilterChange, handleOf, onOpenChannel }: {
  snapshot: CollabSnapshot;
  filter: CollabFilter;
  onFilterChange: (filter: CollabFilter) => void;
  /** avcs actor 키를 사람이 읽는 이름으로. 모르는 키는 **키 그대로** 돌려준다(외부 작업자다). */
  handleOf: (actorKeyId: string) => string;
  /** 저장소에 바인딩된 채널로 간다. 채널이 없으면 부르지 않는다. */
  onOpenChannel: (channelId: string) => void;
}): ReactElement {
  const t = useT();

  return (
    <div className="flex flex-col gap-1" data-testid="collab">
      <div className="border-b border-border pb-2 pt-4">
        <div className="text-title font-semibold text-fg">{t('collab.title')}</div>
      </div>

      {snapshot.kind === 'checking' && (
        <div className="px-2 py-1 text-meta text-fg-subtle" data-testid="collab-checking">
          {t('collab.checking')}
        </div>
      )}

      {/*
        **모름을 0 으로 그리지 않는다.** 물었는데 답을 못 받은 것과 제안이 없는 것은 다르고,
        둘을 같은 모양으로 그리면 사람은 아무도 일하지 않는다고 읽는다. 사유는 서버가 쓴
        문구를 그대로 옮긴다 — 화면이 원인을 지어내면 로그를 볼 이유가 사라진다.
      */}
      {snapshot.kind === 'unknown' && (
        <div
          className="mx-1 rounded border border-dashed border-border px-2 py-2"
          data-testid="collab-unknown"
        >
          <div className="text-meta text-fg">{t('collab.unknown')}</div>
          <div className="mt-0.5 text-meta text-fg-subtle break-words">{snapshot.reason}</div>
        </div>
      )}

      {snapshot.kind === 'known' && (
        snapshot.view.baseUrl === null
          ? (
            // "제안이 없다" 와 "보고 있는 서버가 없다" 는 다른 말이다. 후자는 설정의 문제라
            // 사람이 할 일이 다르다.
            <div
              className="mx-1 rounded border border-dashed border-border px-2 py-2 text-meta text-fg-subtle"
              data-testid="collab-no-server"
            >
              {t('collab.noServer')}
            </div>
          )
          : (
            <Loaded
              repos={snapshot.view.repos}
              actors={snapshot.view.actors ?? {}}
              filter={filter}
              onFilterChange={onFilterChange}
              handleOf={handleOf}
              onOpenChannel={onOpenChannel}
            />
          )
      )}
    </div>
  );
}

function Loaded({ repos, actors, filter, onFilterChange, handleOf, onOpenChannel }: {
  repos: CollabRepoView[];
  actors: Record<string, string>;
  filter: CollabFilter;
  onFilterChange: (filter: CollabFilter) => void;
  handleOf: (actorKeyId: string) => string;
  onOpenChannel: (channelId: string) => void;
}): ReactElement {
  const t = useT();
  const shown = filterRepos(repos, filter);
  const nothing = shown.every((r) => !r.proposals.length && !r.error);

  return (
    <>
      <div className="flex items-center gap-1 px-2 py-1" role="group" aria-label={t('collab.filter.label')}>
        {(['open', 'accepted', 'all'] as const).map((f) => (
          <button
            key={f}
            type="button"
            data-testid={`collab-filter-${f}`}
            aria-pressed={filter === f}
            onClick={() => onFilterChange(f)}
            className={`rounded px-1.5 py-0.5 text-meta ${
              filter === f ? 'bg-surface-sunken text-fg' : 'text-fg-subtle hover:text-fg'
            }`}
          >
            {t(`collab.filter.${f}`, { count: countFor(repos, f) })}
          </button>
        ))}
      </div>

      {nothing && (
        <div className="px-2 py-1 text-meta text-fg-subtle" data-testid="collab-empty">
          {t('collab.empty')}
        </div>
      )}

      {shown.map((repo) => (
        <div key={repo.repo} className="flex flex-col gap-1" data-testid={`collab-repo-${repo.repo}`}>
          <div className="flex items-center gap-2 px-2 pt-3 pb-1">
            <span className="text-meta font-medium tracking-wide text-fg-subtle uppercase">{repo.repo}</span>
            {repo.channelIds[0] && (
              <button
                type="button"
                className="text-meta text-fg-subtle hover:text-fg"
                data-testid={`collab-open-channel-${repo.repo}`}
                onClick={() => onOpenChannel(repo.channelIds[0]!)}
              >
                {t('collab.openChannel')}
              </button>
            )}
          </div>

          {/*
            저장소 하나를 못 읽어도 목록 전체는 선다(서버가 그 줄만 `error` 로 준다). 여기서
            빈 목록으로 그리면 "안 보이는 것" 과 "없는 것" 이 같아진다.
          */}
          {repo.error && (
            <div className="px-2 py-1 text-meta text-danger" data-testid={`collab-repo-error-${repo.repo}`}>
              {t('collab.repoUnreachable')}
            </div>
          )}

          {repo.proposals.map((p) => (
            <Row
              key={p.intentOid}
              proposal={p}
              actorLabel={(key) => (actors[key] ? handleOf(actors[key]) : key)}
            />
          ))}

          {/*
            "어느 시점의, 어느 환원기의 판정인가." 이 응답은 권위가 아니라 복제본이 계산했을
            값이라(avcs docs/26 §6-4) 화면이 그 사실을 말해야 한다. 환원 평면이 없는 서버면
            줄 자체가 없고, 그때 상태는 전부 `모름` 으로 선다.
          */}
          {repo.reducedAt && (
            <div className="px-2 text-meta text-fg-subtle" data-testid={`collab-reduced-${repo.repo}`}>
              {t('collab.reducedAt', {
                cursor: String(repo.reducedAt.cursor),
                materializer: repo.reducedAt.materializer,
              })}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** 상태를 점 하나로. 색은 「막는 것이 눈에 먼저 들어온다」는 순서를 그대로 따른다. */
const STATE_DOT: Record<CollabProposalState, string> = {
  needs_decision: 'text-danger',
  check_failed: 'text-danger',
  open: 'text-state-running',
  accepted: 'text-fg-subtle',
  rejected: 'text-fg-subtle',
  unknown: 'text-fg-subtle',
};

/**
 * op 의 상태를 사람 말로. **모르는 상태는 avcs 가 쓴 말 그대로 보인다** — 프로토콜이 상태를
 * 하나 더하는 날 화면이 빈칸을 그리는 대신, 번역이 없다는 사실이 그대로 드러나는 편이 낫다.
 */
const OP_STATUS = {
  proposed: 'collab.opStatus.proposed',
  validating: 'collab.opStatus.validating',
  accepted: 'collab.opStatus.accepted',
  rejected: 'collab.opStatus.rejected',
  superseded: 'collab.opStatus.superseded',
  needs_decision: 'collab.opStatus.needs_decision',
  quarantined: 'collab.opStatus.quarantined',
} as const;

function opStatusLabel(t: Translate, status: string | null): string | null {
  if (!status) return null;
  const key = OP_STATUS[status as keyof typeof OP_STATUS] as Parameters<Translate>[0] | undefined;
  return key ? t(key) : status;
}

/**
 * 제안 한 줄. **누르면 펼쳐진다**(`docs/desktop-collab.html`: "제안을 열면 트리가 보인다").
 *
 * ## 왜 새 화면이 아니라 그 자리에서 펼치는가
 *
 * 목록이 답하는 물음은 "내가 무엇을 막고 있나" 이고, 상세가 답하는 것은 "그래서 무엇을
 * 골라야 하나" 다. 둘은 **같은 판단의 두 단계**라, 화면을 갈아 끼우면 사람이 목록의 자리를
 * 잃고 돌아와서 다시 찾는다. 펼치면 옆 줄이 그대로 보인다 — 충돌은 대개 **이웃한 두 제안**
 * 사이의 일이므로 그 이웃이 화면에 남아 있어야 한다.
 *
 * ## 펼친 상태는 줄이 들고 있는다
 *
 * 목록은 20초마다 새로 온다(`useCollabProposals`). 펼침을 위에서 들면 그 갱신마다 어느 줄이
 * 열렸는지를 다시 맞춰야 하고, 제안이 사라지면 그 상태도 손으로 지워야 한다. 줄이 들고 있으면
 * React 가 키(`intentOid`)로 알아서 따라간다.
 */
function Row({ proposal, actorLabel }: {
  proposal: CollabProposal;
  actorLabel: (actorKeyId: string) => string;
}): ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const blocked = proposal.ops.map((o) => o.blockedReason).find((r) => r);

  return (
    <div
      className="rounded bg-surface-sunken"
      data-testid={`collab-row-${proposal.intentOid}`}
      /* 상태를 속성으로도 남긴다 — 시험이 상태를 **글자로** 집으면 로케일 기본값이 바뀌는
         날 이유 없이 빨개진다(`agentTurns.test` 가 적어 둔 규칙). */
      data-state={proposal.state}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1 text-left"
        data-testid={`collab-toggle-${proposal.intentOid}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true" className={`shrink-0 text-meta ${STATE_DOT[proposal.state]}`}>●</span>
        <span className="truncate text-meta font-medium text-fg">{proposal.title}</span>
        <span className="ml-auto shrink-0 text-meta text-fg-subtle">
          {proposal.ownerKeyId ? actorLabel(proposal.ownerKeyId) : t('collab.ownerUnknown')}
        </span>
      </button>
      <div className="flex flex-wrap items-center gap-1 px-2 pb-1">
        <span className="text-meta text-fg-subtle" data-testid={`collab-state-${proposal.intentOid}`}>
          {t(`collab.state.${proposal.state}`)}
        </span>
        <span className="text-meta text-fg-subtle">{t('collab.ops', { count: proposal.ops.length })}</span>
        {/*
          파급은 **선언된 것만** 그린다. 아무 op 도 선언하지 않았으면 칩이 없고, 그것은
          "파급 없음" 이 아니라 "선언하지 않았다" 이다 — 서버가 그 둘을 갈라서 준다.
        */}
        {proposal.effects?.changesBehavior && (
          <span className="text-meta text-fg-subtle" data-testid={`collab-effect-behavior-${proposal.intentOid}`}>
            {t('collab.effects.behavior')}
          </span>
        )}
        {proposal.effects?.breaksPublicApi && (
          <span className="text-meta text-danger" data-testid={`collab-effect-api-${proposal.intentOid}`}>
            {t('collab.effects.api')}
          </span>
        )}
        {proposal.conflicts.map((c) => (
          <span key={c.id} className="text-meta text-danger" data-testid={`collab-conflict-${c.id}`}>
            {t('collab.conflict', { key: c.key })}
          </span>
        ))}
      </div>
      {blocked && (
        <div className="px-2 pb-1 text-meta text-fg-subtle break-words">{blocked}</div>
      )}
      {open && <Detail proposal={proposal} actorLabel={actorLabel} />}
    </div>
  );
}

/**
 * 펼친 제안 — `intent` 아래의 **op → evidence**, 그리고 결정과 충돌.
 *
 * 여기서 **avcs 를 다시 부르지 않는다.** 목록이 이미 트리를 통째로 들고 있다(서버가
 * `buildProposals` 로 접어서 준다) — 펼칠 때마다 다시 물으면 같은 값을 두 번 받고, 그 사이에
 * 값이 달라지면 접힌 줄과 펼친 속이 서로 다른 시점을 말하게 된다.
 */
function Detail({ proposal, actorLabel }: {
  proposal: CollabProposal;
  actorLabel: (actorKeyId: string) => string;
}): ReactElement {
  const t = useT();

  return (
    <div
      className="flex flex-col gap-2 border-t border-border px-2 py-2"
      data-testid={`collab-detail-${proposal.intentOid}`}
    >
      <div className="flex flex-col gap-1">
        <div className="text-meta font-medium tracking-wide text-fg-subtle uppercase">
          {t('collab.detail.ops')}
        </div>
        {/* op 이 없는 intent 는 **열어만 둔 제안**이다. 빈칸 대신 그 사실을 적는다. */}
        {!proposal.ops.length && (
          <div className="text-meta text-fg-subtle" data-testid={`collab-detail-noops-${proposal.intentOid}`}>
            {t('collab.detail.noOps')}
          </div>
        )}
        {proposal.ops.map((op) => (
          <div key={op.oid} className="flex flex-col gap-0.5" data-testid={`collab-op-${op.oid}`}>
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 text-meta text-fg break-words">{op.purpose}</span>
              {op.status && (
                <span className="shrink-0 text-meta text-fg-subtle" data-testid={`collab-op-status-${op.oid}`}>
                  {opStatusLabel(t, op.status)}
                </span>
              )}
            </div>
            <div className="text-meta text-fg-subtle">
              {op.actorKeyId ? actorLabel(op.actorKeyId) : t('collab.ownerUnknown')}
            </div>
            {op.blockedReason && (
              <div className="text-meta text-danger break-words">{op.blockedReason}</div>
            )}
            {/* 증거는 op 밑에 붙는다 — 어느 검증이 어느 변경을 향한 것인지가 그 자리로 말해진다. */}
            {op.evidence.map((e) => (
              <div key={e.oid} className="pl-3 text-meta text-fg-subtle" data-testid={`collab-evidence-${e.oid}`}>
                {e.summary}
              </div>
            ))}
          </div>
        ))}
      </div>

      {proposal.conflicts.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-meta font-medium tracking-wide text-danger uppercase">
            {t('collab.detail.conflicts')}
          </div>
          {proposal.conflicts.map((c) => (
            <div key={c.id} className="text-meta text-fg-subtle break-words" data-testid={`collab-detail-conflict-${c.id}`}>
              <span className="text-fg">{c.key}</span>
              {c.reason ? ` — ${c.reason}` : ''}
            </div>
          ))}
          {/*
            **고를 자리는 아직 없다.** 충돌의 선택지(어느 op 을 고를지)는 서버가 아직 내주지
            않고, 고르는 것은 승인과 함께 오는 2단계다(`docs/hub-seat.md` §4). 여기서는
            "무엇이 다투는가" 까지만 말한다 — 없는 문을 그리지 않는다.
          */}
        </div>
      )}

      {proposal.decisions.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-meta font-medium tracking-wide text-fg-subtle uppercase">
            {t('collab.detail.decisions')}
          </div>
          {proposal.decisions.map((d) => (
            <div key={d.oid} className="text-meta text-fg-subtle break-words" data-testid={`collab-decision-${d.oid}`}>
              <span className="text-fg">
                {d.decidedByKeyId ? actorLabel(d.decidedByKeyId) : t('collab.ownerUnknown')}
              </span>
              {d.reason ? ` — ${d.reason}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
