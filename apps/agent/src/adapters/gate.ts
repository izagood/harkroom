// 관문 화면 패턴. **두 어댑터가 같은 값을 가리키므로 한 곳에 둔다.**
//
// 갈라서 각 어댑터에 베껴 적으면 두 벌이 되고, codex 의 관문을 실측해 값이 갈리는 날
// 한쪽만 고치는 사고가 난다. 지금 사실은 "두 하네스가 같은 패턴을 쓴다"이고, 그중 어느
// 쪽이 측정된 것인지는 어댑터의 `screen.gateMeasured` 가 말한다.
//
// 값의 출처와 근거는 `pty.ts::DEFAULT_GATE_PATTERN` 이다 — 이 상수는 그것을 어댑터 표에서
// 가리키기 위한 사본이고, 동일성은 `test/adapterParity.test.ts` 가 실물 화면 fixture 로
// 대조해 지킨다(문자열 비교가 아니라 **같은 판정을 내는가**로 잰다).
export const GATE_PATTERN = /Do you want to (?:proceed|continue)\?|requires confirmation|^\s*❯\s*\d+\.\s/m;
