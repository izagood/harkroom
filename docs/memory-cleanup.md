# 매일 기억 정리

에이전트 기억(`agent_memory`)은 쌓이기만 하면 200개 상한과 core 3,000자에 닿는다. 서버는 신호·후보·보관만 하고(결정론, LLM 없음),
**판단은 그 에이전트 자신의 정리 회차**가 한다. 자동화도 소유자 승인도 필요 없다.

## 모양

- 서버 루프 `memory.daily`(`loops/memory_daily.rs`)가 하루 한 번 에이전트마다 `bg_job`(kind `cleanup`)을 넣는다.
- 시각: 워크스페이스 설정 `GET·PUT /settings/memory-cleanup`(`enabled`·`time`·`tz`, 기본 켬·03:00·Asia/Seoul). 그때부터 2시간 안에서
  에이전트마다 흩는다. 새로 넣는 것은 설정 시각 뒤 4시간까지다.
- 꺼져 있던 에이전트: 회차는 24시간 기다린다. 그 사이 접속하면 한 번 집고, 넘기면 닫힌다(쌓이지 않는다).
- 건너뛰기: 지난 정리 뒤 기억 쓰기가 없고 정리 신호도 없으면 넣지 않는다.
- 에이전트별 끄기: `GET·PUT /accounts/agents/{id}/memory-cleanup`(기본 켬). 증류·구조 정리의 `bg_enabled` 와 따로다.
- 결과는 채팅에 쓰지 않는다. 바꾼 것은 `bg_job`·`bg_job_change` 에 남고 되돌릴 수 있다.
- 러너가 5분마다 `bg.claim` 으로 묻는다. 동시 턴 자리는 한 칸을 사람 턴 몫으로 남기고 잡는다.
- 지금 회차를 돌리는 하네스는 claude-code 뿐이다. API 키 연결 러너는 돌리지 않는다.

## 안전장치

- 회차는 core 를 쓰거나 기억을 지우지 못하고, 쓰기는 20건까지다. 보관은 지우기가 아니다.
- 정리 임대 `memory.lease` — 계정당 하나. 일반 턴이 정리 중이면 회차가 물러난다. 회차가 잡는 임대는 길어야 15분이다.
- 멈추기: 매일 정리는 `HARKROOM_BACKGROUND_ENABLED` 가 아니라 워크스페이스 설정(`PUT /settings/memory-cleanup`, admin)으로 멈춘다.
- 모든 고침은 이전 판을 남긴다.

## 옛 자동화

마이그레이션 193 이 제안 틀로 만든 기억 정리 자동화를 끈다(`paused_reason = 'replaced_by_builtin'`). 지우지는 않는다.
