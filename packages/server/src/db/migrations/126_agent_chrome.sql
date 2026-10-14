-- 에이전트별 Claude in Chrome 연동(스레드 e8c8365d). 켜진 에이전트의 claude 턴에만 러너가 `--chrome` 을
-- 붙이고, 꺼진 에이전트에는 `--no-chrome` 을 명시한다(claude 가 확장 설치를 보고 스스로 켜는 길을 닫는다).
-- 사람의 브라우저를 조작하는 권한이라 **기본 꺼짐**이고, 켜고 끈 기록은 감사 로그(`agent.updated`)에 남는다.
-- 서버는 값만 든다 — 확장·native host 유무와 원격 오퍼레이터 차단은 러너가 그 기계에서 판정한다.
alter table agent_config add column chrome_enabled boolean not null default false;
