import { useEffect, useState } from 'react';
import type { ProjectionConfigView, ProjectionUrlSource } from '@murmur/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { Button, Field, TextInput } from './primitives';
import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n';

/**
 * 출처를 **사정마다 다른 말**로 적는다. 같은 말이면 화면이 env 와 앱 설정을 구별하지
 * 못하고, "env 를 넣었는데 왜 안 먹나" 를 화면에서 알 수 없다.
 *
 * **값이 아니라 키를 든다**(`Sidebar::NOTIFY_LEVEL_KEY` · `lib/presenceView.ts` 와 같은
 * 판례). 문구를 들면 모듈 로드 시점 언어로 굳어 `t()` 를 지나도 안 바뀐다. 표를 남기고
 * `ProjectionUrlSource` 로 색인하는 이유도 같다 — **세 번째 출처가 생기면 여기서
 * 컴파일이 막힌다.**
 */
const SOURCE_LABEL: Record<ProjectionUrlSource, MessageKey> = {
  app: 'projection.url.sourceApp',
  env: 'projection.url.sourceEnv',
};

/**
 * 투영이 바라볼 avcs 주소를 **앱에서** 정한다(`#537` 후속).
 *
 * ## 왜 상태 줄과 별 조각인가
 *
 * 위의 `ProjectionRow` 는 `/projection/status`(모든 로그인 사용자)를 읽어 "투영이 돌고
 * 있는가" 를 말한다. 이 줄은 `/settings/projection`(admin)을 읽어 "무엇을 바라볼 것인가" 를
 * 말한다. **두 사실의 출처가 다르므로** 한 줄에 합치지 않는다 — 합치면 한쪽 조회가
 * 실패했을 때 어느 사실을 못 읽은 것인지 화면이 말할 수 없다.
 *
 * ## 권한이 없는 것은 오류가 아니다
 *
 * admin 이 아니면 **아무것도 그리지 않고 조회도 하지 않는다.** 403 을 오류로 그리면 잘못
 * 없는 화면에 붉은 글이 뜬다(`AgentDefaultsSettings` 와 같은 규칙).
 */
export function ProjectionUrl() {
  const isAdmin = useActiveStore((s) => s.me?.isAdmin === true);
  // **세 상태다**: null(아직 안 읽음) / 'error'(못 읽음) / 값. 셋을 뭉개면 "불러오는 중" 과
  // "못 불러왔다" 가 같은 빈 자리가 된다.
  const [config, setConfig] = useState<ProjectionConfigView | 'error' | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 훅은 조건 앞에서 부른다 — 아래 `if (!isAdmin) return null` 보다 먼저여야 한다.
  const t = useT();

  useEffect(() => {
    if (!isAdmin) return;
    void getController().projectionConfig()
      // `c.url` 은 `resolveProjectionUrl` 이 이미 판정한 결과다 — 여기서 `appUrl ?? envUrl` 로
      // 그 판정을 다시 짜면 우선순위 판정이 두 곳(서버·화면)에 살게 된다.
      .then((c) => { setConfig(c); setDraft(c.url ?? ''); })
      .catch(() => setConfig('error'));
  }, [isAdmin]);

  if (!isAdmin) return null;

  const commit = async (url: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await getController().setProjectionConfig(url);
      setConfig(next);
      setDraft(next.url ?? '');
      setEditing(false);
      // 상태 줄이 따라오게 한다. 정기 갱신은 60 초 주기라, 그것에 맡기면 방금 켠 투영이
      // 최대 1 분 동안 꺼진 것처럼 보이고 사용자는 저장이 실패했다고 읽는다.
      await getController().refreshProjection();
    } catch {
      setError(t('projection.url.saveFailed'));
    } finally { setBusy(false); }
  };

  return (
    <div className="px-4 py-3">
      {config === null && <p className="text-meta text-fg-muted">{t('projection.url.loading')}</p>}
      {config === 'error' && (
        <p role="alert" className="text-meta text-danger">{t('projection.url.loadFailed')}</p>
      )}
      {config !== null && config !== 'error' && !editing && (
        <div className="flex items-center gap-3">
          <span data-testid="projection-source" className="min-w-0 flex-1 truncate text-meta text-fg-muted">
            {/* 출처가 없다는 것도 사정이다 — '아직 아무도 정하지 않았다'. */}
            {config.source === null
              ? t('projection.url.sourceNone')
              /* 틀과 출처 이름을 갈라 둔다 — 한국어는 `출처: X` 이고 영어는 `Source: X` 라
                 지금은 어순이 같지만, 이 자리를 조각으로 이어 붙이면 그 어순이 코드에
                 굳는다(`waitChain.link` 가 금지한 그것). 틀이 자리표시자를 받으므로
                 어순 전체가 각 언어의 것이다. */
              : t('projection.url.sourceOf', { source: t(SOURCE_LABEL[config.source]) })}
          </span>
          <Button disabled={busy} onClick={() => { setEditing(true); setError(null); }}>
            {t('projection.url.edit')}
          </Button>
          {/* 앱 값이 없으면 지울 것이 없다. 누를 수 있게 두면 아무 일도 없는 버튼이 된다. */}
          {config.appUrl !== null && (
            <Button variant="danger" disabled={busy} onClick={() => void commit(null)}>
              {t('projection.url.clear')}
            </Button>
          )}
        </div>
      )}
      {config !== null && config !== 'error' && editing && (
        <div className="max-w-md space-y-2">
          {/* 안내가 **둘로 갈리는 이유는 잃는 것이 다르기 때문이다** — env 값이 있으면
              그리로 돌아가고, 없으면 투영이 꺼진다. 한 문장으로 뭉치면 사람이 지우기 전에
              무엇을 잃는지 모른다. */}
          <Field
            label={t('projection.url.field')}
            hint={config.envUrl
              ? t('projection.url.hintFallback', { url: config.envUrl })
              : t('projection.url.hintOff')}
          >
            <TextInput
              ariaLabel={t('projection.url.field')}
              placeholder={t('projection.url.placeholder')}
              value={draft}
              disabled={busy}
              onChange={setDraft}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void commit(draft)}>
              {t('projection.url.save')}
            </Button>
            <Button disabled={busy} onClick={() => { setEditing(false); setError(null); }}>
              {t('projection.url.cancel')}
            </Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-meta text-danger">{error}</p>}
    </div>
  );
}
