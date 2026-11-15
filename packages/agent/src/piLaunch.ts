// pi 를 **런처를 거치지 않고** 띄우는 실행 파일 해석(p2b, security 감②).
//
// pi 설치기가 까는 `<agent>/bin/pi` 는 sh 런처다: `<agent>/install/current-version` 을 읽어
// `<agent>/install/releases/<판>/node_modules/.bin/pi` 를 exec 하는데, 그 앞에
// `PI_MANAGED_INSTALL_ROOT=<agent>/install` 을 export 한다. 그 이름을 받은 pi 는 사람의 설치 폴더(`install/`)를
// 제 관리 자리로 알고 손댄다. 러너가 띄우는 pi 는 사람 설치를 건드릴 까닭이 없다 — 런처가 하는 일 중
// **판 고르기와 node PATH 만** 여기서 똑같이 하고, 그 이름은 싣지 않는다(부모 env 에 있어도 걷는다).
//
// 런처와 같은 규칙: PATH 앞의 것이 이긴다 · 판 문자는 `[0-9A-Za-z._+-]` 이고 `.`·`..` 가 아니다 ·
// 실행 파일이 실행 가능해야 한다 · `${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin/node` 가 있으면 그 폴더를 PATH 앞에.
// 어느 하나라도 어긋나면(`current-version` 없음·판 폴더 없음·실행 파일 없음, 또는 런처 꼴이 아님) 지금처럼 `pi` 를 부른다.
// 정본 쌍: `crates/harkroom-runner/src/pi_launch.rs`.
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';

/** 런처가 export 하는 이름 — 러너가 띄우는 pi 에는 싣지 않는다. */
export const PI_MANAGED_INSTALL_ROOT_ENV = 'PI_MANAGED_INSTALL_ROOT';

export interface PiLaunch {
  /** 띄울 실행 파일. 런처를 못 풀면 `'pi'`. */
  command: string;
  /** PATH 앞에 붙일 pi 전용 node 폴더. 없으면 null. */
  pathPrepend: string | null;
}

export const PI_FALLBACK_LAUNCH: PiLaunch = { command: 'pi', pathPrepend: null };

const VERSION_RE = /^[0-9A-Za-z._+-]+$/;

function executable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH 에서 실행 가능한 `pi` 를 찾는다(앞의 것이 이긴다). */
function whichPi(path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'pi');
    if (executable(candidate)) return candidate;
  }
  return null;
}

/**
 * 그 env(자식이 받을 PATH·HOME·XDG_DATA_HOME)로 pi 를 어떻게 띄울지 정한다. 파일만 읽는다 — 쓰지 않는다.
 */
export function resolvePiLaunch(env: Readonly<Record<string, string | undefined>>): PiLaunch {
  const found = whichPi(env.PATH);
  if (!found) return PI_FALLBACK_LAUNCH;
  let launcher: string;
  try {
    launcher = realpathSync(found);
  } catch {
    return PI_FALLBACK_LAUNCH;
  }
  // 런처 꼴(`<agent>/bin/pi`)이 아니면(npm 전역 설치 등) 그대로 `pi`.
  if (basename(launcher) !== 'pi' || basename(dirname(launcher)) !== 'bin') return PI_FALLBACK_LAUNCH;
  const agentDir = dirname(dirname(launcher));
  let version: string;
  try {
    version = readFileSync(join(agentDir, 'install', 'current-version'), 'utf8').split('\n')[0] ?? '';
  } catch {
    return PI_FALLBACK_LAUNCH;
  }
  if (!VERSION_RE.test(version) || version === '.' || version === '..') return PI_FALLBACK_LAUNCH;
  const releaseBin = join(agentDir, 'install', 'releases', version, 'node_modules', '.bin', 'pi');
  if (!executable(releaseBin)) return PI_FALLBACK_LAUNCH;
  const dataHome = env.XDG_DATA_HOME || (env.HOME ? join(env.HOME, '.local', 'share') : null);
  const nodeBin = dataHome ? join(dataHome, 'pi-node', 'current', 'bin') : null;
  return { command: releaseBin, pathPrepend: nodeBin && executable(join(nodeBin, 'node')) ? nodeBin : null };
}

/** 해석한 띄우기를 자식 env 에 얹는다 — PATH 앞에 node 폴더, 런처 이름은 걷는다. env 를 고쳐 돌려준다. */
export function applyPiLaunchEnv<T extends Record<string, string>>(env: T, launch: PiLaunch): T {
  delete env[PI_MANAGED_INSTALL_ROOT_ENV];
  if (launch.pathPrepend) {
    (env as Record<string, string>).PATH = env.PATH ? `${launch.pathPrepend}${delimiter}${env.PATH}` : launch.pathPrepend;
  }
  return env;
}
