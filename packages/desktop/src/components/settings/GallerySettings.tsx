import type { AccountView, AskMeta, FailureMeta, MessageRow, ReportMeta } from '@harkroom/shared';
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
import { useT } from '../../i18n/useT';

/**
 * 이름을 못 채웠을 때 그 자리에 서는 글자. **상수인 이유는 두 곳이 이것을 써야 하기
 * 때문이다** — 문장에 끼워 넣는 쪽과, 다른 색을 입히려고 그 문장을 자르는 쪽. 값을 양쪽에
 * 적으면 하나를 고칠 때 자르기가 조용히 실패하고 문장이 통째로 한 색이 된다.
 *
 * `…` 한 글자다(`...` 세 점이 아니다) — 이 화면이 부르는 컴포넌트들이 이름을 못 찾을 때
 * 내는 것과 같아야 한다.
 */
const ELLIPSIS = '…';

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
 *
 * ## 어휘는 견본으로 그리고, 이름만 스토어에서 온다
 *
 * 이 화면은 다른 화면을 재는 **기준자**다. 그래서 여기 그려지는 것이 계정 목록의 상태에
 * 따라 달라지면 안 된다 — 기준자가 흔들리면 그것으로 잰 판정이 전부 흔들린다. 수신자의
 * 종류·강조 여부·사슬의 모양은 **견본 id 두 개**로 고정하고, 실제 계정은 **이름을 부르는
 * 자리에만** 쓴다. 근거와 실측은 `SAMPLE_AGENT` 위 주석에 있다.
 */
export function GallerySettings() {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const realAccounts = useActiveStore((s) => s.accounts);

  /**
   * 갤러리 전용 가짜 계정. **스토어를 건드리지 않는다** — 설정 화면 하나를 보려고 진짜
   * 계정 디렉터리에 없는 이름을 끼워 넣으면 다른 화면이 그것을 사람으로 착각한다.
   * 대신 아래 컴포넌트들이 스토어에서 이름을 못 찾으면 `…` 로 떨어지므로, 이름이 중요한
   * 자리에는 **실제로 있는 계정**을 골라 쓴다.
   */
  const agents = Object.values(realAccounts).filter((a) => a.kind === 'agent');
  const myId = me?.id ?? 'me';

  /**
   * ## 견본 수신자 — **어휘가 계정 목록에 매달리지 않게 한다**(v0.1.52 실측 회귀)
   *
   * 앞 판본은 `agents[1] ?? agents[0]` 로 두 번째 에이전트를 만들고, 하나도 없으면
   * `undefined` 를 그대로 흘렸다. 그러면 수신자를 만드는 함수가 `{ kind: 'human' }` 으로
   * 떨어져 **"에이전트에게 간 것" 칸이 "나에게 온 것"과 픽셀 단위로 같아졌다** — 강조색
   * 테두리에 분홍 배경, 그 칸 자신이 *"무채색. 읽히되 누를 수 없다(규칙 04)"* 라고 적어 둔
   * 바로 그 자리에서. 실측(에이전트 0개): 세 카드의 `data-for-me` 가 전부 `true` 였고 강조
   * 배경이 둘이었다. 갤러리는 다른 화면을 재는 **기준자**라서, 기준자가 규칙과 반대로
   * 그려지면 그것으로 잰 판정이 전부 흔들린다.
   *
   * 그래서 **수신자의 종류는 스토어에서 오지 않는다.** 갤러리는 목업이 아니라 견본이고,
   * 견본에 필요한 것은 "이것은 남에게 간 물음이다"라는 **종류** 하나다. 그것을 없는 계정
   * id 로 고정한다 — `readAskMeta`(shared)는 `accountId` 가 문자열인지만 보고 디렉터리에
   * 있는지는 묻지 않으므로, 화면은 규칙 04 대로 무채색으로 앉는다.
   *
   * ## "모르는 것을 지어내지 않는다"에 어긋나지 않는 이유
   *
   * 지어내는 것이 **이름이 아니다.** 이 id 는 계정 디렉터리에 없으므로 이름을 부르는 자리는
   * 이 저장소가 이미 정한 대로 `…` 로 떨어진다(`MessageItem.tsx`: *"모르면 `…` 다 — 없는
   * 이름을 지어내지 않는다"*). 없는 handle 을 문자열로 박아 두는 것이 지어내는 짓이고,
   * 그것은 하지 않는다. 규칙 06("없는 문은 그리지 않는다")도 지켜진다 — 이 칸이 그리는
   * 문은 *"누를 수 없다"* 이고, 그것이 실제로 이 카드가 가진 유일한 문이다. 칸 자체를
   * 지우는 쪽(후보 a)은 규칙 06 을 만족하되 **갤러리의 존재 이유**(경계 상태를 한 화면에
   * 모아 어휘가 깨진 것을 잡는다)를 깎으므로 택하지 않았다.
   */
  const SAMPLE_AGENT = 'gallery-sample-agent';
  const SAMPLE_PEER = 'gallery-sample-peer';

  /**
   * 이름을 부르는 자리가 쓰는 진짜 계정. **여기서는 견본이 이름까지 채워 주지 못한다** —
   * 참여자 아바타 줄은 `accounts[authorId]?.kind === 'agent'` 로 걸러 그리므로(그 컴포넌트
   * :35) 없는 id 는 줄에서 아예 빠지고, 접힌 주고받기의 이름은 `…` 가 된다.
   *
   * 그래도 폴백은 **견본**이다(`myId` 가 아니다): 이름이 비는 것은 사실을 말하는 것이지만,
   * 화자를 나로 바꾸는 것은 거짓을 말하는 것이다. 이름이 왜 비는지는 아래 안내문이 적는다.
   */
  const named1: AccountView | undefined = agents[0];
  const named2: AccountView | undefined = agents[1] ?? agents[0];

  /**
   * 사슬 두 칸이 쓰는 id. **서로 다른 계정 둘이 필요하다** — 사슬은 `A → B → 사람` 으로
   * 이어져야 "몇 개가 풀리는가"를 말할 수 있고, 교착은 `A ↔ B` 여야 "서로를 기다린다"가
   * 성립한다. 그래서 문턱이 하나가 아니라 **둘**이다: 진짜가 둘 있으면 진짜를 쓰고,
   * 그보다 적으면 둘 다 견본으로 간다(이름은 `…`, 모양은 지켜진다).
   *
   * 하나로 때우면 A→A 가 되어 뜻이 무너진다 — 실측(에이전트 1개): 앞 판본이
   * `forge 가 서로를 기다린다` 라는 혼자 교착하는 문장을 냈다.
   */
  const distinct = agents.length >= 2;
  const chain1 = distinct ? agents[0]!.id : SAMPLE_AGENT;
  const chain2 = distinct ? agents[1]!.id : SAMPLE_PEER;

  /**
   * ## 여기부터는 **견본이다 — 사전을 지나지 않는다**
   *
   * 아래 `body`·`checks`·`next.label` 에 적힌 한국어는 **화면 문구가 아니라 데이터**다.
   * 카드 안에 흐르는 남의 말이고, 이 화면이 가르치는 것은 그 말의 내용이 아니라 **카드의
   * 생김새**다 — 견본이 무슨 언어든 여덟 가지 말의 경계는 그대로 보인다.
   *
   * 사전에 넣으면 두 가지가 나빠진다: 사전이 가짜 대화로 부풀고, 번역자가 이것을 **옮겨야
   * 할 것**으로 읽는다. 그래서 영어로 이 화면을 열면 **설명은 영어, 카드 속 대화는
   * 한국어**다 — 어색해 보이지만 그것이 정직한 상태다.
   *
   * 근거 전문은 `i18n/en.ts` 의 `gallery` 영역 머리말에 있다.
   */
  const base = (id: string, over: Partial<MessageRow> = {}): MessageRow => ({
    // 낸 사람의 기본값은 **에이전트**다. 앞 판본은 에이전트가 없으면 `myId` 로 떨어뜨렸는데,
    // 그러면 "에이전트가 말한 것"이 "내가 말한 것"으로 바뀐다 — 사슬 줄이
    // `jaebin 가 사람의 답을 기다린다` 로 그려져 내가 나를 기다리는 문장이 나왔다(실측).
    // 진짜가 없으면 견본으로 간다: 이름은 `…` 가 되지만 **말한 것이 에이전트라는 사실**은
    // 지켜진다. 그 사실이 뒤집히는 것이 이름이 비는 것보다 큰 거짓이다.
    id, seq: 1, channelId: 'gallery', threadRootId: null,
    authorId: named1?.id ?? SAMPLE_AGENT, body: '', kind: 'user', meta: {},
    createdAt: new Date(Date.now() - 8 * 60_000).toISOString(),
    editedAt: null, reactions: [], attachments: [],
    replyCount: null, activityCount: null, lastReplyAt: null, participantIds: null,
    openAskHumanCount: null, openAskAccountIds: null, openAskLinks: null, failureCount: null, unresolvedFailureCount: null,
    lastKind: null, lastAuthorId: null, alsoInChannel: false, deletedAt: null,
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

  /**
   * 수신자를 **id 로** 만든다 — `AccountView | undefined` 를 받던 앞 판본은 `undefined` 를
   * 사람으로 바꿔 뜻을 뒤집었다(위 주석의 실측). 여기서는 `'human'` 을 쓰려면 호출부가
   * `{ kind: 'human' }` 을 직접 적어야 하므로, 사람에게 온 것과 남에게 간 것이 **코드에서도**
   * 갈린다. 뒤집힐 수 있는 폴백이 아예 없어진다.
   */
  const askTo = (accountId: string): AskMeta['ask']['to'] => ({ kind: 'account', accountId });

  return (
    <SettingsPage
      title={t('gallery.page.title')}
      description={t('gallery.page.subtitle')}
    >
      <div data-testid="gallery" className="space-y-8">
        {!distinct && (
          /*
           * **무엇이 비는지를 정확히 말한다.** 앞 판본은 *"이름 자리를 채울 수 없다"* 라고만
           * 적었고, 정작 그때 색이 뒤집혀 규칙 04 를 위반한 카드가 서는 것은 말하지 않았다 —
           * 사람이 이 문장을 읽어도 아래 카드가 규칙과 반대인 것은 알 수 없었다. 이제
           * 색·수신자·사슬의 모양은 견본이 지키므로 비는 것은 **이름뿐**이고, 이 문장은
           * 그것만 말한다. 없는 것을 넓게 경고하면 그 경고도 못 믿게 된다.
           *
           * 문턱이 0 이 아니라 **둘**이다 — 사슬과 주고받기는 서로 다른 계정 둘이 있어야
           * 성립한다(하나로는 "서로를 기다린다"가 못 된다).
           *
           * **크기를 적지 않아 본문단 13px 을 물려받는다**(타이포 4단 작업의 판단). 이
           * 문단은 아래 칸들과 나란히 서는 안내이지 그 칸의 부속이 아니다 — 11px 로
           * 내리면 갤러리를 처음 여는 사람이 가장 먼저 읽어야 할 줄이 가장 작아진다.
           */
          <p className="text-fg-muted">
            {/* `…` 만 다른 색이라 한 조각으로 못 쓴다. **자르는 것은 채우기 전의 원문**이다 —
                채운 뒤 값으로 찾으면 문장 다른 곳의 같은 글자가 걸린다(`AgentsSettings::emphasize`
                가 실측으로 잡은 함정). 여기서는 자리표시자가 하나라 `split` 하나면 된다. */}
            {t('gallery.page.namesMissing', { ellipsis: ELLIPSIS })
              .split(ELLIPSIS)
              .flatMap((part, i) => (i === 0
                ? [part]
                : [<span key={i} className="text-fg-subtle">{ELLIPSIS}</span>, part]))}
          </p>
        )}

        <Row title={t('gallery.speech.askForMe')} note={t('gallery.speech.askForMeNote')}>
          <AskCard message={base('g-ask-me', { meta: askMeta({ kind: 'human' }) })} />
        </Row>

        <Row title={t('gallery.speech.askToAgent')} note={t('gallery.speech.askToAgentNote')}>
          {/* 견본 수신자로 고정한다 — 이 칸이 가르치는 것이 계정 목록에 따라 뒤집히면
              가르치는 것 자체가 거짓이 된다(위 주석의 실측). */}
          <AskCard message={base('g-ask-other', { meta: askMeta(askTo(SAMPLE_PEER)) })} />
        </Row>

        <Row title={t('gallery.speech.askDone')} note={t('gallery.speech.askDoneNote')}>
          <AskCard message={base('g-ask-done', { meta: askMeta({ kind: 'human' }, true) })} />
        </Row>

        <Row title={t('gallery.speech.failRetry')} note={t('gallery.speech.failRetryNote')}>
          <FailureCard message={base('g-fail-retry', { meta: failMeta(true) })} />
        </Row>

        <Row title={t('gallery.speech.failFinal')} note={t('gallery.speech.failFinalNote')}>
          <FailureCard message={base('g-fail-final', { meta: failMeta(false) })} />
        </Row>

        <Row title={t('gallery.speech.report')} note={t('gallery.speech.reportNote')}>
          <ReportCard message={base('g-report', { meta: reportMeta })} />
        </Row>

        <Row title={t('gallery.speech.progress')} note={t('gallery.speech.progressNote')}>
          <ProgressRow messages={[
            base('g-p1', { kind: 'progress', body: 'heartbeat.ts 를 읽는다' }),
            base('g-p2', { kind: 'progress', body: '재연결 경로를 따라간다' }),
          ]} />
        </Row>

        <Row title={t('gallery.speech.exchange')} note={t('gallery.speech.exchangeNote')}>
          {/* 이 줄은 **이름을 부른다**(`forge ↔ codex · 4번 주고받음`). 그래서 진짜 계정을
              쓰고, 없으면 `…` 로 떨어지는 것을 받아들인다 — 없는 이름을 지어내지 않는다. */}
          <AgentExchange messages={[
            base('g-x1', { body: 'ws 는 내가 본다', authorId: named1?.id ?? SAMPLE_AGENT }),
            base('g-x2', { body: '스키마는 내가', authorId: named2?.id ?? SAMPLE_PEER }),
            base('g-x3', { body: '그럼 넘긴다', authorId: named1?.id ?? SAMPLE_AGENT }),
          ]} />
        </Row>

        <Row title={t('gallery.thread.states')} note={t('gallery.thread.statesNote')}>
          <div className="flex flex-wrap gap-2">
            {(['my-turn', 'stuck', 'waiting', 'running', 'done'] as const).map((s) => (
              <ThreadStateBadge key={s} state={s} />
            ))}
          </div>
        </Row>

        <Row title={t('gallery.thread.chainMine')} note={t('gallery.thread.chainMineNote')}>
          {/* 두 마디가 이어져야 `— 답하면 2개가 풀린다` 가 나온다: 견본 B 가 A 를 기다리고,
              A 가 사람을 기다린다. 앞 판본은 에이전트가 없으면 두 마디가 **같은 계정**(나)이
              되어 사슬이 한 마디로 접혔다 — `jaebin 가 사람의 답을 기다린다` 하나만 남고
              이 칸의 요점인 "몇 개가 풀리는가"가 사라졌다(실측). */}
          <WaitChainLine chain={waitChain({
            messages: [
              base('g-c1', { authorId: chain2, meta: askMeta(askTo(chain1)) }),
              base('g-c2', { authorId: chain1, meta: askMeta({ kind: 'human' }) }),
            ],
            myAccountId: myId,
            // 둘을 살아 있다고 둔다 — 죽었다고 알면 `dead-runner` 교착으로 갈린다.
            live: new Set([chain1, chain2]),
          })} />
        </Row>

        <Row title={t('gallery.thread.chainStuck')} note={t('gallery.thread.chainStuckNote')}>
          {/* 서로를 기다리는 `cycle` 교착이다 — 둘이 **다른** 계정이어야 성립한다. 앞 판본은
              에이전트가 하나뿐일 때 A→A 가 되어 `forge 가 서로를 기다린다` 라는 혼자
              교착하는 문장을 냈고, 0개일 때는 교착이 아니라 `me` 로 그려졌다(실측). */}
          <WaitChainLine chain={waitChain({
            messages: [
              base('g-d1', { authorId: chain1, meta: askMeta(askTo(chain2)) }),
              base('g-d2', { authorId: chain2, meta: askMeta(askTo(chain1)) }),
            ],
            myAccountId: myId,
            live: new Set([chain1, chain2]),
          })} />
        </Row>

        <Row title={t('gallery.thread.participants')} note={t('gallery.thread.participantsNote')}>
          {/* **이 줄만 견본이 통하지 않는다.** `ThreadParticipants` 는 스토어에서
              `kind === 'agent'` 인 것만 아바타로 세우므로(그 컴포넌트 :35) 없는 id 는 줄에서
              빠지고, 하나도 없으면 `null` 을 낸다. 진짜 계정이 없으면 못 채우는 것이 사실이고
              아래·위 안내문이 그 사실을 그대로 말한다 — 이것이 규칙 06 이다. */}
          <ThreadParticipants
            messages={[
              base('g-t1', { authorId: named1?.id ?? SAMPLE_AGENT }),
              base('g-t2', { authorId: named2?.id ?? SAMPLE_PEER }),
            ]}
            // 두 번째를 응답 없음으로 둔다 — 흐림이 실제로 보이는 것이 이 줄의 요점이다.
            live={new Set(named1 ? [named1.id] : [])}
          />
        </Row>
      </div>
    </SettingsPage>
  );
}

function Row({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-body font-semibold text-fg">{title}</h3>
      <p className="mb-2 text-meta text-fg-subtle">{note}</p>
      {children}
    </section>
  );
}
