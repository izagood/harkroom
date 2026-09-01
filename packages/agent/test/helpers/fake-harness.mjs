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
