// 스레드 하나에 avcs 워크스페이스 하나를 붙여 격리한다. git worktree 가 아니라 avcs
// workspace 를 쓰는 이유는 러너의 전제 자체가 "코드 협업 기반은 avcs" 이기 때문이다 —
// git worktree 로 격리하면 그 전제와 모순된다. 이름에 **에이전트를 반드시 넣는** 이유:
// 같은 스레드에 두 에이전트가 멘션될 수 있으므로(spec §3), 스레드만으로 이름을 지으면
// 둘째 에이전트의 project 호출이 실패하거나 — 최악의 경우 — 첫째 에이전트의 디렉터리를
// 그대로 넘겨받아 격리가 조용히 사라진다.
//
// **넣는 것은 id 다**(#850, jaebin 지시: 안은 id, 부르는 이름은 언제 바꿔도 동작에 영향이
// 없어야 한다 — 디렉터리도). 초판은 handle 이었고 그것은 이름이 바뀌면 거짓말로 남는다.
// 에이전트를 가르는 일은 id 가 똑같이 한다.

import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * threadKey(`channelId/threadRootId` 형태, sessions.ts 의 SessionStore.threadKey 참고)를
 * 그대로 디렉터리 이름에 쓰지 않는 이유: 슬래시를 포함하고 길이도 일정하지 않다. sha256
 * 앞 8자로 줄이면 길이가 고정되고 충돌 확률은 무시할 만큼 낮다. 계정 id 는 UUID 라 경로에
 * 위험한 문자가 들어올 입력 자체가 없다 — `stateDir.ts` 가 같은 이유로 문자 방어를 두지 않는다.
 *
 * ## #846: **이름이 바뀌어도 같은 워크스페이스로 돌아온다**
 *
 * 에이전트 이름은 바뀐다(#843). 이름이 바뀌면 이 함수가 내놓는 이름의 가운데가 달라지므로
 * 스레드마다 **새 워크스페이스가 하나씩 더** 생기고, 그때까지 그 스레드에서 하던 일은
 * 옛 디렉터리에 남겨진다 — 커밋하지 않은 변경이 있으면 그대로 잃는다.
 *
 * 그래서 `existingNames` 에 `-<hash>` 로 끝나는 이름이 이미 있으면 **그것을 쓴다**(옛
 * `harkroom-<handle>-<hash>` 가 그렇다). `baseDir` 는 이미 에이전트별로 갈려 있으므로
 * (`stateDir.ts` 의 `workspaceBaseDir`) 그 안에서 스레드를 가르는 것은 해시 하나다.
 *
 * **이름을 뺀다고 에이전트를 빼는 것이 아니다.** 이 문자열은 `avcs workspace project <이름>`
 * 의 **avcs 워크스페이스 이름**이기도 하다(아래). 같은 저장소를 가리키는 두 에이전트가 한
 * 스레드에 불리면 에이전트를 안 넣은 이름은 **같아지고**, 그때 둘째의 project 호출이
 * 실패하거나 첫째의 워크스페이스를 넘겨받아 격리가 조용히 사라진다(이 파일 머리의 경고).
 * 그 자리를 handle 대신 **id** 가 채운다 — 가르는 일은 똑같이 하고 이름이 바뀌어도 안 늙는다.
 *
 * 옮기지 않는 이유는 `resolveAgentStateDir` 과 같다: 같은 에이전트의 다른 인스턴스가 지금
 * 그 안에서 돌고 있을 수 있고, avcs 가 그 이름으로 워크스페이스를 알고 있다 — 디렉터리만
 * 옮기면 그 둘이 갈린다.
 *
 * `existingNames` 를 인자로 받는(여기서 `readdir` 하지 않는) 이유: 이 함수는 이름 계산이고,
 * 계산에 디스크를 섞으면 테스트가 임시 디렉터리를 깔아야 한다. 안 주면 예전 그대로다.
 */
export function workspaceName(
  agentId: string, threadKey: string, existingNames?: readonly string[],
): string {
  const hash = createHash('sha256').update(threadKey).digest('hex').slice(0, 8);
  return existingNames?.find((n) => n.endsWith(`-${hash}`)) ?? `harkroom-${agentId}-${hash}`;
}

/**
 * 이 스레드의 워크스페이스 **이름**을 디스크를 보고 정한다 — 위 함수의 `existingNames` 를
 * 채우는 한 자리.
 *
 * 왜 한 자리인가: 워크스페이스 경로를 만드는 곳이 둘이다(`ensureWorkspace` 와
 * `resolveWorkspaceDir` 의 `workingDir === null` 갈래). 각자 `readdir` 하면 한쪽만 고치는
 * 사고가 나고, 그러면 같은 스레드의 멘션 턴과 인터랙티브 턴이 **서로 다른 디렉터리**에서
 * 돈다 — `resolveWorkspaceDir` 주석이 경계하는 바로 그것이다.
 *
 * 뿌리가 아직 없으면(첫 턴) 읽을 것이 없다 — 그때는 빈 목록이고 새 이름으로 만든다.
 */
export async function resolveWorkspaceName(
  baseDir: string, agentId: string, threadKey: string,
): Promise<string> {
  const existing = await readdir(baseDir).catch(() => [] as string[]);
  return workspaceName(agentId, threadKey, existing);
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
  opts: { agentId: string; threadKey: string; baseDir: string; repoDir: string },
): Promise<string> {
  const name = await resolveWorkspaceName(opts.baseDir, opts.agentId, opts.threadKey);
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
