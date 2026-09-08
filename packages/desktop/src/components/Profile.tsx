import { useEffect, useState } from 'react';
import type { AgentView } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { canSeeAgentConfig } from '../lib/agentConfigGate';
import { Identity, StatusMark } from './Identity';
import { Overlay } from './Overlay';
import { lastTurnLabel } from './settings/AgentsSettings';
import { staleRunners, UNKNOWN_RUNNER_VERSION } from '../lib/runnerVersions';
import { useT, useLocale } from '../i18n/useT';
import type { SectionId } from './settings/sections';

/**
 * 프로필 — **알아야 할 때 여는 자리**(identity 문서 · Task 14).
 *
 * 지금까지 이름을 누르면 디렉터리(검색 목록)가 열렸다. 그것은 프로필이 아니다 —
 * `Directory.tsx` 주석이 "harness·소유자·PAT 는 그리지 않는다"고 적어 두었고, Task 12 가
 * 흐름에서 🤖 를 뺀 뒤로는 **그 정보가 어디에도 없었다.** 문서가 "흐름에서 표시를 빼면 그
 * 정보가 어디에도 없게 된다"고 경계한 그 자리다.
 *
 * ## 사람과 에이전트가 같은 틀을 쓴다
 *
 * 행 이름만 다르다 — 원칙 01("대화에서는 에이전트라고 말하지 않는다")의 연장이다. 종류는
 * 여기 와서야 나오고, 그때도 **다른 화면이 아니라 다른 행**으로 나온다.
 *
 * ## 볼 수 있는 것만 보여 준다
 *
 * harness·model·작업 디렉터리는 **admin·소유자만** 서버에서 받는다(`GET /accounts/agents` 가
 * 비admin 에게 자기 것만 준다). 남의 에이전트를 열면 그 행은 **아예 없다** — 비어 있는 행을
 * 그리면 "값이 없다"로 읽히는데 실제로는 "내가 못 본다"라서 거짓말이 된다(규칙 06).
 */
export function Profile({ accountId, onClose, onOpenSettings }: {
  accountId: string;
  onClose: () => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
}) {
  // 활동 경과는 언어를 따른다(`lib/time.ts`). 나머지 문자열은 아직 한국어다.
  const t = useT();
  const locale = useLocale();
  const account = useActiveStore((s) => s.accounts[accountId]);
  const me = useActiveStore((s) => s.me);
  const accounts = useActiveStore((s) => s.accounts);
  const online = useActiveStore((s) => s.online);
  const connected = useActiveStore((s) => s.connected);

  /**
   * 설정까지 볼 수 있는가 — 서버의 판정과 같아야 한다(`GET /accounts/agents`).
   *
   * 판정은 `lib/agentConfigGate.ts` 하나가 낸다. 여기 사본을 두면 같은 문(설정 › 에이전트)을
   * 여는 세 자리 — 이 프로필 · 본문 멘션 · 레일의 에이전트 격자 — 가 서로 다른 규칙으로
   * 문을 그린다.
   */
  const canSeeConfig = canSeeAgentConfig(account, me);

  const [agent, setAgent] = useState<AgentView | null>(null);
  useEffect(() => {
    if (!canSeeConfig) return;
    // 목록에서 고른다 — 이 라우트가 이미 권한 필터를 걸어 주므로 화면이 다시 거르지 않는다.
    void getController().listAgents()
      .then((list) => setAgent(list.find((a) => a.id === accountId) ?? null))
      .catch(() => setAgent(null));
  }, [accountId, canSeeConfig]);

  /**
   * 이 앱 번들의 버전 — 뒤처짐 판정의 기준. 컨트롤러가 기동 때 스토어에 밀어 넣은 값을
   * 읽는다(`appStore.ts::appVersion`). 러너에 심는 `AGENT_VERSION` 과 **같은 값**이므로,
   * 방금 재기동한 러너가 계속 뒤처진 것으로 보이는 어긋남이 없다.
   */
  const appVersion = useActiveStore((st) => st.appVersion);

  /** 이 앱이 아는 러너의 상태. 없으면 '모른다'다 — '꺼짐'이 아니다. */
  const runnerState = useActiveStore((st) => st.runnerStates[accountId]);

  if (!account) return null;

  const owner = account.ownerAccountId ? accounts[account.ownerAccountId] : undefined;

  /**
   * 이 앱이 **러너가 있다고 보는가.** 없으면 재기동 자리 자체를 두지 않는다 — 갈아 줄
   * 것이 없는데 버튼을 두면 눌러도 아무 일이 없고, 그것이 `#129` 가 금지한 거짓 신호다.
   * 'restarting' 이 여기 드는 이유: 예약 중에도 러너는 아직 살아 있다(턴을 마치는 중).
   */
  const runnerPresent = runnerState?.status === 'running'
    || runnerState?.status === 'adopted'
    || runnerState?.status === 'restarting';

  /**
   * 뒤처졌다고 **확인됐는가.** 판정은 `staleRunners` 하나가 갖는다 — 설정의 전체 재기동이
   * 쓰는 것과 같은 함수여야 한다: 갈라지면 프로필이 경고하는 대상과 전체 재기동이 고르는
   * 대상이 어긋나고, 사람은 그 어긋남을 알 방법이 없다.
   */
  const isStale = staleRunners({
    agents: agent ? [{ id: agent.id, runnerVersion: agent.runnerVersion }] : [],
    live: runnerPresent ? new Set([accountId]) : new Set<string>(),
    appVersion,
  }).stale.length > 0;
  // 생존은 `threadState`·`waitChain` 과 같은 규약이다 — `connected` 가 false 면 '모른다'.
  const live = connected ? online.includes(account.id) : null;

  return (
    <Overlay label={`${account.handle} 프로필`} onClose={onClose} className="w-[26rem]">
      <div className="flex items-center gap-3 border-b border-border p-4">
        <Identity account={account} className="h-12 w-12 text-base" variant="avatar" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* **이름줄단 15px** — 이 겹창의 주제가 사람 하나이고 그 이름이 여기다.
                16px(`text-base`)이었고 4단 중 아무것도 아니었다. 화면 제목단(17px)을 주지
                않는 이유: 이것은 화면이 아니라 겹창이고, 설정·로그인 제목과 같은 단에 서면
                화면과 겹창의 위계가 없어진다. 아래 `@handle` 은 아랫단 11px 이다. */}
            <span className="truncate text-name font-semibold">{account.displayName || account.handle}</span>
            <StatusMark account={account} />
          </div>
          <div className="text-meta text-fg-muted">@{account.handle}</div>
        </div>
      </div>

      <div className="overflow-y-auto p-4">
        <dl className="space-y-2">
          {/* 종류는 여기 와서야 나온다 — 흐름에서는 말하지 않는다(원칙 01). */}
          <Row label="종류" value={account.kind === 'agent' ? '에이전트' : '사람'} />
          {account.isAdmin && <Row label="권한" value="admin" />}
          {account.disabled && <Row label="상태" value="비활성" />}

          {account.kind === 'agent' && (
            <Row
              label="연결"
              value={live === null ? '알 수 없음' : live ? '온라인' : '응답 없음'}
            />
          )}
          {/* 소유자가 `null` 인 것은 '아무나'가 아니라 '아직 아무도'다(#181) — 없으면 행이 없다. */}
          {owner && <Row label="소유자" value={`@${owner.handle}`} />}

          {canSeeConfig && agent && (
            <>
              <Row label="하네스" value={agent.harness} />
              {/* **`null` 은 '모델 없음'이 아니라 '이 설정이 정하지 않는다'다**(#600).
                  그냥 `하네스 기본값` 이라고만 적으면 사람은 이 행을 "실제로 쓰는 모델"로
                  읽는데, 그 경우 murmur 는 실제 모델을 **모른다** — 러너가 `--model` 을
                  아예 붙이지 않아 하네스가 고르고, 러너는 하네스 출력을 해석하지 않는다.
                  실제로 무엇이 답했는지는 발화 이름줄 hover 에 있다(`meta.model`). */}
              <Row
                label="모델"
                value={agent.model ?? '하네스 기본값 — 실제 모델은 발화 이름줄 hover 로 본다'}
              />
              <Row label="작업 디렉터리" value={agent.workingDir ?? '스레드마다 새로 만든다'} mono />
              <Row label="마지막 활동" value={lastTurnLabel(agent.lastTurnAt, Date.now(), locale, t)} />
              {/* 러너가 **어느 번들로** 돌고 있는가. 이 행이 없으면 아래 재기동 버튼은
                  누를 이유를 알 수 없는 버튼이다. `unknown`·`null` 은 원인이 다르지만
                  (환경변수를 못 받았다 / 보고가 한 번도 없었다) 사람이 할 일은 같으므로
                  한 문장으로 적는다 — 없는 구분을 화면에 만들지 않는다. */}
              <Row
                label="러너 버전"
                value={runnerVersionLabel(agent.runnerVersion, appVersion)}
                mono={agent.runnerVersion !== null && agent.runnerVersion !== UNKNOWN_RUNNER_VERSION}
              />
            </>
          )}
        </dl>

        {canSeeConfig && agent && runnerPresent && (
          <div className="mt-3 text-meta">
            {isStale && (
              <p className="text-warning" data-testid="runner-stale-note">
                이 러너는 앱보다 <strong>뒤처진 번들</strong>로 돌고 있다 — 새 버전으로 재기동하면 갈아탄다.
              </p>
            )}
            {/* **기다린다는 사실이 화면에 있어야 한다.** SIGTERM 은 graceful 이라 러너는
                진행 중인 턴을 마친 뒤에야 죽고(실측 5분 넘는 턴도 있다), 그동안 표시가
                없으면 사람에게는 "눌렀는데 아무 일이 없다"다 — `#384` 가 이미 고친 결함이다. */}
            {runnerState?.status === 'restarting' && (
              <p className="text-fg" role="status" data-testid="runner-restart-note">
                재기동을 예약했다 — <strong>진행 중인 턴</strong>을 마치면 새 버전으로 뜬다. 턴을 끊지 않는다.
              </p>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {/*
            터미널은 **소유자·admin 이 아니면 그 자리 자체가 없다**(문서의 지시 · 규칙 06).
            판정을 `TerminalChip` 과 같게 두어야 서버의 `checkOwnerOrAdmin` 과 갈라지지 않는다.
          */}
          {canSeeConfig && onOpenSettings && (
            <button
              data-testid="profile-settings"
              className="rounded border border-border px-3 py-1.5 text-body font-medium
                         text-fg hover:bg-surface-hover"
              onClick={() => { onClose(); onOpenSettings('agents', account.id); }}
            >
              에이전트 설정
            </button>
          )}
          {canSeeConfig && agent && runnerPresent && (
            runnerState?.status === 'restarting' ? (
              <button
                data-testid="profile-runner-restart-cancel"
                className="rounded border border-border px-3 py-1.5 text-body font-medium
                           text-fg hover:bg-surface-hover"
                onClick={() => getController().cancelRestart(account.id)}
              >
                재기동 예약 취소
              </button>
            ) : (
              /* 이름이 사실을 약속한다: 뒤처졌다고 **확인된** 때만 "새 버전으로"라고
                 쓴다. 버전을 모르는데 그렇게 쓰면 지키지 못할 약속이 된다(design.md §4). */
              <button
                data-testid="profile-runner-restart"
                className="rounded border border-border px-3 py-1.5 text-body font-medium
                           text-fg hover:bg-surface-hover"
                onClick={() => { void getController().restartRunner(account.id); }}
              >
                {isStale ? '새 버전으로 재기동' : '러너 재기동'}
              </button>
            )
          )}
          {account.id !== me?.id && (
            <button
              data-testid="profile-dm"
              className="rounded border border-border px-3 py-1.5 text-body font-medium
                         text-fg hover:bg-surface-hover"
              onClick={() => { onClose(); void getController().startDm(account.id); }}
            >
              DM 열기
            </button>
          )}
        </div>
      </div>
    </Overlay>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3 text-body">
      <dt className="w-24 shrink-0 text-fg-subtle">{label}</dt>
      {/* mono 12px 은 4단 밖이지만 본문단(13px)을 **광학적으로** 맞추는 보정이다 —
          등폭 글꼴은 같은 pt 에서 크게 보인다. 근거는 `ReportCard.tsx` 에 적어 뒀다. */}
      <dd className={`min-w-0 break-words text-fg ${mono ? 'font-mono text-[12px]' : ''}`}>{value}</dd>
    </div>
  );
}

/**
 * 러너 버전 한 줄. 두 사실을 함께 적는다 — 러너의 버전과 **비교 대상**(앱의 버전).
 * 앱 버전만 알거나 러너 버전만 알면 사람은 "뒤처졌다"를 스스로 확인할 수 없다.
 */
function runnerVersionLabel(runnerVersion: string | null, appVersion: string | null): string {
  if (runnerVersion === null || runnerVersion === UNKNOWN_RUNNER_VERSION) {
    // 원인은 둘(환경변수를 못 받았다 / 보고가 없었다)이지만 사람이 할 일은 하나다:
    // 한 번 재기동하면 값이 채워진다. 그래서 구분을 화면에 만들지 않는다.
    return '버전을 모른다 — 재기동하면 채워진다';
  }
  return appVersion === null ? runnerVersion : `${runnerVersion} (앱 ${appVersion})`;
}
