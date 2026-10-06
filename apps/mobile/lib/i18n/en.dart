import 'strings.dart';

/// **원본.** 다른 언어는 이 파일을 보고 채운다(계획서 §7-2).
class StringsEn implements Strings {
  const StringsEn();

  @override
  String get localeCode => 'en';

  @override
  String get appName => 'Harkroom';

  @override
  String get connectTitle => 'Connect to a community';

  @override
  String get connectServerUrlLabel => 'Server address';

  @override
  String get connectServerUrlHint => 'https://example.com';

  @override
  String get connectContinue => 'Continue';

  @override
  String get connectErrorEmpty => 'Enter the server address.';

  @override
  String get connectErrorMalformed => 'That does not look like a server address.';

  // ATS 가 돌려주는 것은 사유 없는 "연결 실패" 뿐이다 — 그래서 무엇이 문제이고
  // 무엇으로 바꿔야 하는지를 **둘 다** 말한다.
  @override
  String get connectErrorInsecure =>
      'iOS blocks plain http:// connections. Use an https:// address.';

  @override
  String get commonLoading => 'Loading…';

  @override
  String get commonBack => 'Back';

  @override
  String get commonRetry => 'Try again';

  @override
  String get loginTitle => 'Sign in';

  @override
  String get loginIdLabel => 'Login ID';

  @override
  String get loginPasswordLabel => 'Password';

  @override
  String get loginSubmit => 'Sign in';

  @override
  String get loginErrorRejected => 'That login ID or password is not right.';

  @override
  String get loginErrorUnreachable => 'Could not reach the server. Check the address and your connection.';

  @override
  String get signOut => 'Sign out';

  @override
  String get channelsTitle => 'Channels';

  @override
  String get channelsEmpty => 'You are not in any channel yet.';

  @override
  String get messagesEmpty => 'No messages yet.';

  @override
  String get composerHint => 'Message {name}';

  @override
  String get composerSend => 'Send';

  @override
  String get stickyMentionsLabel => 'Kept mentions';

  @override
  String get stickyMentionRemove => 'Stop mentioning {handle}';

  @override
  String get autoMentionSkip => 'Skip {handle} this time';

  @override
  String get channelAgentTitle => 'Tap to keep mentioning';

  @override
  String get modelDefault => 'Default';

  @override
  String get modelThreadSet => 'this thread';

  @override
  String get modelAgentSet => 'set by {handle}';

  @override
  String get modelAgentSetUnknown => 'set by an agent';

  @override
  String get modelAllDefault => 'Model · all default';

  @override
  String get modelMore => 'More…';

  @override
  String get modelEffort => 'Effort';

  @override
  String get modelEffortDefault => 'Agent setting';

  @override
  String get modelAgentDefault => 'Agent default:';

  @override
  String get modelHarnessDefault => 'harness default';

  @override
  String get modelCostNote => 'Stronger models use weekly limits faster; switching mid-thread misses the cache once; a smaller model may not fit a long thread.';

  @override
  String get modelNextTurn => 'Applies from the next turn.';

  @override
  String get modelReset => 'Reset to default';

  @override
  String get modelApply => 'Apply';

  @override
  String get modelCustom => 'Model name';

  @override
  String get modelStale => 'Not used — the agent\'s harness changed since this was set.';

  @override
  String get modelSheetTitleThread => "This thread's model for {handle}";

  @override
  String get modelSheetTitleComposer => "Model for {handle} in this message";

  @override
  String get modelQuickLabel => "{handle} model";

  @override
  String get modelClearThread => "Clear the thread's model";

  @override
  String get modelStaleDetail => "Harness changed to {harness} — this thread's model is not used.";

  @override
  String get modelRepick => "Choose again";

  @override
  String get connectionOnline => 'Connected';

  @override
  String get connectionConnecting => 'Connecting…';

  @override
  String get connectionReconnecting => 'Reconnecting…';

  @override
  String get connectionDead => 'Disconnected — sign in again';

  @override
  String get noticeSessionNotSaved => 'Could not save your session to the keychain. You can keep using the app now, but you will need to sign in again next time you open it.';

  @override
  String get agentBadge => 'agent';

  @override
  String get askAnswered => 'Decided';

  @override
  String get askClosed => 'Closed without an answer';

  @override
  String get askDecline => 'Don\u2019t answer this';

  @override
  String get askToYou => 'Waiting on you';

  @override
  String get askToAnyone => 'A person picks';

  @override
  String get threadTitle => 'Thread';

  @override
  String get threadReplyHint => 'Reply in thread';

  @override
  String get threadRepliesZero => 'Reply';

  @override
  String get threadRepliesOne => '1 reply';

  @override
  String get threadRepliesMany => '{n} replies';

  @override
  String get mentionPickerEmpty => 'No match';

  @override
  String get mentionUnknown => '@unknown';

  @override
  String get systemAccountUnknown => 'unknown';

  @override
  String get tabChannels => 'Channels';

  @override
  String get tabInbox => 'Inbox';

  @override
  String get tabMe => 'You';
  @override
  String get meSettings => 'Me · Settings';
  @override
  String get tabHome => 'Home';
  @override
  String get tabDms => 'DMs';
  @override
  String get tabAgents => 'Agents';
  @override
  String get agentsRunning => 'Working now';
  @override
  String get agentsWaiting => 'Scheduled';
  @override
  String get agentsAll => 'All agents';
  @override
  String get agentsNoneRunning => 'No agent is working right now.';
  @override
  String get agentsLoadFailed => "Couldn't load what agents are doing.";
  @override
  String get agentsMine => 'Mine';
  @override
  String get dmsEmpty => 'No direct messages yet.';
  @override
  String get sectionStarred => 'Starred';
  @override
  String get sectionChannels => 'Channels';
  @override
  String get cardMyTurn => 'My turn';
  @override
  String get cardNew => 'New';
  @override
  String get newMessage => 'New message';
  @override
  String get newMessagePeople => 'People';
  @override
  String get newMessageDmFailed => "Couldn't open the DM.";
  @override
  String get unreadOnlyEmpty => 'All caught up.';

  @override
  String get inboxEmpty => 'Nothing here yet.';

  @override
  String get inboxMarkAllRead => 'Mark all read';

  @override
  String get inboxReasonMention => 'Called you';

  @override
  String get inboxReasonThreadReply => 'Reply';

  @override
  String get inboxReasonDm => 'DM';

  @override
  String get inboxReasonAskAnswered => 'Answered your question';

  @override
  String get inboxReasonAskClosed => 'Declined your question';

  @override
  String get inboxReasonOther => 'Called you';

  @override
  String get meSignedInAs => 'Signed in as @{handle}';

  @override
  String get attachmentOpen => 'Open';

  @override
  String get attachmentFailed => 'Could not load this file.';
  @override
  String get attachmentGoToMessage => 'Go to message';

  @override
  String get artifactVersion => 'v{v}';

  @override
  String get artifactVersionWithPrev => 'v{v} · {prev} earlier';

  @override
  String get artifactLatest => 'Latest v{v}';

  @override
  String get artifactOpen => 'Open preview';

  @override
  String get artifactMadeBy => 'A page made by an agent';

  @override
  String get artifactReload => 'Reload';

  @override
  String get artifactClose => 'Close preview';

  @override
  String get artifactLoading => 'Loading…';

  @override
  String get artifactTooLarge => 'Too large to preview ({size}). You can download it in the desktop app.';

  @override
  String get artifactForbidden => 'You cannot see this preview.';

  @override
  String get artifactGone => 'This preview was deleted.';

  @override
  String get artifactFailed => 'The preview could not be opened.';

  @override
  String get artifactOpenedOutside => 'Opened in your browser.';

  @override
  String get artifactLeaveTitle => 'Leave the preview?';

  @override
  String get artifactLeaveBody => 'This page wants to go to {host}.';

  @override
  String get artifactLeaveOpen => 'Open in browser';

  @override
  String get artifactLeaveCancel => 'Cancel';

  @override
  String get timeUnderMinute => 'under a minute';

  @override
  String get timeMinutes => '{n}m';

  @override
  String get timeHours => '{n}h';

  @override
  String get timeDays => '{n}d';

  @override
  String get timeRunning => '{duration}';

  @override
  String get timeTook => 'took {duration}';

  @override
  String get timeAgo => '{duration} ago';

  @override
  String get timeJustNow => 'just now';

  @override
  String get timeIn => 'in {duration}';

  @override
  String get timeSoon => 'soon';

  @override
  String get agentWorking => 'Working';

  @override
  String get agentWaiting => 'Waiting';

  @override
  String get reportTitle => 'Done';

  @override
  String get reportChecks => 'Checked';

  @override
  String get reportFiles => 'Files changed';

  @override
  String get reportRemaining => 'Still open';

  @override
  String get reportNext => 'Next';

  @override
  String get failureTitle => 'Could not finish it';

  @override
  String get failureRetryable => 'Can be retried';

  @override
  String get failureNeedsHand => 'Needs a hand';

  @override
  String get attachmentAdd => 'Add attachment';
  @override
  String get reactionAdd => 'Add reaction';
  @override
  String get messageCopyLink => 'Copy link';
  @override
  String get messageReplyInThread => 'Reply in thread';
  @override
  String get messageCopyBody => 'Copy text';
  @override
  String get messageLinkCopied => 'Link copied';
  @override
  String get messageBodyCopied => 'Text copied';
  @override
  String get messageCopyFailed => 'Could not copy';
  @override
  String get messageMarkUnread => 'Mark unread from here';
  @override
  String get messageMarkedUnread => 'Marked unread';
  @override
  String get messagePostToChannel => 'Post to channel';
  @override
  String get messageRecallFromChannel => 'Remove from channel';
  @override
  String get messagePostedToChannel => 'Sent to channel';
  @override
  String get messageRecalledFromChannel => 'Removed from channel';
  @override
  String get messageEdit => 'Edit message';
  @override
  String get messageEditSave => 'Save';
  @override
  String get messageEditCancel => 'Cancel';
  @override
  String get messageDelete => 'Delete message';
  @override
  String get messageDeleteConfirmTitle => 'Delete this message?';
  @override
  String get messageDeleteConfirmBody => 'This cannot be undone.';
  @override
  String get messageDeleteConfirm => 'Delete';
  @override
  String get messageActionFailed => "Couldn't do that";
  @override
  String get mentionAdd => 'Mention a person or agent';

  @override
  String get attachmentUploadFailed => 'Could not upload that file.';

  @override
  String get attachmentRemove => 'Remove from attachments';
  @override
  String attachmentRemoveNamed(String name) => 'Remove $name';

  @override
  String get attachLibrary => 'Photo Library';

  @override
  String get attachCamera => 'Take Photo';

  @override
  String get attachFile => 'Choose File';

  @override
  String get attachCameraUnavailable => 'This device has no camera';

  @override
  String get cameraDeniedTitle => 'Camera is off';

  @override
  String get cameraDeniedBody => 'Turn on Camera in Settings › Harkroom to take a photo and attach it.';

  @override
  String get cameraDeniedClose => 'Close';

  @override
  String get cameraDeniedOpenSettings => 'Open Settings';

  @override
  String get cameraOpenFailed => 'Could not open the camera.';

  @override
  String get loadFailedHint => 'Check your connection and try again.';

  @override
  String get messagesLoadFailed => 'Could not load messages';

  @override
  String get threadLoadFailed => 'Could not load replies';
  @override
  String get threadRootMissing => 'Could not load the original message';
  @override
  String get threadLatestReplies => 'Latest replies ↓';

  @override
  String get inboxLoadFailed => 'Could not load your inbox';

  @override
  String get messagesEmptyHint => 'Say something, or call an agent with @.';

  @override
  String get channelStartLine => 'This is the very beginning of #{name}';

  @override
  String get olderLoadFailed => "Couldn't load earlier messages";

  @override
  String get inboxEmptyHint => 'When someone calls you or waits on you, it shows up here.';

  @override
  String get bootUnreachableTitle => 'Could not reach the server';

  @override
  String get connectionLostBand => 'Disconnected · missed messages load when it reconnects';

  @override
  String get connectionRetryNow => 'Retry';

  @override
  String get connectionSignInAgain => 'Sign in again';

  @override
  String get sendFailed => 'Not sent';

  @override
  String get sending => 'Sending…';

  @override
  String get resend => 'Send again';

  @override
  String get discard => 'Discard';

  @override
  String get sendWaitsForUpload => 'Uploading — you can send when it finishes';

  @override
  String get askFailed => 'Could not send your choice';

  @override
  String get reactionFailed => 'Could not change the reaction';

  @override
  String get loadFailedServer => 'The server did not respond. Try again in a moment.';

  @override
  String get loadFailedForbidden => 'You don\'t have access to this.';

  @override
  String get dayToday => 'Today';

  @override
  String get dayYesterday => 'Yesterday';

  @override
  String get dayDate => '{m}/{d}';

  @override
  String get mentionDeniedLine => 'Did not call {handles} — outside who may invoke them. Ask the owner of that agent.';

  @override
  String get linkConfirmTitle => 'Where this link goes';

  @override
  String get messageLinkGone => 'That message is gone — it was deleted, or the link points at nothing.';

  @override
  String get messageLinkForbidden => "You can't open that message — it's in a conversation you're not part of.";

  @override
  String get messageLinkFailed => 'Could not open that message. Check your connection and try again.';

  @override
  String get linkConfirmOpen => 'Open';

  @override
  String get linkConfirmCancel => 'Cancel';
  @override
  String get markdownTableMoreRows => '…{n} more rows';

  @override
  String get linkUserInfoWarning => 'Something is prefixed to this address. It actually opens the bold host above.';

  @override
  String get linkNonAsciiWarning => 'This address has non-Latin characters. It may imitate another site.';


  @override
  String get meCommunitiesSection => 'Communities on this device';

  @override
  String get communityAdd => 'Add community';

  @override
  String get communityCurrent => 'Current community';

  @override
  String get communityExpired => 'Sign in again';

  @override
  String get communitySignOutAll => 'Sign out of all communities';

  @override
  String get communitySignOutAllConfirm => 'You\'ll be signed out of {count} communities on this device. To use one again, sign in to it again.';

  @override
  String get communityCancel => 'Cancel';

  @override
  String get communitySignOutOne => 'Sign out of {name}';

  @override
  String get communitySwitchTo => 'Switch to this community';

  @override
  String get communitySwitched => 'Now in {name} · @{handle}';

  @override
  String get communityLabel => 'Display name';

  @override
  String get communityLabelHint => 'Only on this device. Leave empty to use the host name.';

  @override
  String get communityAccount => 'Account';

  @override
  String get communityServer => 'Server';

  @override
  String get communityVersion => 'Version';

  @override
  String get communityVersionUnknown => 'Unknown';

  @override
  String get communityAddSubmit => 'Sign in and switch';

  @override
  String get communityAddClose => 'Close';

  @override
  String get communitySave => 'Save';

  @override
  String get loginOtherCommunity => 'Use another community';

  @override
  String get communityExpiredSubtitle => 'Signed out — session expired';

  @override
  String get communityManage => 'Manage communities';

  @override
  String get communitySwitcherLabel => 'Switch community, {name}';

  @override
  String get communityOthersWaiting => ', another community has something waiting for you';

  @override
  String get pushPromptTitle => "Get notified when you're called";

  @override
  String get pushPromptBody => "When an agent mentions you, replies in your thread, or waits for your choice, you'll get a notification — even when the app is closed.";

  @override
  String get pushPromptEnable => 'Turn on notifications';

  @override
  String get pushPromptLater => 'Not now';

  @override
  String get pushSection => 'Notifications';

  @override
  String get pushNotAsked => 'Not turned on yet';

  @override
  String get pushTurnOn => 'Turn on';

  @override
  String get pushDenied => 'Turned off in iOS Settings';

  @override
  String get pushOpenSettings => 'Open iOS Settings';

  @override
  String get pushCommunityOn => 'Notifications on';

  @override
  String get pushCommunityOff => 'Notifications off';

  @override
  String get pushPreview => 'Show previews';

  @override
  String get pushPreviewHint => "Shows the start of the message in notifications. When on, that text passes through Apple's notification servers and may appear on your lock screen.";

  @override
  String get searchButton => 'Search';

  @override
  String get searchHint => 'Search messages';

  @override
  String get searchCancel => 'Cancel';

  @override
  String get searchScopeAll => 'All';

  @override
  String get searchScopeThread => 'This thread';

  @override
  String get searchStart => 'Type two or more letters to search.';

  @override
  String get searchNoResults => 'No messages match ‘{q}’.';

  @override
  String get searchTwoLetterHint => 'Two letters only match the start of a word — try one more.';

  @override
  String get searchEverywhere => 'Search everywhere';

  @override
  String get searchFailed => 'Could not search.';

  @override
  String get searchMoreFailed => 'Could not load more results.';

  @override
  String get searchInThread => 'thread';

  @override
  String get searchRecent => 'Recent';

  @override
  String get searchRecentClear => 'Clear';

  @override
  String get searchRecentRemove => 'Remove';

  @override
  String get searchShortcuts => 'Go to';

  @override
  String get searchCount => '{n} messages';

  @override
  String get searchCountMore => '{n}+ messages';

  @override
  String get searchSort => 'Sort';

  @override
  String get searchSortRelevance => 'Relevance';

  @override
  String get searchSortRelevanceHint => 'Best matches first';

  @override
  String get searchSortRecent => 'Newest';

  @override
  String get searchSortRecentHint => 'Newest first';

  @override
  String get inboxOtherCommunity => '{count} waiting for you in {name}';

  @override
  String get inboxOtherView => 'View';
}
