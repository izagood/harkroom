// 사이드카 번들 머리에 붙는 Node 판 검사 — 의존 없는 모듈로 따로 둔 것은 시험이 esbuild 없이
// 이 문자열을 실제로 실행해 보려고다(`test/daemonExitCodes.test.ts`).

/** 사이드카가 요구하는 Node 의 가장 낮은 major. 루트 `package.json` 의 `engines.node`(`>=22`)와 같다. */
export const NODE_MIN_MAJOR = 22;
/**
 * Node 가 너무 낡아 사이드카가 스스로 물러날 때의 종료 코드. **앱이 이 값을 읽는다** —
 * `src-tauri/src/daemon_client.rs` 의 `EXIT_NODE_TOO_OLD`(대조: `test/daemonExitCodes.test.ts`).
 * operator 의 `EXIT_OCCUPIED`(10)·`EXIT_INCONCLUSIVE`(11) 와 겹치지 않게 12 다.
 */
export const EXIT_NODE_TOO_OLD = 12;

/**
 * 번들 맨 앞에서 Node 판을 본다. 낡았으면 **사유 한 줄을 stderr 에 쓰고** 물러난다.
 *
 * 없으면 Node 18·20 에서 사이드카가 뜬 뒤 엉뚱한 자리(없는 API)에서 죽고, 로그 끝줄은
 * `TypeError …` 같은 것이라 사람이 원인을 알 길이 없었다. 이 줄은 번들된 코드보다 먼저 돈다
 * (esbuild `banner`) — 그 뒤의 모듈 코드가 새 API 를 만지기 전이다.
 * 끝줄의 표식 `harkroom: Node.js` 를 앱이 보고 판정한다(`daemon_client.rs::looks_like_old_node`).
 */
export function nodeVersionGuard() {
  return `if (Number(process.versions.node.split('.')[0]) < ${NODE_MIN_MAJOR}) {\n`
    + `  process.stderr.write('harkroom: Node.js ${NODE_MIN_MAJOR}+ is required, found ' + process.version + ' at ' + process.execPath + '\\n');\n`
    + `  process.exit(${EXIT_NODE_TOO_OLD});\n`
    + '}';
}
