-- 프로필 사진 맞추기(S1). 걸린 아바타(`avatar_attachment_id`)는 앱이 원을 512px 로 잘라 올린 결과이고,
-- 여기 두 칸은 **다시 맞출 때** 원본 전체에서 지난번 자리로 시작하려고 남기는 것이다.
-- 그리는 쪽(데스크톱·모바일·푸시)은 이 칸을 읽지 않는다 — 잘린 정사각형만 보면 된다.
--
-- 원본도 `attachment` 를 가리키고, 023 과 같은 이유로 `on delete` 를 붙이지 않는다: 고아 업로드 GC 가
-- 생기면 원본을 조용히 지우지 말고 소리 내어 실패해야 한다.
alter table account
  add column if not exists avatar_source_attachment_id uuid references attachment(id),
  -- `AvatarCrop`(shared) — 원본 크기에 대한 비율 {x, y, size}. 원본이 없으면 null.
  add column if not exists avatar_crop jsonb;

create index if not exists account_avatar_source_idx on account (avatar_source_attachment_id)
  where avatar_source_attachment_id is not null;
