// claude 계정 **풀**의 타입과 순수 해석. `pools.json` 이 이 모듈의 대상이다.
//
// **서브패스로 낸다**(`@harkroom/shared/claudePools`). 이 패키지의 별 모듈은 전부 그 모양이고
// (`./daemonEndpoint`, `./daemonProtocol`), `index.ts` 는 재수출이 하나도 없는 평평한 파일이다.
// 그 둘이 서브패스인 이유로 적힌 것은 Node 의존이지만 — 이 파일에는 Node 의존이 **없다** —
// 파일 조직의 관례는 그것과 별개다. 웹뷰가 직접 import 해도 안전하다.
//
// **파일 I/O 가 여기 없는 것이 요점이다.** 읽는 쪽(러너)과 쓰는 쪽(데몬)이 다른 프로세스이고
// 각자 자기 방식으로 읽고 쓴다 — 공유해야 하는 것은 **그 내용의 뜻**뿐이다. I/O 를 여기 넣으면
// 이 파일이 `node:fs` 를 물어 웹뷰 번들이 깨진다.
//
// **관용적으로 파싱하는 것이 규율이다.** 이 파일은 UI 가 쓰고 사람이 파인더·에디터로 손댈 수
// 있다. 모양이 틀렸다고 던지면 러너가 뜨지 않고, 그때 사용자는 앱에서 고칠 방법이 없다.
// 그래서 **틀린 항목만 버리고 나머지는 살린다.**
//
// **멤버십은 여기 없다.** 어떤 풀이 있고 그 안에 어떤 계정이 있는지는 **디스크가 진실**이다
// (풀 = 디렉터리, 계정 = 그 안 디렉터리). 이 파일이 담는 것은 디스크가 표현할 수 **없는**
// 셋뿐이다: 기본 풀, 순서, 에이전트 배정. 목록을 여기 이중으로 적으면 파일과 디스크가 갈리는
// 날이 오고, 그날 러너는 없는 계정을 가리킨다.

/**
 * 풀·계정 이름 문법. `agent/src/claudeAccounts.ts::CLAUDE_ACCOUNT_PATTERN` 과 **같은 값**이고
 * 같은 이유다 — 이 이름이 경로 세그먼트가 되므로 `..` 나 `/` 가 들어올 여지를 문법에서 끊는다.
 *
 * 두 곳에 같은 값이 있는 것이 마음에 걸리지만, 러너의 것은 `@harkroom/shared` 를 물지 않는
 * 자리에서도 쓰인다. 하나로 합치려면 그 의존을 먼저 재야 한다.
 */
export const CLAUDE_POOL_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;

export interface ClaudePoolsConfig {
  /** 어느 풀이 기본인가. `null` 은 지정 없음. */
  defaultPool: string | null;
  /** 풀별 계정 순서(페일오버 순서). 디스크에서 유도할 수 없으므로 파일이 유일한 표현이다. */
  order: Record<string, string[]>;
  /** 에이전트 계정 id → 풀 이름. 배정이 없는 에이전트는 여기 없다. */
  agents: Record<string, string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 이름이 문법에 맞으면 그것을, 아니면 `null`. 경로가 되는 값은 전부 이걸 통과해야 한다. */
function name(v: unknown): string | null {
  return typeof v === 'string' && CLAUDE_POOL_NAME_PATTERN.test(v) ? v : null;
}

/**
 * `pools.json` 을 읽는다. **던지지 않는다** — 위 모듈 주석의 규율.
 *
 * 데몬도 쓰기 **전에** 이것을 통과시킨다(정규화). 그러면 디스크에 남는 것은 언제나 이 함수가
 * 인정한 모양이고, 읽는 쪽이 두 번째 방어를 따로 짤 필요가 없다.
 */
export function parseClaudePoolsConfig(raw: unknown): ClaudePoolsConfig {
  if (!isRecord(raw)) return { defaultPool: null, order: {}, agents: {} };

  const order: Record<string, string[]> = {};
  if (isRecord(raw.order)) {
    for (const [pool, list] of Object.entries(raw.order)) {
      if (name(pool) === null || !Array.isArray(list)) continue;
      order[pool] = list.map(name).filter((n): n is string => n !== null);
    }
  }

  const agents: Record<string, string> = {};
  if (isRecord(raw.agents)) {
    for (const [agentId, pool] of Object.entries(raw.agents)) {
      // agentId 는 서버가 발급한 UUID 라 문법을 여기서 재지 않는다 — 재면 서버의 형식 변경이
      // 이 파일을 깨뜨린다. **풀 이름만** 잰다: 그것이 경로가 되는 쪽이다.
      const p = name(pool);
      if (p !== null) agents[agentId] = p;
    }
  }

  return { defaultPool: name(raw.defaultPool), order, agents };
}

/**
 * 이 에이전트가 쓸 풀 이름. `null` 은 "지정 없음"이고 호출자가 암묵 풀로 떨어진다.
 *
 * `forced` 는 `MURMUR_CLAUDE_POOL` 이다 — **운영자가 방금 타이핑한 의도라 가장 세다.**
 * 그 값이 실재하는 풀인지는 여기서 모른다(디스크를 안 본다). 호출자가 잰다.
 *
 * **러너는 이 함수를 직접 쓰지 않는다.** 러너는 없는 풀을 만나면 다음 단계로 떨어져야 하는데
 * (배정 → 기본 풀), "이름 하나를 고르는" 이 함수로는 그 건너뛰기를 표현할 수 없다. 이 함수는
 * UI 가 "지금 이 에이전트는 어느 풀을 쓸 것인가"를 미리 보여 줄 때 쓴다 — 그쪽은 디스크를
 * 이미 목록으로 들고 있어 실재 여부를 스스로 안다.
 */
export function resolvePoolName(
  cfg: ClaudePoolsConfig,
  agentId: string,
  forced?: string | null,
): string | null {
  if (forced) return forced;
  return cfg.agents[agentId] ?? cfg.defaultPool;
}

/**
 * 풀 안 계정을 페일오버 순서로 늘어놓는다.
 *
 * `found` 는 **디스크에서 읽은 목록**이다 — 그것이 멤버십의 진실이므로:
 * - 설정에 있지만 디스크에 없는 이름은 **빠진다**(사람이 지웠다).
 * - 디스크에 있지만 설정에 없는 이름은 **뒤에 붙는다**(UI 가 순서를 쓴 뒤 사람이 계정을 새로
 *   만들었다 — 그때 빠뜨리면 "만들었는데 안 쓴다"가 된다).
 */
export function orderAccounts(
  cfg: ClaudePoolsConfig,
  pool: string,
  found: string[],
): string[] {
  const wanted = cfg.order[pool] ?? [];
  const inOrder = wanted.filter((n) => found.includes(n));
  const rest = found.filter((n) => !inOrder.includes(n)).sort();
  return [...inOrder, ...rest];
}
