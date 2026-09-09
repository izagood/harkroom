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
 *    "회사 계정이 어느 것인가"를 여기서 알 수 없다.
 * 2. **러너 재시작이 필요하다**는 사실. 러너는 풀을 기동 시 1회 읽는다 — 안 말하면 사용자는
 *    계정을 추가하고 왜 안 쓰는지 모른다.
 * 3. **두 번째 계정부터 시크릿 창**이 필요하다는 사실. 그러지 않으면 기존 쿠키로 같은 계정에
 *    다시 로그인되고, 사용자는 "두 번 등록했는데 하나뿐"을 보게 된다. 브라우저를 자동으로
 *    열지 않고 **링크를 보여 주는** 이유의 절반이 이것이다.
 *
 * ## 왜 표인가 (#702)
 *
 * 이 화면은 설정 화면 중 **유일하게 표**다 — 계정 하나가 숫자를 다섯 개 갖는다. 앞판은
 * 그것을 계정마다 네 줄짜리 문장으로 쌓고 `SettingsPage` 기본 폭(768px)에 담았다.
 * 그래서 세 가지가 동시에 망가졌다:
 *
 * 1. `1283` 과 `1649` 가 서로 다른 x 좌표에 130px 떨어져 서서, **어느 계정이 많이
 *    돌았나** 를 눈으로 알 수 없었다. 그 비교가 이 화면이 있는 이유다.
 * 2. 사용량과 한도 상태가 라벨용 회색(`--app-fg-subtle`)의 11px 이었다 — 카드 면과
 *    **3.08:1** 로 WCAG AA(4.5:1) 미달이고, 팔레트에는 그 자리에 쓰라고 정의된
 *    `--app-fg-muted`(5.81:1)가 이미 있었다.
 * 3. 줄마다 가장 넓고 시끄러운 것이 `Remove account <이름>` 이었다. 그 빨강도 같은 면에서
 *    3.08:1 이라, 눈을 끄는 것은 색상뿐이고 읽기 쉬운 것도 아니었다.
 *
 * 고친 방향: 열을 맞추고(`ACCOUNT_GRID`), 숫자를 본문단으로 올리고, 상태를 문장에서
 * 알약으로 바꾸고, 파괴적 조작을 `⋯` 뒤로 내렸다. **재는 값은 하나도 늘리지 않았다** —
 * 데몬이 이미 주던 것을 읽을 수 있게 놓은 것뿐이다.
 *
 * UI 문자열은 **영어**다 — 저장소 관례이고 한 번 어겨 되돌린 적이 있다. 주석은 한국어다.
 */
import { useCallback, useEffect, useState } from 'react';

import { CLAUDE_POOL_NAME_PATTERN } from '@murmur/shared/claudePools';

import { useLocale } from '../../i18n/useT';

import {
  cancelClaudeLogin,
  claudeAccountsUsage,
  configureClaudeAccounts,
  hasClaudeAccountsSurface,
  listClaudeAccounts,
  listenClaudeLogin,
  moveClaudeAccount,
  removeClaudeAccount,
  removeClaudePool,
  startClaudeLogin,
  submitClaudeLoginCode,
  type ClaudeAccountsSnapshot,
  type ClaudeAuthStatus,
  type ClaudeLoginEvent,
  type ClaudeUsageSnapshot,
} from '../../lib/claudeAccounts';
import { accountState, clockLabel, usageByAccount, usageCells } from '../../lib/claudeUsage';
import { getExternalOpener } from '../../lib/openExternal';
import { Menu } from '../Menu';
import { Button, Field, SettingsGroup, SettingsPage, TextInput } from './primitives';

/**
 * 계정 표의 열. **한 곳에 적어 머리줄과 본문 줄이 같은 값을 쓴다** — 두 벌로 두면
 * 언젠가 한쪽만 고쳐지고, 그때 머리줄의 `Cache` 가 다른 열 위에 선다.
 *
 * 이 화면이 표인 이유: 계정 하나가 숫자를 다섯 개 갖는다. 앞판은 그것을 계정마다
 * 네 줄짜리 문장으로 쌓아서, `1283` 과 `1649` 가 서로 다른 x 좌표에 130px 떨어져
 * 섰다 — 그러면 어느 계정이 많이 돌았는지 **눈으로 알 수 없다**.
 */
const ACCOUNT_GRID =
  'grid grid-cols-[7rem_minmax(9rem,1fr)_6.5rem_3.5rem_3rem_3rem_3.75rem_3.5rem_8.5rem_1.75rem] gap-x-3';

/**
 * 상태 알약의 색. **`warning` 만 면을 채운다** — 지금 못 쓰는 계정 하나가 화면에서
 * 튀어야 하고, 다섯 갈래가 다 채워진 면이면 아무것도 튀지 않는다.
 *
 * `muted` 는 테두리만이다: "이 창에서 이미 걸렸다"는 경고가 아니라 **기억해 둘 사실**
 * 이라(이미 풀렸다) 경고와 같은 무게를 주면 거짓말이 된다. 그래도 테두리를 주는 이유는
 * 모양이 있어야 훑을 때 걸리기 때문이다 — 앞판이 이것을 회색 문장으로 둬서 묻혔다.
 */
const STATE_PILL = {
  warning: 'border border-warning-border bg-warning-surface text-warning',
  muted: 'border border-border text-fg-muted',
  success: 'text-success',
  subtle: 'text-fg-subtle',
} as const;

/** 되돌릴 수 없는 일 하나를 기다리는 상태. `null` 은 대기 중인 것이 없다. */
type Pending =
  | { kind: 'account'; pool: string; account: string }
  | { kind: 'pool'; pool: string }
  | null;

/** 진행 중인 로그인 하나. 화면에 둘을 동시에 두지 않는다 — 코드 입력란이 둘이면 헷갈린다. */
interface LoginState {
  pool: string;
  account: string;
  loginId: string | null;
  url: string | null;
  error: string | null;
  done: boolean;
}

function statusLine(status: ClaudeAuthStatus): string {
  if (!status.loggedIn) return 'Not signed in';
  return [status.email, status.orgName, status.subscriptionType].filter(Boolean).join(' · ');
}

export function ClaudeAccountsSettings() {
  const available = hasClaudeAccountsSurface();
  // **글자는 영어이지만 시각 표기는 로케일을 따른다.** 이 화면의 문구는 사전을 쓰지 않는데
  // (이 파일 머리말) `HH:MM` 은 문구가 아니라 숫자 표기라 `Intl` 이 낸다 — `lib/time.ts`
  // 머리말이 가른 그 축이다: 수량·표기는 플랫폼이 우리보다 잘 안다.
  const locale = useLocale();
  const [snap, setSnap] = useState<ClaudeAccountsSnapshot | null>(null);
  // 사용량은 **목록과 따로** 온다. 실패해도 계정 목록은 그대로 옳으므로 오류도 따로 든다 —
  // 하나로 두면 트랜스크립트를 못 읽은 것이 "계정을 못 읽었다"로 보인다.
  const [usage, setUsage] = useState<ClaudeUsageSnapshot | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [login, setLogin] = useState<LoginState | null>(null);
  const [newPool, setNewPool] = useState<string | null>(null);
  const [moveNote, setMoveNote] = useState<string | null>(null);
  // 퍼센트가 없는 이유 — 접어 둔다(위 안내 줄의 주석 참조).
  const [whyOpen, setWhyOpen] = useState(false);

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

  /**
   * 사용량을 다시 잰다. **자동으로 되풀이하지 않는다** — 계정당 트랜스크립트 수십 MB 를
   * 훑는 일이라 주기적으로 돌리면 설정 화면을 열어 둔 것만으로 디스크를 계속 읽는다.
   * 화면을 열 때 한 번 재고, 그 뒤는 사람이 누를 때 다시 잰다.
   */
  const refreshUsage = useCallback(async () => {
    if (!available) return;
    try {
      setUsage(await claudeAccountsUsage());
      setUsageError(null);
    } catch (err) {
      setUsageError(err instanceof Error ? err.message : String(err));
    }
  }, [available]);

  useEffect(() => { void refresh(); void refreshUsage(); }, [refresh, refreshUsage]);

  // 잰 시각을 판정의 기준으로 쓴다. `Date.now()` 를 렌더에서 부르면 같은 스냅샷이
  // 렌더마다 다르게 그려지고, 무엇보다 **잰 뒤에 흐른 시간**이 판정에 섞인다.
  const nowMs = usage?.measuredAtMs ?? 0;
  const usageMap = usageByAccount(usage?.accounts ?? null);

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
      <SettingsPage
        title="Claude accounts"
        description="Manage the Claude account pools your agent runners use."
      >
        <SettingsGroup>
          <div className="px-4 py-4 text-fg-subtle">
            Account management is not available in this build. It needs the desktop app,
            which runs the local daemon that owns these directories.
          </div>
        </SettingsGroup>
      </SettingsPage>
    );
  }

  const nameOk = (v: string): boolean => CLAUDE_POOL_NAME_PATTERN.test(v);
  const NAME_HINT = 'Lowercase letters, digits and hyphens (a-z 0-9 -), up to 32 characters.';

  const writeConfig = async (over: Partial<{
    defaultPool: string | null;
    order: Record<string, string[]>;
    agents: Record<string, string>;
  }>): Promise<void> => {
    if (!snap) return;
    // 세 값을 **한 번에** 쓴다. 부분 갱신이면 배정이 가리키는 풀이 사라진 상태가 중간에 생긴다.
    const order: Record<string, string[]> = {};
    for (const p of snap.pools) if (p.name) order[p.name] = p.accounts.map((a) => a.name);
    try {
      await configureClaudeAccounts({
        defaultPool: snap.defaultPool, order, agents: snap.agents, ...over,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmPending = async (): Promise<void> => {
    if (!pending) return;
    try {
      if (pending.kind === 'account') await removeClaudeAccount(pending.pool, pending.account);
      else await removeClaudePool(pending.pool);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setPending(null);
  };

  return (
    <SettingsPage
      title="Claude accounts"
      description="Group accounts into pools. A runner uses one pool and moves to the next account when it hits a usage limit."
      width="wide"
    >
      {error && (
        <SettingsGroup>
          <div className="px-4 py-3 text-danger">{error}</div>
        </SettingsGroup>
      )}

      {/*
        안내 두 줄과 다시 재기 버튼을 **한 줄로 합쳤다.** 앞판은 이 둘이 각자
        `SettingsGroup` 카드였고, 그래서 화면의 첫 150px 을 **한 번 읽으면 끝인 산문**이
        먹었다 — 그 아래가 이 화면에 매번 오는 이유(계정과 사용량)인데도.

        말해야 할 것을 줄이지는 않았다. 이 파일 머리말이 못 뺀다고 못박은 세 가지 중
        둘이 여기 있다(러너 재시작 · 사용량의 출처). 무게만 낮췄다.

        "퍼센트가 없다"는 설명은 접었다. 그것은 **한 번 납득하면 다시 읽지 않는** 종류의
        사실이라 늘 펼쳐 둘 값이 아니고, 그렇다고 지우면 퍼센트의 부재가 우리 누락처럼
        보인다 — 그래서 지우지 않고 물음 뒤에 둔다.
      */}
      <div className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-fg-muted">
        <span>
          {usageError
            ? `Could not read usage: ${usageError}`
            : usage
              ? 'Counted from each account’s own transcripts over its last 5-hour window.'
              : 'Reading usage from transcripts…'}
        </span>
        <span className="text-fg-subtle">·</span>
        <span>
          A runner reads its pool once at startup — restart it from Settings › Agents after
          changing accounts here.
        </span>
        <span className="text-fg-subtle">·</span>
        <button
          type="button"
          onClick={() => setWhyOpen((v) => !v)}
          aria-expanded={whyOpen}
          className="underline underline-offset-2 hover:text-fg"
        >
          Why no percentages?
        </button>
        <span className="ml-auto">
          <Button onClick={() => void refreshUsage()}>Refresh usage</Button>
        </span>
      </div>

      {whyOpen && (
        <div className="mb-6 rounded-xl border border-border bg-surface-raised px-4 py-3 text-meta text-fg-muted">
          Claude reports no fixed limit to compare against — it is in neither{' '}
          <span className="font-mono">claude auth status</span> nor the transcripts, and Claude only
          says “over” at the moment it is over. So these are amounts, not percentages. The bar
          compares accounts <span className="text-fg">within one pool</span>: full width is the
          busiest account in that pool, never a quota we invented.
        </div>
      )}

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
        const rows = pool.accounts.map((a) => ({ a, u: usageMap.get(`${pool.name}/${a.name}`) }));
        /**
         * 막대의 100%. **풀 안에서만 잰다** — 분모를 모르니 절대 눈금은 지어낸 값이 되고
         * (`lib/claudeUsage.ts` 머리말), 풀들을 통틀어 재면 계정 하나짜리 풀이 언제나
         * 100% 로 보인다. "이 풀에서 누가 제일 많이 돌았나" 는 답할 수 있는 질문이다.
         */
        const busiest = Math.max(0, ...rows.map((r) => r.u?.responses ?? 0));
        const totalResponses = rows.reduce((n, r) => n + (r.u?.responses ?? 0), 0);
        const limited = rows.filter(
          (r) => r.u && accountState(r.u, nowMs, locale).kind.startsWith('limited'),
        ).length;
        // 못 읽은 파일이 있으면 위 합계는 **하한**이다. 그 사실을 계정 줄이 아니라 풀
        // 머리에 적는다 — 합계를 읽는 사람이 알아야 하는 것이고, 줄마다 적으면 표가 시끄럽다.
        const underCounted = rows.some((r) => r.u && r.u.unreadableFiles > 0);
        /*
          아직 안 온 것 · 못 읽은 것 · 이 창에 안 돈 것을 **다른 글리프로** 가른다.
          하나로 두면 화면이 확인한 적 없는 것을 단언한다 — `AgentTurns` 에서 `0` 과
          `모름` 을 가른 것과 같은 규율이다.
        */
        const cellFallback = usageError ? '?' : usage ? '—' : '…';

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
                  **순서에 뜻이 있다는 사실을 처음으로 적는다.** 설정의 `order` 가 러너의
                  대체 순서이고(`writeConfig` 가 화면 순서를 그대로 쓴다), 그래서 이 표는
                  숫자로 정렬하지 않는다 — 정렬하면 보기는 좋아지지만 화면이 들고 있던
                  정보 하나가 조용히 사라진다.
                */}
                {pool.accounts.length > 1 && ' · a runner tries them top to bottom'}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {usage && pool.accounts.length > 0 && (
                <span
                  className="text-meta tabular-nums text-fg-muted"
                  data-testid={`claude-pool-summary-${pool.name}`}
                >
                  <span className="text-fg">{totalResponses}</span>
                  {' responses this window'}
                  {limited > 0 && (
                    <>
                      {' · '}
                      <span className="text-warning">{`${limited} limited`}</span>
                    </>
                  )}
                  {underCounted && ' · some files unreadable, so counts are a floor'}
                </span>
              )}
              {pool.name && snap.defaultPool !== pool.name && (
                <Button onClick={() => void writeConfig({ defaultPool: pool.name })}>
                  Make default
                </Button>
              )}
              {pool.name && (
                <Button
                  ariaLabel={`Add account to ${pool.name}`}
                  onClick={() => setLogin({
                    pool: pool.name, account: '', loginId: null, url: null, error: null, done: false,
                  })}
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
                      onSelect: () => setPending({ kind: 'pool', pool: pool.name }),
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

          {/* 열 이름은 풀마다 한 번 선다. 앞판은 이 이름들을 계정 줄마다 값과 붙여
              반복했다(`in 5.3M · out 1.1M`) — 계정 넷이면 같은 라벨이 넷이다. */}
          {pool.accounts.length > 0 && (
            <div className={`${ACCOUNT_GRID} px-4 py-2 text-meta uppercase tracking-wide text-fg-subtle`}>
              <span>Account</span>
              <span>Signed in as</span>
              <span>Share of pool</span>
              <span className="text-right">Resp</span>
              <span className="text-right">In</span>
              <span className="text-right">Out</span>
              <span className="text-right">Cache</span>
              <span className="text-right">Active</span>
              <span>State</span>
              <span />
            </div>
          )}

          {rows.map(({ a, u }) => {
            const cells = u ? usageCells(u) : null;
            const state = u ? accountState(u, nowMs, locale) : null;
            return (
              <div
                key={a.name}
                className={`${ACCOUNT_GRID} items-center px-4 py-2.5`}
                data-testid={`claude-account-${pool.name}-${a.name}`}
              >
                <span className="truncate font-mono text-fg">{a.name}</span>
                {/*
                  정체는 이 화면이 반드시 말해야 하는 것 중 하나다(파일 머리말). 열로
                  옮기면서 색을 `fg-subtle`(3.08:1) 에서 `fg-muted`(5.81:1) 로 올렸다 —
                  후자가 팔레트에서 "시각·타임스탬프·설명" 용으로 정의된 값이다.
                  좁아질 수 있는 열이라 잘리는 대신 `title` 로 전문을 남긴다.
                */}
                <span
                  className={`truncate text-meta ${a.status.loggedIn ? 'text-fg-muted' : 'text-warning'}`}
                  title={statusLine(a.status)}
                >
                  {statusLine(a.status)}
                </span>

                {/*
                  막대는 숫자 옆의 **중복**이다 — 그러니 스크린리더에서는 빼고 눈으로만
                  일하게 둔다. 남기는 이유: 이 표에서 초점을 맞추지 않고 읽히는 유일한
                  것이다. 안 돈 계정은 막대 대신 기준선만 그어 자리를 지킨다(빈 칸으로
                  두면 그 줄만 높이가 달라 보인다).
                */}
                <span className="flex items-center" aria-hidden="true">
                  {cells && u ? (
                    <span className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                      <span
                        /*
                          제일 많이 돈 계정만 진하게. **강조색(주황)은 쓰지 않는다** —
                          이 저장소는 강조를 "나를 막는 것과 화면당 주 동작 하나"로 좁혀
                          회수해 뒀다(#488 B2, `test/accentBudget.test.tsx`). 많이 돌았다는
                          것은 나를 막는 일이 아니므로 잉크 농도로 말한다.
                        */
                        className={`block h-full rounded-full ${u.responses === busiest ? 'bg-fg' : 'bg-fg-subtle'}`}
                        style={{ width: `${Math.max(3, (u.responses / busiest) * 100)}%` }}
                      />
                    </span>
                  ) : (
                    <span className="h-px w-full bg-border" />
                  )}
                </span>

                {/* 응답 수는 이 표의 머릿수다 — 본문단 `text-fg`(13.5:1). 나머지 토큰
                    열은 한 단 낮춰 `fg-muted` 로. 셋이 다 같은 무게면 위계가 없다. */}
                <span className="text-right tabular-nums text-fg" data-testid="claude-account-usage">
                  {cells ? cells.responses : cellFallback}
                </span>
                <span className="text-right tabular-nums text-fg-muted">
                  {cells ? cells.input : cellFallback}
                </span>
                <span className="text-right tabular-nums text-fg-muted">
                  {cells ? cells.output : cellFallback}
                </span>
                <span className="text-right tabular-nums text-fg-muted">
                  {cells ? cells.cacheRead : cellFallback}
                </span>
                {/* 마지막으로 돈 시각. 사람이 시계와 대조하는 값이라 상대 시간이 아니다. */}
                <span className="text-right tabular-nums text-fg-muted">
                  {u ? (u.lastUsedAtMs === null ? '—' : clockLabel(u.lastUsedAtMs, locale)) : cellFallback}
                </span>

                <span className="min-w-0">
                  {state ? (
                    <span
                      data-testid="claude-account-state"
                      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-meta ${STATE_PILL[state.tone]}`}
                    >
                      {(state.tone === 'warning' || state.tone === 'success') && (
                        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
                      )}
                      <span className="truncate">{state.label}</span>
                    </span>
                  ) : (
                    <span className="text-meta text-fg-subtle">{cellFallback}</span>
                  )}
                </span>

                <span className="relative flex justify-end">
                  <Menu
                    placement="bottom"
                    items={[{
                      label: `Remove account ${a.name}`,
                      onSelect: () => setPending({ kind: 'account', pool: pool.name, account: a.name }),
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
        <SettingsGroup title={`Add account to ${login.pool}`}>
          {login.loginId === null ? (
            <div className="px-4 py-3">
              <Field
                label="Account name"
                hint={login.account === '' || nameOk(login.account) ? NAME_HINT : NAME_HINT}
                tone="warning"
              >
                <TextInput
                  value={login.account}
                  onChange={(v) => setLogin({ ...login, account: v })}
                  placeholder="work-main"
                />
              </Field>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="primary"
                  disabled={!nameOk(login.account)}
                  onClick={async () => {
                    try {
                      const { loginId } = await startClaudeLogin(login.pool, login.account);
                      setLogin((cur) => (cur ? { ...cur, loginId } : cur));
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                >
                  Sign in
                </Button>
                <Button onClick={() => setLogin(null)}>Cancel</Button>
              </div>
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
                    Use a private (incognito) browser window when adding a second account.
                    Otherwise the existing session signs you into the same account again.
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

      {/* 확인 단계 — 자격증명이 사라지는 일이라 한 번 더 묻는다. */}
      {pending && (
        <SettingsGroup title="Confirm">
          <div className="px-4 py-3">
            <div className="text-fg">
              {pending.kind === 'account'
                ? `Remove account ${pending.account} from ${pending.pool}? Its saved sign-in is deleted and you would have to sign in again.`
                : `Remove pool ${pending.pool} and every account in it? Their saved sign-ins are deleted.`}
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="danger" onClick={() => void confirmPending()}>Confirm</Button>
              <Button onClick={() => setPending(null)}>Keep</Button>
            </div>
          </div>
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}

/**
 * 코드 입력만 따로 둔 이유: 부모의 `login` 상태에 코드를 넣으면 이벤트가 올 때마다
 * (`setLogin` 이 새 객체를 만든다) 입력 중인 값이 흔들릴 여지가 생긴다. 코드는 이 화면에서
 * 밖으로 나가지 않는 값이므로 부모가 들 이유가 없다.
 */
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
