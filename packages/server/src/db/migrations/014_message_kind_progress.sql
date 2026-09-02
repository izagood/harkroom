-- 진행 설명 메시지(#144). message.kind 의 체크 제약을 넓힌다.
--
-- 이것이 없으면 kind='progress' 삽입이 제약 위반으로 실패한다 — 001_init.sql 이
-- check (kind in ('user','system')) 를 걸어 뒀다. 타입만 넓히면 컴파일은 통과하고
-- 런타임에 깨진다.
--
-- 왜 새 컬럼이 아니라 kind 인가: 이미 "이 메시지가 어떤 종류인가"를 담는 축이 있고,
-- system 이 그 축의 선례다(avcs 투영 산물이라 사람이 고칠 수 없다). progress 도 같은
-- 성질이다 — 결과 발화가 아니고 러너·UI 가 다르게 취급해야 하는 종류다. 축을 둘로
-- 만들면 "같은 사실을 두 곳에" 가 된다.
alter table message drop constraint message_kind_check;
alter table message add constraint message_kind_check
  check (kind in ('user', 'system', 'progress'));
