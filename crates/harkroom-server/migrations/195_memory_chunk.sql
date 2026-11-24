-- 기억 벡터 검색(V3) — 기억을 조각으로 나눈 임베딩. 조각 하나가 한 줄이다.
--
-- pgvector 는 이미지에 없을 수 있고 `create extension` 은 슈퍼유저를 요구할 수 있다. 044 와 같은 관례로 켤 수 없으면 조용히
-- 넘어간다 — 표가 없으면 서버는 채우기 루프를 띄우지 않고 낱말 검색만 쓴다. 나중에 확장을 깔았으면 마이그레이션 역할로
-- `select memory_chunk_setup();` 을 한 번 부르고 쓰기 역할에 GRANT 를 준 뒤 서버를 다시 띄운다.
--
-- - 본문 사본을 두지 않는다. `start_char`·`len_char` 는 `agent_memory.value` 안의 자리다(`doc_hash` 가 같을 때만 맞다).
-- - 종류·보관·숨김 표시도 베끼지 않는다 — 읽을 때 `agent_memory` 를 조인한다.
-- - 차원을 칸에 박지 않는다(`vector`). 모델이 바뀌면 `model`·`dim` 이 다른 줄은 낡은 것이라 다시 만든다. 견줄 때는 둘 다 거른다.
-- - 근사 색인(HNSW)은 만들지 않는다 — 에이전트 하나로 먼저 거르면 수백~천 조각이다.
create function memory_chunk_setup() returns boolean language plpgsql as $$
begin
  if not exists (select 1 from pg_extension where extname = 'vector') then
    begin
      create extension if not exists vector;
    exception
      when insufficient_privilege or undefined_file or feature_not_supported then
        raise notice 'pgvector unavailable — memory search stays word-only';
        return false;
    end;
  end if;
  create table if not exists agent_memory_chunk (
    account_id uuid not null,
    slug text not null,
    source text not null check (source in ('body', 'description')),
    idx integer not null check (idx >= 0),
    start_char integer not null check (start_char >= 0),
    len_char integer not null check (len_char >= 0),
    doc_hash text not null,
    model text not null,
    dim integer not null,
    embedding vector not null,
    created_at timestamptz not null default now(),
    primary key (account_id, slug, source, idx),
    foreign key (account_id, slug) references agent_memory (account_id, slug)
      on update cascade on delete cascade,
    check (vector_dims(embedding) = dim)
  );
  return true;
end $$;
revoke execute on function memory_chunk_setup() from public;

select memory_chunk_setup();
