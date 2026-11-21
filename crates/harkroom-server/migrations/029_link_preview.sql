-- #215: 링크 미리보기
-- URL 정규화 키로 저장한다: 스킴·호스트 소문자, 기본 포트 제거, fragment 제거
-- 같은 URL 은 한 번만 가져온다
create table link_preview (
  url text primary key,
  title text null,
  description text null,
  image_url text null,
  site_name text null,
  status text not null,
  -- 'ok' | 'failed' | 'blocked'
  fetched_at timestamptz not null default now()
);