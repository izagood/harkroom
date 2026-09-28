// claude 계정별 **사용량 관측**. 트랜스크립트(`<configDir>/projects/**/*.jsonl`)를 읽어
// 5시간 창의 토큰과 한도 사건을 센다.
//
// ## 왜 파일을 읽는가 — 물어볼 곳이 없다
//
// 사용량을 알려 주는 표면이 claude 쪽에 **없다**(실측 2.1.263):
// `claude auth status --json` 은 `loggedIn`·`authMethod`·`email`·`orgId`·`orgName`·
// `subscriptionType` 만 주고 `usage` 서브커맨드도 없다. 러너가 한도에 걸린 순간에는
// `policy.ts::isQuotaExhausted` 가 `resetsAt` 을 보지만 그것은 **실패한 그 순간에만**
// 있고 그대로 버려진다 — 그래서 사람은 "지금 어느 계정이 얼마나 남았나"를 알 수 없었다.
//
// 그런데 claude 자신이 그것을 디스크에 적는다: assistant 레코드마다 `message.usage` 가
// 있고, 한도에 걸린 순간에는 최상위 `quotaLimits`(`status`·`resetsAt`·`rateLimitType`)가
// 붙은 합성 레코드가 남는다. 관측이 이미 있으니 새로 만들 필요가 없다.
//
// ## 왜 데몬인가
//
// 계정 디렉터리의 주인이 데몬이다(`claudeAccounts.ts` 머리 주석). 웹뷰에는 로컬 파일을
// 읽을 표면이 **의도적으로** 없고 이 기능은 그 문을 열지 않는다 — 웹뷰는 이름 하나도
// 넘기지 않고 "사용량을 다오"만 말한다. 서버도 거치지 않는다: 이 사실은 이 기계의
// 로컬 사실이고, 서버로 올리면 남의 계정 사용량이 채널에 실리는 다른 결정이 된다.
//
// ## 여기서 판단하지 않는 것
//
// **퍼센트를 내지 않는다.** 분모를 아무 데서도 알 수 없다(프로토콜의
// `ClaudeAccountUsage` 주석). 관측된 토큰과 claude 자신이 말한 한도 사건만 옮긴다.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ClaudeAccountLimitHit,
  ClaudeAccountUsage,
  ClaudeUsageSnapshot,
} from '@harkroom/shared/daemonProtocol';

/** 창 길이. claude 의 `rateLimitType: 'five_hour'` 와 같은 5시간이다(실측). */
export const USAGE_WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * 한 파일에서 읽는 최대 바이트. 트랜스크립트는 계정당 수십 MB 까지 자란다(실측:
 * `work/lime/projects` 61MB). 창 안의 파일만 열어도 하나가 아주 클 수 있으므로
 * 상한을 둔다 — 넘치면 **뒤쪽**(최신)을 읽는다. 앞을 버리는 쪽이 맞다: 창 안의 최신
 * 레코드가 우리가 세려는 것이다.
 */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** 이 계정의 트랜스크립트 파일 하나. */
interface TranscriptFile {
  path: string;
  mtimeMs: number;
}

/** 창 안에서 센 assistant 응답 하나. */
interface UsageEntry {
  atMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** `<dir>/projects/<슬러그>/<세션>.jsonl` 을 전부 모은다. **읽지 않고 stat 만 한다.** */
async function transcriptFiles(accountDir: string): Promise<TranscriptFile[]> {
  const projects = join(accountDir, 'projects');
  let slugs;
  try {
    slugs = await readdir(projects, { withFileTypes: true });
  } catch {
    return []; // 없다 = 이 계정으로 돈 적이 없다. 정상 경로다.
  }
  const out: TranscriptFile[] = [];
  for (const slug of slugs) {
    const dir = join(projects, slug.name);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.name.endsWith('.jsonl')) continue;
      const path = join(dir, e.name);
      const st = await stat(path).catch(() => null);
      if (!st?.isFile()) continue;
      out.push({ path, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/**
 * 파일의 꼬리 `MAX_FILE_BYTES` 를 텍스트로 읽는다. 잘린 첫 줄은 버려진다(파싱이 실패해
 * 조용히 건너뛴다) — 한 레코드를 잃는 것이 32MB 를 다 메모리에 올리는 것보다 낫다.
 */
async function readTail(path: string, size: number): Promise<string> {
  const buf = await readFile(path);
  return size > MAX_FILE_BYTES ? buf.subarray(buf.length - MAX_FILE_BYTES).toString('utf8') : buf.toString('utf8');
}

/**
 * 계정 하나를 센다.
 *
 * ## `message.id` 로 중복을 제거하는 이유
 *
 * 세션을 이어받거나(`--resume`) 갈라내면 claude 가 **이전 레코드를 새 파일에 그대로
 * 복사한다**(실측). 파일 단위로 더하면 같은 응답이 두 번, 세 번 세어진다. `message.id`
 * 는 그 복사본에서도 같으므로 그것으로 한 번만 센다.
 *
 * ## `<synthetic>` 을 빼는 이유
 *
 * 한도 거부·중단 같은 것은 claude 가 `model: '<synthetic>'` 인 가짜 assistant 레코드로
 * 남긴다. API 호출이 아니므로 응답 수에 넣지 않는다(토큰은 어차피 0 이다).
 */
async function measureAccount(
  pool: string,
  account: string,
  accountDir: string,
  nowMs: number,
): Promise<ClaudeAccountUsage> {
  const files = await transcriptFiles(accountDir);
  const lastUsedAtMs = files.length ? Math.max(...files.map((f) => f.mtimeMs)) : null;

  // **창 밖의 파일은 열지 않는다.** 이것이 이 스캔을 쓸 만하게 만드는 유일한 수단이다
  // (계정당 파일 100여 개 중 창 안은 수십 개다). 레코드의 시각은 파일 mtime 보다 이르므로
  // mtime 이 창 밖이면 그 파일에 창 안의 레코드가 없다.
  const rollingStart = nowMs - USAGE_WINDOW_MS;
  const candidates = files.filter((f) => f.mtimeMs >= rollingStart);

  const entries: UsageEntry[] = [];
  const seen = new Set<string>();
  let limitHit: ClaudeAccountLimitHit | null = null;
  let unreadableFiles = 0;

  for (const f of candidates) {
    let text: string;
    try {
      const st = await stat(f.path);
      text = await readTail(f.path, st.size);
    } catch {
      // **못 읽은 것을 0 으로 세지 않는다.** 개수를 세어 올려 보내면 화면이 "이 숫자는
      // 적게 세어졌다"를 말할 수 있다.
      unreadableFiles += 1;
      continue;
    }
    for (const line of text.split('\n')) {
      // 값싼 선별. 줄 대부분은 사용자 발화·도구 결과이고 파싱할 이유가 없다.
      if (!line.includes('"usage"') && !line.includes('"quotaLimits"')) continue;
      let rec: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null) continue;
        rec = parsed as Record<string, unknown>;
      } catch {
        continue; // 쓰다 만 마지막 줄·잘린 첫 줄. 정상 경로다.
      }
      const atMs = Date.parse(String(rec.timestamp ?? ''));
      if (!Number.isFinite(atMs)) continue;

      // 한도 사건. **`quotaLimits` 가 최상위 객체일 때만** 본다 — 그 낱말은 사람이 쓴
      // 본문에도 나타난다(이 기능을 설계한 스레드가 그랬다).
      const quota = rec.quotaLimits;
      if (typeof quota === 'object' && quota !== null) {
        const q = quota as Record<string, unknown>;
        if (q.status === 'rejected' && (limitHit === null || atMs > limitHit.atMs)) {
          // `resetsAt` 은 **초**다(실측: 1788852600). ms 로 바꿔 나른다.
          const resets = typeof q.resetsAt === 'number' && Number.isFinite(q.resetsAt)
            ? q.resetsAt * 1000
            : null;
          limitHit = {
            atMs,
            resetsAtMs: resets,
            rateLimitType: typeof q.rateLimitType === 'string' ? q.rateLimitType : null,
          };
        }
      }

      if (rec.type !== 'assistant') continue;
      const msg = rec.message;
      if (typeof msg !== 'object' || msg === null) continue;
      const m = msg as Record<string, unknown>;
      if (m.model === '<synthetic>') continue;
      const usage = m.usage;
      if (typeof usage !== 'object' || usage === null) continue;
      const id = typeof m.id === 'string' ? m.id : `${f.path}:${String(rec.uuid ?? atMs)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const u = usage as Record<string, unknown>;
      entries.push({
        atMs,
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheCreation: num(u.cache_creation_input_tokens),
      });
    }
  }

  // **창의 시작을 소진 상태에서는 claude 에게서 받는다.** `resetsAt` 이 미래면 그것이
  // 지금 창의 끝이므로 창은 `[resetsAt - 5h, resetsAt]` 이다. 그 계정에 롤링 5시간을
  // 쓰면 **이전 창**의 토큰이 섞여 "지금 이만큼 썼다"가 부풀려진다.
  const resets = limitHit?.resetsAtMs ?? null;
  const windowStartMs = resets !== null && resets > nowMs ? resets - USAGE_WINDOW_MS : rollingStart;

  const inWindow = entries.filter((e) => e.atMs >= windowStartMs);
  return {
    pool,
    account,
    windowStartMs,
    tokens: {
      input: inWindow.reduce((a, e) => a + e.input, 0),
      output: inWindow.reduce((a, e) => a + e.output, 0),
      cacheRead: inWindow.reduce((a, e) => a + e.cacheRead, 0),
      cacheCreation: inWindow.reduce((a, e) => a + e.cacheCreation, 0),
    },
    responses: inWindow.length,
    lastUsedAtMs,
    limitHit,
    unreadableFiles,
  };
}

/** 어느 계정들을 셀 것인가. 열거는 `claudeAccounts.ts` 가 한 벌로 갖고 있다. */
export interface UsageTarget {
  pool: string;
  account: string;
  dir: string;
}

/**
 * 계정들을 **차례로** 센다. 병렬로 하지 않는 이유: 이 일은 디스크가 병목이고, 수십 MB
 * 짜리 트랜스크립트 셋을 동시에 열면 그 바이트가 동시에 메모리에 올라간다. 계정 셋을
 * 순서대로 세는 편이 데몬을 조용하게 둔다.
 */
export async function measureClaudeUsage(
  targets: UsageTarget[],
  nowMs: number,
): Promise<ClaudeUsageSnapshot> {
  const accounts: ClaudeAccountUsage[] = [];
  for (const t of targets) {
    accounts.push(await measureAccount(t.pool, t.account, t.dir, nowMs));
  }
  return { measuredAtMs: nowMs, windowMs: USAGE_WINDOW_MS, accounts };
}
