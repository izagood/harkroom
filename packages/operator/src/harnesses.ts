/**
 * 하네스 능력 — 스펙 2026-09-20 §3(능력). 오퍼레이터는 "이 머신에 어떤 하네스가 있고 로그인돼
 * 있나"를 hello 의 `capabilities.harnesses` 로 서버에 올린다. 서버는 배정 때 그 하네스가 없으면
 * 거절하고(`assignmentRoutes` 409 harness_missing), 화면은 오퍼레이터 옆에 보인다 — 옛 러너의
 * "살아 있는데 claude 를 못 찾아 답을 못 하는" 조용한 실패를 배정 시점으로 당기는 장치다.
 *
 * 판정의 재료는 둘뿐이고 전부 파일 존재다: 실행 파일이 로그인 셸 PATH 의 어느 디렉터리에
 * 있는가(installed), 자격증명 파일이 있는가(loggedIn). 로그인이 **유효**한지는 여기서 모른다 —
 * 그것은 턴을 돌려 봐야 아는 사실이고, 오퍼레이터는 없는 것을 있다고 하지 않는 쪽으로만 잰다.
 */
import { join } from 'node:path';
import type { OperatorCapabilities, AgentHarness } from '@harkroom/shared';

/** 러너가 실제로 부르는 실행 파일 이름(`turn.ts::PRESETS.command`). */
export const HARNESS_BINARIES: Record<Extract<AgentHarness, 'claude-code' | 'codex' | 'opencode'>, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

/**
 * PATH 에 없어도 **거기 있으면 설치된 것**인 자리(2026-09-22).
 *
 * opencode 의 공식 설치본은 `~/.opencode/bin` 에 들어가고 **그 디렉터리를 PATH 에 넣는 것은
 * 사람 몫**이다. 로그인 셸 PATH 만 보면 멀쩡히 설치된 머신이 `installed:false` 로 잡히고,
 * 서버는 그 하네스로의 배정을 409 로 거절한다 — 사람은 "설치했는데 왜 안 되지"만 본다.
 *
 * 그래서 **설치 관례로 아는 자리**를 함께 본다. 이것은 PATH 를 대신하지 않는다: 러너가
 * 실행할 때는 여전히 PATH 가 필요하므로, 여기서 발견해도 `path` 로 잡히지 않았다면
 * `viaKnownDir` 로 표시해 화면이 그 사실을 말할 수 있게 한다.
 */
const KNOWN_INSTALL_DIRS: Partial<Record<keyof typeof HARNESS_BINARIES, (home: string) => string>> = {
  opencode: (home) => join(home, '.opencode', 'bin'),
};

export interface DetectDeps {
  /** 로그인 셸의 PATH(`loginPath.ts`). null 이면 아무것도 installed 가 아니다. */
  path: string | null;
  env: NodeJS.ProcessEnv;
  home: string;
  exists(path: string): Promise<boolean>;
}

/** 러너와 같은 규칙으로 자격증명 파일 자리를 정한다(`claudeAccounts.ts`·`codexHome.ts`). */
function credentialFile(harness: keyof typeof HARNESS_BINARIES, env: NodeJS.ProcessEnv, home: string): string {
  switch (harness) {
    case 'claude-code':
      return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.credentials.json');
    case 'codex':
      return join(env.CODEX_HOME || join(home, '.codex'), 'auth.json');
    // opencode 는 XDG 를 따른다 — 자리가 한 단계 깊다(`<data>/opencode/auth.json`).
    case 'opencode':
      return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode', 'auth.json');
  }
}

export async function detectHarnesses(deps: DetectDeps): Promise<OperatorCapabilities['harnesses']> {
  const dirs = deps.path ? deps.path.split(':').filter(Boolean) : [];
  const out: OperatorCapabilities['harnesses'] = {};
  for (const [harness, bin] of Object.entries(HARNESS_BINARIES) as [keyof typeof HARNESS_BINARIES, string][]) {
    let installed = false;
    for (const dir of dirs) {
      if (await deps.exists(join(dir, bin))) { installed = true; break; }
    }
    // PATH 에 없으면 설치 관례 자리를 한 번 더 본다(위 `KNOWN_INSTALL_DIRS` 주석).
    if (!installed) {
      const known = KNOWN_INSTALL_DIRS[harness]?.(deps.home);
      if (known && await deps.exists(join(known, bin))) installed = true;
    }
    const loggedIn = await deps.exists(credentialFile(harness, deps.env, deps.home));
    out[harness] = { installed, loggedIn };
  }
  return out;
}
