-- 1회 머지·CI 실패 무시 승인에서 gh 계정을 비워 둘 수 있다(G1: 사람의 결정은 서버가 진실, 실행 수단은 에이전트가 도는 오퍼레이터가 고른다).
-- `gh_user` 가 null 이면 래퍼가 그 저장소용 계정(`ghUserFor`, 7일 grant 와 같은 길)으로 머지한다 — 없으면 머지하지 않는다(`no_gh_user`).
-- 값이 있으면 지금처럼 래퍼는 그 계정만 쓴다(fallback 없음).
alter table merge_approval alter column gh_user drop not null;
