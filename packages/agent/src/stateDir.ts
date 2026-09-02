import { join } from 'node:path';

/**
 * 러너 상태 디렉터리를 정한다(#167).
 *
 * **키는 계정 id 다 — URL 이 아니다.** 같은 서버는 어느 URL 로 닿아도(`localhost` vs
 * LAN IP) 같은 계정 id 를 주고, 다른 서버의 같은 handle 은 다른 id 를 준다. URL 로
 * 키를 만들면 같은 서버에 디렉터리가 둘 생겨 세션 연속성이 끊긴다.
 *
 * **handle 은 사람이 디렉터리를 보고 알아볼 수 있게 하려고 넣는다** — 격리에 필요한
 * 것은 id 뿐이다.
 *
 * 문자 방어를 두지 않는 이유: `handle` 은 서버가 `HANDLE_PATTERN`
 * (`[a-zA-Z0-9_-]{2,32}`) 으로 제한하고 `id` 는 UUID 다. 경로에 위험한 문자가 들어올
 * 입력 자체가 없다. 방어를 두면 도달 불가능한 분기가 되고, 게다가 인코딩 폴백은
 * **handle 과 다른 이름의 디렉터리**를 조용히 만들어 사람이 찾을 수 없게 한다.
 * 제약이 느슨해진다면 그것은 서버 쪽 변경이고 거기서 잡혀야 한다.
 *
 * `legacyPath` 는 서버별로 갈리기 **전** 경로다(handle 만으로 스코프). 호출자가
 * 존재를 확인해 운영자에게 안내한다 — 자동으로 옮기지 않는다.
 */
export function resolveAgentStateDir(
  baseDir: string,
  handle: string,
  id: string,
): { agentStateDir: string; legacyPath: string } {
  return {
    agentStateDir: join(baseDir, `${handle}-${id}`),
    legacyPath: join(baseDir, handle),
  };
}
