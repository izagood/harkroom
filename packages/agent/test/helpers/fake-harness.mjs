import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
// PTY 계약 테스트용 가짜 하네스. 시나리오는 env FAKE_MODE 로 고른다 —
// 인자 파싱을 흉내내지 않는다(그건 turn.ts 의 몫이고 여기선 프로세스 행동만 필요하다).
const mode = process.env.FAKE_MODE ?? 'ok';
if (mode === 'ok')      { console.log('done'); process.exit(0); }
if (mode === 'fail')    { console.error('boom'); process.exit(3); }
if (mode === 'hang')    { setInterval(() => {}, 1_000); }            // 타임아웃 검증용
if (mode === 'chatty')  { for (let i = 0; i < 10_000; i++) console.log(`line ${i}`); process.exit(0); }
// 브리프에는 없는 다섯 번째 시나리오 — 출력을 한 바이트도 안 남기고 바로 죽는 하네스
// (예: 인자 파싱에서 즉시 실패). tail/ring 이 빈 상태를 견디는지 확인하는 데 필요하다.
if (mode === 'silent')  { process.exit(7); }
// 멀티바이트(한글, 3바이트) 출력 — RingBuffer 가 바이트 경계에서 자르면 문자 경계와
// 어긋날 수 있다는 것을 재현하는 데 쓴다(리뷰 지적: cap=8 에 이 문자열을 넣으면 "라마" 앞에
// 잘린 조각이 남는다).
if (mode === 'korean')  { process.stdout.write('가나다라마'); process.exit(0); }
// #117 회귀 테스트: stdin 리다이렉션이 실제로 프롬프트를 전달하는지 확인한다.
// fake-harness 가 stdin 을 읽어 그 내용을 출력하고 종료한다 — PTY tail 에서 확인한다.
if (mode === 'stdin-echo') {
  const data = readFileSync(0, 'utf8');
  console.log(`stdin-received: ${data.trim()}`);
  process.exit(0);
}
// tail 의 고정 2KB 캡을 실제로 넘기면서, 그 절단 지점이 항상 문자 경계와 어긋나게 만든다 —
// 한글은 3바이트, 2048 은 3의 배수가 아니라서(2048 % 3 === 2) 총 바이트 수가 3의 배수인 한
// "끝에서 2048바이트" 지점은 언제나 글자 중간이다.
if (mode === 'korean-chatty') { process.stdout.write('가'.repeat(1000)); process.exit(0); }
// SIGTERM 을 무시하고 계속 도는 하네스 — 'hang' 은 기본 처분(종료)으로 SIGTERM 에 그냥
// 죽어서 SIGKILL 승격 경로를 한 번도 안 태운다(리뷰 지적). 이 모드가 그 경로를 실제로
// 타게 만든다. 자기 pid 를 먼저 찍어 두는 이유: 테스트가 이 pid 로 "진짜 거둬졌는지"
// (kill(pid, 0) 이 ESRCH 를 던지는지)를 확인한다.
if (mode === 'hang-ignore-sigterm') {
  // pid 를 **파일로도** 남긴다. stdout 은 PTY 를 거치므로, SIGKILL 로 pty 가 닫히면 그 줄이
  // ring 에 도달하기 전에 유실될 수 있다 — CI 부하에서 실제로 그렇게 실패했다
  // (`expected null not to be null`: ring 에 pid= 가 없었다). 파일 쓰기는 프로세스가 죽어도
  // 남으므로 테스트가 경쟁 없이 pid 를 얻는다.
  if (process.env.FAKE_PID_FILE) {
    writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
  }
  console.log(`pid=${process.pid}`);
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
}
// #315: attach 한 사람이 친 바이트가 정말 이 프로세스의 stdin 에 닿는지 확인한다.
// 받은 바이트를 **hex 로** 되뱉는다 — 문자열로 찍으면 제어 바이트(ESC, Ctrl-C)가 화면
// 제어로 해석돼 ring 에서 사라지고, 그러면 "닿았다"를 바이트로 단언할 수 없다.
// 줄이 끝나면(개행 어느 쪽이든 — PTY 의 라인 디서플린이 \r 을 \n 으로 바꾼다) 끝낸다.
if (mode === 'stdin-live') {
  const chunks = [];
  process.stdin.on('data', (d) => {
    chunks.push(Buffer.from(d));
    const all = Buffer.concat(chunks);
    if (all.includes(0x0a) || all.includes(0x0d)) {
      process.stdout.write(`\ngot:${all.toString('hex')}\n`);
      process.exit(0);
    }
  });
  // 아무것도 안 오면 매달리지 않는다 — 그때는 이 종료 코드가 원인을 말해 준다.
  setTimeout(() => process.exit(11), 8_000);
}
// #335: attach 한 소유자의 패널 크기가 정말 이 프로세스의 PTY 창 크기가 되는지 확인한다.
//
// **SIGWINCH 를 기다린다.** "숫자가 러너까지 왔다"는 프레임을 세면 알 수 있지만, 그것과
// "PTY 크기가 바뀌었다"는 다른 사실이다 — 커널이 TIOCSWINSZ 를 받아야 이 시그널이 오고,
// 그때서야 `process.stdout.columns` 가 새 값을 준다. 하네스(claude code 의 입력 상자·표)가
// 자기 폭을 다시 계산하는 것도 이 시그널이다.
if (mode === 'winsize') {
  // spawn 시점의 크기를 먼저 찍는다 — 이것이 있어야 "원래부터 그 크기였다"와
  // "바뀌어서 그 크기가 됐다"를 테스트가 가를 수 있다.
  process.stdout.write(`start:${process.stdout.columns}x${process.stdout.rows}\n`);
  process.on('SIGWINCH', () => {
    process.stdout.write(`winch:${process.stdout.columns}x${process.stdout.rows}\n`);
    process.exit(0);
  });
  setTimeout(() => process.exit(12), 8_000);
}
