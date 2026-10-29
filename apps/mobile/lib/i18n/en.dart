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

  // 비밀번호 재설정 코드(서버 #1409).
  @override
  String get loginForgot => 'Forgot your password?';
  @override
  String get pwresetGuideTitle => 'Recover your password';
  @override
  String get pwresetGuideBody => 'In this community, passwords are reset with a reset code that an admin issues.';
  @override
  String get pwresetGuideStep1 => '1. Ask an admin for a reset code. They’ll give you your login ID with it — it can differ from your @handle.';
  @override
  String get pwresetGuideStep2 => '2. Once you have the code, choose a new password.';
  @override
  String get pwresetGuideNote => 'A code works once, for 30 minutes. The admin never sees your new password.';
  @override
  String get pwresetGuideHaveCode => 'I have a reset code';
  @override
  String get pwresetGuideClose => 'Close';
  @override
  String get pwresetGuideNoAdminSummary => 'No admin, or the admin is locked out?';
  @override
  String get pwresetGuideNoAdminBody => 'Whoever runs the server has to reset it on the server host. Hosted communities: use password recovery on the service that created your community.';
  @override
  String get pwresetFormTitle => 'New password';
  @override
  String get pwresetFormCode => 'Reset code';
  @override
  String get pwresetFormCodeHint => 'Paste is fine · letter case doesn’t matter';
  @override
  String get pwresetFormNewPassword => 'New password';
  @override
  String get pwresetFormConfirm => 'Confirm new password';
  @override
  String get pwresetFormTooShort => 'At least 8 characters.';
  @override
  String get pwresetFormTooLong => 'At most 128 characters.';
  @override
  String get pwresetFormMismatch => 'The two passwords don’t match.';
  @override
  String get pwresetFormSubmit => 'Change and sign in';
  @override
  String get pwresetFormSubmitting => 'Changing…';
  @override
  String get pwresetFormInvalid => 'The code is wrong, already used, or expired. Ask an admin for a new one.';
  @override
  String get pwresetFormLimited => 'Too many attempts. Try again later.';
  @override
  String get pwresetFormUnsupported => 'This server doesn’t support reset codes yet. Ask whoever runs it to update.';
  @override
  String get pwresetNoticeIssuedDetail => 'If you didn’t ask for it, tell the owner.';
  @override
  String get pwresetNoticeUsedDetail => 'All other devices were signed out.';
  @override
  String get pwresetNoticeUnknownAdmin => 'An admin';
  @override
  String get pwresetNoticeRevokedTag => '(revoked)';
  @override
  String get pwresetNoticeAck => 'Got it';
  @override
  String pwresetNoticeIssued(String by, String when) => '$by issued a password reset code for your account ($when).';
  @override
  String pwresetNoticeUsed(String by, String when) => 'Your password was changed with a reset code issued by $by ($when).';

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
  String get askReplied => 'Answered in text';

  @override
  String permWarnHead(String code) {
    switch (code) {
      case 'runs_arbitrary':
        return 'Can run anything';
      case 'executes_in_workload':
        return 'Runs inside a live workload';
      case 'mutates_remote':
        return 'Changes remote state';
      case 'reads_file':
        return 'Reads a file';
      case 'short_prefix':
        return 'Short prefix';
      case 'uses_github_account':
        return 'Runs as a GitHub account';
      default:
        return code;
    }
  }

  @override
  String permWarnWhy(String code) {
    switch (code) {
      case 'runs_arbitrary':
        return 'this command runs other commands';
      case 'executes_in_workload':
        return 'the command runs in a container or pod';
      case 'mutates_remote':
        return 'may be hard to undo';
      case 'reads_file':
        return 'approval is tied to its current contents and asks again if it changes';
      case 'short_prefix':
        return 'every subcommand after it is opened';
      case 'uses_github_account':
        return 'the gh account signed in on the Mac running this agent is used, with everything it can reach';
      default:
        return '';
    }
  }

  @override
  String get permMandateChip => 'Mandate';

  @override
  String permMandateStarted(String date) => 'started $date';

  @override
  String get permAskAddLine => 'Add a line to the mandate?';

  @override
  String get permAskNewMandate => 'Start a mandate and add this line?';

  @override
  String permAskOwnerTurn(String owner) => "$owner's turn";

  @override
  String get permApproveMandate => 'For this mandate';

  @override
  String get permApproveNewMandate => 'Start a mandate from this thread and add';

  @override
  String get permApproveOnce => 'Just this once';

  @override
  String get permDeny => 'Deny';

  @override
  String get permOnceOperatorPicks => 'The operator on the running device picks the account';

  @override
  String get permStateAdded => 'Added to the mandate';

  @override
  String get permStateOnce => 'Approved just this once';

  @override
  String permStateOnceGh(String gh) => 'Approved just this once · gh $gh';

  @override
  String get permStateDenied => 'Denied';

  @override
  String permResultDenied(String who) => '$who denied';

  @override
  String permResultAdded(String who) => '$who added this to the mandate';

  @override
  String permResultOnce(String who) => '$who allowed it once';

  @override
  String permResultNewAdded(String who) => '$who started a mandate and added this';

  @override
  String get permStateExpired => 'Expired · the agent has to ask again';

  @override
  String get permStateSuperseded => 'Replaced by a new card';

  @override
  String get permOpenNewCard => 'Open the new card';

  @override
  String get permStateMandateEnded => 'The mandate has ended · nothing more to decide';

  @override
  String get permReadOnly => 'Only the owner can decide';

  @override
  String get permViaChat => 'answered in chat';

  @override
  String get permMirrorNeutral => 'Permission request · check and decide in the original card\'s channel';

  @override
  String get permOpenOriginal => 'Open the original card';

  @override
  String get permMirrorOf => 'Mirror · deciding here decides the original';

  @override
  String permLimitUses(int n) => n == 1 ? 'once' : '$n uses';

  @override
  String permLimitDays(int n) => '$n days';

  @override
  String permLimitHours(int n) => '$n h';

  @override
  String get permLimitCi => 'CI failure ignored';

  @override
  String get askSuperseded => 'Replaced by a new question';

  @override
  String get askExpired => 'Expired';

  @override
  String get askExpiredHint => 'The agent has to ask again';

  @override
  String askPickAnyway(int n) => 'Pick anyway ($n)';

  @override
  String get askDecline => 'Don\u2019t answer this';

  @override
  String get askToYou => 'Waiting on you';

  @override
  String get askToAnyone => 'A person picks';

  @override
  String bundleRemaining(int n, int m) => '$n of $m left to decide';

  @override
  String bundleAllDone(int m) => 'All $m decided';

  @override
  String bundleAcceptRecommended(int n) => 'Accept $n recommended';

  @override
  String get bundleAcceptNote => 'Irreversible decisions (merge, deploy, secrets, permissions) are left out';

  @override
  String bundleAcceptPending(int n, int s) => 'Choosing $n recommended · $s';

  @override
  String get bundleAcceptCancel => 'Cancel';

  @override
  String get bundleRecommended => 'recommended';

  @override
  String get bundleReplyInThread => 'Reply in the original thread →';

  @override
  String get bundleDecideInThread => 'Decide in the original thread →';

  @override
  String get bundleLoading => 'Loading the original…';

  @override
  String get bundleUnavailable => 'Can’t see the original card';

  @override
  String bundleAnswered(String label, String name) => '$label · $name';

  @override
  String bundleReplied(String name) => 'Replied in writing · $name';

  @override
  String bundleNoteBy(String name) => 'Summary by $name:';

  @override
  String get bundleSkipIrreversible => 'Irreversible, so left out — pick it yourself';

  @override
  String get bundleSkipNoRecommendation => 'No recommendation, so left out';

  @override
  String get bundleSkipLink => 'Decided in its own thread, so left out';

  @override
  String get bundleSkipFailed => 'Couldn’t pick — try again';

  @override
  String get bundleSomeone => 'Someone';

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
  String get systemAuthor => 'Harkroom';
  @override
  String get systemBadge => 'System';
  @override
  String get systemNotice => 'System notice';
  @override
  String get systemAboutPost => 'About {name}’s message';
  @override
  String get systemAboutRequest => 'About {name}’s request';
  @override
  String get systemOpenOriginal => 'open the message';

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
  String sectionMoveTitle(String channel) => 'Move #$channel to a section';
  @override
  String get sectionNew => 'New section…';
  @override
  String get sectionRemove => 'Remove from section';
  @override
  String get sectionNameHint => 'Section name';
  @override
  String get sectionCreate => 'Create';
  @override
  String get sectionCancel => 'Cancel';
  @override
  String get sectionMoveFailed => "Couldn't move the channel.";
  @override
  String get sectionNameTaken => 'A section with that name already exists.';
  @override
  String sectionMoved(String channel, String section) => '#$channel → $section';
  @override
  String get sectionStarredNote => 'Unstar it to see it in this section.';
  @override
  String get sectionHasUnread => 'Has unread channels';
  @override
  String get sectionEmpty => 'Long-press a channel to move it here';
  @override
  String get cardMyTurn => 'My turn';
  @override
  String get cardNew => 'New';
  @override
  String get cardSaved => 'Saved';
  @override
  String get messageSave => 'Save for later';
  @override
  String get messageUnsave => 'Unsave';
  @override
  String get messageSavedMark => 'Saved';
  @override
  String get messageSavedMarkLong => 'Saved for later';
  @override
  String get savedAdded => 'Saved';
  @override
  String get savedOpenList => 'View list';
  @override
  String get savedRemoved => 'Removed';
  @override
  String get savedUndo => 'Undo';
  @override
  String get savedSaveFailed => 'Couldn’t save this message';
  @override
  String get savedActionFailed => 'Couldn’t update the saved list';
  @override
  String get savedTitle => 'Saved messages';
  @override
  String get savedTabOpen => 'To do';
  @override
  String get savedTabDone => 'Done';
  @override
  String get savedEmptyOpen => 'Nothing saved yet';
  @override
  String get savedEmptyOpenHint => 'Long-press a message and choose “Save for later” to collect it here.';
  @override
  String get savedEmptyDone => 'Nothing done yet';
  @override
  String get savedLoadFailed => 'Saved messages didn’t load';
  @override
  String get savedMarkDone => 'Mark as done';
  @override
  String get savedMarkOpen => 'Put back on the list';
  @override
  String get savedMovedDone => 'Moved to done';
  @override
  String get savedMovedOpen => 'Back on the list';
  @override
  String get savedDeleted => 'Deleted message';
  @override
  String get savedUnavailable => 'You no longer have access to this channel';
  @override
  String get newDm => 'New DM';
  @override
  String get newDmStart => 'Start a DM';
  @override
  String get newDmFilter => 'Search people';
  @override
  String get newDmNoMatch => 'No one matches.';
  @override
  String get newMessageDmFailed => "Couldn't open the DM.";
  @override
  String get unreadOnlyEmpty => 'All caught up.';

  @override
  String get inboxEmpty => 'Nothing here yet.';

  @override
  String get inboxMineCount => '{count} waiting on you';
  @override
  String get inboxTabTodo => 'To do';
  @override
  String get inboxTabNews => 'Updates';
  @override
  String get inboxTabLater => 'Later';
  @override
  String get inboxTabCleared => 'Cleared';
  @override
  String get inboxSectionDecision => 'Needs your decision';
  @override
  String get inboxSectionBlocker => 'Blocked, waiting on you';
  @override
  String get inboxSectionNews => 'Also waiting on you';
  @override
  String get inboxKindDecision => 'Decide';
  @override
  String get inboxKindBlocker => 'Blocked';
  @override
  String get inboxKindNews => 'Update';
  @override
  String get inboxStale => 'Waiting over a week ({count})';
  @override
  String get inboxStaleDecisions => '{count} decisions';
  @override
  String get inboxClearAll => 'Dismiss all';
  @override
  String get inboxDismiss => 'Dismiss';
  @override
  String get inboxLater => 'Later';
  @override
  String get inboxPutBack => 'Put back';
  @override
  String get inboxUndo => 'Undo';
  @override
  String get inboxOpenThread => 'Open thread';
  @override
  String get inboxLatest => 'Latest';
  @override
  String get inboxReplies => '{count} replies';
  @override
  String get inboxNew => 'New';
  @override
  String get inboxDays => '{count}d';
  @override
  String get inboxDismissed => 'Dismissed {count}';
  @override
  String get inboxSnoozed => 'Snoozed {count} until tomorrow';
  @override
  String get inboxActionFailed => 'Could not update. Try again.';
  @override
  String get inboxMineEmpty => 'Nothing is waiting on you';
  @override
  String get inboxShowNews => 'See {count} updates';
  @override
  String get inboxTabEmpty => 'Nothing here';

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
  String attachmentHtmlMeta(String size) => 'HTML · $size';

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
  String get exchangeDecided => 'Decided';
  @override
  String get exchangeFinished => 'Finished';
  @override
  String get exchangeCollapse => 'Collapse';
  @override
  String exchangeCount(int n) => n == 1 ? '1 exchange' : '$n exchanges';
  @override
  String exchangeAttachments(int n) => n == 1 ? '1 attachment' : '$n attachments';

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
  String get threadStatusReceived => 'Received';
  @override
  String get threadStatusRunning => 'Working';
  @override
  String get threadStatusWaiting => 'Waiting';
  @override
  String get threadStatusMyTurn => 'Your turn';
  @override
  String get threadStatusStuck => 'Stuck';
  @override
  String get threadStatusDone => 'Done';
  @override
  String get threadStatusSomeone => 'An agent';
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
  String get threadLatestLoadFailed => "Couldn't load the latest replies";
  @override
  String get threadLatestNewReplies => '{n} new · Jump to latest ↓';
  @override
  String get threadJumpLatest => 'Latest replies';
  @override
  String get threadJumpNew => '{n} new replies';
  @override
  String get threadJumpA11y => 'Jump to latest replies';
  @override
  String get threadJumpA11yNew => 'Jump to latest replies, {n} new';

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
  String get mergeOnceCiButton => 'Merge once ignoring CI failures';
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

  @override
  Map<String, String> get systemTemplates => const {
        'system.member.added': '{accountId} was added to the channel.',
        'system.member.left': '{accountId} left the channel.',
        'system.member.removed': '{accountId} was removed from the channel.',
        'system.member.addedBy': '{actorId} added {accountId} to the channel.',
        'system.member.removedBy': '{actorId} removed {accountId} from the channel.',
        'system.threadModel.set': '{accountId} set {agentId}\'s model in this thread to {value}. It applies from the next turn.',
        'system.threadModel.setByAgent': '{accountId} set {agentId}\'s model in this thread to {value} (set by an agent). It applies from the next turn.',
        'system.threadModel.cleared': '{accountId} cleared {agentId}\'s model in this thread. It runs on its default from the next turn.',
        'system.threadModel.clearedByAgent': '{accountId} cleared {agentId}\'s model in this thread (set by an agent). It runs on its default from the next turn.',
        'system.merge.approvalUsed': '🔓 {repo}#{number} merge attempted with a one-time approval · head {head} · gh {ghUser}',
        'system.merge.approvalUsedRelaxed': '🔓 {repo}#{number} merge attempted with a one-time approval · head {head} · gh {ghUser} · CI check left to GitHub',
        'system.merge.merged': '🔀 {repo}#{number} merged · {sha} (wrapper report)',
        'system.merge.mergedGranted': '🔀 {repo}#{number} merged · {sha} · permission: {granterId} (wrapper report)',
        'system.merge.queued': '📥 {repo}#{number} added to the merge queue · head {head} (wrapper report)',
        'system.merge.queuedGranted': '📥 {repo}#{number} added to the merge queue · head {head} · permission: {granterId} (wrapper report)',
        'system.merge.approvalUsedCiOverride': '🔓 {repo}#{number} merge attempted with a CI-failure override · approved by {approverId} · head {head} · gh {ghUser}',
        'system.merge.approvalUsedOperatorPick': "🔓 {repo}#{number} merge attempted with a one-time approval · head {head} · gh (operator's pick)",
        'system.merge.approvalUsedRelaxedOperatorPick': "🔓 {repo}#{number} merge attempted with a one-time approval · head {head} · gh (operator's pick) · CI check left to GitHub",
        'system.merge.approvalUsedCiOverrideOperatorPick': "🔓 {repo}#{number} merge attempted with a CI-failure override · approved by {approverId} · head {head} · gh (operator's pick)",
        'system.merge.mergedIgnoring': '🔀 {repo}#{number} merged · {sha} · permission: {granterId} · ignored: {checks} (wrapper report)',
        'system.merge.mergedCiOverride': '🔀 {repo}#{number} merged · {sha} · permission: {granterId} · CI-failure override · ignored: {checks} (wrapper report)',
        'system.merge.mergedCiOverrideGrew': '🔀 {repo}#{number} merged · {sha} · permission: {granterId} · CI-failure override · ignored: {checks} (more than when approved) (wrapper report)',
        'system.merge.queuedIgnoring': '📥 {repo}#{number} added to the merge queue · head {head} · permission: {granterId} · ignored: {checks} (wrapper report)',
        'system.merge.queuedCiOverride': '📥 {repo}#{number} added to the merge queue · head {head} · permission: {granterId} · CI-failure override · ignored: {checks} (wrapper report)',
        'system.merge.queuedCiOverrideGrew': '📥 {repo}#{number} added to the merge queue · head {head} · permission: {granterId} · CI-failure override · ignored: {checks} (more than when approved) (wrapper report)',
        'system.merge.failed': '⛔ {repo}#{number} merge failed · head {head} (wrapper report)',
        'system.apiCall.done': '🔌 {connector} {method} {path} · {status} (wrapper report)',
        'system.apiCall.doneGranted': '🔌 {connector} {method} {path} · {status} · permission: {granterId} (wrapper report)',
        'system.apiCall.unreachable': '🔌 {connector} {method} {path} · unreachable (wrapper report)',
        'system.apiCall.unreachableGranted': '🔌 {connector} {method} {path} · unreachable · permission: {granterId} (wrapper report)',
        'system.apiBlocked': '🔒 {agentId}\'s API call was blocked · {connector} {request} · {code}',
        'system.apiBlocked.noConnector': '🔒 {agentId}\'s API call was blocked · (no connection) {request} · {code}',
        'system.delegation.pending': '🔑 {fromId} is trying to re-grant {toId} the permission {scope} · waiting for {rootId} to allow it',
        'system.delegation.done': '🔑 {fromId} re-granted {toId} the permission {scope} · from: {rootId}',
        'system.secret.createdGenerated': '🔑 {agentId} created the secret {name} · value made by the server ({type}) · granted only to itself in this channel · Settings › Me › Secrets and APIs · {ownerId}',
        'system.secret.createdImported': '🔑 {agentId} created the secret {name} · value set by the agent (import) · granted only to itself in this channel · Settings › Me › Secrets and APIs · {ownerId}',
        'system.secret.rotatedGenerated': '🔑 {agentId} rotated the secret {name} (version {version}) · value made by the server ({type}) · granted only to itself in this channel · Settings › Me › Secrets and APIs · {ownerId}',
        'system.secret.rotatedImported': '🔑 {agentId} rotated the secret {name} (version {version}) · value set by the agent (import) · granted only to itself in this channel · Settings › Me › Secrets and APIs · {ownerId}',
        'system.permission.approvedByUser': '🔓 {actorId} approved a permission request from {agentId} (not the owner) · {kind} {target} · revoke it in Settings › Agents · {ownerId}',
        'system.skill.proposed': 'Skill proposed: {slug} — waiting for approval.',
        'system.skill.proposedFlagged': 'Skill proposed: {slug} — waiting for approval.\n⚠️ It was flagged by the write check ({reason}). Check the body before approving.',
        'system.chatApproval.negated': '⚠️ Not approved: the message says no, wait or cancel, so nothing was decided.',
        'system.chatApproval.question': '⚠️ Not approved: it reads as a question, so nothing was decided. To approve, end with a plain "approve".',
        'system.chatApproval.bypass': '⚠️ Not approved: "bypass" does not approve anything from chat. Decide on the card.',
        'system.chatApproval.conflict': '⚠️ Not approved: it has both an approve and a deny word, so nothing was decided.',
        'system.chatApproval.denyNeedsLink': '⚠️ Not denied: to deny from chat, include the card link.',
        'system.chatApproval.noWord': '⚠️ Not approved: there is a card link but no approval word (approve, 승인, 허락, 머지해, 진행해).',
        'system.chatApproval.notFinal': '⚠️ Not approved: other words follow the approval word, so nothing was decided. To approve, end the message with it, like "approve".',
        'system.chatApproval.denyNotFinal': '⚠️ Not denied: other words follow the deny word, so nothing was decided. End the message with it, like "deny".',
        'system.chatApproval.tooMany': '⚠️ Not approved: one message decides at most 5 cards. Split it and write again.',
        'system.chatApproval.noCard': '⚠️ Not approved: none of the linked messages is a card you can decide.',
        'system.chatApproval.askCard': '⚠️ Not answered: answer a choice card with its number ("1"), an option name, or "as recommended". You can also pick on the card.',
        'system.chatApproval.askMany': '⚠️ Not answered: several choice cards are waiting, so it is unclear which one. Write again with one card link.',
        'system.chatApproval.askNoMatch': '⚠️ Not answered: no option matches. Write again with a number ("1") or an option name.',
        'system.chatApproval.askNoRecommended': '⚠️ Not answered: this card has no single recommended option. Write again with a number or an option name.',
        'system.chatApproval.askIrreversible': '⚠️ Not answered: this card asks about something that cannot be undone, so "as recommended" or a number without a card link does not pick on it. Write again with the exact option name, or with the card link and a number.',
        'system.chatApproval.askAnswered': '⚠️ Not answered: this card is already answered.',
        'system.chatApproval.hidden': '⚠️ Not approved: that card is in a channel you cannot see.',
        'system.chatApproval.headChanged': '⚠️ Not approved: the PR head changed since the card was shown. Look at the card again.',
        'system.chatApproval.ciWord': '⚠️ Not approved: a CI-failure card needs "ignore CI" (CI 무시) in the message to approve.',
        'system.chatApproval.settled': '⚠️ Not approved: the cards in this thread are already decided or expired. Link another card to decide it.',
        'system.chatApproval.noRequest': '⚠️ Not approved: there is no waiting request older than this message. Write again with the card link.',
        'system.chatApproval.notBefore': '⚠️ Not approved: the card was posted after this message. Decide on the card, or write again with its link.',
        'system.chatApproval.decided': '⚠️ Not approved: that card is already decided.',
        'system.chatApproval.expired': '⚠️ Not approved: that card has expired.',
        'system.chatApproval.onceOnCard': '⚠️ Not approved: decide this merge card in its thread or with its link.',
        'system.chatApproval.failed': '⚠️ Not approved: it could not be decided. Try again on the card.',
      };

  @override
  Map<String, String> get blockedWhy => const {
        'not_granted': 'no permission',
        'no_connector': 'no such connection',
        'no_secret': 'no key',
        'secret_expired': 'key expired',
        'expired': 'permission expired',
        'suspended': 'permission stopped',
        'method_not_allowed': 'method outside the permission',
        'path_not_allowed': 'path outside the permission',
        'cause_not_human': 'This permission can only be used in turns a person started',
      };
}
