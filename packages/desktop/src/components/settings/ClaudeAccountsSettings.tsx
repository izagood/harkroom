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
 * UI 문자열은 **영어**다 — 저장소 관례이고 한 번 어겨 되돌린 적이 있다. 주석은 한국어다.
 */
import { useCallback, useEffect, useState } from 'react';

import { CLAUDE_POOL_NAME_PATTERN } from '@murmur/shared/claudePools';

import {
  cancelClaudeLogin,
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
} from '../../lib/claudeAccounts';
import { getExternalOpener } from '../../lib/openExternal';
import { Button, Field, SettingsGroup, SettingsPage, TextInput } from './primitives';

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
  const [snap, setSnap] = useState<ClaudeAccountsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [login, setLogin] = useState<LoginState | null>(null);
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
    >
      {error && (
        <SettingsGroup>
          <div className="px-4 py-3 text-danger">{error}</div>
        </SettingsGroup>
      )}

      {/* 러너 반영 안내 — 이 화면의 변경이 언제 효과를 내는지 말한다. */}
      <SettingsGroup>
        <div className="px-4 py-3 text-meta text-fg-subtle">
          A runner reads its pool once at startup. After changing accounts here, restart the
          runner from Settings › Agents for the change to take effect.
        </div>
      </SettingsGroup>

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

      {snap?.pools.map((pool) => (
        // 카드 제목을 쓰지 않는다 — 풀 이름을 카드 제목과 본문에 두 번 그리면 화면이
        // 같은 말을 반복하고, 이름으로 요소를 찾는 쪽(테스트·스크린리더)이 둘 중 어느
        // 것인지 알 수 없다.
        <SettingsGroup key={pool.name || '(default)'}>
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="font-medium text-fg">{pool.name || 'Ungrouped'}</div>
              <div className="text-meta text-fg-subtle">
                {snap.defaultPool === pool.name
                  ? 'Default pool — used by agents with no pool of their own'
                  : `${pool.accounts.length} account${pool.accounts.length === 1 ? '' : 's'}`}
              </div>
            </div>
            <div className="flex gap-2">
              {pool.name && snap.defaultPool !== pool.name && (
                <Button onClick={() => void writeConfig({ defaultPool: pool.name })}>
                  Make default
                </Button>
              )}
              {pool.name && (
                <Button onClick={() => setLogin({
                  pool: pool.name, account: '', loginId: null, url: null, error: null, done: false,
                })}>
                  {`Add account to ${pool.name}`}
                </Button>
              )}
              {pool.name && (
                <Button variant="danger" onClick={() => setPending({ kind: 'pool', pool: pool.name })}>
                  {`Remove pool ${pool.name}`}
                </Button>
              )}
            </div>
          </div>

          {pool.accounts.map((a) => (
            <div key={a.name} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="font-mono text-fg">{a.name}</div>
                <div className={`text-meta ${a.status.loggedIn ? 'text-fg-subtle' : 'text-warning'}`}>
                  {statusLine(a.status)}
                </div>
              </div>
              <Button
                variant="danger"
                onClick={() => setPending({ kind: 'account', pool: pool.name, account: a.name })}
              >
                {`Remove account ${a.name}`}
              </Button>
            </div>
          ))}
        </SettingsGroup>
      ))}

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
