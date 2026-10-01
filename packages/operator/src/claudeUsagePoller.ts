// claude 계정 사용률을 **백그라운드로** 재서 `<뿌리>/usage.json` 에 쓴다(2026-09-29, C ①).
//
// 읽는 쪽은 러너다 — 새 스레드에 계정을 고를 때 이 파일의 %·초기화 시각으로 점수를 매긴다(C ②).
// 이 PR 에는 읽는 쪽이 아직 없고 화면도 바뀌지 않는다. 파일의 모양·뜻은 `@harkroom/shared/claudeUsage`.
//
// ## 얼마나 자주 재나
//
// 계정마다 CLI 프로세스가 하나씩 뜬다(`usageChain.ts`). 그래서 **쓰이는 계정만 자주** 잰다:
// - 쓰이는 계정 `USAGE_POLL_ACTIVE_MS`(2분), 쉬는 계정 `USAGE_POLL_IDLE_MS`(10분).
// - "쓰이는가"는 **지난 번과 값이 달라졌는가**로 판단한다. 배정 기록은 러너 쪽에 있고 이
//   프로세스는 그것을 모른다. 사용률이 움직였다면 누군가 쓰고 있는 것이다.
//   쉬던 계정에 새 스레드가 배정되면 최대 10분 늦게 알아챈다 — 그 사이 러너는 자기가 배정한
//   턴 수만큼 점수를 깎아 몰림을 막는다(C ②).
//
// ## 실패를 다루는 법
//
// 조회가 실패하면 **앞 값을 지우지 않는다** — `readAtMs` 도 그대로 둔다. 읽는 쪽은 `readAtMs` 로
// 신선도를 재고, 10분을 넘은 값으로는 계정을 빼지 않는다(`isUsageFresh`). 실패로 값을 지우면
// 한 번의 네트워크 끊김이 "그 계정은 모른다"가 되어 점수가 흔들린다.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CLAUDE_USAGE_FILE,
  CLAUDE_USAGE_VERSION,
  type ClaudeUsageEntry,
  type ClaudeUsageFile,
} from '@harkroom/shared/claudeUsage';
import type { ProviderAccountUsage } from '@harkroom/shared/daemonProtocol';

import { readClaudeAccountsLayout, readSignInKey } from './claudeAccounts.js';

export const USAGE_POLL_ACTIVE_MS = 2 * 60 * 1000;
export const USAGE_POLL_IDLE_MS = 10 * 60 * 1000;
/** 깨어나는 주기. 계정마다 기한이 따로라 가장 짧은 기한보다 촘촘해야 한다. */
export const USAGE_POLL_TICK_MS = 60 * 1000;
/**
 * 기동 직후 첫 조회까지의 유예. 데몬이 뜨는 순간은 러너 입양·서버 연결로 바쁘다 — 계정 수만큼
 * `claude` 를 같이 띄우지 않는다.
 */
export const USAGE_POLL_FIRST_DELAY_MS = 15 * 1000;

type Measured = Omit<ProviderAccountUsage, 'account' | 'pool'>;

interface AccountState {
  entry: ClaudeUsageEntry;
  /** 마지막으로 **시도한** 시각(성공·실패 무관). 다음 기한의 기준이다. */
  triedAtMs: number;
  active: boolean;
}

export interface ClaudeUsagePoller {
  /** 기한이 된 계정을 재고 파일을 쓴다. 테스트가 직접 부른다. */
  tick(): Promise<void>;
  /**
   * 그 계정(`CLAUDE_CONFIG_DIR`)의 값을 버리고 곧바로 다시 잰다. 다시 로그인한 계정이 부른다 —
   * 그러지 않으면 기한(쉬는 계정 10분)까지 `usage.json` 이 **옛 로그인의 %**를 싣는다.
   */
  forget(configDir: string): Promise<void>;
  start(): void;
  stop(): void;
}

export function createClaudeUsagePoller(opts: {
  root: string;
  measure: (configDir: string) => Promise<Measured>;
  readSignIn?: (configDir: string) => Promise<string | null>;
  now?: () => number;
  log?: (line: string) => void;
}): ClaudeUsagePoller {
  const now = opts.now ?? ((): number => Date.now());
  const readSignIn = opts.readSignIn ?? readSignInKey;
  /** 키는 `CLAUDE_CONFIG_DIR` 경로 — 계정 이름은 풀 사이에서 겹칠 수 있다. */
  const states = new Map<string, AccountState>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const due = (s: AccountState | undefined, at: number): boolean =>
    !s || at - s.triedAtMs >= (s.active ? USAGE_POLL_ACTIVE_MS : USAGE_POLL_IDLE_MS);

  async function measureOne(pool: string, account: string, dir: string, at: number): Promise<void> {
    const prev = states.get(dir);
    const [m, signIn] = await Promise.all([
      opts.measure(dir).catch((): Measured => ({ fetchedAtMs: at, session: null, weekly: null, error: 'network' })),
      readSignIn(dir).catch(() => null),
    ]);
    let entry: ClaudeUsageEntry;
    if (m.error) {
      entry = prev
        ? { ...prev.entry, pool, account, signIn: signIn ?? prev.entry.signIn, error: m.error }
        : { pool, account, signIn, session: null, weekly: null, modelWeekly: [], readAtMs: null, error: m.error };
    } else {
      entry = {
        pool, account, signIn,
        session: m.session, weekly: m.weekly,
        // `extra` 는 지금 모델별 주간 창뿐이다(`parseClaudeOAuthUsage`·`parseClaudeUsageText`).
        modelWeekly: m.extra ?? [],
        readAtMs: m.fetchedAtMs,
      };
    }
    const active = !m.error && prev !== undefined && prev.entry.readAtMs !== null && moved(prev.entry, entry);
    // 실패는 쓰이는지를 말해 주지 않는다 — 앞 판정을 그대로 둔다.
    states.set(dir, { entry, triedAtMs: at, active: m.error ? (prev?.active ?? false) : active });
  }

  async function write(at: number): Promise<void> {
    const file: ClaudeUsageFile = {
      version: CLAUDE_USAGE_VERSION,
      writtenAtMs: at,
      accounts: [...states.values()].map((s) => s.entry),
    };
    await mkdir(opts.root, { recursive: true });
    const tmp = join(opts.root, `.${CLAUDE_USAGE_FILE}.${process.pid}.tmp`);
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    // rename 으로 바꿔 끼운다 — 러너가 반쯤 쓴 파일을 읽지 않게.
    await rename(tmp, join(opts.root, CLAUDE_USAGE_FILE));
  }

  async function tickOnce(): Promise<void> {
    const at = now();
    const layout = await readClaudeAccountsLayout(opts.root);
    const targets = layout.pools.flatMap((p) => p.accounts.map((a) => ({ pool: p.name, ...a })));
    const present = new Set(targets.map((t) => t.dir));
    let changed = false;
    // 디스크에서 사라진 계정은 파일에서도 뺀다 — 디스크가 멤버십의 진실이다(`claudePools.ts`).
    for (const dir of [...states.keys()]) {
      if (!present.has(dir)) { states.delete(dir); changed = true; }
    }
    const dueNow = targets.filter((t) => due(states.get(t.dir), at));
    if (dueNow.length > 0) {
      await Promise.all(dueNow.map((t) => measureOne(t.pool, t.name, t.dir, at)));
      changed = true;
    }
    if (changed) await write(at);
  }

  function tick(): Promise<void> {
    // 앞 조회가 아직 돌면 겹치지 않는다(CLI 는 45초까지 걸린다).
    if (running) return running;
    running = tickOnce()
      .catch((err: unknown) => {
        opts.log?.(`claude usage poll failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => { running = null; });
    return running;
  }

  function schedule(ms: number): void {
    if (stopped) return;
    timer = setTimeout(() => { void tick().finally(() => schedule(USAGE_POLL_TICK_MS)); }, ms);
    // 이 타이머가 데몬을 살려 두면 안 된다(`run.ts` 의 `pollTimer` 와 같은 이유).
    timer.unref?.();
  }

  return {
    tick,
    forget(configDir: string): Promise<void> {
      // 돌던 조회가 끝난 **뒤에** 버린다 — 그 조회가 로그인 전에 잰 값을 다시 넣을 수 있다.
      return (running ?? Promise.resolve()).then(() => {
        states.delete(configDir);
        return tick();
      });
    },
    start() {
      if (timer || stopped) return;
      schedule(USAGE_POLL_FIRST_DELAY_MS);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** 초기화 시각은 분 단위로 비교한다 — 재는 방식(CLI 글자·API)에 따라 초 단위가 흔들릴 수 있다. */
const minute = (ms: number | null | undefined): number | null => (ms == null ? null : Math.round(ms / 60_000));

/** 창 가운데 하나라도 %가 달라졌거나 새 창이 시작됐으면 움직인 것이다. */
function moved(a: ClaudeUsageEntry, b: ClaudeUsageEntry): boolean {
  const w = (x: ClaudeUsageEntry) => [x.session, x.weekly, ...x.modelWeekly.map((m) => m.window)];
  const pa = w(a);
  const pb = w(b);
  if (pa.length !== pb.length) return true;
  return pa.some((x, i) => {
    const y = pb[i];
    return (x?.usedPercent ?? null) !== (y?.usedPercent ?? null) || minute(x?.resetsAtMs) !== minute(y?.resetsAtMs);
  });
}
