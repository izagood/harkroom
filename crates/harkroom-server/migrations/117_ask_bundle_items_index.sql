-- 묶음 카드(선택 카드 P1, 3c): 원본 카드가 어느 묶음에 담겼는지(`items @> [{rootId}]`)를 스레드 집계마다 묻는다
-- (`askBundleSql.ts::bundledRootSql`, `syncAskBundles`). 묶음 글은 적으므로 부분 색인으로 둔다.
CREATE INDEX IF NOT EXISTS message_ask_bundle_items_idx
  ON message USING gin ((meta->'askBundle'->'items') jsonb_path_ops)
  WHERE meta->>'kind' = 'askBundle';
