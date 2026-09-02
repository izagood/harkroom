-- 채널 음소거·즐겨찾기 저장(#151, #152). 한 테이블에 두 컬럼인 이유: 두 이슈가 같은 저장소를
-- 요구한다 — 같은 사실을 두 테이블에 두면 조인이 둘이 되고, 한쪽만 정리하는 사고가 난다.
--
-- 불리언이 아니라 시각인 이유: 009_agent_disable.sql 이 같은 성질의 소프트 상태를 시각으로 둔
-- 선례이고 이유를 그 파일 주석에 적어뒀다 — "언제 껐나"가 감사·운영에 필요하고, null 이 곧
-- 활성이라 기본값 backfill 이 필요 없다.
--
-- on delete cascade 를 명시한 이유: 이 저장소는 on delete 절을 생략해 기본값 NO ACTION 이 걸린 FK
-- 로 인해 삭제가 막히는 곳이 있다(#155). 선호 행이 계정·채널보다 오래 살 이유가 없다.
create table channel_pref (
  account_id uuid not null references account(id) on delete cascade,
  channel_id uuid not null references channel(id) on delete cascade,
  muted_at   timestamptz,
  starred_at timestamptz,
  primary key (account_id, channel_id)
);