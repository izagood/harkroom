-- 러너 종료 요청(#129). **재시작이 아니라 종료 요청이다.**
-- murmur 는 러너 프로세스를 띄우지 않는다(docs/design.md §1 "외부 접속형", §6 스코프 제외).
-- 서버가 할 수 있는 것은 러너에게 "지금 턴을 끝내고 스스로 물러나 달라"고 부탁하는 것까지고,
-- 다시 띄우는 것은 운영자(또는 그 사람의 launchd/systemd 감독)의 몫이다. 그래서 컬럼 이름도
-- restart 가 아니라 stop 이다 — 이름이 murmur 가 하지 않는 일을 약속하면 안 된다(§4).
--
-- 불리언이 아니라 시각인 이유는 009_agent_disable.sql 과 같다: "언제 요청했나"가 감사·운영에
-- 필요하고, null 이 곧 '요청 없음'이라 기본값 backfill 이 필요 없다. 기존 행은 전부 null 로 남는다.
--
-- requested_by 를 함께 남기는 이유: 남의 러너를 멈추는 조작이다. audit_log 에도 남기지만,
-- 정의 옆에 행위자가 있어야 "이 러너가 왜 서 있나"를 이 한 행만 보고 답할 수 있다.
--
-- acked 를 따로 두는 이유: 러너가 종료하면 그 다음 GET /agent/config 도 오지 않는다. 그래서
-- 서버는 프로세스가 실제로 죽었는지 **영원히 모른다** — 알 수 있는 것은 "러너가 그 요청을
-- 읽어 갔다"까지다. 요청과 수령을 한 컬럼으로 뭉개면 화면이 '아직 못 봤다'와 '받아 갔다'를
-- 구분하지 못하고, 구분이 없으면 UI 는 결국 '멈췄다'고 단정하게 된다(§4 위반).
--
-- 컬럼 추가만이라 옛 코드와 호환된다 — 롤백은 '되돌리기'가 아니라 '안 쓰기'다.
alter table agent_config add column stop_requested_at timestamptz;
alter table agent_config add column stop_requested_by uuid references account(id);
alter table agent_config add column stop_acked_at timestamptz;
