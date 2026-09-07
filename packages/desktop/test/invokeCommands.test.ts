/**
 * 웹뷰가 부르는 Tauri command 가 **Rust 에 실제로 등록돼 있는가.**
 *
 * ## 왜 이 회귀선이 필요한가
 *
 * `invoke('app_version')` 은 문자열이다. Rust 의 `invoke_handler` 에 그 이름이 없으면
 * 타입 검사도, 빌드도, 번들도 통과한다 — **실패는 사람이 그 기능을 누르는 순간**에만
 * 드러나고, 그때 오는 것은 "command not found" 한 줄이다.
 *
 * 그리고 이 저장소의 브리지들은 실패를 조용히 삼키도록 되어 있다(`tauriLoginPathReader`
 * 와 `tauriAppVersionReader` 의 `catch { return null }`). 그 설계는 옳다 — 앱이 뜨는
 * 것을 막지 않기 위해서다. 대가로 이름이 틀렸을 때도 조용해진다: 앱 버전이 영원히
 * `null` 이고, 화면은 러너가 뒤처졌는지 "모른다"고만 말한다. 정확히 이 결함을 이 파일이
 * 잡는다.
 *
 * ## 왜 소스를 문자열로 읽는가
 *
 * 웹뷰 테스트에서 Rust 를 실행할 수는 없다. `bundleSignable.test.ts` 가 같은 자리에서
 * 같은 방식(`main.rs` 를 읽어 검사)을 쓰고 있으므로 그 관례를 따른다.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const DESKTOP_DIR = path.resolve(__dirname, '..');
const MAIN_RS = path.join(DESKTOP_DIR, 'src-tauri', 'src', 'main.rs');
const LAUNCHER_TS = path.join(DESKTOP_DIR, 'src', 'lib', 'runnerLauncher.ts');

/** `invoke('name')` 의 이름들. 상수로 넘기는 것(`LOGIN_PATH_COMMAND`)은 여기 안 걸린다. */
function invokedCommands(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/invoke\(\s*['"]([a-z0-9_]+)['"]/g)) found.add(m[1]!);
  return [...found].sort();
}

describe('Tauri command 등록', () => {
  it('러너 실행기가 부르는 command 가 모두 main.rs 에 등록돼 있다', () => {
    const launcher = readFileSync(LAUNCHER_TS, 'utf8');
    const mainRs = readFileSync(MAIN_RS, 'utf8');
    const commands = invokedCommands(launcher);

    // 대조군 — 정규식이 아무것도 못 찾으면 이 회귀선은 항상 초록이다.
    expect(commands.length, 'invoke 호출을 하나도 못 찾았다면 이 검사는 무의미하다')
      .toBeGreaterThan(0);

    const missing = commands.filter((name) => !new RegExp(`\\b${name}\\b`).test(mainRs));
    expect(missing, `main.rs 의 invoke_handler 에 없는 command: ${missing.join(', ')}`)
      .toEqual([]);
  });
});
