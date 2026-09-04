import { useCallback, useEffect, useState } from 'react';
import { skillGroupOf, type SkillGroupId, type WorkspaceSkillView } from '@murmur/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { SettingsPage } from './primitives';

/**
 * 워크스페이스 스킬 승인 화면(#311). `#140` 이 만든 라우트·모델 위에 얹는다.
 *
 * **왜 승인 게이트가 화면을 갖는가:** 승인된 스킬 본문은 **모든 에이전트의 시스템
 * 프롬프트**에 들어간다. 그래서 이 화면이 하는 일은 목록을 예쁘게 그리는 것이 아니라,
 * 승인하는 사람이 **실제로 들어갈 바이트를 눈으로 보게** 하는 것이다.
 *
 * `AgentsSettings.tsx` 는 건드리지 않는다 — 레이아웃만 다른 별개의 절이다.
 */

const GROUPS: { id: SkillGroupId; title: string; empty: string }[] = [
  { id: 'pending', title: '대기 중', empty: '승인을 기다리는 스킬이 없다' },
  { id: 'approved', title: '승인됨', empty: '승인된 스킬이 없다' },
  { id: 'disabled', title: '비활성', empty: '비활성된 스킬이 없다' },
];

/**
 * 승인 확인 문구. **"모든 에이전트"가 들어 있어야 한다** — 승인이 무엇을 하는 일인지
 * 그 한 줄이 전부다. `window.confirm` 은 쓰지 않는다: Tauri 웹뷰에서 막힐 수 있고,
 * 이 저장소의 선례(`HandleGroupsSettings` 의 삭제 확인, `AgentsSettings` 의 '정말 지운다')가
 * 모두 화면 안 인라인 확인이다.
 */
export const APPROVE_CONFIRM_TEXT = '승인하면 모든 에이전트가 이 스킬을 시스템 프롬프트로 읽는다';

/**
 * 거부·비활성 확인 문구(#325). **한 문구가 아니라 둘인 이유:** 서버에서 둘은 같은 경로지만
 * (`disableSkill` — 미승인을 비활성하면 그것이 거부다) 사람에게 일어나는 일이 다르다.
 * 승인된 스킬을 비활성하면 러너가 다음 턴에 **이미 깔린 파일과 링크를 지운다**. 미승인
 * 스킬은 애초에 실체화된 적이 없으므로 지울 파일이 없다 — 거부에까지 "파일을 삭제한다"고
 * 적으면 일어나지 않는 일을 경고하는 것이고, 확인 문구가 한 번 거짓말하면 다음 문구도
 * 읽히지 않는다.
 */
export const REJECT_CONFIRM_TEXT = '거부하면 이 스킬은 비활성으로 내려간다 — 되돌리려면 에이전트가 다시 제안해야 한다';
export const DISABLE_CONFIRM_TEXT = '비활성화하면 모든 에이전트가 이 스킬의 파일과 링크를 삭제한다';

export function SkillsSettings({ targetId }: { targetId?: string } = {}) {
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
      description="에이전트가 제안한 워크스페이스 스킬. 승인된 스킬의 본문은 모든 에이전트의 시스템 프롬프트에 들어간다."
    >
      <div className="mb-6 flex items-center gap-2">
        <button
          className="rounded-lg border border-border px-3 py-1.5 font-medium text-fg hover:bg-surface-hover
                     disabled:opacity-50"
          onClick={reload}
          // 불러오는 중에만 막는다. 실패했을 때야말로 다시 눌러야 하므로 그때는 열어 둔다.
          disabled={skills === null}
        >
          새로고침
        </button>
        {skills === null && <span className="text-fg-subtle">불러오는 중…</span>}
      </div>

      {skills === 'error' && (
        <p role="alert" className="mb-6 rounded-lg border border-danger-border bg-danger-surface p-3 text-danger">
          스킬 목록을 불러오지 못했다
        </p>
      )}
      {error && (
        <p role="alert" className="mb-6 rounded-lg border border-danger-border bg-danger-surface p-3 text-danger">
          {error}
        </p>
      )}

      {GROUPS.map((group) => {
        const items = rows.filter((s) => skillGroupOf(s) === group.id);
        return (
          <section key={group.id} className="mb-8">
            <h3 className="mb-2 text-[13px] font-semibold text-fg-subtle">
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
                              // 두 확인이 동시에 열리면 경고 상자와 '취소' 버튼이 둘씩 뜬다 —
                              // 어느 쪽을 취소하는지 사람이 알 수 없다. 하나만 열어 둔다.
                              setConfirmingDisable(null);
                              setConfirmingApprove(skill.slug);
                            }}
                          >
                            승인
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
                            {group.id === 'pending' ? '거부' : '비활성화'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {isAdmin && confirmingApprove === skill.slug && (
                    <div className="mt-2 rounded-lg border border-warning-border bg-warning-surface p-3">
                      <p className="text-warning">{APPROVE_CONFIRM_TEXT}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          className="rounded-lg bg-accent px-3 py-1.5 font-medium text-fg-on-strong
                                     hover:bg-accent-hover disabled:opacity-50"
                          disabled={busy === skill.slug}
                          onClick={() => void run(
                            skill.slug,
                            () => getController().approveSkill(skill.slug),
                            '승인하지 못했다',
                          )}
                        >
                          승인 확인
                        </button>
                        <button
                          className="rounded-lg border border-border px-3 py-1.5 font-medium text-fg
                                     hover:bg-surface-hover disabled:opacity-50"
                          disabled={busy === skill.slug}
                          onClick={() => setConfirmingApprove(null)}
                        >
                          취소
                        </button>
                      </div>
                    </div>
                  )}
                  {isAdmin && confirmingDisable === skill.slug && (
                    <div className="mt-2 rounded-lg border border-warning-border bg-warning-surface p-3">
                      <p className="text-warning">
                        {group.id === 'pending' ? REJECT_CONFIRM_TEXT : DISABLE_CONFIRM_TEXT}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          className="rounded-lg bg-danger px-3 py-1.5 font-medium text-fg-on-strong
                                     hover:bg-danger-hover disabled:opacity-50"
                          disabled={busy === skill.slug}
                          onClick={() => void run(
                            skill.slug,
                            () => getController().disableSkill(skill.slug),
                            group.id === 'pending' ? '거부하지 못했다' : '비활성화하지 못했다',
                          )}
                        >
                          {group.id === 'pending' ? '거부 확인' : '비활성화 확인'}
                        </button>
                        <button
                          className="rounded-lg border border-border px-3 py-1.5 font-medium text-fg
                                     hover:bg-surface-hover disabled:opacity-50"
                          disabled={busy === skill.slug}
                          onClick={() => setConfirmingDisable(null)}
                        >
                          취소
                        </button>
                      </div>
                    </div>
                  )}

                  <button
                    className="mt-2 text-fg-muted hover:text-fg"
                    aria-expanded={expandedSlug === skill.slug}
                    onClick={() => setExpandedSlug(expandedSlug === skill.slug ? null : skill.slug)}
                  >
                    {expandedSlug === skill.slug ? '본문 접기' : '본문 보기'}
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
                      className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg
                                 border border-border bg-surface p-3 font-mono text-xs text-fg"
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
