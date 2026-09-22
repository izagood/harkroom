/**
 * 오퍼레이터 로컬 설정 `operator.json` — 스펙 2026-09-20 §3 능력.
 *
 * 머신 종속 값(작업 디렉터리·claude 계정 풀)이 서버 `agent_config` 에서 나와 여기 산다.
 * A컴퓨터의 워크스페이스 경로가 B컴퓨터에 있을 이유가 없다. 커뮤니티(=서버)마다 섹션이
 * 갈린다 — 오퍼레이터는 머신당 하나이고 커뮤니티 여럿에 붙으므로(§2-6 의 인스턴스 격리),
 * 같은 에이전트 id 가 두 서버에서 다른 뜻일 수 있다는 것을 파일 구조가 그대로 담는다.
 *
 * **writer 는 오퍼레이터 하나다.** 그 머신의 데스크탑은 unix 소켓으로 요청할 뿐 파일을 직접
 * 쓰지 않는다 — `claudeAccounts.ts` 가 `pools.json` 에 세운 것과 같은 단일 writer 규칙이다.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LocalAgentConfig {
  /** 이 머신에서의 작업 디렉터리. 없으면 서버 정의의 `workingDirDefault`. */
  workingDir?: string;
  /** claude 계정 풀 이름(`pools.json`). 없으면 시스템 기본 로그인. */
  claudePool?: string;
}

export interface CommunityConfig {
  /** 이 커뮤니티에서 이 머신이 돌릴 수 있는 에이전트. 키는 에이전트 계정 id. */
  agents: Record<string, LocalAgentConfig>;
  /**
   * 이 커뮤니티에서 **이 머신의** 오퍼레이터 id. 서버가 준 값이고 파일에 적어 두는 이유는
   * 앱이 `GET /operators` 의 목록에서 자기 기기를 골라야 하기 때문이다 — 이름만으로는
   * 고를 수 없다(같은 이름의 기기가 둘일 수 있다). 등록 때 적고, 붙을 때마다
   * `/operators/self` 로 맞춘다(옛 설정을 뒤늦게 채우는 길이기도 하다).
   */
  operatorId?: string;
}

export interface OperatorConfig {
  /** 키는 서버 baseUrl(끝 슬래시 없음). */
  communities: Record<string, CommunityConfig>;
}

const EMPTY: OperatorConfig = { communities: {} };

function isConfig(value: unknown): value is OperatorConfig {
  if (typeof value !== 'object' || value === null) return false;
  const c = (value as { communities?: unknown }).communities;
  return typeof c === 'object' && c !== null && !Array.isArray(c);
}

/**
 * 없거나 깨졌으면 빈 설정이다 — 던지지 않는다. 깨진 파일은 **덮어쓰지 않는다**: 다음
 * `writeConfig` 가 사람이 손으로 고치던 내용을 지울 수 있고, 그 손실은 되돌릴 수 없다.
 * 로그는 호출자가 남긴다(이 모듈은 파일만 안다).
 */
export async function readConfig(path: string): Promise<OperatorConfig> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return { communities: {} }; }
  try {
    const parsed: unknown = JSON.parse(text);
    return isConfig(parsed) ? parsed : { ...EMPTY };
  } catch { return { ...EMPTY }; }
}

/** 임시 파일에 쓰고 rename 한다 — 도중에 죽어도 반쪽짜리 설정이 남지 않는다. */
export async function writeConfig(path: string, cfg: OperatorConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

/**
 * 그 커뮤니티의 오퍼레이터 id 를 적는다. **바뀐 때만 쓴다** — 붙을 때마다 부르는 자리라
 * 같은 값을 다시 쓰면 `localAgents` 의 쓰기와 겹칠 창만 늘린다(둘 다 read-modify-write 다).
 */
export async function rememberOperatorId(path: string, baseUrl: string, operatorId: string): Promise<void> {
  const key = communityKey(baseUrl);
  const config = await readConfig(path);
  const section = (config.communities[key] ??= { agents: {} });
  if (section.operatorId === operatorId) return;
  section.operatorId = operatorId;
  await writeConfig(path, config);
}

/** baseUrl 을 설정 키로 정규화한다 — 끝 슬래시 하나 때문에 같은 서버가 두 섹션이 되면 안 된다. */
export function communityKey(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}
