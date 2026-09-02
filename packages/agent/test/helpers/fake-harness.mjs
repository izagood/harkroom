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
