-- 비밀 보관소 키 확인값(KCV). kid 하나에 키 하나가 묶였음을 기억한다.
--
-- 같은 kid 이름 아래 다른 키가 걸리면, 그 키로 봉인한 새 값과 원래 키로 봉인한 옛 값이 섞여
-- 어느 쪽 키를 걸어도 한쪽이 풀리지 않는다. 서버는 기동 때 마운트한 키의 KCV 를 이 행과
-- 비교하고, 다르면 그 kid 로는 봉인도 풀기도 하지 않는다(secretKeyCheck.ts).
--
-- 행은 처음 한 번만 들어가고 **고쳐 쓰지 않는다** — 고쳐 쓰는 길이 있으면 틀린 키가 걸린
-- 서버가 스스로를 정답으로 만든다. 키를 바꾸려면 새 kid 를 쓴다.
create table secret_key_check (
  kid        text primary key check (kid ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  kcv        bytea not null check (octet_length(kcv) = 16),
  created_at timestamptz not null default now()
);
