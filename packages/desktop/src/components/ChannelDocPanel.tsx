import { useEffect, useRef, useState } from 'react';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { MessageBody } from './MessageBody';
import { ApiError } from '../lib/api';
import type { ChannelDoc } from '@murmur/shared';
import type { SectionId } from './settings/sections';
import { useT } from '../i18n/useT';

interface ChannelDocPanelProps {
  channelId: string;
  onClose: () => void;
  /** 문서 본문의 멘션을 눌렀을 때 갈 곳(#279). `MessageBody` 로 그대로 넘긴다. */
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
}

/** 서버가 준 시각을 `expectedUpdatedAt`(epoch ms) 로. 아직 아무도 안 썼으면 null 이다. */
function expectationOf(doc: ChannelDoc | undefined | null): number | null {
  return doc?.updatedAt ? new Date(doc.updatedAt).getTime() : null;
}

/**
 * 채널 문서 패널(#188). 읽기 모드가 기본이고 편집으로 전환한다.
 *
 * 이 컴포넌트가 지켜야 하는 것 세 가지:
 *
 * 1. **조회 실패를 빈 문서로 보여주지 않는다.** 실패는 오류로 뜬다 — 못 읽은 문서를
 *    "비어 있다"로 보여 주면 사람이 그 위에 저장해서 남의 문서를 지운다.
 * 2. **409 는 사람에게 보이고, 편집 내용은 사라지지 않는다.** 낙관적 동시성이 막으려던 것은
 *    조용한 손실이다. 남의 것을 덮어쓰지 않으려고 내 것을 조용히 버리면 손실의 주체만
 *    바뀐다. 그래서 내 편집은 편집칸에 그대로 두고 서버의 현재 본문을 **나란히** 보여
 *    준다. 다시 누르는 저장은 "봤고 내 것으로 간다"는 뜻이라 그때는 통과한다.
 * 3. **편집 중에 스토어가 편집칸을 덮지 않는다.** 초안은 편집 모드로 들어갈 때 한 번만
 *    스토어에서 뜬다. 스토어를 `useEffect` 의존성으로 걸어 매번 맞추면 문서가 갱신되는
 *    순간 타이핑 중인 내용이 날아간다.
 */
export function ChannelDocPanel({ channelId, onClose, onOpenDirectory, onOpenSettings }: ChannelDocPanelProps) {
  const t = useT();
  const accounts = useActiveStore((s) => s.accounts);
  const doc = useActiveStore((s) => s.channelDocs[channelId]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 409 를 받았을 때 서버에 있던 본문. 내 편집과 나란히 보여 주기 위한 것이다. */
  const [theirBody, setTheirBody] = useState<string | null>(null);
  /**
   * 내가 읽은 판. 저장 성공과 409 마다 갱신된다 — 409 뒤에는 서버의 최신 판이 되므로
   * 사람이 두 판을 보고 다시 누른 저장이 또 튕기지 않는다.
   */
  const expectedRef = useRef<number | null>(null);

  // 패널을 열 때마다 다시 받는다. 스토어에 있는 것으로 그리고 넘어가면 지난번에 열었던
  // 판을 보여 주고, 그 낡은 `expectedUpdatedAt` 으로 저장해 곧바로 409 가 난다.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    getController().loadChannelDoc(channelId)
      .then((fresh) => {
        if (!alive) return;
        expectedRef.current = expectationOf(fresh);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLoadError(err instanceof Error ? err.message : t('channel.doc.unknownError'));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [channelId]);

  const startEditing = () => {
    setDraft(doc?.body ?? '');
    setTheirBody(null);
    setSaveError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setSaveError(null);
    setTheirBody(null);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await getController().saveChannelDoc(channelId, draft, expectedRef.current);
      expectedRef.current = expectationOf(saved);
      setTheirBody(null);
      setEditing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'doc_stale') {
        const current = (err.payload as { doc?: ChannelDoc } | null)?.doc;
        // 편집칸(`draft`)은 **건드리지 않는다.** 여기서 내 편집을 버리면 이 기능이 막으려던
        // 조용한 손실을 방향만 바꿔 저지르는 것이다.
        setTheirBody(current?.body ?? '');
        expectedRef.current = expectationOf(current);
        setSaveError(t('channel.doc.conflict'));
      } else {
        setSaveError(err instanceof Error ? err.message : t('channel.doc.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const updatedByHandle = doc?.updatedBy ? accounts[doc.updatedBy]?.handle ?? null : null;
  const updatedAtLabel = doc?.updatedAt ? new Date(doc.updatedAt).toLocaleString() : null;

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {/* 패널 제목은 **이름줄단 15px** 이다 — 화면 제목단(17px)은 설정 화면 제목처럼
            화면 하나를 여는 자리에만 준다. 이 패널은 채널 안에 붙는 곁창이고, 옆의 메타는
            아랫단 11px 이라 15px 이면 둘 사이 간격이 4px 로 위계가 분명하다. */}
        <span className="text-name font-semibold">{t('channel.doc.heading')}</span>
        {/* "누가 언제"는 실제로 저장된 판에만 붙는다. 아직 아무도 쓰지 않은 문서에 지금
            시각과 내 이름을 붙이면 화면이 거짓말한다. */}
        {updatedAtLabel && (
          <span className="truncate text-meta text-fg-subtle">
            {updatedByHandle ?? t('channel.doc.unknownAuthor')} · {updatedAtLabel}
          </span>
        )}
        <button
          className="ml-auto shrink-0 rounded border border-border px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-sunken"
          onClick={onClose}
        >
          {t('channel.doc.close')}
        </button>
      </div>

      {loading && <div className="p-3 text-fg-subtle">{t('channel.doc.loading')}</div>}

      {/* 조회 실패는 오류다 — 빈 문서가 아니다(docs/design.md §4). */}
      {/* 오류 문구는 **읽어야 하는 글자**다 — 색이 danger 라고 아랫단(11px)으로 내리면
          사람이 무엇이 틀렸는지 읽어야 할 때 가장 작은 글자가 된다. 본문단 13px 이고,
          앱 기본값이 그 값이라 크기를 안 적는다(아래 saveError 도 같다). */}
      {loadError && (
        <div role="alert" className="m-3 rounded bg-danger-surface px-2 py-1 text-danger">
          {t('channel.doc.loadFailed', { reason: loadError })}
        </div>
      )}

      {saveError && (
        <div role="alert" className="m-3 rounded bg-warning-surface px-2 py-1 text-warning">
          {saveError}
        </div>
      )}

      {!loading && !loadError && (
        <>
          <div className="flex-1 overflow-y-auto p-3">
            {editing ? (
              <textarea
                aria-label={t('channel.doc.editLabel')}
                className="w-full resize-none rounded border border-border bg-field p-2 focus:border-border focus:outline-none"
                rows={12}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('channel.doc.placeholder')}
              />
            ) : doc?.body ? (
              <div className="text-fg">
                <MessageBody
                  body={doc.body}
                  messageId={`channel-doc:${channelId}`}
                  onOpenDirectory={onOpenDirectory}
                  onOpenSettings={onOpenSettings}
                />
              </div>
            ) : (
              <span className="text-fg-muted">{t('channel.doc.noneYet')}</span>
            )}

            {/* 409 뒤에만 나온다. 내 편집은 위 편집칸에 그대로 있고 서버에 있는 것은 여기
                있다 — 둘을 나란히 보고 사람이 정한다. */}
            {theirBody !== null && (
              <section className="mt-3 rounded border border-warning-border bg-warning-surface p-2">
                <h3 className="text-meta font-semibold text-warning">{t('channel.doc.theirs')}</h3>
                {/* 서버에 있는 문서 본문 — 내 편집과 나란히 놓고 읽는 글자다. 본문단이다. */}
                <pre className="mt-1 whitespace-pre-wrap break-words text-fg">
                  {theirBody === '' ? t('channel.doc.empty') : theirBody}
                </pre>
              </section>
            )}
          </div>

          <div className="border-t border-border p-2">
            {editing ? (
              <div className="flex gap-2">
                <button
                  className="flex-1 rounded bg-surface-hover px-3 py-1.5 text-fg hover:bg-border"
                  onClick={cancelEditing}
                >
                  {t('channel.doc.cancel')}
                </button>
                <button
                  className="flex-1 rounded bg-accent px-3 py-1.5 text-fg-on-strong hover:bg-accent-hover disabled:opacity-50"
                  onClick={() => void save()}
                  disabled={saving}
                >
                  {saving ? t('channel.doc.saving') : t('channel.doc.save')}
                </button>
              </div>
            ) : (
              <button
                className="w-full rounded border border-border px-3 py-1.5 text-fg hover:bg-surface-sunken"
                onClick={startEditing}
              >
                {t('channel.doc.edit')}
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
