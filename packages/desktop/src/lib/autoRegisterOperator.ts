/**
 * **첫 설치에서 이 머신의 오퍼레이터를 커뮤니티에 등록한다.**
 *
 * 앱은 뜰 때 오퍼레이터 프로세스를 세우지만(`RunnerLauncher.ensureOperator`), 커뮤니티에 **등록**하는
 * 길은 설정 › 이 머신의 오퍼레이터의 [이 머신을 등록] 버튼 하나뿐이었다. 그래서 커뮤니티를 새로 만들고
 * 앱을 깐 사람은 Operators 가 비어 있는 채로 시작했다 — 에이전트를 만들어도 돌릴 곳이 없다.
 *
 * 자동으로 하는 것은 **커뮤니티 전체 목록을 볼 수 있는 사람(`operator.manage`)이 아무 오퍼레이터도 없는
 * 커뮤니티**에 들어왔을 때뿐이다 — 커뮤니티를 새로 만든 사람이다. `operator.manage` 가 없는 member 에게
 * `GET /operators` 는 **자기 것만** 돌려주므로 빈 목록이 「빈 커뮤니티」가 아니다(security F1): 거기서 자동으로
 * 붙이면 남의 커뮤니티에 이 기기 이름이 동의 없이 오른다. 그런 사람과, 이미 다른 기기가 있는 커뮤니티는
 * 사람이 정한다(버튼). 판단에 필요한 사실 중 하나라도 못 읽으면 하지 않는다 — 모르는 채로 등록하면 같은
 * 머신이 두 번 선다.
 */
export interface AutoRegisterDeps {
  /** 지금 로그인한 커뮤니티 주소. 없으면 하지 않는다. */
  baseUrl: string | null;
  /** `operator.register` 능력이 있는가. */
  canRegister: boolean;
  /** `operator.manage` 능력이 있는가 — 있어야 `GET /operators` 가 커뮤니티 전체다. */
  canManage: boolean;
  /** 이 머신의 오퍼레이터 로컬 설정(`operator_agents_list`). */
  listLocal: () => Promise<{ communities: { baseUrl: string; registered: boolean }[] }>;
  /** 커뮤니티에 등록된 오퍼레이터 목록(`GET /operators`). `canManage` 일 때만 전체다. */
  listOperators: () => Promise<unknown[]>;
  /** 등록 코드 발급(`POST /operators/register-code`). */
  mintCode: () => Promise<{ code: string }>;
  /** 코드를 이 머신의 오퍼레이터에 넘긴다(`operator_register`). */
  register: (baseUrl: string, code: string) => Promise<unknown>;
}

export type AutoRegisterOutcome =
  | 'registered'
  | 'no-server'
  | 'no-capability'
  | 'already-local'
  | 'community-has-operators'
  | 'unknown';

export async function autoRegisterFirstOperator(deps: AutoRegisterDeps): Promise<AutoRegisterOutcome> {
  const { baseUrl } = deps;
  if (!baseUrl) return 'no-server';
  if (!deps.canRegister || !deps.canManage) return 'no-capability';
  let local: Awaited<ReturnType<AutoRegisterDeps['listLocal']>>;
  let operators: unknown[];
  try {
    [local, operators] = await Promise.all([deps.listLocal(), deps.listOperators()]);
  } catch {
    return 'unknown';
  }
  if (local.communities.some((c) => c.baseUrl === baseUrl && c.registered)) return 'already-local';
  if (operators.length > 0) return 'community-has-operators';
  const { code } = await deps.mintCode();
  await deps.register(baseUrl, code);
  return 'registered';
}
