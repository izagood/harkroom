-- 투영이 바라볼 avcs 서버 주소를 **앱에서** 정할 수 있게 한다.
--
-- 지금까지 이 값은 `AVCS_BASE_URL` 환경변수뿐이었고, 바꾸려면 VM 에 붙어 서버를
-- 재시작해야 했다. 그 자리를 DB 로 옮기면 admin 이 설정 화면에서 켤 수 있다.
-- env 를 없애지는 않는다 — 앱 값이 없을 때의 기본값으로 남는다(resolveProjectionUrl).
--
-- 행이 하나뿐인 테이블이다. `id boolean primary key check (id)` 가 그것을 강제하는
-- 관용구다(017_agent_defaults.sql 과 같다): PK 유일성이 두 번째 true 행을 막고 check 가
-- false 행을 막는다. 행이 둘이면 "투영 URL 이 무엇인가" 에 답이 둘이 되고, 어느 쪽을
-- 읽느냐가 정렬 순서 같은 우연에 달린다.
create table projection_config (
  id boolean primary key default true check (id),
  -- null 이면 '앱에서 정한 것이 없다' → env 로 떨어진다.
  -- 빈 문자열을 '없음' 으로 쓰지 않는다: 섞으면 지우기와 오타 저장이 같은 값이 된다.
  -- URL 형식 검증은 애플리케이션이 한다 — 허용 프로토콜은 코드와 함께 바뀌므로
  -- 스키마 제약으로 굳히지 않는다(004_agent_config.sql 의 harness 와 같은 이유).
  avcs_base_url text check (avcs_base_url is null or length(avcs_base_url) > 0)
);

-- 읽는 쪽이 "행이 없다" 를 따로 다루지 않도록 처음부터 한 행을 둔다.
insert into projection_config (id) values (true);
