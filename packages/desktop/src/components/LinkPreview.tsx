import { useEffect, useState } from 'react';
import { getController } from '../state/controller';
import { useActiveStore } from '../state/communities';
import type { LinkPreviewView } from '@harkroom/shared';
import { peekLinkPreview, storeLinkPreview } from '../lib/linkPreviewCache';

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
  // 받아 둔 응답이 있으면 **첫 렌더부터** 그린다 — 가상 목록에서 줄이 다시 마운트될 때 카드가
  // 늦게 붙으면 줄 높이가 바뀌어 스크롤이 튄다(스레드 bf24d7bd ①, `linkPreviewCache`).
  const [preview, setPreview] = useState<LinkPreviewView | null>(() => peekLinkPreview(url)?.view ?? null);
  // 가져오기는 비동기라 메시지가 먼저 뜬다 — 서버가 "준비됐다"고 하면 다시 읽는다(#215).
  // 이 신호가 없으면 카드는 이 메시지를 다시 그릴 때까지(사실상 앱을 다시 켤 때까지) 안 보인다.
  const readyAt = useActiveStore((s) => s.linkPreviewReadyAt[url]);

  useEffect(() => {
    let cancelled = false;
    const cached = peekLinkPreview(url);
    if (cached) setPreview(cached.view);
    if (cached?.fresh(readyAt)) return;
    void (async () => {
      try {
        const data = await getController().api.getLinkPreview(url);
        storeLinkPreview(url, readyAt, data);
        if (!cancelled) setPreview(data);
      } catch {
        // 실패(404·오프라인·5xx·컨트롤러 없음)는 조용히 넘어간다 — 카드는 장식이고, 없으면
        // 링크가 그대로 남는다. 사람에게 알릴 실패가 아니다.
        //
        // **`try` 가 `getController()` 까지 감싸는 것이 중요하다.** 반환값에만 `.catch` 를
        // 걸면 컨트롤러가 아직(또는 이미) 없을 때 던지는 것이 `.catch` 밖이라 잡히지 않고,
        // 화면 밖에서 unhandled rejection 이 된다. 이미 그린 카드는 지우지 않는다 —
        // 한 번 실패했다고 보이던 것을 없애면 깜빡임만 남는다.
      }
    })();
    return () => { cancelled = true; };
  }, [url, readyAt]);

  if (!preview || preview.status !== 'ok') return null;
  if (!preview.title && !preview.description && !preview.siteName) return null;

  return (
    <div className="mt-2 rounded-row border border-border p-3" data-testid="link-preview">
      {/* 출처와 주소는 **아랫단 11px** 이다 — 읽는 것은 제목과 설명이고 이 둘은 그 카드가
          어디서 왔는지 알려 주는 꼬리표다. 제목은 크기를 안 적어 본문단 13px 을 물려받고,
          `font-semibold` 로만 도드라진다(같은 단 안에서 굵기로 위계를 낸다). */}
      {preview.siteName && (
        <div className="text-meta text-fg-subtle">{preview.siteName}</div>
      )}
      {/* 제목 한 줄·설명 두 줄로 자른다 — 긴 og 설명이 카드를 몇 배로 키우지 않게, 카드 높이의
          상한을 정해 둔다(스레드 bf24d7bd ①). 잘린 전문은 `title` 로 본다. */}
      {preview.title && (
        <div className="truncate font-semibold text-fg" title={preview.title}>{preview.title}</div>
      )}
      {preview.description && (
        <div className="mt-1 line-clamp-2 text-fg-muted" title={preview.description}>{preview.description}</div>
      )}
      <a
        href={preview.url}
        rel="noreferrer noopener"
        className="mt-2 block truncate text-meta text-fg-subtle hover:text-fg"
      >
        {preview.url}
      </a>
    </div>
  );
}
