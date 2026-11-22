-- H1 기기 표지 — 오퍼레이터가 hello 에 싣는 「어떤 기기에 어떤 꼴로 깔렸나」를 적어 둔다.
--
-- - `platform`(macos·linux …) · `arch`(aarch64·x86_64 …) · `install_kind`(app = 데스크톱 앱 번들 · bundle = 릴리스 묶음 · dev)
--   · `update_channel`(띄운 쪽이 알려 줄 때만). 넷 다 소문자·숫자·`_`·`.`·`-` 1~32자만 받는다(서버가 hello 에서 거른다).
-- - `version`(075)처럼 hello 마다 덮는다. null 은 「안 실어 보냄」(옛 오퍼레이터 포함)이다.
-- - 적기만 한다 — 일 배정·권한 판정은 이 칸을 읽지 않는다.
-- - 쓰기 역할 GRANT 추가 없음: `operator` 표의 UPDATE 는 이미 있다.
alter table operator add column if not exists platform text;
alter table operator add column if not exists arch text;
alter table operator add column if not exists install_kind text;
alter table operator add column if not exists update_channel text;
