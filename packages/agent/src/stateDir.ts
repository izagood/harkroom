import { lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * 러너 상태 디렉터리를 정한다(#167).
 *
 * **키는 계정 id 다 — URL 이 아니다.** 같은 서버는 어느 URL 로 닿아도(`localhost` vs
 * LAN IP) 같은 계정 id 를 주고, 다른 서버의 같은 handle 은 다른 id 를 준다. URL 로
 * 키를 만들면 같은 서버에 디렉터리가 둘 생겨 세션 연속성이 끊긴다.
 *
 * **이름은 뿌리 이름에 넣지 않는다**(2026-09-22, jaebin 지시: *"안은 id, 부르는 이름은
 * 언제든 바꿔도 동작에 영향이 없어야 한다 — 디렉터리도 마찬가지"*). 초판은 `<handle>-<id>`
 * 였고 handle 은 사람이 알아보라고 붙인 꼬리표였는데, 이름이 바뀌면 그 꼬리표가 **거짓말로
 * 남는다**. 사람이 찾는 길은 `nameLinkPath` 의 심링크가 따로 낸다 — 그쪽은 이름이 바뀌면
 * 다시 걸리므로 언제나 지금 이름이다.
 *
 * 이름을 빼면 좋은 것이 하나 더 있다: 아래 `existingNames` 물려받기는 **폴백**이고, 폴백은
 * 어긋날 수 있다(디렉터리를 복사해 두면 같은 id 로 끝나는 것이 둘이 된다). 새 뿌리가 처음부터
 * id 면 그 경로에는 물려받을 일이 아예 없다 — 옛 이름의 디렉터리를 쓰는 러너만 한 번 지난다.
 *
 * 문자 방어를 두지 않는 이유: `handle` 은 서버가 `HANDLE_PATTERN`
 * (`[a-zA-Z0-9_-]{2,32}`) 으로 제한하고 `id` 는 UUID 다. 경로에 위험한 문자가 들어올
 * 입력 자체가 없다. 방어를 두면 도달 불가능한 분기가 되고, 게다가 인코딩 폴백은
 * **handle 과 다른 이름의 디렉터리**를 조용히 만들어 사람이 찾을 수 없게 한다.
 * 제약이 느슨해지면 그것은 서버 쪽 변경이고 거기서 잡혀야 한다.
 *
 * #843: **에이전트 이름이 바뀔 수 있다.** 그러면 `<handle>-<id>` 의 앞쪽이 달라지므로 다음
 * 기동에 새 이름으로 빈 디렉터리가 하나 더 생기고, 세션 레코드·avcs 워크스페이스·CODEX_HOME 이
 * 통째로 남겨진다 — 이름 하나 바꿨더니 에이전트가 모든 스레드의 기억을 잃는 모양이다. 오래
 * 서버가 에이전트 이름 변경을 400 으로 막았던 이유가 이것이다.
 *
 * 그래서 **id 로 먼저 찾는다**: `existingNames` 에 `<id>` 이거나 `-<id>` 로 끝나는 디렉터리가
 * 이미 있으면 이름이 무엇이든 그것을 쓴다(`<handle>-<id>` 로 만들어진 옛 뿌리가 그렇다).
 * 없으면 새 뿌리는 `<id>` 하나다. 옛 뿌리를 **옮기지 않는** 이유는 `legacyPath` 와 같다:
 * 같은 에이전트의 다른 인스턴스가 지금 그 안에서 돌고 있을 수 있고, 기동 중의 `mv` 는 그
 * 러너의 발밑을 치운다.
 *
 * `existingNames` 를 인자로 받는(여기서 `readdir` 하지 않는) 이유: 이 함수는 경로 계산이고,
 * 계산에 디스크를 섞으면 테스트가 임시 디렉터리를 깔아야 한다. 주지 않으면 예전 그대로다.
 *
 * `legacyPath` 는 서버별로 갈리기 **전** 경로다(handle 만으로 스코프). 호출자가
 * 존재를 확인해 운영자에게 안내한다 — 자동으로 옮기지 않는다.
 *
 * #174: 같은 에이전트를 여러 인스턴스로 동시에 돌리기 위해 인스턴스 축을 하나 더한다.
 * `instance` 가 없으면 기존 경로가 그대로(하위 호환) — 지금 돌고 있는 러너가 재시작에
 * 상태를 잃으면 안 된다. 있으면 마지막 세그먼트로 붙인다.
 *
 * **상태 경로를 여기서 전부 조립해 돌려주는 것이 이 함수의 요점이다(#174).** 호출자가
 * 뿌리만 받아 각자 이어 붙이면 하나를 옛 뿌리에 두는 실수가 조용히 지나간다 — 두
 * 인스턴스가 그 파일 하나를 밟으면 격리는 없는 것과 같다(세션 레코드를 공유하면 인스턴스
 * B 가 A 의 세션 id 를 자기 워크스페이스에서 resume 하려 든다). 그래서 세션 파일·MCP
 * 설정·avcs 워크스페이스가 **한 자리에서** 같은 뿌리로 만들어진다.
 *
 * 인스턴스가 같은 스레드에 동시에 답하면 at-least-once 성질로 중복 답장이 가능하다
 * (이것은 설계된 선택이고 고치지 않는다 — prompt.ts::hasOwnPostSince 주석 참고).
 */
export interface AgentStatePaths {
  /**
   * 이 러너(handle × 서버 × 인스턴스)의 상태 뿌리. 지시문 파일(#92)이 여기 바로 아래 산다 —
   * 에이전트 워크스페이스가 아니라 러너의 상태 디렉터리다.
   */
  agentStateDir: string;
  /** 스레드별 세션 레코드(`sessions.json`). */
  sessionsPath: string;
  /** 기동 시 한 번 구워 두는 MCP 설정이 사는 디렉터리. */
  mcpDir: string;
  /** avcs 워크스페이스들의 상위 디렉터리. 세션 파일과 생애주기를 같이 한다. */
  workspaceBaseDir: string;
  /** 개인 Codex 설정과 분리한 이 러너 전용 CODEX_HOME. */
  codexHomeDir: string;
  /** opencode 의 러너 전용 XDG 루트(config·data·state 세 디렉터리가 그 아래 선다). */
  opencodeHomeDir: string;
  /** 서버별로 갈리기 **전** 경로(handle 만으로 스코프). 존재 확인용이고 자동 이전은 하지 않는다. */
  legacyPath: string;
}

export function resolveAgentStateDir(
  baseDir: string,
  handle: string,
  id: string,
  instance?: string,
  existingNames?: readonly string[],
): AgentStatePaths {
  // 같은 id 를 가리키는 이름이 여럿일 수는 없다 — id 가 UUID 라 한 에이전트당 한 자리다.
  // 그래도 `find` 로 첫 것을 쓰는 편이 안전하다(수동으로 만든 디렉터리까지 막지 않는다).
  // `n === id` 가 지금 모양이고 `-${id}` 로 끝나는 쪽이 옛 `<handle>-<id>` 다.
  const adopted = existingNames?.find((n) => n === id || n.endsWith(`-${id}`));
  const handleId = adopted ?? id;
  const agentStateDir = instance
    ? join(baseDir, handleId, instance)
    : join(baseDir, handleId);
  return {
    agentStateDir,
    sessionsPath: join(agentStateDir, 'sessions.json'),
    mcpDir: join(agentStateDir, 'mcp'),
    workspaceBaseDir: join(agentStateDir, 'workspaces'),
    codexHomeDir: join(agentStateDir, 'codex-home'),
    opencodeHomeDir: join(agentStateDir, 'opencode-home'),
    legacyPath: join(baseDir, handle),
  };
}

/** 사람이 찾아 들어가는 이름 심링크들이 사는 곳. `by-name/<handle> -> ../<뿌리>`. */
export const NAME_LINK_DIR = 'by-name';

/**
 * 이름으로 찾아 들어가는 심링크의 경로(#850).
 *
 * 뿌리 이름에서 handle 을 뺐으므로(`resolveAgentStateDir`) `~/.harkroom-agent/` 는 uuid 밭이
 * 된다. 사람이 *"murmur 의 상태가 어디냐"* 를 답할 수 있어야 하므로 이름 → 뿌리 링크를 따로 낸다.
 *
 * **`baseDir/<handle>` 에 걸지 않는다.** 거기는 `legacyPath` 다 — 서버별로 갈리기 전(#167)의
 * 진짜 디렉터리가 있을 수 있는 자리이고, 기동할 때마다 존재를 확인해 운영자에게 *"옮겨라"* 고
 * 안내한다. 그 자리에 내가 심링크를 걸면 **내가 만든 것을 보고 옮기라고 말하는** 러너가 된다.
 * 한 단 내려 `by-name/` 에 모으면 그 충돌이 없고, 디렉터리 이름 자체가 무엇인지 말한다.
 */
export function nameLinkPath(baseDir: string, handle: string): string {
  return join(baseDir, NAME_LINK_DIR, handle);
}

/**
 * 이름 심링크를 **지금 이름으로** 맞춘다(#850). 기동 때 한 번 부른다.
 *
 * 이름이 바뀌면 옛 이름의 링크가 남는다. 그것을 그대로 두면 `by-name/` 이 *"한 에이전트를
 * 가리키는 이름이 둘"* 이라고 말하게 되고, 그 둘 중 무엇이 지금 이름인지는 아무 데도 안 적혀
 * 있다 — 편의로 낸 것이 오히려 사람을 헷갈리게 한다. 그래서 **같은 뿌리를 가리키는 다른
 * 이름의 링크는 걷어낸다.**
 *
 * **심링크만 건드린다.** 그 자리에 진짜 디렉터리나 파일이 있으면 손대지 않는다 — 사람이
 * 둔 것일 수 있고, 편의 기능이 남의 파일을 지우는 것은 어떤 편의로도 못 갚는다.
 *
 * 실패를 삼킨다. 심링크를 못 만드는 파일시스템·권한이 있고, **이 링크가 없어도 러너는
 * 똑같이 돈다** — 없는 편의 때문에 에이전트를 세우지 않는다.
 */
export async function ensureNameLink(
  baseDir: string, handle: string, rootName: string,
): Promise<void> {
  try {
    const dir = join(baseDir, NAME_LINK_DIR);
    await mkdir(dir, { recursive: true });

    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name === handle) continue;
      const target = await readlink(join(dir, name)).catch(() => null);
      // `basename` 으로 견주는 이유: 링크는 `../<뿌리>` 라 문자열이 뿌리 이름과 다르다.
      if (target !== null && basename(target) === rootName) {
        await rm(join(dir, name), { force: true }).catch(() => { /* 남아도 해롭지 않다 */ });
      }
    }

    const link = join(dir, handle);
    const existing = await lstat(link).catch(() => null);
    if (existing && !existing.isSymbolicLink()) return;
    if (existing) await rm(link, { force: true });
    await symlink(join('..', rootName), link);
  } catch {
    // 위 주석: 없어도 러너는 돈다.
  }
}
