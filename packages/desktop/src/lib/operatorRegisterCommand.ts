/**
 * 설정 › Operators 가 보여 주는 등록 명령.
 *
 * 앱은 PATH 에 아무것도 깔지 않으므로 맨 이름(`harkroom-operator`)은 첫 설치 맥에서 `command not found` 다(10-27).
 * 앱이 지금 오퍼레이터를 띄우는 실제 경로(Tauri `operator_cli_path`)를 앞에 쓰고, 그 경로를 모르거나 임시 경로면
 * 맥 기본 설치 경로로 물러선다. 공백이 든 경로는 셸에 그대로 붙여 넣을 수 있게 작은따옴표로 감싼다.
 */
export const DEFAULT_OPERATOR_CLI_PATH = '/Applications/Harkroom.app/Contents/MacOS/harkroom-operator';

export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function operatorRegisterCommand(cliPath: string | null, baseUrl: string, code: string): string {
  return `${shellQuote(cliPath ?? DEFAULT_OPERATOR_CLI_PATH)} register ${shellQuote(baseUrl)} ${shellQuote(code)}`;
}
