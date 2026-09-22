// opencode 도 세션 id 를 **사전에 지정할 수 없다**(`session` 에 `create` 가 없다). 그래서
// codex 와 같은 갈래다 — 첫 턴을 id 없이 돌리고 **끝난 뒤 발견한다**.
//
// 다만 재료가 다르다. codex 는 파일(rollout jsonl)이라 디렉터리를 훑었지만, opencode 의
// 세션은 **SQLite**(`<data>/opencode.db`) 안에 있다. 그 파일을 우리가 열지 않는 이유:
// 스키마는 그쪽 내부 사정이고, 판본이 바뀌면 조용히 틀린 답을 낸다. 대신 opencode 가
// **물어볼 표면을 준다**:
//
//     opencode session list --format json
//     [{ "id": "ses_…", "title": "…", "created": 1789…, "updated": 1789…,
//        "directory": "/private/var/…/workspace" }]
//
// **이 목록은 프로젝트 단위다**(실측 2026-09-22, 1.18.32). opencode 는 cwd 의 git 루트를
// 프로젝트로 잡고 그 프로젝트의 세션만 내놓는다 — git 밖이면 `projectId: "global"` 이다.
// 그래서 목록을 **턴을 돌린 그 cwd 에서** 물어야 한다. 다른 자리에서 물으면 빈 배열이
// 돌아오고, 그것은 "세션이 없다"와 구별되지 않는다(발견이 늘 조용히 실패한다).
//
// 실측(2026-09-19, 1.18.31): `directory` 가 그 턴을 돌린 cwd 다. 그래서 **워크스페이스
// 경로로 맞추고 시각으로 거른다** — codex 쪽 `findCodexSessionId` 와 같은 판단이다.
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 파일 시각의 반올림·클럭 오차를 감안한 여유. `codexSessions.ts` 와 같은 값이다. */
const TIME_TOLERANCE_MS = 2000;

interface SessionRow { id: string; created?: number; updated?: number; directory?: string }

/**
 * 방금 끝난 턴이 만든 세션 id. 못 찾으면 `null` — 그때는 다음 턴이 새 세션으로 시작한다
 * (잃는 것은 하네스 내부 컨텍스트뿐이고 스레드의 사실은 프롬프트가 다시 싣는다).
 *
 * **경로는 realpath 로 맞춘다.** macOS 의 `/var` → `/private/var` 처럼 같은 자리를 다른
 * 문자열로 부르는 경우가 있고, 그 어긋남은 "왜 늘 새 세션이지"로만 드러난다(실측으로
 * 신뢰 장부에서 한 번 데인 자리와 같은 함정이다).
 */
export async function findOpencodeSessionId(
  opts: { command: string; env: Record<string, string>; cwd: string; sinceMs: number },
): Promise<string | null> {
  let out: string;
  try {
    const res = await run(opts.command, ['session', 'list', '--format', 'json', '-n', '50'], {
      env: opts.env,
      // 목록이 프로젝트 단위라서 **어디서 묻느냐가 답을 바꾼다**(위 머리말). 러너의 cwd 가
      // 무엇이든 턴의 워크스페이스에서 묻는다.
      cwd: opts.cwd,
      // 목록이 프로젝트 단위라서 **어디서 묻느냐가 답을 바꾼다**(위 머리말). 러너의 cwd 가
      // 무엇이든 턴의 워크스페이스에서 묻는다.
      // 이 명령은 turn 이 끝난 뒤 한 번 도는 조회다. 오래 걸리면 발견을 포기하는 편이
      // 낫다 — 다음 턴이 새 세션으로 시작할 뿐이다.
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    out = res.stdout;
  } catch {
    return null;
  }

  let rows: SessionRow[];
  try {
    const parsed: unknown = JSON.parse(out);
    if (!Array.isArray(parsed)) return null;
    rows = parsed as SessionRow[];
  } catch {
    return null;
  }

  const want = await realpath(opts.cwd).catch(() => resolve(opts.cwd));
  let best: { id: string; at: number } | null = null;
  for (const row of rows) {
    if (typeof row?.id !== 'string' || typeof row.directory !== 'string') continue;
    const dir = await realpath(row.directory).catch(() => resolve(row.directory!));
    if (dir !== want) continue;
    const at = typeof row.created === 'number' ? row.created : (row.updated ?? 0);
    if (at + TIME_TOLERANCE_MS < opts.sinceMs) continue;
    if (best === null || at > best.at) best = { id: row.id, at };
  }
  return best?.id ?? null;
}
