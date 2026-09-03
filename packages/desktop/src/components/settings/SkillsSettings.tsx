import { useEffect, useState } from 'react';
import type { WorkspaceSkillView } from '@murmur/shared';
import { getController } from '../../state/controller';
import { useAppStore } from '../../state/appStore';

interface SkillGroup {
  title: string;
  skills: WorkspaceSkillView[];
}

export function SkillsSettings() {
  const [skills, setSkills] = useState<WorkspaceSkillView[] | 'error' | null>(null);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [confirmingApprove, setConfirmingApprove] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = useAppStore((s) => s.me?.isAdmin === true);
  const accounts = useAppStore((s) => s.accounts);

  const reload = () => {
    setSkills(null);
    void getController().listSkills()
      .then(setSkills)
      .catch(() => setSkills('error'));
  };

  useEffect(reload, []);

  const handleApprove = async (slug: string) => {
    setError(null);
    setBusy(slug);
    try {
      await getController().approveSkill(slug);
      reload();
    } catch (e) {
      setError('승인하지 못했다');
    } finally {
      setBusy(null);
      setConfirmingApprove(null);
    }
  };

  const handleDisable = async (slug: string) => {
    setError(null);
    setBusy(slug);
    try {
      await getController().disableSkill(slug);
      reload();
    } catch (e) {
      setError('비활성화하지 못했다');
    } finally {
      setBusy(null);
    }
  };

  const pending = skills && !Array.isArray(skills) ? [] : (skills ?? []).filter((s) => !s.approvedAt && !s.disabledAt);
  const approved = skills && !Array.isArray(skills) ? [] : (skills ?? []).filter((s) => s.approvedAt && !s.disabledAt);
  const disabled = skills && !Array.isArray(skills) ? [] : (skills ?? []).filter((s) => s.disabledAt);

  const groups: SkillGroup[] = [
    { title: '대기 중', skills: pending },
    { title: '승인됨', skills: approved },
    { title: '비활성', skills: disabled },
  ];

  const getProposerHandle = (proposedBy: string) => {
    return accounts[proposedBy]?.handle ?? proposedBy;
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex items-center border-b border-zinc-200 px-5 py-3">
        <h2 className="text-base font-bold">스킬</h2>
        <button
          className="ml-auto rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-200"
          onClick={reload}
          disabled={!skills || skills === 'error'}
        >
          새로고침
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-5">
        {skills === null && <div className="text-xs text-zinc-400">불러오는 중…</div>}
        {skills === 'error' && <div role="alert" className="text-xs text-red-600">스킬 목록을 불러오지 못했다</div>}

        {groups.map((group) => (
          <div key={group.title} className="mb-6">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              {group.title} ({group.skills.length})
            </div>

            {group.skills.length === 0 && (
              <div className="mt-2 rounded border border-zinc-100 p-3 text-xs text-zinc-400">
                스킬이 없습니다
              </div>
            )}

            {group.skills.map((skill) => (
              <div key={skill.slug} className="mt-2 rounded border border-zinc-200 p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-mono text-sm font-medium">{skill.slug}</span>
                    <span className="ml-2 text-xs text-zinc-500">
                      제안자: @{getProposerHandle(skill.proposedBy)}
                    </span>
                    <span className="ml-2 text-xs text-zinc-400">
                      {new Date(skill.proposedAt).toLocaleString()}
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    {isAdmin && group.title === '대기 중' && (
                      confirmingApprove === skill.slug ? (
                        <div className="flex flex-col items-end gap-1">
                          <p className="mb-1 max-w-[200px] text-[11px] text-green-700">
                            승인하면 모든 에이전트가 이 스킬을 읽습니다
                          </p>
                          <div className="flex items-center gap-1">
                            <button
                              className="rounded border border-green-300 bg-green-50 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50"
                              disabled={busy === skill.slug}
                              onClick={() => handleApprove(skill.slug)}
                            >
                              승인 확인
                            </button>
                            <button
                              className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                              onClick={() => setConfirmingApprove(null)}
                              disabled={busy === skill.slug}
                            >
                              취소
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          className="rounded border border-green-300 bg-green-50 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50"
                          disabled={busy === skill.slug}
                          onClick={() => setConfirmingApprove(skill.slug)}
                        >
                          승인
                        </button>
                      )
                    )}

                    {isAdmin && group.title !== '비활성' && (
                      <button
                        className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                        disabled={busy === skill.slug}
                        onClick={() => handleDisable(skill.slug)}
                      >
                        {group.title === '대기 중' ? '거부' : '비활성화'}
                      </button>
                    )}
                  </div>
                </div>

                <button
                  className="mt-1 text-xs text-zinc-500 hover:text-zinc-700"
                  onClick={() => setExpandedSlug(expandedSlug === skill.slug ? null : skill.slug)}
                >
                  {expandedSlug === skill.slug ? '▲ 본문 접기' : '▼ 본문 보기'}
                </button>

                {expandedSlug === skill.slug && (
                  <pre className="mt-2 max-h-64 overflow-auto rounded bg-zinc-50 p-2 text-xs text-zinc-800 whitespace-pre-wrap break-words">
                    {skill.body}
                  </pre>
                )}
              </div>
            ))}
          </div>
        ))}

        {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}

        <div className="mt-4 rounded border border-zinc-100 bg-zinc-50 p-3">
          <div className="text-xs text-zinc-500">
            <strong>참고:</strong> 스킬 본문은 프롬프트 인젝션 표면이므로 원문 그대로 보여줍니다.
            마크다운이나 HTML로 해석하지 않습니다.
          </div>
        </div>
      </div>
    </div>
  );
}