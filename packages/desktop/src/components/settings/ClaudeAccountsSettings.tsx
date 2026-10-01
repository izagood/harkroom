/**
 * claude 계정 풀 설정.
 *
 * ## 이 화면이 하는 일과 하지 않는 일
 *
 * **하지 않는 것**: 디렉터리를 읽거나 프로그램을 띄우는 일. 웹뷰에는 그 표면이 **의도적으로**
 * 없다(`capabilities/default.json` 에 `shell:allow-execute` 가 0개, `#513` 이 지웠다). 전부
 * 데몬에 이름 붙은 연산으로 부탁한다 — 이 화면이 넘기는 것은 이름·코드·id 뿐이다.
 *
 * **하는 것**: 무엇이 있는지 보여 주고, 무엇이 바뀔지 말하고, 되돌릴 수 없는 일에 확인을 둔다.
 *
 * ## 세 가지를 반드시 말한다
 *
 * 1. **계정의 정체**(이메일·조직·구독). 이름만 보여 주면 그건 사용자가 붙인 별명일 뿐이고,
 *    "회사 계정이 어느 것인가"를 여기서 알 수 없다. 그래서 줄의 첫 칸이 **팀**이고 계정 이름은
 *    옆에 작은 id 로만 선다 — 추가할 때 이름을 묻지도 않는다(`newClaudeAccountId`). 사람이 붙인
 *    `lime` 이 재인증 뒤 Lychee 팀을 가리키는 일이 실제로 있었다(2026-09-29).
 * 2. **언제부터 반영되는가.** 러너는 멘션 턴마다 풀을 다시 읽는다(2026-09-30,
 *    `agent/src/claudeAccounts.ts::createLiveAccountLane`) — 재시작은 필요 없지만, 이미 계정에
 *    고정된 스레드는 그대로이고 **새 스레드부터** 따른다는 것을 말해 둔다.
 * 3. **두 번째 계정부터 시크릿 창**이 필요하다는 사실. 그러지 않으면 기존 쿠키로 같은 계정에
 *    다시 로그인되고, 사용자는 "두 번 등록했는데 하나뿐"을 보게 된다. 브라우저를 자동으로
 *    열지 않고 **링크를 보여 주는** 이유의 절반이 이것이다.
 *
 * ## 사용량은 공급자가 말한 % 뿐이다 (2026-09-29)
 *
 * 계정 줄 아래의 막대 두 개(5시간·주간)가 전부다 — CLI(`claude -p /usage`) 먼저, 실패하면 같은
 * API(`operator/src/usageChain.ts`). 앞판은 여기에 트랜스크립트 토큰 합계·응답 수·한도 사건으로
 * 짐작한 상태 알약을 표로 그렸는데(#702), 분모가 없어 "몇 % 남았나"에 답하지 못했고 공급자 %가
 * 생긴 뒤로는 같은 질문에 두 답을 주는 셈이라 걷어 냈다.
 *
 * 파괴적 조작은 `⋯` 뒤에 둔다 — 안전은 색이 아니라 확인 단계가 진다.
 *
 * UI 문자열은 **영어**다 — 저장소 관례이고 한 번 어겨 되돌린 적이 있다. 주석은 한국어다.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { CLAUDE_POOL_NAME_PATTERN, resolveAssignThresholds, type ClaudePoolsConfig } from '@harkroom/shared/claudePools';
import { headroomPerHour } from '@harkroom/shared/claudeUsage';

import {
  cancelClaudeLogin,
  configureClaudeAccounts,
  hasClaudeAccountsSurface,
  listClaudeAccounts,
  listenClaudeLogin,
  moveClaudeAccount,
  newClaudeAccountId,
  removeClaudeAccount,
  removeClaudePool,
  sameSignInAs,
  startClaudeLogin,
  submitClaudeLoginCode,
  type ClaudeAccountsSnapshot,
  type ClaudeAccountView,
  type ClaudeAuthStatus,
  type ClaudeLoginEvent,
} from '../../lib/claudeAccounts';
import { getExternalOpener } from '../../lib/openExternal';
import { ConfirmDialog } from '../ConfirmDialog';
import { Menu } from '../Menu';
import { Button, Field, SettingsGroup, SettingsPage, TextInput } from './primitives';
import { ProviderSection } from './ProviderSection';
import { ProviderUsageBars } from './ProviderUsageBars';
import { ClaudeAssignThresholdsRow } from './ClaudeAssignThresholds';
import { usageFor, useProviderUsage } from '../../lib/providerUsage';

/** 제공업체 계정 화면 안의 Claude 칸. `SettingsPage` 와 같은 인자를 받아 `Shell` 로 갈아 끼운다. */
function ClaudeSection({ description, children }: {
  title: string; description?: string; width?: 'default' | 'wide'; children: ReactNode;
}) {
  return (
    <ProviderSection icon="claude" title="Claude" description={description ?? ''} testId="provider-claude">
      {children}
    </ProviderSection>
  );
}

/**
 * 계정 줄의 열. **한 곳에 적어 머리줄과 본문 줄이 같은 값을 쓴다** — 두 벌로 두면 언젠가
 * 한쪽만 고쳐진다.
 */
const ACCOUNT_GRID = 'grid grid-cols-[9rem_minmax(9rem,1fr)_1.75rem] gap-x-3';

/** 되돌릴 수 없는 일 하나를 기다리는 상태. `null` 은 대기 중인 것이 없다. */
type Pending =
  | { kind: 'account'; pool: string; account: string; label: string }
  | { kind: 'pool'; pool: string }
  | null;

/**
 * 다시 로그인을 묻는 중인 계정. 삭제(`Pending`)와 따로 둔다 — 되돌릴 수 없는 일이 아니라서
 * 확인창의 색·버튼이 다르고, 확인하면 곧바로 아래 로그인 패널이 선다.
 */
interface ReauthAsk { pool: string; account: string; label: string }

/** 진행 중인 로그인 하나. 화면에 둘을 동시에 두지 않는다 — 코드 입력란이 둘이면 헷갈린다. */
interface LoginState {
  pool: string;
  account: string;
  /**
   * 있는 계정에 **다시** 로그인하는가(이름·풀·순서·세션은 그대로, 인증만 바뀐다). 아니면 추가다.
   * `label` 은 패널 제목에 쓰는 그 계정의 지금 정체다.
   */
  reauth?: { label: string };
  loginId: string | null;
  url: string | null;
  error: string | null;
  done: boolean;
}

function statusLine(status: ClaudeAuthStatus): string {
  if (!status.loggedIn) return 'Not signed in';
  return [status.email, status.orgName, status.subscriptionType].filter(Boolean).join(' · ');
}

/** 줄 첫 칸. 계정을 가리키는 것은 **로그인한 팀**이다 — 디렉터리 이름은 id 일 뿐이다. */
function teamLabel(a: ClaudeAccountView): string {
  if (!a.status.loggedIn) return 'Not signed in';
  return a.status.orgName ?? a.status.email ?? a.name;
}

/** 둘째 칸의 글자. 팀은 첫 칸이 이미 말했으니 여기서 되풀이하지 않는다. */
function signedInAs(status: ClaudeAuthStatus): string {
  return [status.email, status.subscriptionType].filter(Boolean).join(' · ');
}

/** 확인 문구·메뉴에 쓰는 한 줄 이름. */
function accountLabel(a: ClaudeAccountView): string {
  return a.status.loggedIn ? statusLine(a.status) : `${a.name} (not signed in)`;
}

/**
 * `embedded` = 제공업체 계정 화면(`ProviderAccountsSettings`)의 한 칸으로 그린다. 그때는 화면
 * 껍데기(`SettingsPage`) 대신 하네스 칸(`ProviderSection`)을 쓴다 — 껍데기가 둘이면 제목이 둘이다.
 */
export function ClaudeAccountsSettings({ embedded = false }: { embedded?: boolean } = {}) {
  const Shell = embedded ? ClaudeSection : SettingsPage;
  // 한도 사용률: CLI(`/usage`) 먼저, 실패하면 같은 API(`usageChain.ts`). 사용량은 이것 하나다.
  const available = hasClaudeAccountsSurface();
  const { snap: providerSnap } = useProviderUsage('claude', available);
  const [snap, setSnap] = useState<ClaudeAccountsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  // 확인한 삭제가 도는 중인가 · 실패한 까닭. 둘 다 확인창 안에서만 뜻이 있다.
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [login, setLogin] = useState<LoginState | null>(null);
  const [reauthAsk, setReauthAsk] = useState<ReauthAsk | null>(null);
  const [newPool, setNewPool] = useState<string | null>(null);
  const [moveNote, setMoveNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      setSnap(await listClaudeAccounts());
      setError(null);
    } catch (err) {
      // **조회 실패와 빈 풀을 구분한다.** 실패를 빈 목록으로 그리면 사용자는 자기 계정이
      // 사라진 줄 안다.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [available]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 로그인 진행을 듣는다. 화면이 살아 있는 동안만 — 떠날 때 떼지 않으면 다음 마운트가
  // 두 번 듣는다.
  useEffect(() => {
    if (!available) return;
    let off: (() => void) | null = null;
    let dead = false;
    void listenClaudeLogin((e: ClaudeLoginEvent) => {
      setLogin((cur) => {
        // **다른 로그인의 통지는 버린다.** 사용자가 취소하고 다시 시작하면 옛 프로세스의
        // 통지가 뒤늦게 올 수 있고, 그것으로 새 화면을 덮으면 엉뚱한 URL 이 보인다.
        if (!cur || (cur.loginId !== null && cur.loginId !== e.loginId)) return cur;
        return {
          ...cur,
          ...(e.url !== undefined ? { url: e.url } : {}),
          ...(e.done ? { done: true } : {}),
          ...(e.error !== undefined ? { error: e.error } : {}),
        };
      });
      // 끝났으면 목록을 다시 읽어 상태가 갱신되게 한다.
      if (e.done) void refresh();
    }).then((fn) => { if (dead) fn(); else off = fn; });
    return () => { dead = true; off?.(); };
  }, [available, refresh]);

  if (!available) {
    return (
      <Shell
        title="Claude accounts"
        description="Manage the Claude account pools your agent runners use."
      >
        <SettingsGroup>
          <div className="px-4 py-4 text-fg-subtle">
            Account management is not available in this build. It needs the desktop app,
            which runs the local daemon that owns these directories.
          </div>
        </SettingsGroup>
      </Shell>
    );
  }

  const nameOk = (v: string): boolean => CLAUDE_POOL_NAME_PATTERN.test(v);
  const NAME_HINT = 'Lowercase letters, digits and hyphens (a-z 0-9 -), up to 32 characters.';

  const writeConfig = async (over: Partial<{
    defaultPool: string | null;
    order: Record<string, string[]>;
    agents: Record<string, string>;
    assign: NonNullable<ClaudePoolsConfig['assign']>;
  }>): Promise<void> => {
    if (!snap) return;
    // 세 값을 **한 번에** 쓴다. 부분 갱신이면 배정이 가리키는 풀이 사라진 상태가 중간에 생긴다.
    const order: Record<string, string[]> = {};
    for (const p of snap.pools) if (p.name) order[p.name] = p.accounts.map((a) => a.name);
    try {
      await configureClaudeAccounts({
        // 배정 기준은 옛 데몬이 싣지 않는다(`snap.assign` 부재). 그때는 칸을 보내지 않아 데몬이
        // 디스크의 값을 그대로 두게 한다 — 빈 객체를 보내면 지운다.
        defaultPool: snap.defaultPool, order, agents: snap.agents,
        ...(snap.assign ? { assign: snap.assign } : {}), ...over,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * 추가는 곧바로 로그인이다 — 이름을 묻지 않는다(파일 머리말). 상태를 **먼저** 세우고 부르는
   * 이유는 URL 통지가 `loginStart` 응답보다 먼저 올 수 있어서다: 그때 `loginId` 가 아직 `null`
   * 이면 리스너가 통지를 받아 준다(위 `listenClaudeLogin`).
   */
  const beginLogin = async (pool: string, taken: string[]): Promise<void> => {
    const account = newClaudeAccountId(taken);
    setLogin({ pool, account, loginId: null, url: null, error: null, done: false });
    try {
      const { loginId } = await startClaudeLogin(pool, account);
      setLogin((cur) => (cur && cur.account === account ? { ...cur, loginId } : cur));
    } catch (err) {
      setLogin(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * 있는 계정에 다시 로그인한다. 이름을 새로 짓지 않는 것 말고는 추가와 같은 길이다 — 상태를
   * 먼저 세우는 이유도 같다(위 `beginLogin`). 데몬은 그 계정이 없으면 거절한다(`reauth`).
   */
  const beginReauth = async ({ pool, account, label }: ReauthAsk): Promise<void> => {
    setLogin({ pool, account, reauth: { label }, loginId: null, url: null, error: null, done: false });
    try {
      const { loginId } = await startClaudeLogin(pool, account, { reauth: true });
      setLogin((cur) => (cur && cur.account === account ? { ...cur, loginId } : cur));
    } catch (err) {
      setLogin(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const askPending = (p: NonNullable<Pending>): void => {
    setPendingError(null);
    setPending(p);
  };

  /**
   * 확인한 삭제를 한 번만 보낸다. **실패하면 창을 닫지 않는다** — 앞판은 실패를 화면 맨 위
   * 오류 칸에 띄우고 확인 카드를 닫아서, 사람은 무엇이 실패했는지를 다시 찾아야 했다.
   */
  const confirmPending = async (): Promise<void> => {
    if (!pending || pendingBusy) return;
    setPendingBusy(true);
    setPendingError(null);
    try {
      if (pending.kind === 'account') await removeClaudeAccount(pending.pool, pending.account);
      else await removeClaudePool(pending.pool);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
      setPendingBusy(false);
      return;
    }
    setPendingBusy(false);
    setPending(null);
    await refresh();
  };

  return (
    <Shell
      title="Claude accounts"
      description="Group accounts into pools. A runner uses one pool and spreads new threads across its accounts by usage; a thread stays on its account unless that account nears its limit."
      width="wide"
    >
      {error && (
        <SettingsGroup>
          <div className="px-4 py-3 text-danger">{error}</div>
        </SettingsGroup>
      )}

      {/* 언제부터 반영되는가 — 이 파일 머리말 2. */}
      <div className="mb-6 text-meta text-fg-muted">
        Runners pick up account changes here on their next turn — no restart needed. Threads
        already on an account stay on it; new threads follow the change.
      </div>

      {/* 평평한 계정 이전 안내 — 풀 모드에서 목록에서 사라진 계정들이다. */}
      {snap && snap.strays.length > 0 && (
        <SettingsGroup title="Accounts outside any pool">
          <div className="px-4 py-3 text-meta text-fg-subtle">
            These were created before pools existed. Move them into a pool so runners can
            use them. Signing in again may be required afterwards.
          </div>
          {snap.strays.map((name) => (
            <div key={name} className="flex items-center justify-between px-4 py-3">
              <span className="font-mono text-fg">{name}</span>
              <Button onClick={async () => {
                const target = snap.defaultPool ?? snap.pools[0]?.name;
                if (!target) { setError('Create a pool first.'); return; }
                try {
                  const res = await moveClaudeAccount(name, target);
                  setMoveNote(res.loggedIn
                    ? `Moved ${name} into ${target}.`
                    : `Moved ${name} into ${target}, but it is no longer signed in — sign in again.`);
                  await refresh();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}>
                Move into a pool
              </Button>
            </div>
          ))}
          {moveNote && <div className="px-4 py-3 text-meta text-fg">{moveNote}</div>}
        </SettingsGroup>
      )}

      {snap?.pools.map((pool) => {
        // 카드 제목을 쓰지 않는다 — 풀 이름을 카드 제목과 본문에 두 번 그리면 화면이
        // 같은 말을 반복하고, 이름으로 요소를 찾는 쪽(테스트·스크린리더)이 둘 중 어느
        // 것인지 알 수 없다.
        return (
        <SettingsGroup key={pool.name || '(default)'}>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-medium text-fg">{pool.name || 'Ungrouped'}</span>
              {snap.defaultPool === pool.name && (
                <span className="rounded border border-border px-1.5 text-meta uppercase tracking-wide text-fg-muted">
                  Default pool
                </span>
              )}
              <span className="text-meta text-fg-subtle">
                {snap.defaultPool === pool.name
                  ? 'used by agents with no pool of their own'
                  : `${pool.accounts.length} account${pool.accounts.length === 1 ? '' : 's'}`}
                {/*
                  **순서의 뜻이 바뀌었다(C ③).** 러너는 새 스레드를 점수(주간 여유 ÷ 초기화까지
                  남은 시간) 순으로 나누고, 설정의 `order` 는 동점일 때의 순서다(`writeConfig` 가
                  화면 순서를 그대로 쓴다). 그래서 이 표는 여전히 점수로 정렬하지 않는다 —
                  점수는 몇 분마다 바뀌고, 사람이 정한 순서가 화면에서 사라지면 안 된다.
                */}
                {pool.accounts.length > 1 && ' · new threads go to the account with the most weekly room per hour left; order breaks ties'}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {pool.name && snap.defaultPool !== pool.name && (
                <Button onClick={() => void writeConfig({ defaultPool: pool.name })}>
                  Make default
                </Button>
              )}
              {pool.name && (
                <Button
                  ariaLabel={`Add account to ${pool.name}`}
                  onClick={() => void beginLogin(pool.name, pool.accounts.map((a) => a.name))}
                >
                  Add account
                </Button>
              )}
              {/*
                풀을 지우는 일은 `⋯` 뒤로 내렸다. **안전은 색이 아니라 확인 단계가 진다**
                (아래 `Pending`) — 앞판은 풀마다 · 계정마다 빨간 버튼을 세워서, 거의 누르지
                않는 일이 화면에서 가장 시끄러운 것이 됐다. 게다가 그 빨강(`#dc2626`)은
                카드 면 위에서 사용량 글자와 대비가 같다(3.08:1): 눈을 끄는 것은 색상뿐이고
                읽기 쉬운 것도 아니다.
              */}
              {pool.name && (
                <span className="relative flex">
                  <Menu
                    placement="bottom"
                    items={[{
                      label: `Remove pool ${pool.name}`,
                      onSelect: () => askPending({ kind: 'pool', pool: pool.name }),
                    }]}
                    renderTrigger={(triggerProps) => (
                      <button
                        {...triggerProps}
                        type="button"
                        aria-label={`Actions for pool ${pool.name}`}
                        className="rounded px-2 py-1 text-fg-subtle hover:bg-surface-hover hover:text-fg"
                      >
                        ⋯
                      </button>
                    )}
                  />
                </span>
              )}
            </div>
          </div>

          {/* 기준은 `pools.json` 에만 산다 — 평평한 구조(이름 없는 풀)에는 적을 자리가 없다. */}
          {pool.name && pool.accounts.length > 1 && (
            <ClaudeAssignThresholdsRow
              pool={pool.name}
              assign={snap.assign ?? {}}
              onSave={(next) => {
                const assign = { ...(snap.assign ?? {}) };
                if (Object.keys(next).length) assign[pool.name] = next;
                else delete assign[pool.name];
                return writeConfig({ assign });
              }}
            />
          )}

          {pool.accounts.length > 0 && (
            <div className={`${ACCOUNT_GRID} px-4 py-2 text-meta uppercase tracking-wide text-fg-subtle`}>
              <span>Team</span>
              <span>Signed in as</span>
              <span />
            </div>
          )}

          {pool.accounts.map((a) => {
            const pu = providerSnap ? usageFor(providerSnap, a.name, pool.name) : null;
            // 같은 로그인이 둘이면 페일오버가 같은 한도로 옮겨 탈 뿐이다 — 사람이 알아야 한다.
            const dup = sameSignInAs(pool.accounts, a.name);
            return (
              // 줄과 막대를 **한 자식**으로 묶는다 — `SettingsGroup` 이 자식 사이에 선을 긋는데,
              // 막대가 따로 서면 계정과 그 계정의 한도 사이에 선이 생긴다.
              <div key={a.name}>
              <div
                className={`${ACCOUNT_GRID} items-center px-4 py-2.5`}
                data-testid={`claude-account-${pool.name}-${a.name}`}
              >
                <span
                  className={`truncate ${a.status.loggedIn ? 'text-fg' : 'text-warning'}`}
                  title={teamLabel(a)}
                >
                  {teamLabel(a)}
                </span>
                {/*
                  정체는 이 화면이 반드시 말해야 하는 것 중 하나다(파일 머리말). 열로
                  옮기면서 색을 `fg-subtle`(3.08:1) 에서 `fg-muted`(5.81:1) 로 올렸다 —
                  후자가 팔레트에서 "시각·타임스탬프·설명" 용으로 정의된 값이다.
                  좁아질 수 있는 열이라 잘리는 대신 `title` 로 전문을 남긴다.
                */}
                <span className="flex min-w-0 items-baseline gap-2 text-meta" title={statusLine(a.status)}>
                  {a.status.loggedIn && <span className="truncate text-fg-muted">{signedInAs(a.status)}</span>}
                  {/* 디렉터리 이름은 id 로만 선다 — `HARKROOM_CLAUDE_ACCOUNTS`·로그가 이것을 쓴다. */}
                  <span className="shrink-0 font-mono text-fg-subtle">{a.name}</span>
                  {dup && (
                    <span className="shrink-0 text-warning" data-testid="claude-account-duplicate">
                      same sign-in as {dup.name}
                    </span>
                  )}
                  {/* 경고를 본 자리에서 고친다 — 프로필을 지우지 않고 로그인만 바꾸는 길이 이것이다. */}
                  {dup && (
                    <button
                      type="button"
                      className="shrink-0 text-accent underline hover:text-fg"
                      aria-label={`Sign in again to ${a.name}`}
                      data-testid="claude-account-duplicate-reauth"
                      onClick={() => setReauthAsk({ pool: pool.name, account: a.name, label: accountLabel(a) })}
                    >
                      Sign in again
                    </button>
                  )}
                </span>

                <span className="relative flex justify-end">
                  <Menu
                    placement="bottom"
                    items={[{
                      label: `Sign in again to ${a.name}`,
                      onSelect: () => setReauthAsk({ pool: pool.name, account: a.name, label: accountLabel(a) }),
                    }, {
                      label: `Remove account ${a.name}`,
                      onSelect: () => askPending({
                        kind: 'account', pool: pool.name, account: a.name, label: accountLabel(a),
                      }),
                    }]}
                    renderTrigger={(triggerProps) => (
                      <button
                        {...triggerProps}
                        type="button"
                        aria-label={`Actions for account ${a.name}`}
                        className="rounded px-1.5 py-1 text-fg-subtle hover:bg-surface-hover hover:text-fg"
                      >
                        ⋯
                      </button>
                    )}
                  />
                </span>
              </div>
              {pu && (
                <div className="px-4 pb-2.5" data-testid={`claude-provider-usage-${pool.name}-${a.name}`}>
                  <ProviderUsageBars usage={pu} nowMs={providerSnap!.measuredAtMs} />
                  <AssignScore
                    usage={pu}
                    nowMs={providerSnap!.measuredAtMs}
                    limits={resolveAssignThresholds(
                      { defaultPool: null, order: {}, agents: {}, assign: snap.assign ?? {} }, pool.name || null,
                    )}
                    show={pool.accounts.length > 1}
                  />
                </div>
              )}
              </div>
            );
          })}
        </SettingsGroup>
        );
      })}

      {/* 새 풀 — 설정에 이름이 나타나면 데몬이 디렉터리를 만든다. 그것이 생성 경로다. */}
      <SettingsGroup title="New pool">
        {newPool === null ? (
          <div className="px-4 py-3">
            <Button onClick={() => setNewPool('')}>New pool</Button>
          </div>
        ) : (
          <div className="px-4 py-3">
            <Field label="Pool name" hint={nameOk(newPool) ? undefined : NAME_HINT} tone="warning">
              <TextInput value={newPool} onChange={setNewPool} placeholder="work" />
            </Field>
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                disabled={!nameOk(newPool)}
                onClick={async () => {
                  const order: Record<string, string[]> = {};
                  for (const p of snap?.pools ?? []) if (p.name) order[p.name] = p.accounts.map((a) => a.name);
                  order[newPool] = [];
                  await writeConfig({ order });
                  setNewPool(null);
                }}
              >
                Create
              </Button>
              <Button onClick={() => setNewPool(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </SettingsGroup>

      {/* 계정 추가 — URL 을 링크로 보여 주고 코드를 받는다. */}
      {login && (
        <SettingsGroup title={login.reauth ? `Sign in again — ${login.reauth.label}` : `Add account to ${login.pool}`}>
          {login.loginId === null ? (
            <div className="px-4 py-3">
              {/*
                취소를 여기 두지 않는다: 아직 `loginId` 가 없어 데몬의 로그인 프로세스를 거둘 수
                없다. 이 틈은 데몬이 자식을 띄우는 동안뿐이고, URL 이 오면 아래에 취소가 선다.
              */}
              <div className="text-meta text-fg-subtle">Starting sign-in…</div>
            </div>
          ) : (
            <div className="px-4 py-3">
              {login.url ? (
                <>
                  <div className="text-meta text-fg-subtle">
                    Open this link and sign in, then paste the code below.
                  </div>
                  <a
                    className="mt-2 block break-all text-accent underline"
                    href={login.url}
                    onClick={(e) => { e.preventDefault(); void getExternalOpener().open(login.url!); }}
                  >
                    {login.url}
                  </a>
                  <div className="mt-2 text-meta text-warning">
                    {login.reauth
                      ? 'Use a private (incognito) browser window. Otherwise the existing session signs this account into the same login again.'
                      : 'Use a private (incognito) browser window when adding a second account. Otherwise the existing session signs you into the same account again.'}
                  </div>
                  <div className="mt-3">
                    <LoginCodeForm
                      onSubmit={async (code) => {
                        try {
                          await submitClaudeLoginCode(login.loginId!, code);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    />
                  </div>
                </>
              ) : (
                <div className="text-fg-subtle">Starting sign-in…</div>
              )}
              {login.error && <div className="mt-3 text-danger">{login.error}</div>}
              <div className="mt-3">
                <Button onClick={async () => {
                  if (login.loginId) await cancelClaudeLogin(login.loginId).catch(() => undefined);
                  setLogin(null);
                }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </SettingsGroup>
      )}

      {/*
        확인 단계 — 자격증명이 사라지는 일이라 한 번 더 묻는다. **겹창이다.** 앞판은 페이지 맨
        아래 "Confirm" 카드로 붙였는데, 누른 `⋯` 에서 멀고 스크롤해야 보일 때도 있어서 오류
        배너로 읽혔다(2026-09-29 jaebin). 버튼 이름은 "Confirm" 이 아니라 **하는 일**이다.
      */}
      {/*
        다시 로그인 확인(2026-10-01 jaebin: 막지 않고 알린다). 세 가지를 말한다 — 무엇이 남는가,
        왜 시크릿 창인가(그러지 않으면 같은 로그인으로 돌아와 `same sign-in` 이 그대로다), 돌던
        턴은 어떻게 되는가. 턴을 막지 않는 이유: 데몬은 어느 턴이 어느 계정을 쓰는지 모르고,
        다시 로그인하려는 때는 대개 그 계정이 이미 실패하는 중이다. claude 2.1.286 은 토큰을
        갱신하기 전에 저장소를 다시 읽고 값이 바뀌었으면 그것을 따른다(`refresh_race_resolved`)
        — 돌던 턴이 Keychain 을 옛 로그인으로 되덮지 않는다.
      */}
      {reauthAsk && (
        <ConfirmDialog
          title={`Sign in again to ${reauthAsk.account}?`}
          detail={
            // 겹창의 미리보기 칸은 높이가 정해져 있다(`max-h-24`) — 세 줄을 짧게 둔다.
            <div className="flex flex-col gap-1">
              <span>Name, pool and order stay; only the sign-in changes.</span>
              <span>Use a private browser window, or you get the same login again.</span>
              <span>Turns already running on this account are not stopped.</span>
            </div>
          }
          confirmLabel="Sign in again"
          onConfirm={() => { const ask = reauthAsk; setReauthAsk(null); void beginReauth(ask); }}
          onCancel={() => setReauthAsk(null)}
        />
      )}

      {pending && (
        <ConfirmDialog
          danger
          title={pending.kind === 'account' ? `Remove account ${pending.account}?` : `Remove pool ${pending.pool}?`}
          detail={pending.kind === 'account'
            ? `${pending.label}${pending.pool ? ` in pool ${pending.pool}` : ''}. Its saved sign-in is deleted and you would have to sign in again.`
            : 'Every account in it and their saved sign-ins are deleted.'}
          confirmLabel={pending.kind === 'account' ? 'Remove' : 'Remove pool'}
          cancelLabel="Keep"
          busy={pendingBusy}
          error={pendingError}
          onConfirm={() => void confirmPending()}
          onCancel={() => setPending(null)}
        />
      )}
    </Shell>
  );
}

/**
 * 코드 입력만 따로 둔 이유: 부모의 `login` 상태에 코드를 넣으면 이벤트가 올 때마다
 * (`setLogin` 이 새 객체를 만든다) 입력 중인 값이 흔들릴 여지가 생긴다. 코드는 이 화면에서
 * 밖으로 나가지 않는 값이므로 부모가 들 이유가 없다.
 */
/**
 * 러너가 이 계정에 매기는 점수와, 새 배정에서 빠지는지(C ③). 식은 러너와 **같은 함수**다
 * (`headroomPerHour`) — 다르면 화면이 러너의 판단과 다른 말을 한다. 모델별 주간 창은 에이전트
 * 모델에 따라 갈리므로 여기서는 전체 주간 창만 본다.
 */
function AssignScore({ usage, nowMs, limits, show }: {
  usage: { session: { usedPercent: number } | null; weekly: { usedPercent: number; resetsAtMs: number | null } | null; error?: string };
  nowMs: number;
  limits: { newSessionPct: number; newWeeklyPct: number };
  show: boolean;
}) {
  if (!show || !usage.weekly || usage.error) return null;
  const score = headroomPerHour(usage.weekly, nowMs);
  const skip = (usage.session && usage.session.usedPercent >= limits.newSessionPct)
    || usage.weekly.usedPercent >= limits.newWeeklyPct;
  return (
    <div className="mt-1 text-meta text-fg-subtle" data-testid="claude-assign-score">
      Score {score.toFixed(2)}%/h
      {skip && <span className="text-warning"> · skipped for new threads</span>}
    </div>
  );
}

function LoginCodeForm({ onSubmit }: { onSubmit(code: string): Promise<void> }) {
  const [code, setCode] = useState('');
  return (
    <>
      <Field label="Code from the browser">
        <TextInput value={code} onChange={setCode} placeholder="paste here" />
      </Field>
      <div className="mt-3">
        <Button variant="primary" disabled={code.trim() === ''} onClick={() => void onSubmit(code.trim())}>
          Submit
        </Button>
      </div>
    </>
  );
}
