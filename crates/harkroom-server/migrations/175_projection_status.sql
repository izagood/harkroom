-- avcs 투영 상태(decision 4, Rust 전환). TS 는 이 값을 워커 메모리(`ProjectionWorker.runtime`)에만 들고 있었다 —
-- 그래서 `/projection/status` 는 워커를 쥔 그 프로세스만 답할 수 있었다. 투영 루프가 Rust 로 오면서 상태를 이 표 한 줄에 둔다.
--
-- - 줄은 하나다(`id = true`, `projection_config` 와 같은 꼴). 루프가 사이클마다 고친다.
-- - 칸은 shared `ProjectionRuntime` + `connected` 와 같다. 시각은 ms(epoch) 정수 — 응답 JSON 이 ms 를 싣는다.
-- - `avcs_base_url` 은 이 상태가 어느 서버를 본 결과인가. 서버가 바뀌면 루프가 상태를 새로 시작한다(TS 의 워커 교체와 같다).
-- - 쓰기 역할 GRANT: select, insert, update(칸 단위). 없으면 Rust 는 루프를 띄우지 않는다(TS 에 남는다).
create table if not exists projection_status (
  id boolean primary key default true check (id),
  avcs_base_url text,
  configured boolean not null default false,
  connected boolean not null default false,
  repo text,
  last_log_index bigint not null default 0,
  last_polled_at bigint,
  last_advanced_at bigint,
  last_error text,
  updated_at timestamptz not null default now()
);
