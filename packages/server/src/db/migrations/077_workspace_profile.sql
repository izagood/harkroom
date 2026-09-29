-- 워크스페이스 아이콘 — 데스크탑 좌측 커뮤니티 레일의 사진(2026-09-29).
--
-- 지금까지 레일은 호스트명 첫 글자만 그렸다. 커뮤니티마다 서버가 따로이므로 "이 워크스페이스의
-- 얼굴" 은 그 서버가 알아야 모든 멤버·모든 기기에서 같은 사진이 나온다(로컬 저장이면 각자 다르다).
--
-- 행이 하나뿐인 테이블이다(041 projection_config 와 같은 관용구): PK 유일성이 두 번째 true 행을
-- 막고 check 가 false 행을 막는다. 이름·설명 같은 워크스페이스 메타가 더 생기면 여기에 붙인다.
create table workspace_profile (
  id boolean primary key default true check (id),
  -- 023 account.avatar_attachment_id 와 같은 이유로 새 파일 저장소를 만들지 않고 attachment 를
  -- 가리킨다. `on delete` 도 일부러 붙이지 않는다 — 붙지 않은 업로드 GC 가 생기면 이 사진을
  -- 조용히 지우는 대신 **소리 내어** 실패하게 둔다.
  icon_attachment_id uuid references attachment(id)
);

-- 읽는 쪽이 "행이 없다" 를 따로 다루지 않도록 처음부터 한 행을 둔다.
insert into workspace_profile (id) values (true);
