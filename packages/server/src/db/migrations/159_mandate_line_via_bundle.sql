-- 묶음 카드 줄에서 정한 승인도 위임장 줄을 적는다 — 어디서 눌렀는지 `via` 로 남긴다(감사·카드 meta 의 `via: bundle` 과 같다).
alter table mandate_line drop constraint mandate_line_via_check;
alter table mandate_line add constraint mandate_line_via_check check (via in ('button', 'chat', 'mirror', 'bundle', 'standing', 'system'));
