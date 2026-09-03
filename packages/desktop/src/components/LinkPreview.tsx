import { useEffect, useState } from 'react';
import { getController } from '../state/controller';
import { useAppStore } from '../state/appStore';
import type { LinkPreviewView } from '@murmur/shared';

/**
 * 본문 아래 붙는 링크 카드(#215).
 *
 * **v1 은 텍스트만이다.** `imageUrl` 을 받아 두고도 `<img>` 로 그리지 않는 이유가 이 기능의
 * 전제다: 이미지를 그리면 그 링크를 본 사람마다 자기 기기에서 외부 서버를 치게 되고, 그것이
 * 바로 "서버가 가져온다"는 결정 1 을 어기는 것이다(사람마다 IP 가 샌다). 바이트를 프록시하는
 * 것은 후속 이슈다.
 *
 * **아무것도 없을 때는 아무것도 그리지 않는다.** 뼈대(스켈레톤)도 두지 않는다 — 링크가 많은
 * 채널에서 대부분의 링크는 카드가 없고(사설·실패·og 없음), 그러면 회색 상자만 줄줄이 남는다.
 * 빈 카드는 "무언가 있는데 못 읽었다"는 거짓을 말한다.
 */
export function LinkPreview({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreviewView | null>(null);
  // 가져오기는 비동기라 메시지가 먼저 뜬다 — 서버가 "준비됐다"고 하면 다시 읽는다(#215).
  // 이 신호가 없으면 카드는 이 메시지를 다시 그릴 때까지(사실상 앱을 다시 켤 때까지) 안 보인다.
  const readyAt = useAppStore((s) => s.linkPreviewReadyAt[url]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 실패(404·오프라인·5xx)는 조용히 넘어간다 — 카드는 장식이고, 없으면 링크가 그대로
      // 남는다. 사람에게 알릴 실패가 아니다.
      const data = await getController().api.getLinkPreview(url).catch(() => null);
      if (!cancelled) setPreview(data);
    })();
    return () => { cancelled = true; };
  }, [url, readyAt]);

  if (!preview || preview.status !== 'ok') return null;
  if (!preview.title && !preview.description && !preview.siteName) return null;

  return (
    <div className="mt-2 rounded border border-slate-200 p-3" data-testid="link-preview">
      {preview.siteName && (
        <div className="text-xs text-slate-500">{preview.siteName}</div>
      )}
      {preview.title && (
        <div className="font-semibold text-slate-900">{preview.title}</div>
      )}
      {preview.description && (
        <div className="mt-1 text-sm text-slate-600">{preview.description}</div>
      )}
      <a
        href={preview.url}
        rel="noreferrer noopener"
        className="mt-2 block truncate text-xs text-slate-400 hover:text-slate-600"
      >
        {preview.url}
      </a>
    </div>
  );
}
