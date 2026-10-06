import { useState } from 'react';
import { CHANNEL_NAME_PATTERN, PROJECTION_UNCONFIGURED_NOTICE, type ChannelRow } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { ApiError } from '../lib/api';
import { useT } from '../i18n/useT';

/**
 * 채널 이름·주제·저장소 편집 폼(UX ⑦b-2). `Sidebar` 의 인라인 폼을 **그대로** 꺼냈다 — 규칙과 그 근거
 * 주석은 옮기기 전과 한 글자도 다르지 않다. 지금은 채널 설정 시트의 정보 탭이 이것을 연다.
 */
export function ChannelEditForm({ channel, onDone }: { channel: ChannelRow; onDone: () => void }) {
  const t = useT();
  const projectionStatus = useActiveStore((s) => s.projectionStatus);
  const [editName, setEditName] = useState(channel.name ?? '');
  const [editTopic, setEditTopic] = useState(channel.topic);
  const [editRepo, setEditRepo] = useState(channel.repo ?? '');
  const [editError, setEditError] = useState<string | null>(null);



  const submitEdit = async (): Promise<void> => {
    const original = useActiveStore.getState().channels.find((c) => c.id === channel.id);
    const input: { name?: string; topic?: string; repo?: string | null } = {};
    /**
     * 이름은 **바뀐 경우에만** 싣는다. 안 바꾸고 저장할 때마다 이름을 같이 보내면 서버가
     * 그때마다 유니크 검사와 감사 기록의 대상으로 삼고, 무엇보다 이 채널이 자기 이름으로
     * 유니크 위반을 낼 여지를 만든다.
     *
     * 규칙은 만들기와 **같은 상수**로 미리 거른다(`submitNewChannel` 과 같은 이유) — 서버
     * 왕복 없이 안내하되 최종 판정은 서버다. 빈 이름은 해제 의사가 아니다: 이름 없는 채널은
     * 없으므로 패턴이 이미 걸러 낸다.
     */
    const nextName = editName.trim();
    if (nextName !== original?.name) {
      if (!new RegExp(CHANNEL_NAME_PATTERN).test(nextName)) {
        setEditError(t('sidebar.channel.createInvalidName'));
        return;
      }
      input.name = nextName;
    }
    if (editTopic !== original?.topic) {
      input.topic = editTopic;
    }
    // repo 는 **키 부재(변경 없음)와 null(바인딩 해제)를 구분**해야 한다. 그래서 원래
    // 값과 다를 때만 키를 넣는다 — topic 만 고칠 때 repo 키가 따라가면 바인딩이 조용히
    // 끊긴다.
    //
    // 필드를 비운 것은 **해제 의사**로 읽는다. 필드가 이 채널의 바인딩을 표현하는 유일한
    // 곳이므로, 바인딩이 남아 있는데 필드가 비어 보이는 상태를 만들면 안 된다. 예전에는
    // 이 자리에 `editRepo || undefined` 가 있었는데, 그러면 키는 들어가지만 값이
    // undefined 라 JSON 에서 사라진다 — 사용자가 필드를 비우고 저장했는데 아무 일도
    // 일어나지 않고 안내도 없었다.
    if (editRepo !== (original?.repo ?? '')) {
      input.repo = editRepo === '' ? null : editRepo;
    }
    try {
      await getController().updateChannel(channel.id, input);
      onDone();
    } catch (err) {
      // 이름 충돌은 **코드로** 가른다(`ProfileSettings` 의 handle 과 같은 판단) — 문구를
      // 문자열로 뒤지면 서버가 문구를 다듬는 순간 조용히 "편집에 실패했다" 로 뭉개진다.
      // 이건 사용자가 고칠 수 있는 유일한 실패라 그렇게 말해 줘야 한다.
      if (err instanceof ApiError && err.code === 'channel_name_taken') {
        setEditError(t('sidebar.edit.nameTaken'));
        return;
      }
      setEditError(err instanceof Error ? err.message : t('sidebar.edit.failed'));
    }
  };

  return (
        <div data-testid="channel-edit-form" className="rounded-row border border-border bg-surface-raised p-1">
          {/*
            **사이드바의 단은 아랫단 11px 이다** — 이 파일이 이미 그렇게 서 있었다: 오류·
            안내·멤버 이름·구획 라벨·미읽음 개수가 전부 11px 이고, 그것은 10px 27곳을
            11px 로 올린 앞 작업이 만든 상태다. 그래서 남아 있던 12px(`text-xs`) 24곳을
            **색으로 가르지 않고 자리로** 11px 에 붙였다: 이 열은 좁고, 한 열 안에 두 단이
            서면 눌러야 할 버튼과 읽어야 할 줄이 눈에서 뒤섞인다.

            **입력칸만 예외로 본문단 13px** 이다 — 14px(`text-sm`) 4곳과 12px 1곳으로
            갈려 있던 것을 하나로 맞췄고, 크기를 안 적어 앱 기본값을 물려받는다. 방금 친
            글자를 다시 읽는 자리다. `SidebarFind.tsx` 에 그 근거를 적어 뒀다.
          */}
          <div className="mb-1 text-meta text-fg-muted">{t('sidebar.edit.title', { name: `#${channel.name}` })}</div>
          {/*
            이름이 맨 위다 — 이 폼에서 **바꿨을 때 가장 눈에 띄는 값**이고, 제목 줄이
            `#옛이름` 으로 무엇을 고치는 중인지 이미 말하고 있다. `#` 는 붙여서 그리지 않는다:
            저장되는 값에는 `#` 가 없고, 칸 안에 넣어 두면 사람이 그것까지 이름으로 친다.
          */}
          <input
            type="text"
            aria-label="Channel name"
            data-testid="channel-edit-name"
            className="mb-1 w-full rounded-row border border-border bg-field px-2 py-1 text-fg placeholder-fg-subtle"
            placeholder={t('sidebar.edit.namePlaceholder')}
            value={editName}
            onChange={(e) => { setEditName(e.target.value); setEditError(null); }}
          />
          <input
            type="text"
            aria-label="Topic"
            className="mb-1 w-full rounded-row border border-border bg-field px-2 py-1 text-fg placeholder-fg-subtle"
            placeholder={t('sidebar.edit.topicPlaceholder')}
            value={editTopic}
            onChange={(e) => { setEditTopic(e.target.value); setEditError(null); }}
          />
          <div className="mb-1 flex items-center gap-1">
            <input
              type="text"
              aria-label="Repository"
              className="flex-1 rounded-row border border-border bg-field px-2 py-1 text-fg placeholder-fg-subtle"
              placeholder={t('sidebar.edit.repoPlaceholder')}
              value={editRepo}
              onChange={(e) => { setEditRepo(e.target.value); setEditError(null); }}
            />
          </div>
          {editError && <p role="alert" className="mb-1 text-meta text-danger">{editError}</p>}
          {/*
            repo 를 채워도 아무도 읽지 않는다는 사실을 폼 안에서 말한다(#381). 배지가 뜨는
            것만으로는 바인딩이 살아 있다고 읽히는데, 투영이 꺼져 있으면 `projection.ts`
            말고는 이 값을 읽는 곳이 없다. 문구는 `LeasePanel` 배너와 **같은 상수**다 —
            사본을 만들면 둘이 갈라진다.
          */}
          {editRepo && projectionStatus?.state === 'unconfigured' && (
            <p className="mb-1 text-meta text-warning">{PROJECTION_UNCONFIGURED_NOTICE}</p>
          )}
          <div className="flex gap-1">
            <button
              className="rounded-row bg-accent px-2 py-0.5 text-meta text-fg-on-strong hover:bg-accent-hover"
              onClick={() => void submitEdit()}
            >
              {t('sidebar.edit.save')}
            </button>
            <button
              className="rounded-row px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-hover"
              onClick={onDone}
            >
              {t('sidebar.edit.cancel')}
            </button>
          </div>
        </div>
  );
}
