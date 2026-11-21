-- 메모리 체계화 O2 · P2(설계 harkroom://message/dfad81b8 2·4절 L3): 백그라운드 회차 종류 organize(주간 구조 정리)를 더한다.
-- 위생(cleanup)·증류(distill)는 있으나 「체계」를 만드는 단계가 없었다 — 분야 접두(mem/<area>/…)·목차(mem/map)·모순 해소.
alter table bg_job drop constraint bg_job_kind_check;
alter table bg_job add constraint bg_job_kind_check check (kind in ('distill', 'cleanup', 'organize'));
