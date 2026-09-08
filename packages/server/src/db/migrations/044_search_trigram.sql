-- 검색 회수율(#): `simple` tsvector 는 어간을 떼지 않으므로 한국어가 조사 하나에 걸린다.
-- 실측: to_tsvector('simple','검색을 켜고') @@ websearch_to_tsquery('simple','검색') → false.
-- 파일명·부분일치도 같은 이유로 죽는다. 그래서 질의를 tsvector 매치 **또는** 부분문자열
-- (lower(body) like '%q%') 두 갈래로 두고, 두 번째를 이 인덱스가 받는다.
--
-- pg16 에 한국어 text search config 이 없고(pg_bigm 도 이 이미지엔 없다) 그래서 trigram 이
-- 현실적인 답이다.
--
-- `create extension` 은 슈퍼유저를 요구할 수 있다. 여기서 그냥 터뜨리면 **서버가 부팅하지
-- 못한다** — 인덱스는 어디까지나 최적화이고 like 질의 자체는 확장 없이도 맞는 답을 주므로,
-- 확장을 못 켜는 배포에서는 조용히 넘어가고(느릴 뿐이다) 켤 수 있는 곳에서만 인덱스를 만든다.
do $$
begin
  create extension if not exists pg_trgm;
exception
  when insufficient_privilege or undefined_file or feature_not_supported then
    raise notice 'pg_trgm unavailable — search falls back to a sequential scan for substring matches';
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    execute 'create index if not exists message_body_trgm_idx on message using gin (lower(body) gin_trgm_ops)';
  end if;
end $$;
