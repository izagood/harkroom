import { useCallback, useEffect, useState } from 'react';
import { skillGroupOf, type SkillGroupId, type WorkspaceSkillView } from '@murmur/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { SettingsPage } from './primitives';
import { useT } from '../../i18n/useT';
import type { Translate } from '../../i18n';

/**
 * 워크스페이스 스킬 승인 화면(#311). `#140` 이 만든 라우트·모델 위에 얹는다.
 *
 * **왜 승인 게이트가 화면을 갖는가:** 승인하면 이 본문이 **모든 에이전트의 스킬
 * 디렉터리에 `SKILL.md` 로 깔린다**(러너의 `mentionTurn.ts::syncSkills`) — 하네스는
 * 그 파일을 필요할 때 읽는다. 그래서 이 화면이 하는 일은 목록을 예쁘게 그리는 것이
 * 아니라, 승인하는 사람이 **실제로 깔릴 바이트를 눈으로 보게** 하는 것이다.
 *
 * **문구가 "시스템 프롬프트에 들어간다"였다가 바뀌었다.** 실제로 프롬프트에 상주하는
 * 것은 스킬의 이름·설명뿐이고 본문은 하네스가 필요할 때 읽는다. 승인하는 사람이 "본문
 * 전체가 언제나 모두의 프롬프트에 들어간다"고 읽으면 승인 판단이 실제보다 무거워지고,
 * 확인 문구가 한 번 사실과 어긋나면 다음 문구도 읽히지 않는다(아래 거부·비활성 문구를
 * 둘로 가른 것과 같은 이유다).
 *
 * `AgentsSettings.tsx` 는 건드리지 않는다 — 레이아웃만 다른 별개의 절이다.
 */

/**
 * 세 칸의 이름과 빈 목록. **모듈 상수였다가 함수가 됐다** — 상수는 모듈이 처음 읽힐 때
 * 한 번만 만들어지므로 그때의 언어로 굳고, 언어를 바꿔도 이 세 칸만 옛 언어로 남는다.
 * 화면이 `t()` 를 지나도 그런 자리는 안 바뀐다는 것이 `i18n.test.tsx` 머리말의 경고이고,
 * 여기가 실제로 그 모양이었다.
 */
const groups = (t: Translate): { id: SkillGroupId; title: string; empty: string }[] => [
  { id: 'pending', title: t('skills.group.pending'), empty: t('skills.group.pendingEmpty') },
  { id: 'approved', title: t('skills.group.approved'), empty: t('skills.group.approvedEmpty') },
  { id: 'disabled', title: t('skills.group.disabled'), empty: t('skills.group.disabledEmpty') },
];

/**
 * 승인 확인 문구. **"모든 에이전트"가 들어 있어야 한다** — 승인이 무엇을 하는 일인지
 * 그 한 줄이 전부다. `window.confirm` 은 쓰지 않는다: Tauri 웹뷰에서 막힐 수 있고,
 * 이 저장소의 선례(`HandleGroupsSettings` 의 삭제 확인, `AgentsSettings` 의 '정말 지운다')가
 * 모두 화면 안 인라인 확인이다.
 */
export const approveConfirmText = (t: Translate) => t('skills.confirm.approve');

/**
 * 거부·비활성 확인 문구(#325). **한 문구가 아니라 둘인 이유:** 서버에서 둘은 같은 경로지만
 * (`disableSkill` — 미승인을 비활성하면 그것이 거부다) 사람에게 일어나는 일이 다르다.
 * 승인된 스킬을 비활성하면 러너가 다음 턴에 **이미 깔린 파일과 링크를 지운다**. 미승인
 * 스킬은 애초에 실체화된 적이 없으므로 지울 파일이 없다 — 거부에까지 "파일을 삭제한다"고
 * 적으면 일어나지 않는 일을 경고하는 것이고, 확인 문구가 한 번 거짓말하면 다음 문구도
 * 읽히지 않는다.
 */
export const rejectConfirmText = (t: Translate) => t('skills.confirm.reject');
export const disableConfirmText = (t: Translate) => t('skills.confirm.disable');

export function SkillsSettings({ targetId }: { targetId?: string } = {}) {
  const t = useT();
  const [skills, setSkills] = useState<WorkspaceSkillView[] | 'error' | null>(null);
  // 제안 알림에서 왔으면 그 스킬의 본문을 처음부터 펼쳐 둔다 — 승인하러 온 사람이
  // 한 번 더 눌러야 본문을 보게 되면, 그 클릭이 곧 안 보고 승인하는 길이 된다.
  const [expandedSlug, setExpandedSlug] = useState<string | null>(targetId ?? null);
  const [confirmingApprove, setConfirmingApprove] = useState<string | null>(null);
  const [confirmingDisable, setConfirmingDisable] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = useActiveStore((s) => s.me?.isAdmin === true);
  const accounts = useActiveStore((s) => s.accounts);
  // `skill.*` 이벤트가 올 때마다 올라가는 세는 수(#311 요구 6). 목록을 다시 읽는 신호다.
  const skillsRevision = useActiveStore((s) => s.skillsRevision);

  const reload = useCallback(() => {
    setSkills(null);
    void getController().listSkills()
      .then(setSkills)
      .catch(() => setSkills('error'));
  }, []);

  // 처음 한 번 + `skill.*` 이벤트가 올 때마다. 남이 승인·제안한 것이 열려 있는 화면에
  // 반영되지 않으면, 이미 승인된 것을 또 승인하려다 409 를 보게 된다.
  useEffect(() => { reload(); }, [reload, skillsRevision]);

  /** 서버가 사유를 말해 주면 그것을 보인다 — 우리가 지어낸 한 줄로 덮으면 사유가 사라진다. */
  const reason = (e: unknown, fallback: string): string =>
    (e instanceof Error && e.message ? e.message : fallback);

  const run = async (slug: string, action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    setBusy(slug);
    try {
      await action();
      setConfirmingApprove(null);
      setConfirmingDisable(null);
      reload();
    } catch (e) {
      setError(reason(e, fallback));
    } finally {
      setBusy(null);
    }
  };

  const rows = Array.isArray(skills) ? skills : [];
  const handleOf = (accountId: string) => accounts[accountId]?.handle ?? accountId;

  return (
    <SettingsPage
      title="Skills"
      description={t('skills.group.subtitle')}
    >
      <div className="mb-6 flex items-center gap-2">
        <button
          className="rounded-lg border border-border px-3 py-1.5 font-medium text-fg hover:bg-surface-hover
                     disabled:opacity-50"
          onClick={reload}
          // 불러오는 중에만 막는다. 실패했을 때야말로 다시 눌러야 하므로 그때는 열어 둔다.
          disabled={skills === null}
        >
          {t('skills.list.refresh')}
        </button>
        {skills === null && <span className="text-fg-subtle">{t('skills.list.loading')}</span>}
      </div>

      {skills === 'error' && (
        <p role="alert" className="mb-6 rounded-lg border border-danger-border bg-danger-surface p-3 text-danger">
          {t('skills.list.loadFailed')}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-6 rounded-lg border border-danger-border bg-danger-surface p-3 text-danger">
          {error}
        </p>
      )}

      {groups(t).map((group) => {
        const items = rows.filter((s) => skillGroupOf(s) === group.id);
        return (
          <section key={group.id} className="mb-8">
            <h3 className="mb-2 text-body font-semibold text-fg-subtle">
              {group.title} ({items.length})
            </h3>
            <div className="divide-y divide-border rounded-xl border border-border bg-surface-raised">
              {items.length === 0 && <p className="px-4 py-3 text-fg-subtle">{group.empty}</p>}

              {items.map((skill) => (
                <div key={skill.slug} className="px-4 py-3">
                  <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <span className="font-mono font-medium text-fg">{skill.slug}</span>
                      <span className="ml-2 text-fg-muted">제안자 @{handleOf(skill.proposedBy)}</span>
                      <span className="ml-2 text-fg-subtle">
                        {new Date(skill.proposedAt).toLocaleString()}
                      </span>
                    </div>

                    {/*
                      **컨트롤은 admin 에게만 렌더한다 — 비활성 버튼이 아니라 부재다.**
                      서버가 `requireAdmin` 으로 막으므로, 비-admin 에게 눌리는 버튼을
                      보여 주면 누를 때마다 403 을 받는 죽은 버튼이 된다. 목록 자체는
                      `GET /skills` 가 `requireAccount` 라 로그인한 사람 모두가 본다.
                    */}
                    {isAdmin && (
                      <div className="flex shrink-0 items-center gap-2">
                        {group.id === 'pending' && confirmingApprove !== skill.slug && (
                          <button
                            className="rounded-lg border border-border px-3 py-1.5 font-medium text-fg
                                       hover:bg-surface-hover disabled:opacity-50"
                            disabled={busy === skill.slug}
                            onClick={() => {
                              // 두 확인이 동시에 열리면 경고 상자와 t('skills.confirm.cancel') 버튼이 둘씩 뜬다 —
                              // 어느 쪽을 취소하는지 사람이 알 수 없다. 하나만 열어 둔다.
                              setConfirmingDisable(null);
                              setConfirmingApprove(skill.slug);
                            }}
                          >
                            {t('skills.row.approve')}
                          </button>
                        )}
                        {group.id !== 'disabled' && (
                          <button
                            className="rounded-lg border border-danger-border px-3 py-1.5 font-medium text-danger
                                       hover:bg-danger-surface disabled:opacity-50"
                            disabled={busy === skill.slug || confirmingDisable === skill.slug}
                            onClick={() => {
                              setConfirmingApprove(null);
                              setConfirmingDisable(skill.slug);
                            }}
                          >
                            {group.id === 'pending' ? t('skills.row.reject') : t('skills.row.disable')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {isAdmin && confirmingApprove === skill.slug && (
                    <div className="mt-2 rounded-lg border border-warning-border bg-warning-surface p-3">
                      <p className="text-warning">{approveConfirmText(t)}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          className="rounded-lg bg-accent px-3 py-1.5 font-medium text-fg-on-strong
                                     hover:bg-accent-hover disabled:opacity-50"
                          disabled={busy === skill.slug}
                          onClick={() => void run(
                            skill.slug,
                            () => getController().approveSkill(skill.slug),
                            t('skills.row.approveFailed'),
                          )}
                        >
                          {t('skills.confirm.approveStart')}
                        </button>
                        <button
                          className="rounded-lg border border-border px-3 py-1.5 font-medium text-fg
                                     hover:bg-surface-hover disabled:opacity-50"
                          disabled={busy === skill.slug}
                          onClick={() => setConfirmingApprove(null)}
                        >
                          {t('skills.confirm.cancel')}
                        </button>
                      </div>
                    </div>
                  )}
                  {isAdmin && confirmingDisable === skill.slug && (
                    <div className="mt-2 rounded-lg border border-warning-border bg-warning-surface p-3">
                      <p className="text-warning">
                        {group.id === 'pending' ? rejectConfirmText(t) : disableConfirmText(t)}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          className="rounded-lg bg-danger px-3 py-1.5 font-medium text-fg-on-strong
                                     hover:bg-danger-hover disabled:opacity-50"
                          disabled={busy === skill.slug}
                          onClick={() => void run(
                            skill.slug,
                            () => getController().disableSkill(skill.slug),
                            group.id === 'pending' ? t('skills.row.rejectFailed') : t('skills.row.disableFailed'),
                          )}
                        >
                          {group.id === 'pending' ? t('skills.row.confirmReject') : t('skills.row.confirmDisable')}
                        </button>
                        <button
                          className="rounded-lg border border-border px-3 py-1.5 font-medium text-fg
                                     hover:bg-surface-hover disabled:opacity-50"
                          disabled={busy === skill.slug}
                          onClick={() => setConfirmingDisable(null)}
                        >
                          {t('skills.confirm.cancel')}
                        </button>
                      </div>
                    </div>
                  )}

                  <button
                    className="mt-2 text-fg-muted hover:text-fg"
                    aria-expanded={expandedSlug === skill.slug}
                    onClick={() => setExpandedSlug(expandedSlug === skill.slug ? null : skill.slug)}
                  >
                    {expandedSlug === skill.slug ? t('skills.row.fold') : t('skills.row.unfold')}
                  </button>

                  {/*
                    **본문은 해석하지 않는다.** 스킬 본문은 이 저장소에서 가장 레버리지가
                    큰 프롬프트 인젝션 표면이다(#140 의 결정). 마크다운·HTML 로 그리면
                    `**굵게**` 는 굵은 글자가 되고 `<script>` 는 사라져, 승인하는 사람이
                    보는 것과 에이전트가 읽는 것이 달라진다 — 승인 게이트의 값이 그 순간
                    사라진다. `<pre>` 안에 원문 그대로, 텍스트 노드로만 둔다.
                  */}
                  {expandedSlug === skill.slug && (
                    <pre
                      data-testid={`skill-body-${skill.slug}`}
                      /* 스킬 본문은 **읽는 글자**이므로 본문단이고, 등폭이라 한 단 내린
                         12px 이다 — 이 저장소의 등폭 보정(`ReportCard`·`Profile` 의
                         `font-mono text-[12px]`)과 같은 규칙이다. 등폭은 같은 pt 에서
                         산세리프보다 크게 보여 13px 로 두면 옆의 13px 본문보다 커 보인다.
                         `test/typeScale.test.ts` 의 `ALLOWED` 가 그 근거를 적어 뒀다. */
                      className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg
                                 border border-border bg-surface p-3 font-mono text-[12px] text-fg"
                    >
                      {skill.body}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </SettingsPage>
  );
}
