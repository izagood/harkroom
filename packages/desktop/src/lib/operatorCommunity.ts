/**
 * 오퍼레이터를 부르는 Tauri 명령마다 실을 `community`(baseUrl)를 정한다(격리 C P6).
 *
 * 스위치 `HARKROOM_OPERATOR_PER_COMMUNITY` 가 켜지면 Rust 가 이 값으로 **그 커뮤니티의** 오퍼레이터 연결을 고른다
 * (`daemon_client.rs::ensure_daemon`). 꺼져 있으면 Rust 가 무시한다. 넘기는 것은 baseUrl 문자열뿐이고 뿌리 경로는
 * Rust 가 정한다.
 *
 * **전역 「현재 커뮤니티」 값을 두지 않는다**(security P6-F1). 데스크톱은 커뮤니티마다 컨트롤러를 띄우므로 「마지막으로
 * 붙은 커뮤니티」는 지금 보고 있는 커뮤니티가 아니다. 그래서 값은 부르는 그 순간에 정한다:
 * 1. 호출자가 `community` 를 직접 주면 그것(컨트롤러에 묶인 호출 — 러너 관측·자동 등록 등)
 * 2. 인자에 `baseUrl` 이 있으면 그것(그 커뮤니티를 고치는 명령은 그 커뮤니티의 오퍼레이터로 간다)
 * 3. 아니면 **지금 활성인** 커뮤니티(화면에서 한 호출) — `state/communities.ts` 가 리졸버를 건다
 * 셋 다 모르면 싣지 않는다 — 스위치가 켜져 있으면 Rust 가 거절한다(기계 하나로 물러서지 않는다).
 */
let activeResolver: () => string | null = () => null;

/** 활성 커뮤니티의 baseUrl 을 그 순간 읽는 함수를 건다. state 가 lib 를 부르는 방향이라 순환 import 를 피한다. */
export function setActiveCommunityResolver(fn: () => string | null): void {
  activeResolver = fn;
}

export function withCommunity(args?: Record<string, unknown>): Record<string, unknown> | undefined {
  const explicit = typeof args?.community === 'string' ? args.community : null;
  const target = typeof args?.baseUrl === 'string' ? args.baseUrl : null;
  const community = explicit ?? target ?? activeResolver();
  if (community === null) return args;
  return { ...(args ?? {}), community };
}
