-- 키 연결이 비밀을 **id 로** 가리킨다(J2a). 185 는 비밀 이름을 베껴 두고 이름으로 비밀을 찾았다 — 이름은 바뀌거나
-- 지워진 뒤 다른 사람이 다시 쓸 수 있어, 연결이 조용히 다른 비밀을 가리키게 된다.
--
-- - `secret_id`: 정본. 비밀이 지워지면 null 이 된다(`on delete set null`) — 그 연결은 「주인 없는 줄」이고, 같은 이름의
--   비밀이 새로 생겨도 다시 이어지지 않는다. 주인 없는 연결은 고칠 수 없고 지울 수만 있다(`core/exec_combo.rs`).
-- - `secret_name`: 남긴다. 연결을 만들거나 고칠 때 베낀 **표시용** 이름이다 — 권한 판정에는 쓰지 않는다.
-- - 옛 줄은 이름이 지금 맞는 비밀로 한 번 잇는다(185 에서는 쓰는 HTTP 길이 없었다).
-- - 새 GRANT 는 없다 — 칸을 더할 뿐이고 표 권한(185)이 그대로 덮는다.
alter table exec_key_link
  add column if not exists secret_id uuid references secret(id) on delete set null;

update exec_key_link k
   set secret_id = s.id
  from secret s
 where k.secret_id is null and s.name = k.secret_name;

create index if not exists exec_key_link_secret_idx on exec_key_link (secret_id);
