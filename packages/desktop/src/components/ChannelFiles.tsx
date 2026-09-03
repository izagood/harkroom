import { useCallback, useEffect, useState } from 'react';
import type { ChannelFileRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { formatSize } from './Attachments';

/**
 * 채널 파일 색인(#232) — 이 채널에 오간 첨부를 최신순으로 모아 보여 준다.
 *
 * **이번에는 첨부만이다. 본문 링크는 포함하지 않는다.** 첨부는 `attachment` 행으로 이미
 * 존재하므로 질의만 있으면 되지만, 링크는 본문을 훑어 뽑아낸 뒤 그 결과를 저장할지
 * 매번 계산할지까지 정해야 한다 — 그건 별개 작업이다. #214 가 본문 링크 인식
 * (`lib/link.ts` 의 `splitLinks`)을 넣었으니 나중에 그것을 재사용할 수 있다.
 */
export function FilesPanel({ files, loading, error, hasMore, onRetry, onLoadMore, onClose, onOpen }: {
  files: ChannelFileRow[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onClose: () => void;
  onOpen: (file: ChannelFileRow) => void;
}) {
  const accounts = useAppStore((s) => s.accounts);

  return (
    <section className="flex w-80 flex-col border-l border-zinc-200 bg-white" aria-label="채널 파일">
      <header className="flex items-center border-b border-zinc-200 px-4 py-2">
        <span className="font-bold">파일</span>
        <button className="ml-auto rounded px-2 text-zinc-500 hover:bg-zinc-100"
          onClick={onClose} aria-label="파일 목록 닫기">×</button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {loading && <p className="p-4 text-sm text-zinc-500">불러오는 중…</p>}

        {/* 못 불러온 것과 파일이 없는 것은 **다른 상태다.** 조회 실패를 빈 목록으로 삼키면
            화면이 "오간 파일이 없다"고 말하게 되고, 그것은 거짓말이다(docs/design.md §4).
            그래서 오류일 때는 '없다' 문구를 그리는 분기 자체에 닿지 않는다. */}
        {!loading && error && (
          <div className="p-4">
            <p role="alert" className="text-sm text-red-600">파일 목록을 불러오지 못했다: {error}</p>
            <button className="mt-2 rounded border border-zinc-300 px-2 py-1 text-[11px] text-zinc-600"
              onClick={onRetry}>다시 시도</button>
          </div>
        )}

        {!loading && !error && !files.length && (
          <p className="p-4 text-sm text-zinc-500">아직 오간 파일이 없다</p>
        )}

        {!loading && !error && files.length > 0 && (
          <ul className="divide-y divide-zinc-100">
            {files.map((f) => (
              <li key={f.id}>
                {/*
                  누르면 그 메시지로 간다 — 내려받기가 아니다. 파일을 다시 찾는 사람이 원하는
                  것은 대개 바이트가 아니라 그 파일이 오간 맥락이고, 내려받기는 그 메시지의
                  첨부 버튼(`Attachments`)에 이미 있다.
                */}
                <button
                  className="block w-full px-4 py-2 text-left hover:bg-zinc-50"
                  onClick={() => onOpen(f)}
                >
                  <span className="block truncate text-[13px] font-medium text-zinc-800">{f.filename}</span>
                  <span className="block text-[11px] text-zinc-500">
                    {formatSize(f.sizeBytes)} · @{accounts[f.authorId]?.handle ?? f.authorId}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!loading && !error && hasMore && (
          <div className="px-4 py-2 text-center">
            <button className="rounded border border-zinc-300 px-2 py-1 text-[11px] text-zinc-600"
              onClick={onLoadMore}>더 오래된 파일</button>
          </div>
        )}
      </div>
    </section>
  );
}

/** 한 페이지에 담을 메시지 수. 서버의 `limit` 은 메시지를 센다(첨부가 아니다). */
const PAGE = 50;

/** 이 채널의 파일을 불러와 `FilesPanel` 에 넘긴다. */
export function ChannelFiles({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const [files, setFiles] = useState<ChannelFileRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** `before` 가 없으면 첫 페이지다. 이어 붙일 때는 기존 목록 뒤에 놓는다(최신순 유지). */
  const load = useCallback(async (before?: number) => {
    setLoading(true);
    setError(null);
    try {
      const page = await getController().api.channelFiles(channelId, { before, limit: PAGE });
      setFiles((prev) => (before === undefined ? page.files : [...prev, ...page.files]));
      setHasMore(page.hasMore);
    } catch (e) {
      // 실패했으면 이전 목록도 버린다 — 남겨 두면 오류 문구 옆에 낡은 목록이 함께 보인다.
      setFiles([]);
      setHasMore(false);
      setError(e instanceof Error ? e.message : '알 수 없는 오류');
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <FilesPanel
      files={files}
      loading={loading}
      error={error}
      hasMore={hasMore}
      onRetry={() => void load()}
      onLoadMore={() => { const last = files[files.length - 1]; if (last) void load(last.messageSeq); }}
      onClose={onClose}
      // 패널은 닫지 않는다. 파일 하나를 찾으러 온 사람이 대개 두세 개를 확인하고,
      // 누를 때마다 닫히면 그때마다 다시 열어 처음부터 스크롤해야 한다.
      onOpen={(f) => void getController().openMessage(f.messageId)}
    />
  );
}
