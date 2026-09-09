import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
// PTY 계약 테스트용 가짜 하네스. 시나리오는 env FAKE_MODE 로 고른다 —
// 인자 파싱을 흉내내지 않는다(그건 turn.ts 의 몫이고 여기선 프로세스 행동만 필요하다).
const mode = process.env.FAKE_MODE ?? 'ok';
if (mode === 'ok')      { console.log('done'); process.exit(0); }
if (mode === 'fail')    { console.error('boom'); process.exit(3); }
if (mode === 'hang')    { setInterval(() => {}, 1_000); }            // 타임아웃 검증용
// 많이 뿜는 하네스(10,000 줄 ≈ 109KB). **다 쓴 뒤 곧장 죽지 않고, 부모가 "다 읽었다"고
// 알려 줄 때까지 기다렸다 죽는다**(#416).
//
// ## 왜 기다려야 하는가 — 이것은 픽스처의 편의가 아니라 PTY 의 계약이다
//
// PTY 의 slave 쪽 fd 가 **전부 닫히는 순간**, 커널은 그 slave 의 출력 큐에 아직 남아 있던
// 바이트를 **버린다**. 그 뒤 master 에서 읽으면 남은 데이터가 아니라 EIO 가 온다. 즉
// `write(2)` 가 전부 성공해도, 부모가 그것을 다 읽기 **전에** 자식이 죽으면 못 읽은 만큼은
// 영영 사라진다. 파이프와 다른 점이 정확히 이것이다 — 파이프는 쓰는 쪽이 죽어도 버퍼에
// 남은 것을 읽는 쪽이 끝까지 읽을 수 있다.
//
// **실측(#416, Linux/2코어, chatty 를 6개 동시 + CPU 버너 6개).** 자식이 마지막 줄을 쓴
// 직후 표식 파일을 남기게 해서 "자식이 못 쓴 것"과 "부모가 못 읽은 것"을 갈랐다:
//
// - 종료 전 대기 없음: **180회 중 14회**가 끝을 잃었다(7.8%). 전부 자식은 다 썼고
//   (exitCode 0 + 표식 파일 존재) 부모만 최대 12KB 를 못 받았다. 잘린 자리는 줄 경계와도
//   무관해서 `"lin"`, `"line "` 처럼 토큰 중간이었다 — 커널이 큐를 통째로 버린 흔적이다.
// - 자식이 종료 전 300ms 만 머무름: **90회 중 0회**.
// - 아래의 ack 핸드셰이크: **180회 중 0회**.
//
// ## 왜 `setTimeout` 으로 머무르지 않는가
//
// 300ms 도 통했지만 그것은 **시간으로 상태를 갈음하는 것**이고, 러너가 더 느려지면 다시
// 샌다(#391 이 같은 계열에서 고친 실수다). 여기서 기다리는 대상은 "얼마간의 시간"이 아니라
// **"부모가 마지막 줄을 봤다"는 사건**이므로, 그 사건 자체를 기다린다. 부모는 ring 에서
// `line 9999` 를 본 순간 PTY stdin 으로 아무 바이트나 보내고, 그것이 도착하면 여기서 죽는다.
//
// stdin 으로 받을 수 있는 이유는 이 모드를 쓰는 계획의 `stdinFile` 이 null 이라 자식의
// fd 0 이 PTY slave 이기 때문이다(`pty.ts::acceptsPtyInput`). 신호가 영영 안 오면 매달리지
// 않는다 — 그때는 종료 코드 22 가 원인을 말해 준다(다른 모드들의 8초 안전망과 같은 규율).
// TUI 흉내(2026-09-08 실행 모델 교체). 준비 신호를 찍고 stdin 을 읽어 되뱉는다 —
// 러너가 "준비를 본 뒤에만 주입한다" 를 지키는지 재는 데 쓴다. 준비 신호를 **늦게** 찍는
// 것이 요점이다: 즉시 찍으면 고정 슬립으로도 통과해 조건 대기를 검증하지 못한다.
if (mode === 'ready-then-echo') {
  // 'READY' 는 pty.test 가 명시 패턴으로 쓰고, '❯ ' 는 러너의 기본 패턴이 찾는 것이다
  // (claude TUI 의 입력 프롬프트 표시). 둘을 함께 찍어 두 경로를 같은 픽스처로 잰다.
  // '❯' 뒤는 **비분리 공백(U+00A0)** 이다 — 실물 claude TUI 가 입력줄을 그 문자로 채우고,
  // 러너의 준비 판정이 그것으로 입력창과 승인 메뉴를 가른다(메뉴는 `❯1.` 처럼 보통 문자다).
  // 보통 공백으로 두면 이 픽스처가 실물과 다른 성질을 갖게 되고, 그때 이 테스트는 초록인데
  // 프로덕션은 준비를 못 본다 — 2026-09-08 에 실제로 그렇게 깨졌다.
  setTimeout(() => process.stdout.write('READY\n\u276f\u00a0'), 300);
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    // bracketed paste 의 끝 표식이 오면 받은 것을 그대로 되뱉고 끝낸다.
    if (buf.includes('[201~')) { process.stdout.write(buf); process.exit(0); }
  });
  setTimeout(() => process.exit(21), 8_000); // 안전망
}

// 아무 신호도 안 찍고 버틴다 — 미로그인 화면·디렉터리 신뢰 대화상자가 이 모양이다.
if (mode === 'hang-silent') { setInterval(() => {}, 1_000); }

if (mode === 'chatty') {
  for (let i = 0; i < 10_000; i++) console.log(`line ${i}`);
  process.stdin.on('data', () => process.exit(0));
  setTimeout(() => process.exit(22), 20_000);
}
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
//
// **여기에는 위 'chatty' 의 ack 핸드셰이크를 달지 않았다.** 총 3,000바이트라 PTY 버퍼
// 한 번에 다 들어가고, 부모가 한 번 읽으면 큐가 빈다 — 잃을 잔량 자체가 안 생긴다(실측
// #416: Linux/2코어 부하 아래 60회 전부 3,000바이트를 온전히 받았다). 이 모드가 재는 것도
// "끝 2048바이트의 절단 지점"이라 앞이 아니라 **끝**이 온전하기만 하면 되고, 그 끝은 마지막
// 읽기에 실려 온다. 출력량을 키우게 되면 그때는 이 판단이 깨지므로 핸드셰이크를 달아야 한다.
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
  //
  // **핸들러를 pid 파일보다 먼저 건다**(#391). 순서가 계약이다: pid 파일이 존재한다는 것은
  // 곧 이 프로세스가 이미 SIGTERM 에 면역이라는 뜻이어야 한다. 예전 순서(쓰기 → 핸들러)는
  // 그 사이 창에 SIGTERM 이 닿으면 기본 처분으로 죽는데, 그때 테스트는 pid 를 읽는 데
  // 성공하므로 **승격 경로를 안 태우고도 초록으로 통과**했다. 실측(#391 통제 실험): 부팅이
  // timeoutMs 를 넘으면 pid 파일이 3초 뒤에도 안 생기고 턴이 SIGTERM 시점에 끝났다.
  // 핸들러는 **SIGTERM 을 봤다는 사실을 남긴다**(#391). 이것이 없으면, 하네스가 핸들러를
  // 못 걸고 SIGTERM 에 그냥 죽은 경우에도 테스트는 (pid 파일이 있고 프로세스가 사라졌으므로)
  // 초록으로 통과한다 — 승격을 한 번도 안 태우고서. 무시했다는 증거를 파일로 남겨야 그
  // 사건과 "SIGTERM 을 받고도 살아남았다" 를 테스트가 가를 수 있다.
  process.on('SIGTERM', () => {
    if (process.env.FAKE_SIGTERM_FILE) writeFileSync(process.env.FAKE_SIGTERM_FILE, 'seen');
  });
  if (process.env.FAKE_PID_FILE) {
    writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
  }
  console.log(`pid=${process.pid}`);
  setInterval(() => {}, 1_000);
}
// #315: attach 한 사람이 친 바이트가 정말 이 프로세스의 stdin 에 닿는지 확인한다.
// 받은 바이트를 **hex 로** 되뱉는다 — 문자열로 찍으면 제어 바이트(ESC, Ctrl-C)가 화면
// 제어로 해석돼 ring 에서 사라지고, 그러면 "닿았다"를 바이트로 단언할 수 없다.
// 줄이 끝나면(개행 어느 쪽이든 — PTY 의 라인 디서플린이 \r 을 \n 으로 바꾼다) 끝낸다.
// #337: 인터랙티브 턴 흉내 — stdin 을 **계속** 읽어 에코하고, 스스로 끝나지 않는다
// (사람이 앉아 있는 하네스처럼). 끝은 시그널(고아 회수)이거나 "exit\r" 입력뿐이다.
// 'stdin-live' 와 다른 점: 그쪽은 한 줄 받고 종료(입력 왕복 1회 검증용)이고, 이쪽은
// 무기한 턴(timeoutMs 0)·회수 경로 검증용이다.
if (mode === 'echo-stdin-live') {
  process.stdout.write('interactive-ready\n');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += String(d);
    process.stdout.write(`echo:${String(d)}`);
    if (buf.includes('exit')) process.exit(0);
  });
  setInterval(() => {}, 1_000);
}
// #337: node-pty resize() 가 SIGWINCH 로 닿는지 확인한다(스파이크 §3을 회귀선으로 고정).
// 준비 신호를 먼저 찍고, SIGWINCH 를 받으면 그 시점의 크기를 찍고 끝낸다.
if (mode === 'report-winch') {
  process.stdout.write(`ready ${process.stdout.columns}x${process.stdout.rows}\n`);
  process.on('SIGWINCH', () => {
    process.stdout.write(`winch ${process.stdout.columns}x${process.stdout.rows}\n`);
    process.exit(0);
  });
  // 신호가 영영 안 오면 매달리지 않는다 — 이 종료 코드가 원인을 말해 준다.
  setTimeout(() => { process.stdout.write('no-winch\n'); process.exit(12); }, 8_000);
}
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
// #369: stdin 이 **프롬프트 파일로 리다이렉트된** 턴에서, 파일 EOF 뒤에 PTY master 로 들어온
// 바이트가 이 프로세스에 닿는지 잰다.
//
// 왜 이 모드가 따로 필요한가: 'stdin-live'·'echo-stdin-live' 는 stdinFile 이 **없는** 계획으로만
// 돌아서 자식의 fd 0 이 PTY slave 다 — 그 조합으로는 이 결함이 재현되지 않는다(#369 가 지적한
// 테스트 공백 그대로다). 여기서는 파일을 끝까지 읽어(EOF) 프로덕션 멘션 턴과 같은 상태를 만든
// 뒤, 그 다음에 들어오는 것이 있는지를 본다.
//
// 판정을 **센티넬 문자열**로 하는 이유: PTY 는 자기가 받은 바이트를 에코해 master 로 돌려주므로
// "출력에 그 글자가 있다"로는 도달을 잴 수 없다. 자식이 직접 읽은 것만 이 줄에 실린다.
if (mode === 'stdin-file-probe') {
  const data = readFileSync(0, 'utf8');
  process.stdout.write(`file-read:${data.trim()}\n`);
  process.stdout.write('EOF_SEEN\n');
  let extra = '';
  process.stdin.on('data', (d) => { extra += String(d); });
  setTimeout(() => {
    process.stdout.write(`probe-seen:${extra.includes('ZZPROBEZZ') ? 'yes' : 'no'}\n`);
    process.exit(0);
  }, Number(process.env.FAKE_PROBE_WAIT_MS ?? '1500'));
}
// #380 1단계 실측: claude -p·codex exec 는 stdin 이 tty(PTY) 면 프롬프트 위치인자가 없는 한
// **stdin 을 아예 읽지 않고 즉시 실패한다**(실측: `Input must be provided either through
// stdin or as a prompt argument when using --print`, `No prompt provided. Either specify
// one as an argument or pipe the prompt into stdin.`). spawn 직후 동기적으로 write() 해도
// 결과가 같았다 — race 가 아니라 `isatty(0)` 판정이다. 이 모드는 그 실제 하네스 동작을
// 흉내낸다: `process.stdin.isTTY` 를 확인해서 참이면 즉시 에러를 찍고 죽는다. 이 모드가
// 초록이면 "pty.write() 로 보낸 프롬프트가 하네스에 닿는다"는 이 이슈의 전제가 실제
// 하네스에서 성립하지 않는다는 뜻이다.
if (mode === 'isatty-reject') {
  if (process.stdin.isTTY) {
    process.stdout.write('Error: Input must be provided either through stdin or as a prompt argument when using --print\n');
    process.exit(1);
  }
  const data = readFileSync(0, 'utf8');
  process.stdout.write(`prompt-received:${data.trim()}\n`);
  process.exit(0);
}

// 2026-09-08: 첫 실행 관문 흉내. 준비 신호가 **아닌** 화면(승인 메뉴)을 그리고 버틴다.
// 사람이 Enter 를 보내면 그때서야 입력 프롬프트를 그린다 — "사람이 관문을 지나면 그
// 자리에서 주입된다"(스펙 2-2)의 회귀선이다.
//
// '\u276f' 뒤가 **보통 공백**인 것이 요점이다: 실물 승인 메뉴가 그 모양이고, 러너의 준비
// 판정은 NBSP(U+00A0) 로 입력창과 메뉴를 가른다. 여기를 NBSP 로 바꾸면 이 픽스처가
// 실물과 다른 성질을 갖게 되고, 테스트는 초록인데 프로덕션은 관문을 준비로 읽는다.
if (mode === 'gatekeeper') {
  process.stdout.write('WARNING: fake gatekeeper\n\u276f No, exit\n  Yes, I accept\n');
  process.stdin.setEncoding('utf8');
  let 지났나 = false;
  process.stdin.on('data', (d) => {
    if (!지났나) {
      if (!d.includes('\r') && !d.includes('\n')) return;
      지났나 = true;
      // 사람이 관문을 지났다 — 이제 입력 프롬프트를 그린다(NBSP).
      process.stdout.write('\n\u276f\u00a0');
      return;
    }
    if (d.includes('[201~')) { process.stdout.write(`injected:${d}`); process.exit(0); }
  });
  setTimeout(() => process.exit(23), 20_000); // 안전망
}

// 2026-09-08 프로덕션의 무발화 30분 모양. 준비 신호를 찍고, 주입을 받고, **그 뒤로
// 아무것도 하지 않는다** — 죽지도 않는다. 'ready-then-echo' 로는 이 상태를 못 만든다:
// 그쪽은 주입을 받자마자 종료해서 턴이 정착하고, 정착한 턴에는 부를 이유가 없다.
if (mode === 'ready-then-silent') {
  setTimeout(() => process.stdout.write('READY\n❯ '), 100);
  process.stdin.on('data', () => { /* 받지만 아무 일도 하지 않는다 */ });
  setInterval(() => {}, 1_000);
}

// 2026-09-09 프로덕션의 모양: 대화가 **시작된 뒤에** 하네스가 확인을 묻고 선다
// (`--permission-mode auto` 의 classifier). 'ready-then-silent' 와 갈라야 하는 이유는
// 화면이다 — 저쪽은 아무것도 안 그리고, 이쪽은 **물음을 그린 채로** 선다. 러너가 그 둘을
// 가르지 못하던 것이 이 커밋이 고치는 결함이다.
if (mode === 'ready-then-gate') {
  // 입력창(NBSP)을 먼저 그린다 — 주입은 준비 신호를 본 뒤에만 일어난다.
  setTimeout(() => process.stdout.write('READY\n\u276f\u00a0'), 100);
  process.stdin.on('data', (d) => {
    if (!String(d).includes('[201~')) return;
    // 주입을 받고 일을 시작한 척하다가 확인 화면을 그리고 선다. 실물과 같은 순서다:
    // 입력창 표시가 **먼저**, 관문이 **나중**이다 — `looksLikeGate` 가 있다/없다가 아니라
    // 순서로 판정하는 이유가 이 픽스처에 그대로 들어 있다.
    setTimeout(() => process.stdout.write(
      '\nAuto mode classifier requires confirmation for this command.\n'
      + '3 consecutive actions were blocked. Please review the transcript before continuing.\n'
      + '\nDo you want to proceed?\n\u276f 1. Yes\n  2. Yes, and do not ask again\n  3. No\n',
    ), 50);
  });
  setInterval(() => {}, 1_000);
}

// 2026-09-09 프로덕션의 그 모양: 붙여넣기는 입력창에 들어갔는데 **전송이 삼켜진다.**
// 붙여넣기와 같은 덩어리로 온 개행은 무시하고, 그 뒤에 따로 오는 개행 하나에만 반응한다 —
// 러너의 확인 창이 "증거가 없으면 개행을 한 번 더 쏜다"를 지키는지 재는 데 쓴다.
if (mode === 'swallowed-enter') {
  setTimeout(() => process.stdout.write('READY\n❯ '), 100);
  process.stdin.setEncoding('utf8');
  let 붙었나 = false;
  process.stdin.on('data', (d) => {
    if (!붙었나) {
      // 붙여넣기 덩어리는 받아 두고 전송은 못 본 척한다(같은 청크의 \r 을 무시한다).
      if (d.includes('[201~')) 붙었나 = true;
      return;
    }
    // 뒤늦게 온 개행 하나 — 이제 전송된다.
    if (d.includes('\r') || d.includes('\n')) { process.stdout.write('injected:재전송'); process.exit(0); }
  });
  setInterval(() => {}, 1_000);
  setTimeout(() => process.exit(24), 20_000); // 안전망
}

// 되살린 턴(`claude -r`)의 **재생** 흉내(2026-09-09). 앞 대화를 되그리는 동안 화면에
// 입력창 표시(NBSP 포함)가 스치지만, 그때 온 붙여넣기는 **사라진다** — 입력창이 아직
// 그려지지 않았기 때문이다. 재생이 끝난 뒤에 온 것만 받는다.
if (mode === 'replay-then-ready') {
  let 재생중 = true;
  const t = setInterval(() => process.stdout.write('과거대화 ❯ \n'), 100);
  setTimeout(() => {
    clearInterval(t);
    재생중 = false;
    process.stdout.write('\n❯ ');   // 이제 진짜 입력창이다
  }, 600);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    if (재생중) return;                        // 재생 중 붙여넣기는 아무 데도 안 간다
    if (d.includes('[201~')) { process.stdout.write(`injected:${d}`); process.exit(0); }
  });
  setTimeout(() => process.exit(25), 8_000); // 안전망
}

// 쉬지 않고 그리는 화면(스피너). 정적이 영영 오지 않으므로 정적 상한이 없으면 프롬프트가
// 한 번도 안 들어간다 — 그 상한이 사는지 재는 데 쓴다. 이쪽은 그리는 중에도 받는다.
if (mode === 'never-quiet') {
  setInterval(() => process.stdout.write('❯ '), 50);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    if (d.includes('[201~')) { process.stdout.write(`injected:${d}`); process.exit(0); }
  });
  setTimeout(() => process.exit(26), 8_000); // 안전망
}
