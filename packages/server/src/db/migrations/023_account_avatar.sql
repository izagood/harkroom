-- 계정 프로필 사진(#159). 새 파일 저장소를 만들지 않고 `attachment` 를 그대로 가리킨다 —
-- 저장소가 둘이면 백업 순서 규칙(operations.md: 파일 볼륨 먼저, DB 나중)도 둘이 되고,
-- 하나를 빠뜨리는 순간 복구 뒤에 '깨진 아바타'가 남는다.
alter table account add column avatar_attachment_id uuid references attachment(id);

-- `on delete cascade` 도 `on delete set null` 도 **일부러 붙이지 않는다.**
-- 아바타는 어떤 메시지에도 붙지 않으므로 `attachment_unattached_idx`(006) 가 예고한
-- "붙지 않은 채 오래된 업로드" GC 의 검색 결과에 그대로 걸린다. 그때 이 제약이 없으면
-- GC 가 사람들의 얼굴을 조용히 지운다. 제약을 restrict 로 두면 그 삭제가 **소리 내어**
-- 실패하고, GC 를 쓰는 쪽이 아바타를 제외하도록 고치게 된다.
create index if not exists account_avatar_idx on account (avatar_attachment_id)
  where avatar_attachment_id is not null;
