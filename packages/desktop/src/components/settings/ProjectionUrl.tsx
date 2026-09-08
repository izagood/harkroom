import { useEffect, useState } from 'react';
import type { ProjectionConfigView, ProjectionUrlSource } from '@murmur/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { Button, Field, TextInput } from './primitives';

/**
 * 출처를 **사정마다 다른 말**로 적는다. 같은 말이면 화면이 env 와 앱 설정을 구별하지
 * 못하고, "env 를 넣었는데 왜 안 먹나" 를 화면에서 알 수 없다.
 */
const SOURCE_LABEL: Record<ProjectionUrlSource, string> = {
  app: '앱에서 설정',
  env: '환경변수(AVCS_BASE_URL)',
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
      setError('투영 URL 을 저장하지 못했다');
    } finally { setBusy(false); }
  };

  return (
    <div className="px-4 py-3">
      {config === null && <p className="text-[11px] text-fg-muted">투영 설정을 불러오는 중…</p>}
      {config === 'error' && (
        <p role="alert" className="text-[11px] text-danger">투영 설정을 불러오지 못했다</p>
      )}
      {config !== null && config !== 'error' && !editing && (
        <div className="flex items-center gap-3">
          <span data-testid="projection-source" className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">
            {/* 출처가 없다는 것도 사정이다 — '아직 아무도 정하지 않았다'. */}
            {config.source === null
              ? '아직 정해지지 않았다'
              : `출처: ${SOURCE_LABEL[config.source]}`}
          </span>
          <Button disabled={busy} onClick={() => { setEditing(true); setError(null); }}>편집</Button>
          {/* 앱 값이 없으면 지울 것이 없다. 누를 수 있게 두면 아무 일도 없는 버튼이 된다. */}
          {config.appUrl !== null && (
            <Button variant="danger" disabled={busy} onClick={() => void commit(null)}>지우기</Button>
          )}
        </div>
      )}
      {config !== null && config !== 'error' && editing && (
        <div className="max-w-md space-y-2">
          <Field label="avcs 주소" hint={config.envUrl ? `지우면 ${config.envUrl} 로 돌아간다` : '지우면 투영이 꺼진다'}>
            <TextInput
              ariaLabel="avcs 주소"
              placeholder="http://avcs.example:4000"
              value={draft}
              disabled={busy}
              onChange={setDraft}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void commit(draft)}>저장</Button>
            <Button disabled={busy} onClick={() => { setEditing(false); setError(null); }}>취소</Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-[11px] text-danger">{error}</p>}
    </div>
  );
}
