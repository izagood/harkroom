import 'strings.dart';

/// **원본.** 다른 언어는 이 파일을 보고 채운다(계획서 §7-2).
class StringsEn implements Strings {
  const StringsEn();

  @override
  String get localeCode => 'en';

  @override
  String get appName => 'Harkroom';

  @override
  String get connectTitle => 'Connect to a workspace';

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
  String get composerHint => 'Message, or @mention an agent';

  @override
  String get composerSend => 'Send';

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
  String get tabChannels => 'Channels';

  @override
  String get tabInbox => 'Inbox';

  @override
  String get tabMe => 'You';

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
  String get attachmentAdd => 'Attach a file';

  @override
  String get attachmentUploadFailed => 'Could not upload that file.';

  @override
  String get loadFailedHint => 'Check your connection and try again.';

  @override
  String get messagesLoadFailed => 'Could not load messages';

  @override
  String get threadLoadFailed => 'Could not load replies';

  @override
  String get inboxLoadFailed => 'Could not load your inbox';

  @override
  String get messagesEmptyHint => 'Say something, or call an agent with @.';

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
  String get linkConfirmTitle => 'This opens';

  @override
  String get linkConfirmOpen => 'Open';

  @override
  String get linkConfirmCancel => 'Cancel';

  @override
  String get linkUserInfoWarning => 'Something is prefixed to this address. It actually opens the bold host above.';

  @override
  String get linkNonAsciiWarning => 'This address has non-Latin characters. It may imitate another site.';

}
