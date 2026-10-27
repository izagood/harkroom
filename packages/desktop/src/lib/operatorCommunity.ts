/**
 * 이 창이 지금 보고 있는 커뮤니티 — 오퍼레이터를 부르는 Tauri 명령마다 `community` 로 싣는다(격리 C P6).
 *
 * 스위치 `HARKROOM_OPERATOR_PER_COMMUNITY` 가 켜지면 Rust 가 이 값으로 **그 커뮤니티의** 오퍼레이터 연결을 고른다
 * (`daemon_client.rs::ensure_daemon`). 꺼져 있으면 Rust 가 무시한다 — 지금처럼 기계에 오퍼레이터 하나다.
 * 넘기는 것은 baseUrl 문자열뿐이다. 뿌리 경로는 Rust 가 정한다(웹뷰가 경로를 고를 수 없다).
 *
 * 값은 컨트롤러가 커뮤니티에 붙을 때 넣는다(`controller.start`). 컨트롤러는 state 에 있고 이 파일은 lib 의 여러
 * 모듈이 import 하므로, 순환 import 를 피하려고 컨트롤러를 부르지 않고 값만 받아 둔다.
 */
let current: string | null = null;

export function setOperatorCommunity(baseUrl: string | null): void {
  current = baseUrl;
}

export function operatorCommunity(): string | null {
  return current;
}

/**
 * Tauri 명령 인자에 `community` 를 얹는다. 호출자가 준 값이 있으면 그것을 쓴다. 아직 모르면(컨트롤러가 붙기 전)
 * 싣지 않는다 — 그때 스위치가 켜져 있으면 Rust 가 「어느 커뮤니티인지 받지 못했다」로 거절한다(기계 하나로 물러서지 않는다).
 */
export function withCommunity(args?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (current === null) return args;
  return { community: current, ...(args ?? {}) };
}
