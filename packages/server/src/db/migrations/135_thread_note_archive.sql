-- 백그라운드 턴 G1 · BG3 증류 생산자(설계 harkroom://message/4a44f18a 4절 「메모」).
-- 증류가 끝난(done) 회차가 입력 스레드의 메모를 **보관**한다(지우지 않는다). 보관된 메모는 읽기·주입에서 빠지고,
-- 다시 쓰면 열린다. 회차를 되돌리면(BG4) 그 회차가 보관한 메모도 다시 연다 — 그래서 어느 회차가 보관했는지 적는다.
alter table thread_note add column archived_at timestamptz null;
alter table thread_note add column archived_by_run uuid null references bg_job(id) on delete set null;
create index thread_note_archived_by_run on thread_note (archived_by_run) where archived_by_run is not null;
