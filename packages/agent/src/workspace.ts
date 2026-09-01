// 스레드 하나에 avcs 워크스페이스 하나를 붙여 격리한다. git worktree 가 아니라 avcs
// workspace 를 쓰는 이유는 러너의 전제 자체가 "코드 협업 기반은 avcs" 이기 때문이다 —
// git worktree 로 격리하면 그 전제와 모순된다. 이름에 handle 을 반드시 넣는 이유:
// 같은 스레드에 두 에이전트가 멘션될 수 있으므로(spec §3), 스레드만으로 이름을 지으면
// 둘째 에이전트의 project 호출이 실패하거나 — 최악의 경우 — 첫째 에이전트의 디렉터리를
// 그대로 넘겨받아 격리가 조용히 사라진다.

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * threadKey(`channelId/threadRootId` 형태, sessions.ts 의 SessionStore.threadKey 참고)를
 * 그대로 디렉터리 이름에 쓰지 않는 이유: 슬래시를 포함하고 길이도 일정하지 않다. sha256
 * 앞 8자로 줄이면 길이가 고정되고 충돌 확률은 무시할 만큼 낮다. handle 은 HANDLE_PATTERN
 * (`[a-zA-Z0-9_-]{2,32}`, @murmur/shared)으로 이미 디렉터리 이름에 안전한 문자만 허용되므로
 * 별도로 다듬지 않는다.
 */
export function workspaceName(handle: string, threadKey: string): string {
  const hash = createHash('sha256').update(threadKey).digest('hex').slice(0, 8);
  return `murmur-${handle}-${hash}`;
}

/**
 * 스레드×에이전트 전용 avcs 워크스페이스를 확보한다. 반환값은 언제나 사용 가능한 작업
 * 디렉터리다:
 * - 이미 만들어져 있으면(이전 턴이 만든 것) exec 를 부르지 않고 그 경로를 바로 돌려준다 —
 *   매 턴 project 를 다시 실행하면 avcs 가 매번 병합을 시도해 느려지고, 실패하면 세션
 *   연속성이 깨진다.
 * - repoDir 이 avcs repo 가 아니면(`avcs workspace --help` 가 실제로 뱉는 문구의 부분 문자열인
 *   "not an AVCS repo") 격리를 포기하고 repoDir 자체를 돌려준다 — 채팅 전용 에이전트나 avcs
 *   로 관리하지 않는 저장소를 가리키는 에이전트까지 이 이유로 멈출 필요는 없다(spec §8).
 *   이 폴백은 "이 저장소는 avcs 가 아니다"에만 걸어야 한다 — 그 외 실패는 원인을 숨기지
 *   않고 stderr 를 담아 던진다.
 */
export async function ensureWorkspace(
  exec: Exec,
  opts: { handle: string; threadKey: string; baseDir: string; repoDir: string },
): Promise<string> {
  const name = workspaceName(opts.handle, opts.threadKey);
  const dir = join(opts.baseDir, name);

  // access() 는 존재 여부만 보고 파일과 디렉터리를 구분하지 않는다 — 그 경로에 일반 파일이
  // 있으면(비정상 종료가 남긴 빈 파일 등) 디렉터리로 착각해 그대로 돌려주고, 그 값이 이후
  // PTY spawn 의 cwd 로 쓰인다(main.ts). ENOTDIR 로 죽거나 더 나쁘게는 엉뚱한 곳에서 돈다 —
  // stat 으로 실제 타입을 확인한다.
  let existing: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    existing = await stat(dir);
  } catch {
    existing = null;
  }
  if (existing) {
    if (!existing.isDirectory()) {
      // 이건 폴백 대상이 아니다 — avcs 가 아니라서 못 만든 게 아니라, 사람(또는 다른
      // 프로세스)이 이 경로에 뭔가를 잘못 남겨 둔 상태다. 조용히 넘어가면 다음에 그 자리에
      // cwd 로 들어가는 PTY 가 알 수 없는 이유로 죽는다 — 원인을 여기서 바로 알려준다.
      throw new Error(`${dir} 에 디렉터리가 아닌 파일이 있다 — 사람이 정리해야 한다`);
    }
    return dir;
  }

  const result = await exec('avcs', ['workspace', 'project', name, '--out', dir], { cwd: opts.repoDir });
  if (result.code === 0) return dir;

  if (result.stderr.includes('not an AVCS repo')) {
    console.warn(`[workspace] ${opts.repoDir} 는 avcs repo 가 아니다 — 격리 없이 repoDir 로 폴백한다`);
    return opts.repoDir;
  }

  throw new Error(`avcs workspace project 실패: ${result.stderr}`);
}
