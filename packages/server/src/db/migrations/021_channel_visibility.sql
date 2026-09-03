-- 채널마다 공개 범위를 고른다(#156, #182).
--
-- public: 지금까지의 동작 그대로다. 전원에게 보이고, 멤버십은 구독(사이드바·알림)일 뿐이라
--   멤버가 아니어도 읽고 쓸 수 있다.
-- private: 멤버만 존재를 안다. 목록·검색·미읽음 배지 어디에도 뜨지 않고, id 를 직접 알아도
--   메시지는 403 이다.
--
-- check 제약을 두는 이유: 값 집합이 애플리케이션 코드에만 있으면 수동 SQL 이나 다음
-- 마이그레이션이 'secret' 같은 값을 넣어도 DB 가 막지 못한다. 그런 행이 생기면 화면은
-- 모르는 값에 아무것도 그리지 못하고, 가시성 술어는 그 채널을 어느 쪽으로도 분류하지 못한다.
-- (004 의 harness 판례처럼 애플리케이션 검증에 맡기는 컬럼도 있지만, 이건 가시성이다 —
--  잘못된 값의 결과가 '표시가 이상하다'가 아니라 '보이면 안 되는 것이 보인다'다.)
--
-- 기존 행 backfill 없음. 기본값이 'public' 이라 기존 채널은 전부 지금과 같이 남는다.
-- 008 이 소유자에 대해 적은 것과 같은 이유다 — 추측 소유자는 소유자가 아니다. 지금 있는
-- 표준 채널을 private 으로 바꾸면서 멤버를 '최근 발언자'로 채우면, 조용히 읽기만 하던
-- 사람이 채널을 통째로 잃는다. private 전환은 admin 이 멤버를 직접 지정할 때만 일어난다.
alter table channel
  add column visibility text not null default 'public'
    check (visibility in ('public', 'private'));

-- private 채널의 멤버십 조회가 가시성 술어의 모든 질의에 들어간다(목록·배지·검색·읽기 게이트).
-- 001 의 기본키가 (channel_id, account_id) 라 '이 계정이 어느 채널의 멤버인가'는 인덱스를
-- 타지 못한다 — 그 방향이 매 요청마다 도는 쪽이다.
create index if not exists channel_member_account_idx on channel_member (account_id);
