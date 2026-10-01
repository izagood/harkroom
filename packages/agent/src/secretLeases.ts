/**
 * 턴 임대(비밀 보관소 PR 3) — 러너 쪽. 멘션 하나에 임대 하나를 받아 오퍼레이터에 맡기고, 그 멘션의
 * 일이 끝나면 기록을 가린 뒤 놓는다. 계획·보안 검토: harkroom 스레드 bc98df3a.
 *
 * - **멘션마다 한 번만 받는다**(R1). 계정 전환(`withAccountFailover`)·재시도(`attempts`)로 같은 멘션의 턴이
 *   다시 돌아도 이 프로세스가 받은 임대를 그대로 쓴다 — 오퍼레이터가 들고 있다. 서버도 멘션당 평생 하나만
 *   준다(086, S1).
 * - **재기동한 러너는 비밀 없이 돈다**(R1 fail-closed). 이 장부는 메모리에만 있고, 다시 받으려 하면 서버가
 *   409 `lease_used` 로 거절한다. 실패는 턴을 막지 않는다 — 비밀이 없을 뿐이다.
 * - **토큰은 relay 통지로만 나간다**(R2). 하네스 env·argv·프롬프트·로그 어디에도 싣지 않는다. 이 장부에도
 *   임대 id 만 남긴다.
 * - **놓기 전에 가린다**(D7). 그 멘션의 턴들이 남긴 하네스 기록(`noteTranscript`)에서 마운트한 값을 `***` 로
 *   바꾼다. 값은 오퍼레이터가 쓴 턴 디렉터리(`<turnSecretsDir>/<leaseId>/`)에서 읽는다 — 값이 새 통로로
 *   흐르지 않는다. 가린 **뒤에** 끝 통지를 보낸다(오퍼레이터가 그 디렉터리를 지운다).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scrubNeedles, scrubPath } from './secretScrub.js';

export interface TurnLease { id: string; token: string; expiresAt: string }

export interface SecretLeaseDeps {
  /** `POST /agent/turn-leases`. 거절·실패면 null — 이유는 로그 한 줄로 충분하다(토큰은 찍지 않는다). */
  issue(causeMessageId: string): Promise<TurnLease | null>;
  notifyLease(cause: string, lease: TurnLease): void;
  notifyEnded(cause: string): void;
  /** 오퍼레이터의 턴 비밀 루트(`HARKROOM_TURN_SECRETS_DIR`). 없으면 가리지 않는다(옛 오퍼레이터). */
  turnSecretsDir?: string | null;
  log?(line: string): void;
}

export interface SecretLeases {
  acquire(causeMessageId: string): Promise<void>;
  /** 그 멘션의 하네스 기록(파일 또는 디렉터리 — 디렉터리면 그 아래 일반 파일 전부). 같은 멘션의 재시도가 여럿 남길 수 있다. */
  noteTranscript(causeMessageId: string, path: string): void;
  /** 가리고 놓는다. 던지지 않는다 — 가리기가 실패해도 임대는 놓는다(값을 오래 붙들지 않는다). */
  release(causeMessageId: string): Promise<void>;
  /**
   * 그 멘션에 마운트된 값의 바늘(긴 것부터). 실패 통지에 싣는 PTY 꼬리를 가릴 때 쓴다(`harnessTailNotice`).
   * 임대가 없거나 마운트가 없으면 빈 목록이다. 결과를 오래 들고 있지 마라.
   */
  needles(causeMessageId: string): Promise<string[]>;
  /** 종료 경로: 진행 중인 놓기(가리기)를 최대 `ms` 기다린다. 넘으면 그냥 돌아온다 — 종료를 막지 않는다. */
  drain(ms: number): Promise<void>;
}

interface Held { leaseId: string | null; transcripts: Set<string> }

export function createSecretLeases(deps: SecretLeaseDeps): SecretLeases {
  /** 멘션 id → 받은 임대(id 만). 거절된 것도 적는다(leaseId null) — 재시도마다 다시 묻지 않는다(어차피 409 다). */
  const held = new Map<string, Held>();
  const log = deps.log ?? ((line: string) => console.error(line));

  /** 턴 디렉터리의 값으로 바늘을 만든다(긴 것부터). 값 자체는 이 함수 밖으로 나가지 않는다. */
  const needlesOf = async (leaseId: string | null): Promise<string[]> => {
    if (!deps.turnSecretsDir || !leaseId) return [];
    const dir = join(deps.turnSecretsDir, leaseId);
    const names = await readdir(dir).catch(() => [] as string[]);
    const needles = new Set<string>();
    for (const n of names) {
      const value = await readFile(join(dir, n)).catch(() => null);
      if (value) for (const x of scrubNeedles(value)) needles.add(x);
    }
    return [...needles].sort((a, b) => b.length - a.length);
  };
  const inFlight = new Set<Promise<void>>();

  const scrub = async (h: Held): Promise<void> => {
    if (!h.transcripts.size) return;
    const sorted = await needlesOf(h.leaseId);
    if (!sorted.length) return;
    const onSkip = (path: string) => log(`[secretLeases] ${path}: 64MB 를 넘어 가리지 않았다`);
    for (const path of h.transcripts) {
      const n = await scrubPath(path, sorted, onSkip).catch((e: unknown) => {
        log(`[secretLeases] 기록 가리기 실패(${path}) — ${e instanceof Error ? e.message : String(e)}`);
        return 0;
      });
      // 값도 바늘 수도 찍지 않는다 — 몇 군데를 가렸는지만.
      if (n) log(`[secretLeases] ${path}: 비밀 값 ${n}곳을 가렸다`);
    }
  };

  return {
    async acquire(cause) {
      if (held.has(cause)) return;
      const h: Held = { leaseId: null, transcripts: new Set() };
      held.set(cause, h);
      const lease = await deps.issue(cause).catch(() => null);
      if (!lease) return;
      h.leaseId = lease.id;
      deps.notifyLease(cause, lease);
    },
    noteTranscript(cause, path) {
      held.get(cause)?.transcripts.add(path);
    },
    async release(cause) {
      const h = held.get(cause);
      held.delete(cause);
      if (!h?.leaseId) return;
      const work = (async () => {
        await scrub(h).catch(() => {});
        deps.notifyEnded(cause);
      })();
      inFlight.add(work);
      try { await work; } finally { inFlight.delete(work); }
    },
    async needles(cause) {
      return needlesOf(held.get(cause)?.leaseId ?? null).catch(() => []);
    },
    async drain(ms) {
      if (!inFlight.size) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise<void>((r) => { timer = setTimeout(r, ms); }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}
