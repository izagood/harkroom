-- 검색 회수율: `simple` tsvector 는 어간을 떼지 않으므로 한국어가 조사 하나에 걸린다.
-- 실측: to_tsvector('simple','검색을 켜고') @@ websearch_to_tsquery('simple','검색') → false.
-- 조사·파일명·부분 식별자는 **접두 tsquery**(`'검색':*`)가 기존 tsvector GIN 그대로 잡는다
-- (services/messages.ts::PREFIX_TSQUERY). 그래도 남는 구멍이 **중간일치**다 — `검색` 으로
-- `재검색`. 그 갈래(lower(body) like '%q%')를 이 인덱스가 받는다.
--
-- 이 인덱스는 **3글자 이상**에만 값을 낸다: gin_trgm_ops 는 2글자 패턴에서 트라이그램 키를
-- 못 뽑아 순차 스캔이 되고, OR 로 묶이면 tsvector 인덱스까지 함께 버려진다. 그래서 like
-- 갈래는 char_length >= 3 에서만 켠다(같은 파일의 SEARCH_MATCH 주석에 실측값이 있다).
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
