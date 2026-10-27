/**
 * **이 기계가 아직 이 커뮤니티에 없으면 이 기계의 오퍼레이터를 등록한다**(격리 C P8, 결정 D4).
 *
 * 앱은 뜰 때 오퍼레이터 프로세스를 세우지만(`RunnerLauncher.ensureOperator`), 커뮤니티에 **등록**하는
 * 길은 설정 › 이 머신의 오퍼레이터의 [이 머신을 등록] 버튼 하나뿐이었다. 그래서 커뮤니티를 새로 만들고
 * 앱을 깐 사람은 Operators 가 비어 있는 채로 시작했다 — 에이전트를 만들어도 돌릴 곳이 없다.
 *
 * 앞 판본은 「오퍼레이터가 하나도 없는 커뮤니티」에서만 했다. 그러면 다른 기기가 이미 선 커뮤니티에 새 기계로
 * 들어온 관리자는 버튼을 찾아야 했다. 이제 조건은 **이 기계의 로컬 설정에 이 커뮤니티 등록이 없음**이다.
 * 커뮤니티마다 프로세스 모드(스위치 켜짐)에서는 로컬 설정이 그 커뮤니티 뿌리의 것이다 — 호출부가 오퍼레이터를
 * 세운 **뒤에** 부르므로 순서는 뿌리 생성 → 기동 → 등록이 된다.
 *
 * 남은 거름:
 * - **`operator.manage` 가 있는 사람만**(커뮤니티를 관리하는 사람). member 가 들어올 때마다 그 사람의 기기 이름이
 *   남의 커뮤니티 목록에 동의 없이 오르면 안 된다(security F1). 그 사람은 버튼으로 정한다.
 * - **커뮤니티마다 한 번뿐**(`wasAutoRegistered`). 사람이 이 기계를 뺐으면 다음 기동에 다시 세우지 않는다 —
 *   뺀 것이 그 사람의 뜻이다. 이미 등록돼 있던 기계도 표시해 둔다(나중에 빼도 되살리지 않게).
 * - 판단에 필요한 사실을 못 읽으면 하지 않는다 — 모르는 채로 등록하면 같은 기계가 두 번 선다.
 */
export interface AutoRegisterDeps {
  /** 지금 로그인한 커뮤니티 주소. 없으면 하지 않는다. */
  baseUrl: string | null;
  /** `operator.register` 능력이 있는가. */
  canRegister: boolean;
  /** `operator.manage` 능력이 있는가 — 커뮤니티를 관리하는 사람만 자동으로 기계를 세운다. */
  canManage: boolean;
  /** 이 기계의 오퍼레이터 로컬 설정(`operator_agents_list`, 그 커뮤니티의 오퍼레이터). */
  listLocal: () => Promise<{ communities: { baseUrl: string; registered: boolean }[] }>;
  /** 이 커뮤니티에 이 기계를 자동으로 세운 적이 있는가(`operatorAutoRegisteredStorage`). */
  wasAutoRegistered: (baseUrl: string) => boolean;
  /** 자동 등록을 끝낸 것으로 표시한다 — 다음부터는 하지 않는다. */
  markAutoRegistered: (baseUrl: string) => void;
  /** 등록 코드 발급(`POST /operators/register-code`). */
  mintCode: () => Promise<{ code: string }>;
  /** 코드를 이 기계의 오퍼레이터에 넘긴다(`operator_register`). 이름은 `AUTO_REGISTER_NAME`. */
  register: (baseUrl: string, code: string, name: string) => Promise<unknown>;
}

/**
 * 자동 등록 때 쓰는 기기 이름. **hostname 을 쓰지 않는다**(security #1651 F1) — 맥 기본 hostname 에는 실명이 들기 쉽고(「○○의
 * MacBook Pro」), 자동 등록은 사람이 고르지 않은 순간에 다른 관리자들의 목록에 이 이름을 올린다. 사람이 버튼으로 등록하는 길은
 * 지금처럼 hostname 을 쓴다. 이름은 Operators 에서 언제든 바꿀 수 있다.
 */
export const AUTO_REGISTER_NAME = 'Harkroom desktop';

export type AutoRegisterOutcome =
  | 'registered'
  | 'no-server'
  | 'no-capability'
  | 'done-before'
  | 'already-local'
  | 'unknown';

function sameCommunity(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

export async function autoRegisterFirstOperator(deps: AutoRegisterDeps): Promise<AutoRegisterOutcome> {
  const { baseUrl } = deps;
  if (!baseUrl) return 'no-server';
  if (!deps.canRegister || !deps.canManage) return 'no-capability';
  if (deps.wasAutoRegistered(baseUrl)) return 'done-before';
  let local: Awaited<ReturnType<AutoRegisterDeps['listLocal']>>;
  try {
    local = await deps.listLocal();
  } catch {
    return 'unknown';
  }
  if (local.communities.some((c) => sameCommunity(c.baseUrl, baseUrl) && c.registered)) {
    deps.markAutoRegistered(baseUrl);
    return 'already-local';
  }
  const { code } = await deps.mintCode();
  await deps.register(baseUrl, code, AUTO_REGISTER_NAME);
  deps.markAutoRegistered(baseUrl);
  return 'registered';
}
