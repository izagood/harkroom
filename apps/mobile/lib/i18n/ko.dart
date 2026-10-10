import 'strings.dart';

/// 한국어. **비워 두지 않는다**(계획서 §7-2) — 빈 자리는 "번역이 없다"가 아니라
/// "덜 만든 화면"으로 읽힌다. `test/i18n_test.dart` 가 그것을 지킨다.
class StringsKo implements Strings {
  const StringsKo();

  @override
  String get localeCode => 'ko';

  // 고유명사라 영어와 같다. 그래도 통과하는 이유는 `i18nAllowSameAsEnglish` 에 적혀서다.
  @override
  String get appName => 'Harkroom';

  @override
  String get connectTitle => '커뮤니티에 연결';

  @override
  String get connectServerUrlLabel => '서버 주소';

  @override
  String get connectServerUrlHint => 'https://example.com';

  @override
  String get connectContinue => '계속';

  @override
  String get connectErrorEmpty => '서버 주소가 비어 있다.';

  @override
  String get connectErrorMalformed => '서버 주소 형식이 아니다.';

  @override
  String get connectErrorInsecure => 'iOS 는 http:// 연결을 막는다. https:// 주소여야 한다.';

  @override
  String get commonLoading => '불러오는 중…';

  @override
  String get commonBack => '뒤로';

  @override
  String get commonRetry => '다시 시도';

  @override
  String get loginTitle => '로그인';

  @override
  String get loginIdLabel => '로그인 아이디';

  @override
  String get loginPasswordLabel => '비밀번호';

  @override
  String get loginSubmit => '로그인';

  @override
  String get loginErrorRejected => '로그인 아이디나 비밀번호가 맞지 않는다.';

  @override
  String get loginErrorUnreachable => '서버에 연결하지 못했다. 주소와 네트워크를 확인해 달라.';

  @override
  String get signOut => '로그아웃';

  @override
  String get channelsTitle => '채널';

  @override
  String get channelsEmpty => '아직 들어간 채널이 없다.';

  @override
  String get messagesEmpty => '아직 메시지가 없다.';

  @override
  String get composerHint => '{name} 에 메시지';

  @override
  String get composerSend => '보내기';

  @override
  String get stickyMentionsLabel => '계속 부르는 상대';

  @override
  String get stickyMentionRemove => '{handle} 그만 부르기';

  @override
  String get autoMentionSkip => '이번만 {handle} 빼기';

  @override
  String get channelAgentTitle => '누르면 계속 부른다';

  @override
  String get modelDefault => '기본';

  @override
  String get modelThreadSet => '스레드 지정';

  @override
  String get modelAgentSet => '{handle} 지정';

  @override
  String get modelAgentSetUnknown => '에이전트 지정';

  @override
  String get modelAllDefault => '모델 · 모두 기본';

  @override
  String get modelMore => '더보기…';

  @override
  String get modelEffort => 'effort';

  @override
  String get modelEffortDefault => '에이전트 설정';

  @override
  String get modelAgentDefault => '에이전트 기본값:';

  @override
  String get modelHarnessDefault => '하네스 기본값';

  @override
  String get modelCostNote => '고급 모델은 주간 한도를 빨리 쓴다. 도중에 바꾸면 캐시가 한 번 빗나가고, 작은 모델은 긴 스레드를 다 못 담을 수 있다.';

  @override
  String get modelNextTurn => '다음 턴부터 적용된다.';

  @override
  String get modelReset => '기본으로 되돌리기';

  @override
  String get modelApply => '적용';

  @override
  String get modelCustom => '모델 이름';

  @override
  String get modelStale => '쓰지 않음 — 지정한 뒤 에이전트의 하네스가 바뀌었다.';

  @override
  String get modelSheetTitleThread => "이 스레드의 {handle} 모델";

  @override
  String get modelSheetTitleComposer => "이 글로 부를 {handle} 모델";

  @override
  String get modelQuickLabel => "{handle} 모델";

  @override
  String get modelClearThread => "스레드 지정 풀기";

  @override
  String get modelStaleDetail => "하네스가 {harness} 로 바뀌어 이 지정을 쓰지 않는다.";

  @override
  String get modelRepick => "다시 고르기";

  @override
  String get connectionOnline => '연결됨';

  @override
  String get connectionConnecting => '연결 중…';

  @override
  String get connectionReconnecting => '다시 연결 중…';

  @override
  String get connectionDead => '연결 끊김 — 다시 로그인해야 한다';

  @override
  String get noticeSessionNotSaved => '세션을 키체인에 저장하지 못했다. 지금은 계속 쓸 수 있지만, 앱을 다시 열면 다시 로그인해야 한다.';

  @override
  String get agentBadge => '에이전트';

  @override
  String get askAnswered => '정해졌다';

  @override
  String get askClosed => '답 없이 닫혔다';

  @override
  String get askReplied => '글로 답했다';

  @override
  String get askSuperseded => '새 질문으로 바뀜';

  @override
  String askPickAnyway(int n) => '그래도 고르기 ($n)';

  @override
  String get askDecline => '답하지 않기';

  @override
  String get askToYou => '내 차례';

  @override
  String get askToAnyone => '사람이 고른다';

  @override
  String bundleRemaining(int n, int m) => '정할 것 $n/$m 남음';

  @override
  String bundleAllDone(int m) => '$m개 모두 정해졌다';

  @override
  String bundleAcceptRecommended(int n) => '남은 $n개 추천대로';

  @override
  String get bundleAcceptNote => '되돌릴 수 없는 결정(머지·배포·비밀·권한)은 빠진다';

  @override
  String bundleAcceptPending(int n, int s) => '$n개를 추천대로 고른다 · $s';

  @override
  String get bundleAcceptCancel => '취소';

  @override
  String get bundleRecommended => '추천';

  @override
  String get bundleReplyInThread => '원 스레드에서 글로 답하기 →';

  @override
  String get bundleDecideInThread => '원 스레드에서 정하기 →';

  @override
  String get bundleLoading => '원본을 읽는 중…';

  @override
  String get bundleUnavailable => '원본 카드를 볼 수 없다';

  @override
  String bundleAnswered(String label, String name) => '$label · $name';

  @override
  String bundleReplied(String name) => '글로 답했다 · $name';

  @override
  String bundleNoteBy(String name) => '$name 요약:';

  @override
  String get bundleSkipIrreversible => '되돌릴 수 없는 결정이라 일괄에서 뺐다 — 직접 골라 줘';

  @override
  String get bundleSkipNoRecommendation => '추천이 없어 일괄에서 뺐다';

  @override
  String get bundleSkipLink => '원 스레드에서 정하는 카드라 뺐다';

  @override
  String get bundleSkipFailed => '고르지 못했다 — 다시 시도해 줘';

  @override
  String get bundleSomeone => '누군가';

  @override
  String get threadTitle => '스레드';

  @override
  String get threadReplyHint => '스레드에 답글';

  @override
  String get threadRepliesZero => '답글 달기';

  @override
  String get threadRepliesOne => '답글 1개';

  @override
  String get threadRepliesMany => '답글 {n}개';

  @override
  String get mentionPickerEmpty => '맞는 사람이 없다';

  @override
  String get mentionUnknown => '@알 수 없음';

  @override
  String get systemAccountUnknown => '알 수 없음';

  @override
  String get tabChannels => '채널';

  @override
  String get tabInbox => '인박스';

  @override
  String get tabMe => '나';
  @override
  String get meSettings => '나 · 설정';
  @override
  String get tabHome => '홈';
  @override
  String get tabDms => 'DM';
  @override
  String get tabAgents => '에이전트';
  @override
  String get agentsRunning => '지금 도는 것';
  @override
  String get agentsWaiting => '예약';
  @override
  String get agentsAll => '에이전트 전체';
  @override
  String get agentsNoneRunning => '지금 도는 에이전트가 없다.';
  @override
  String get agentsLoadFailed => '에이전트 상태를 읽지 못했다.';
  @override
  String get agentsMine => '내 것';
  @override
  String get dmsEmpty => '아직 DM 이 없다.';
  @override
  String get sectionStarred => '즐겨찾기';
  @override
  String get sectionChannels => '채널';
  @override
  String get cardMyTurn => '내 차례';
  @override
  String get cardNew => '새로 온 것';
  @override
  String get cardSaved => '저장';
  @override
  String get messageSave => '나중에 보기로 담기';
  @override
  String get messageUnsave => '담은 것 빼기';
  @override
  String get messageSavedMark => '나중을 위해 저장됨';
  @override
  String get savedAdded => '담았다';
  @override
  String get savedOpenList => '목록 보기';
  @override
  String get savedRemoved => '뺐다';
  @override
  String get savedUndo => '되돌리기';
  @override
  String get savedSaveFailed => '담지 못했다';
  @override
  String get savedActionFailed => '바꾸지 못했다';
  @override
  String get savedTitle => '저장된 메시지';
  @override
  String get savedTabOpen => '할 것';
  @override
  String get savedTabDone => '완료';
  @override
  String get savedEmptyOpen => '저장된 메시지가 없다';
  @override
  String get savedEmptyOpenHint => '메시지를 길게 눌러 「나중에 보기로 담기」를 고르면 여기 모인다.';
  @override
  String get savedEmptyDone => '완료된 메시지가 없다';
  @override
  String get savedLoadFailed => '저장된 메시지를 불러오지 못했다';
  @override
  String get savedMarkDone => '완료로 표시';
  @override
  String get savedMarkOpen => '할 것으로 되돌리기';
  @override
  String get savedMovedDone => '완료로 옮겼다';
  @override
  String get savedMovedOpen => '할 것으로 되돌렸다';
  @override
  String get savedDeleted => '삭제된 메시지';
  @override
  String get savedUnavailable => '이 채널을 볼 수 없어 내용을 보여 줄 수 없다';
  @override
  String get newMessage => '새 메시지';
  @override
  String get newMessagePeople => '사람';
  @override
  String get newMessageDmFailed => 'DM 을 열지 못했다.';
  @override
  String get unreadOnlyEmpty => '새로 온 것이 없다.';

  @override
  String get inboxEmpty => '인박스가 비어 있다.';

  @override
  String get inboxMarkAllRead => '모두 읽음';

  @override
  String get inboxReasonMention => '불렀다';

  @override
  String get inboxReasonThreadReply => '답글';

  @override
  String get inboxReasonDm => '다이렉트 메시지';

  @override
  String get inboxReasonAskAnswered => '내 물음에 답했다';

  @override
  String get inboxReasonAskClosed => '내 물음을 닫았다';

  @override
  String get inboxReasonOther => '불렀다';

  @override
  String get meSignedInAs => '@{handle} 계정으로 로그인했다';

  @override
  String get attachmentOpen => '열기';

  @override
  String get attachmentFailed => '이 파일을 불러오지 못했다.';
  @override
  String get attachmentGoToMessage => '글로 가기';

  @override
  String get artifactVersion => 'v{v}';

  @override
  String get artifactVersionWithPrev => 'v{v} · 이전 {prev}개';

  @override
  String get artifactLatest => '최신 v{v} 있음';

  @override
  String get artifactOpen => '미리보기 열기';

  @override
  String get artifactMadeBy => '에이전트가 만든 페이지';

  @override
  String get artifactReload => '다시 불러오기';

  @override
  String get artifactClose => '미리보기 닫기';

  @override
  String get artifactLoading => '불러오는 중…';

  @override
  String get artifactTooLarge => '미리보기 한도를 넘는다({size}). 데스크톱 앱에서 파일로 받아 볼 수 있다.';

  @override
  String get artifactForbidden => '이 미리보기를 볼 수 없다(채널 멤버가 아니다).';

  @override
  String get artifactGone => '지워진 미리보기다.';

  @override
  String get artifactFailed => '미리보기를 열지 못했다.';

  @override
  String get artifactOpenedOutside => '브라우저로 열었다.';

  @override
  String get artifactLeaveTitle => '미리보기 밖으로 이동';

  @override
  String get artifactLeaveBody => '이 페이지가 {host} 로 이동하려 한다.';

  @override
  String get artifactLeaveOpen => '브라우저로 열기';

  @override
  String get artifactLeaveCancel => '취소';

  @override
  String get timeUnderMinute => '1분 미만';

  @override
  String get timeMinutes => '{n}분';

  @override
  String get timeHours => '{n}시간';

  @override
  String get timeDays => '{n}일';

  @override
  String get timeRunning => '{duration}째';

  @override
  String get timeTook => '{duration} 걸림';

  @override
  String get timeAgo => '{duration} 전';

  @override
  String get timeJustNow => '방금';

  @override
  String get timeIn => '{duration} 뒤';

  @override
  String get timeSoon => '곧';

  @override
  String get agentWorking => '작업 중';

  @override
  String get agentWaiting => '대기 중';

  @override
  String get reportTitle => '끝남';

  @override
  String get reportChecks => '확인한 것';

  @override
  String get reportFiles => '바뀐 파일';

  @override
  String get reportRemaining => '남은 것';

  @override
  String get reportNext => '다음';

  @override
  String get failureTitle => '끝내지 못했다';

  @override
  String get failureRetryable => '다시 해 볼 수 있다';

  @override
  String get failureNeedsHand => '손이 필요하다';

  @override
  String get attachmentAdd => '첨부 추가';
  @override
  String get reactionAdd => '이모지 달기';
  @override
  String get messageCopyLink => '링크 복사';
  @override
  String get messageReplyInThread => '스레드에서 답글';
  @override
  String get messageCopyBody => '본문 복사';
  @override
  String get messageLinkCopied => '링크를 복사했다';
  @override
  String get messageBodyCopied => '본문을 복사했다';
  @override
  String get messageCopyFailed => '복사하지 못했다';
  @override
  String get messageMarkUnread => '여기부터 안 읽음';
  @override
  String get messageMarkedUnread => '안 읽음으로 표시했다';
  @override
  String get threadStatusReceived => '받음';
  @override
  String get threadStatusRunning => '작업 중';
  @override
  String get threadStatusWaiting => '기다림';
  @override
  String get threadStatusMyTurn => '내 차례';
  @override
  String get threadStatusStuck => '막힘';
  @override
  String get threadStatusDone => '완료';
  @override
  String get threadStatusSomeone => '에이전트';
  @override
  String get messagePostToChannel => '채널에도 올리기';
  @override
  String get messageRecallFromChannel => '채널에서 거두기';
  @override
  String get messagePostedToChannel => '채널에도 올렸다';
  @override
  String get messageRecalledFromChannel => '채널에서 거뒀다';
  @override
  String get messageEdit => '수정';
  @override
  String get messageEditSave => '저장';
  @override
  String get messageEditCancel => '취소';
  @override
  String get messageDelete => '삭제';
  @override
  String get messageDeleteConfirmTitle => '이 메시지를 지울까?';
  @override
  String get messageDeleteConfirmBody => '지운 메시지는 되돌릴 수 없다.';
  @override
  String get messageDeleteConfirm => '삭제';
  @override
  String get messageActionFailed => '하지 못했다';
  @override
  String get mentionAdd => '사람·에이전트 부르기';

  @override
  String get attachmentUploadFailed => '파일을 올리지 못했다.';

  @override
  String get attachmentRemove => '첨부에서 빼기';
  @override
  String attachmentRemoveNamed(String name) => '첨부에서 빼기: $name';

  @override
  String get attachLibrary => '사진 보관함';

  @override
  String get attachCamera => '사진 찍기';

  @override
  String get attachFile => '파일 선택';

  @override
  String get attachCameraUnavailable => '이 기기에는 카메라가 없다';

  @override
  String get cameraDeniedTitle => '카메라를 쓸 수 없다';

  @override
  String get cameraDeniedBody => '설정 › Harkroom 에서 카메라를 켜면 사진을 찍어 붙일 수 있다.';

  @override
  String get cameraDeniedClose => '닫기';

  @override
  String get cameraDeniedOpenSettings => '설정 열기';

  @override
  String get cameraOpenFailed => '카메라를 열지 못했다.';

  @override
  String get loadFailedHint => '네트워크를 확인한 뒤 다시 시도해 달라.';

  @override
  String get messagesLoadFailed => '메시지를 불러오지 못했다';

  @override
  String get threadLoadFailed => '답글을 불러오지 못했다';
  @override
  String get threadRootMissing => '원글을 불러오지 못했다';
  @override
  String get threadLatestReplies => '최신 답글로 ↓';
  @override
  String get threadLatestLoadFailed => '최신 답글을 불러오지 못했다';
  @override
  String get threadLatestNewReplies => '새 답글 {n}개 · 최신으로 ↓';

  @override
  String get inboxLoadFailed => '인박스를 불러오지 못했다';

  @override
  String get messagesEmptyHint => '첫 말을 남기거나 @ 로 에이전트를 불러 본다.';

  @override
  String get channelStartLine => '여기가 #{name} 의 처음이다';

  @override
  String get olderLoadFailed => '이전 메시지를 불러오지 못했다';

  @override
  String get inboxEmptyHint => '누가 부르거나 답을 기다리면 여기 선다.';

  @override
  String get bootUnreachableTitle => '서버에 닿지 못했다';

  @override
  String get connectionLostBand => '연결 끊김 · 다시 붙으면 놓친 메시지를 읽어 온다';

  @override
  String get connectionRetryNow => '다시';

  @override
  String get connectionSignInAgain => '다시 로그인';

  @override
  String get sendFailed => '보내지 못했다';

  @override
  String get sending => '보내는 중…';

  @override
  String get resend => '다시 보내기';

  @override
  String get discard => '지우기';

  @override
  String get sendWaitsForUpload => '첨부를 올리는 중이다 — 끝나면 보낼 수 있다';

  @override
  String get askFailed => '고르지 못했다';
  @override
  String get mergeOnceButton => '이번 한 번 머지';
  @override
  String get mergeOnceSheetTitle => '데스크톱에서 승인하세요';
  @override
  String get mergeOnceSheetBody => '이번 한 번 머지는 머지할 GitHub 계정을 고르는 승인이다. 계정은 그 에이전트가 도는 기기의 것이라 데스크톱 앱의 이 카드에서 고른다. 7일 허락과 거절은 여기서도 된다.';

  @override
  String get reactionFailed => '리액션을 바꾸지 못했다';

  @override
  String get loadFailedServer => '서버가 응답하지 않았다. 잠시 뒤 다시 시도해 달라.';

  @override
  String get loadFailedForbidden => '이 대화를 볼 권한이 없다.';

  @override
  String get dayToday => '오늘';

  @override
  String get dayYesterday => '어제';

  @override
  String get dayDate => '{m}월 {d}일';

  @override
  String get mentionDeniedLine => '{handles} 를 부르지 않았다 — 부를 수 있는 범위 밖이다. 그 에이전트의 소유자에게 물어라.';

  @override
  String get linkConfirmTitle => '이 링크가 여는 곳';

  @override
  String get messageLinkGone => '그 메시지가 없다 — 지워졌거나, 링크가 아무것도 가리키지 않는다.';

  @override
  String get messageLinkForbidden => '그 메시지를 열 수 없다 — 내가 참여하지 않은 대화에 있다.';

  @override
  String get messageLinkFailed => '메시지를 열지 못했다. 연결을 확인하고 다시 시도해라.';

  @override
  String get linkConfirmOpen => '열기';

  @override
  String get linkConfirmCancel => '취소';
  @override
  String get markdownTableMoreRows => '…{n}행 더';

  @override
  String get linkUserInfoWarning => '주소 앞에 다른 이름이 붙어 있다. 실제로 열리는 곳은 위의 굵은 주소다.';

  @override
  String get linkNonAsciiWarning => '주소에 영문이 아닌 글자가 있다. 닮은 글자로 꾸민 주소일 수 있다.';


  @override
  String get meCommunitiesSection => '이 기기의 커뮤니티';

  @override
  String get communityAdd => '커뮤니티 추가';

  @override
  String get communityCurrent => '지금 커뮤니티';

  @override
  String get communityExpired => '다시 로그인';

  @override
  String get communitySignOutAll => '모든 커뮤니티에서 로그아웃';

  @override
  String get communitySignOutAllConfirm => '이 기기의 커뮤니티 {count}개에서 모두 로그아웃한다. 다시 쓰려면 하나씩 다시 로그인해야 한다.';

  @override
  String get communityCancel => '취소';

  @override
  String get communitySignOutOne => '{name} 에서 로그아웃';

  @override
  String get communitySwitchTo => '이 커뮤니티로 옮기기';

  @override
  String get communitySwitched => '지금 커뮤니티: {name} · @{handle}';

  @override
  String get communityLabel => '표시 이름';

  @override
  String get communityLabelHint => '이 기기에서만 쓴다. 비우면 호스트명을 쓴다.';

  @override
  String get communityAccount => '계정';

  @override
  String get communityServer => '서버';

  @override
  String get communityVersion => '버전';

  @override
  String get communityVersionUnknown => '알 수 없음';

  @override
  String get communityAddSubmit => '로그인하고 옮기기';

  @override
  String get communityAddClose => '닫기';

  @override
  String get communitySave => '저장';

  @override
  String get loginOtherCommunity => '다른 커뮤니티로';

  @override
  String get communityExpiredSubtitle => '로그인이 만료됐다';

  @override
  String get communityManage => '커뮤니티 관리';

  @override
  String get communitySwitcherLabel => '커뮤니티 전환, {name}';

  @override
  String get communityOthersWaiting => ', 다른 커뮤니티에 나를 기다리는 것이 있다';

  @override
  String get pushPromptTitle => '부르면 알려 드릴게요';

  @override
  String get pushPromptBody => '에이전트가 나를 부르거나, 내 스레드에 답하거나, 내 선택을 기다리면 앱이 꺼져 있어도 알림을 보내요.';

  @override
  String get pushPromptEnable => '알림 켜기';

  @override
  String get pushPromptLater => '나중에';

  @override
  String get pushSection => '알림';

  @override
  String get pushNotAsked => '아직 켜지 않았어요';

  @override
  String get pushTurnOn => '켜기';

  @override
  String get pushDenied => 'iOS 설정에서 꺼져 있어요';

  @override
  String get pushOpenSettings => 'iOS 설정 열기';

  @override
  String get pushCommunityOn => '알림 받음';

  @override
  String get pushCommunityOff => '알림 끔';

  @override
  String get pushPreview => '내용 미리보기';

  @override
  String get pushPreviewHint => '알림에 글 앞부분을 보여 줘요. 켜면 그 내용이 Apple 알림 서버를 거치고 잠금 화면에도 보일 수 있어요.';

  @override
  String get searchButton => '찾기';

  @override
  String get searchHint => '메시지 찾기';

  @override
  String get searchCancel => '취소';

  @override
  String get searchScopeAll => '전체';

  @override
  String get searchScopeThread => '이 스레드';

  @override
  String get searchStart => '두 글자부터 찾는다.';

  @override
  String get searchNoResults => '‘{q}’에 맞는 메시지가 없다.';

  @override
  String get searchTwoLetterHint => '두 글자는 낱말 앞부분만 찾는다 — 한 글자 더 쳐 보라.';

  @override
  String get searchEverywhere => '전체에서 찾기';

  @override
  String get searchFailed => '찾지 못했다.';

  @override
  String get searchMoreFailed => '결과를 더 불러오지 못했다.';

  @override
  String get searchInThread => '스레드';

  @override
  String get searchRecent => '최근 찾은 말';

  @override
  String get searchRecentClear => '모두 지우기';

  @override
  String get searchRecentRemove => '지우기';

  @override
  String get searchShortcuts => '바로 가기';

  @override
  String get searchCount => '메시지 {n}개';

  @override
  String get searchCountMore => '메시지 {n}개 이상';

  @override
  String get searchSort => '정렬';

  @override
  String get searchSortRelevance => '관련도순';

  @override
  String get searchSortRelevanceHint => '맞는 글 먼저';

  @override
  String get searchSortRecent => '최신순';

  @override
  String get searchSortRecentHint => '새 글 먼저';

  @override
  String get inboxOtherCommunity => '{name} 에 나를 기다리는 것 {count}';

  @override
  String get inboxOtherView => '보기';

  @override
  Map<String, String> get systemTemplates => const {
        'system.member.added': '{accountId}님이 채널에 추가됐다.',
        'system.member.left': '{accountId}님이 채널에서 나갔다.',
        'system.member.removed': '{accountId}님이 채널에서 제거됐다.',
        'system.threadModel.set': '{accountId}님이 이 스레드에서 {agentId} 의 모델을 {value} 로 정했다. 다음 턴부터 적용된다.',
        'system.threadModel.setByAgent': '{accountId}님이 이 스레드에서 {agentId} 의 모델을 {value} 로 정했다(에이전트 지정). 다음 턴부터 적용된다.',
        'system.threadModel.cleared': '{accountId}님이 이 스레드에서 {agentId} 의 모델 지정을 풀었다. 다음 턴부터 기본값으로 돈다.',
        'system.threadModel.clearedByAgent': '{accountId}님이 이 스레드에서 {agentId} 의 모델 지정을 풀었다(에이전트 지정). 다음 턴부터 기본값으로 돈다.',
        'system.merge.approvalUsed': '🔓 {repo}#{number} 1회 승인으로 머지 시도 · head {head} · gh {ghUser}',
        'system.merge.approvalUsedRelaxed': '🔓 {repo}#{number} 1회 승인으로 머지 시도 · head {head} · gh {ghUser} · CI 판정은 GitHub 에 맡김',
        'system.merge.merged': '🔀 {repo}#{number} 머지됨 · {sha} (래퍼 보고)',
        'system.merge.mergedGranted': '🔀 {repo}#{number} 머지됨 · {sha} · 권한: {granterId} (래퍼 보고)',
        'system.merge.failed': '⛔ {repo}#{number} 머지 실패 · head {head} (래퍼 보고)',
        'system.apiCall.done': '🔌 {connector} {method} {path} · {status} (래퍼 보고)',
        'system.apiCall.doneGranted': '🔌 {connector} {method} {path} · {status} · 권한: {granterId} (래퍼 보고)',
        'system.apiCall.unreachable': '🔌 {connector} {method} {path} · 닿지 않음 (래퍼 보고)',
        'system.apiCall.unreachableGranted': '🔌 {connector} {method} {path} · 닿지 않음 · 권한: {granterId} (래퍼 보고)',
        'system.apiBlocked': '🔒 {agentId} 의 API 호출이 막혔다 · {connector} {request} · {code}',
        'system.apiBlocked.noConnector': '🔒 {agentId} 의 API 호출이 막혔다 · (연결 없음) {request} · {code}',
        'system.delegation.pending': '🔑 {fromId} 가 {toId} 에게 {scope} 권한을 다시 주려 한다 · {rootId} 의 허락을 기다린다',
        'system.delegation.done': '🔑 {fromId} 가 {toId} 에게 {scope} 권한을 다시 줬다 · 받은 곳: {rootId}',
        'system.secret.createdGenerated': '🔑 {agentId} 가 비밀을 만들었다: {name} · 서버가 만든 값({type}) · 이 채널로 자기에게만 부여 · 설정 › 나 › 비밀과 API · {ownerId}',
        'system.secret.createdImported': '🔑 {agentId} 가 비밀을 만들었다: {name} · 값을 에이전트가 정함(import) · 이 채널로 자기에게만 부여 · 설정 › 나 › 비밀과 API · {ownerId}',
        'system.secret.rotatedGenerated': '🔑 {agentId} 가 비밀을 회전했다(판 {version}): {name} · 서버가 만든 값({type}) · 이 채널로 자기에게만 부여 · 설정 › 나 › 비밀과 API · {ownerId}',
        'system.secret.rotatedImported': '🔑 {agentId} 가 비밀을 회전했다(판 {version}): {name} · 값을 에이전트가 정함(import) · 이 채널로 자기에게만 부여 · 설정 › 나 › 비밀과 API · {ownerId}',
        'system.skill.proposed': '스킬이 제안됐다: {slug} — 승인을 기다린다.',
        'system.skill.proposedFlagged': '스킬이 제안됐다: {slug} — 승인을 기다린다.\n⚠️ 쓰기 검사에 걸렸다({reason}). 승인 전에 본문을 확인해라.',
      };

  @override
  Map<String, String> get blockedWhy => const {
        'not_granted': '권한 없음',
        'no_connector': '연결 없음',
        'no_secret': '키 없음',
        'secret_expired': '키 만료',
        'expired': '권한 만료',
        'suspended': '권한 멈춤',
        'method_not_allowed': '메서드가 범위 밖',
        'path_not_allowed': '경로가 범위 밖',
        'cause_not_human': '이 권한은 사람이 시킨 턴에서만 쓸 수 있다',
      };
}
