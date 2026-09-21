/**
 * 로그인 셸의 `PATH` — 러너 자식에 넘긴다. 데스크탑이 `login_path.rs` 로 캐내던 것을 오퍼레이터가
 * 직접 한다(단계 2: 기동 결정이 앱에서 오퍼레이터로 옮겨왔다). launchd/systemd 아래서 뜬
 * 프로세스는 로그인 셸의 PATH 를 물려받지 않으므로, 이것이 없으면 러너는 살아 있는데 `claude`
 * 를 못 찾는 조용한 실패가 된다(operations.md §8 의 함정 그대로).
 */
import { execFile } from 'node:child_process';

export function readLoginPath(timeoutMs = 5_000): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/sh';
  return new Promise((resolve) => {
    execFile(shell, ['-lc', 'echo "$PATH"'], { timeout: timeoutMs }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const line = String(stdout).trim().split('\n').pop() ?? '';
      resolve(line.includes('/') ? line : null);
    });
  });
}
