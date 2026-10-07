-- 「정확한 명령」 grant 를 파일 내용·cwd 에 묶는다(H③a, 스레드 8769dbf7, security F1·C1·C2).
--
-- 승인은 명령 글자에 묶이는데, `--patch-file /x.json`·`-f /m.yaml`·`--kubeconfig /k` 같은 명령은 파일 내용이 바뀌면 같은 글자가
-- 다른 일을 한다. 그래서 요청 때 **오퍼레이터가** 그 파일들의 sha256 을 재서(헤더 `x-harkroom-command-files`, MCP 본문이 아니다)
-- 요청 줄에 두고, 승인하면 grant 로 옮기고, match 때 오퍼레이터가 다시 잰 값과 **모두 같을 때만** 연다. 어느 파일이 대상인지는
-- 서버가 명령에서 직접 뽑는다(shared validateExactCommand.files) — 경로 집합이 다르면 거절(C1).
--
-- `bound_cwd`: 1시간 grant 는 처음 match 된 hook 입력의 cwd 에 묶인다(파일 인자 없는 명령도 cwd 로 뜻이 바뀔 수 있다).
alter table permission_request add column file_digests jsonb not null default '[]';
alter table command_grant add column file_digests jsonb not null default '[]';
alter table command_grant add column bound_cwd text;
