import type { AccountView, AskMeta, FailureMeta, MessageRow, ReportMeta } from '@murmur/shared';
import { useActiveStore } from '../../state/communities';
import { AskCard } from '../AskCard';
import { FailureCard } from '../FailureCard';
import { ReportCard } from '../ReportCard';
import { ProgressRow } from '../ProgressRow';
import { AgentExchange } from '../AgentExchange';
import { WaitChainLine } from '../WaitChain';
import { ThreadStateBadge } from '../ThreadStateBadge';
import { ThreadParticipants } from '../ThreadParticipants';
import { waitChain } from '../../lib/waitChain';
import { SettingsPage } from './primitives';

/**
 * 컴포넌트 갤러리(계획 Task 11) — **여덟 가지 말과 그 경계 상태를 한 화면에** 모은다.
 *
 * 이 화면의 목적은 "이후 기능 개발이 기존 디자인을 따라간다"를 가능하게 하는 것이다.
 * 따라갈 것이 한 화면에 모여 있어야 하고, **여기가 깨지면 어휘가 깨진 것**이다.
 *
 * ## 진짜 컴포넌트를 그린다
 *
 * 목업을 그리지 않는다 — 목업은 실물과 갈라지는 순간 거짓말이 되고, 갈라진 것을 아무도
 * 모른다. 여기 서는 것은 대화에 서는 것과 **같은 컴포넌트에 같은 `meta`** 다. 그래서 이
 * 화면이 회귀 테스트의 대상이 될 수 있다.
 *
 * ## 없는 어휘는 그리지 않는다
 *
 * 디자인 문서의 여덟 가지 말 중 **넘김·제안은 아직 전용 컴포넌트가 없다** — 넘김은
 * 에이전트끼리의 발화로 흐르고(그래서 `AgentExchange` 가 접는다), 제안은 완료 보고의 칩이다.
 * 없는 것에 자리를 만들어 두면 "있는데 안 그려진 것"으로 읽힌다(규칙 06).
 */
export function GallerySettings() {
  const me = useActiveStore((s) => s.me);
  const realAccounts = useActiveStore((s) => s.accounts);

  /**
   * 갤러리 전용 가짜 계정. **스토어를 건드리지 않는다** — 설정 화면 하나를 보려고 진짜
   * 계정 디렉터리에 없는 이름을 끼워 넣으면 다른 화면이 그것을 사람으로 착각한다.
   * 대신 아래 컴포넌트들이 스토어에서 이름을 못 찾으면 `…` 로 떨어지므로, 이름이 중요한
   * 자리에는 **실제로 있는 계정**을 골라 쓴다.
   */
  const agents = Object.values(realAccounts).filter((a) => a.kind === 'agent');
  const a1: AccountView | undefined = agents[0];
  const a2: AccountView | undefined = agents[1] ?? agents[0];
  const myId = me?.id ?? 'me';

  const base = (id: string, over: Partial<MessageRow> = {}): MessageRow => ({
    id, seq: 1, channelId: 'gallery', threadRootId: null,
    authorId: a1?.id ?? myId, body: '', kind: 'user', meta: {},
    createdAt: new Date(Date.now() - 8 * 60_000).toISOString(),
    editedAt: null, reactions: [], attachments: [],
    replyCount: null, lastReplyAt: null, participantIds: null, alsoInChannel: false,
    ...over,
  });

  const askMeta = (to: AskMeta['ask']['to'], answered = false): Record<string, unknown> => ({
    kind: 'ask',
    ask: {
      prompt: '마이그레이션을 어떻게 넣을까?',
      options: [
        { id: 'new', label: '새 마이그레이션 009', hint: '되돌리기 쉽다' },
        { id: 'edit', label: '008 을 고친다', hint: '파일 하나로 끝난다' },
      ],
      to,
      ...(answered ? { answeredWith: 'new', answeredBy: myId, answeredAt: new Date().toISOString() } : {}),
    },
  } as unknown as Record<string, unknown>);

  const failMeta = (retryable: boolean): Record<string, unknown> => ({
    kind: 'failure',
    failure: {
      what: '008 적용 확인',
      reason: retryable ? '스테이징 DB 에 붙지 못했다.' : '설정이 빠져 있다 — 사람이 채워야 한다.',
      retryable,
    },
  } as unknown as Record<string, unknown>);

  const reportMeta: Record<string, unknown> = {
    kind: 'report',
    report: {
      checks: ['연속 미응답만 끊도록 되어 있다', '회귀 테스트로 고정했다'],
      files: ['packages/server/src/ws/heartbeat.ts'],
      remaining: ['lint 를 다시 부를지'],
      durationMs: 400_000,
      next: [{ id: 'lint', label: 'lint 를 다시 불러 줘' }],
    },
  } as unknown as ReportMeta as unknown as Record<string, unknown>;

  const askTo = (target?: AccountView): AskMeta['ask']['to'] =>
    (target ? { kind: 'account', accountId: target.id } : { kind: 'human' });

  return (
    <SettingsPage
      title="Component gallery"
      description="여덟 가지 말과 그 경계 상태. 여기가 깨지면 어휘가 깨진 것이다."
    >
      <div data-testid="gallery" className="space-y-8">
        {agents.length === 0 && (
          // 에이전트가 없으면 이름 자리가 전부 `…` 가 된다 — 그 화면은 갤러리로 쓸모가 없다.
          <p className="text-xs text-fg-muted">
            에이전트가 하나도 없어 이름 자리를 채울 수 없다. 먼저 에이전트를 만들면 여기에
            실제 이름으로 그려진다.
          </p>
        )}

        <Row title="선택 — 나에게 온 것" note="강조를 받는 유일한 카드. 누를 수 있다.">
          <AskCard message={base('g-ask-me', { meta: askMeta({ kind: 'human' }) })} />
        </Row>

        <Row title="선택 — 에이전트에게 간 것" note="무채색. 읽히되 누를 수 없다(규칙 04).">
          <AskCard message={base('g-ask-other', { meta: askMeta(askTo(a2)) })} />
        </Row>

        <Row title="선택 — 이미 답한 것" note="고른 것만 남고 강조를 거둔다.">
          <AskCard message={base('g-ask-done', { meta: askMeta({ kind: 'human' }, true) })} />
        </Row>

        <Row title="실패 — 다시 부를 수 있다" note="언제나 사람에게 온다. 고치는 경로가 같은 자리에.">
          <FailureCard message={base('g-fail-retry', { meta: failMeta(true) })} />
        </Row>

        <Row title="실패 — 다시 불러도 소용없다" note="'다시 부르기'가 없다 — 없는 문은 그리지 않는다.">
          <FailureCard message={base('g-fail-final', { meta: failMeta(false) })} />
        </Row>

        <Row title="완료 보고" note="읽히는 말이라 강조색을 쓰지 않는다. 가장 오래 남는 말이다.">
          <ReportCard message={base('g-report', { meta: reportMeta })} />
        </Row>

        <Row title="진행" note="답이 필요 없는 구간. 문장이 아니라 상태 한 줄이다.">
          <ProgressRow messages={[
            base('g-p1', { kind: 'progress', body: 'heartbeat.ts 를 읽는다' }),
            base('g-p2', { kind: 'progress', body: '재연결 경로를 따라간다' }),
          ]} />
        </Row>

        <Row title="에이전트끼리의 주고받기" note="기본 접힘. 접지 않으면 스레드가 로그가 된다.">
          <AgentExchange messages={[
            base('g-x1', { body: 'ws 는 내가 본다', authorId: a1?.id ?? myId }),
            base('g-x2', { body: '스키마는 내가', authorId: a2?.id ?? myId }),
            base('g-x3', { body: '그럼 넘긴다', authorId: a1?.id ?? myId }),
          ]} />
        </Row>

        <Row title="스레드 상태 5단" note="강조는 둘뿐이고 그 둘도 색이 다르다.">
          <div className="flex flex-wrap gap-2">
            {(['my-turn', 'stuck', 'waiting', 'running', 'done'] as const).map((s) => (
              <ThreadStateBadge key={s} state={s} />
            ))}
          </div>
        </Row>

        <Row title="대기 사슬 — 내 차례" note="몇 개가 풀리는지가 사람이 답할 이유다.">
          <WaitChainLine chain={waitChain({
            messages: [
              base('g-c1', { authorId: a2?.id ?? myId, meta: askMeta(askTo(a1)) }),
              base('g-c2', { authorId: a1?.id ?? myId, meta: askMeta({ kind: 'human' }) }),
            ],
            myAccountId: myId,
            live: new Set(agents.map((a) => a.id)),
          })} />
        </Row>

        <Row title="대기 사슬 — 교착" note="사슬이 아무 데도 닿지 않는다. 사람만이 푼다.">
          <WaitChainLine chain={waitChain({
            messages: [
              base('g-d1', { authorId: a1?.id ?? myId, meta: askMeta(askTo(a2)) }),
              base('g-d2', { authorId: a2?.id ?? myId, meta: askMeta(askTo(a1)) }),
            ],
            myAccountId: myId,
            live: new Set(agents.map((a) => a.id)),
          })} />
        </Row>

        <Row title="참여자 줄 · 터미널 선택자" note="응답 없는 자는 흐리다. 소유자 아닌 것은 목록에 없다.">
          <ThreadParticipants
            messages={[
              base('g-t1', { authorId: a1?.id ?? myId }),
              base('g-t2', { authorId: a2?.id ?? myId }),
            ]}
            // 두 번째를 응답 없음으로 둔다 — 흐림이 실제로 보이는 것이 이 줄의 요점이다.
            live={new Set(a1 ? [a1.id] : [])}
          />
        </Row>
      </div>
    </SettingsPage>
  );
}

function Row({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      <p className="mb-2 text-[11px] text-fg-subtle">{note}</p>
      {children}
    </section>
  );
}
