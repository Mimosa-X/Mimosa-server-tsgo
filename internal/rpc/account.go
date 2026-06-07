package rpc

import (
	"context"
	"errors"

	"github.com/gotd/td/tg"

	"telesrv/internal/compat/tdesktop"
	"telesrv/internal/domain"
)

// registerAccount 注册 account.* RPC handler。
func (r *Router) registerAccount(d *tg.ServerDispatcher) {
	d.OnAccountCheckUsername(r.onAccountCheckUsername)
	d.OnAccountUpdateProfile(r.onAccountUpdateProfile)
	d.OnAccountUpdateUsername(r.onAccountUpdateUsername)
	d.OnAccountGetPassword(func(ctx context.Context) (*tg.AccountPassword, error) {
		if r.deps.Account == nil {
			return tgPassword(domain.PasswordSettings{SecureRandom: []byte("telesrv-tdesktop-dev-secure-rand")}), nil
		}
		userID, _, err := r.currentUserID(ctx)
		if err != nil {
			return nil, internalErr()
		}
		settings, err := r.deps.Account.GetPassword(ctx, userID)
		if err != nil {
			return nil, internalErr()
		}
		return tgPassword(settings), nil
	})
	d.OnAccountGetNotifySettings(func(ctx context.Context, peer tg.InputNotifyPeerClass) (*tg.PeerNotifySettings, error) {
		return tdesktop.NotifySettings(), nil
	})
	d.OnAccountUpdateNotifySettings(func(ctx context.Context, req *tg.AccountUpdateNotifySettingsRequest) (bool, error) {
		return true, nil
	})
	d.OnAccountGetPrivacy(r.onAccountGetPrivacy)
	d.OnAccountSetPrivacy(r.onAccountSetPrivacy)
	d.OnAccountGetAuthorizations(func(ctx context.Context) (*tg.AccountAuthorizations, error) {
		return tdesktop.Authorizations(), nil
	})
	d.OnAccountGetDefaultEmojiStatuses(func(ctx context.Context, hash int64) (tg.AccountEmojiStatusesClass, error) {
		return tdesktop.DefaultEmojiStatuses(), nil
	})
	d.OnAccountGetCollectibleEmojiStatuses(func(ctx context.Context, hash int64) (tg.AccountEmojiStatusesClass, error) {
		return tdesktop.CollectibleEmojiStatuses(), nil
	})
	d.OnAccountGetDefaultGroupPhotoEmojis(func(ctx context.Context, hash int64) (tg.EmojiListClass, error) {
		return tdesktop.DefaultGroupPhotoEmojis(), nil
	})
	d.OnAccountGetConnectedBots(func(ctx context.Context) (*tg.AccountConnectedBots, error) {
		return tdesktop.ConnectedBots(), nil
	})
	d.OnAccountGetReactionsNotifySettings(r.onAccountGetReactionsNotifySettings)
	d.OnAccountSetReactionsNotifySettings(r.onAccountSetReactionsNotifySettings)
	d.OnAccountGetContactSignUpNotification(func(ctx context.Context) (bool, error) {
		return false, nil
	})
	d.OnAccountGetThemes(func(ctx context.Context, req *tg.AccountGetThemesRequest) (tg.AccountThemesClass, error) {
		return tdesktop.AccountThemes(), nil
	})
	d.OnAccountGetContentSettings(func(ctx context.Context) (*tg.AccountContentSettings, error) {
		return tdesktop.ContentSettings(), nil
	})
	d.OnAccountGetGlobalPrivacySettings(func(ctx context.Context) (*tg.GlobalPrivacySettings, error) {
		return tdesktop.GlobalPrivacySettings(), nil
	})
	d.OnAccountGetPasskeys(func(ctx context.Context) (*tg.AccountPasskeys, error) {
		return tdesktop.Passkeys(), nil
	})
	d.OnAccountGetSavedMusicIDs(func(ctx context.Context, hash int64) (tg.AccountSavedMusicIDsClass, error) {
		if _, _, err := r.currentUserID(ctx); err != nil {
			return nil, internalErr()
		}
		return &tg.AccountSavedMusicIDs{IDs: []int64{}}, nil
	})
	d.OnAccountGetAccountTTL(r.onAccountGetAccountTTL)
	d.OnAccountUpdateStatus(r.onAccountUpdateStatus)
}

func (r *Router) onAccountGetPrivacy(ctx context.Context, key tg.InputPrivacyKeyClass) (*tg.AccountPrivacyRules, error) {
	userID, _, err := r.currentUserID(ctx)
	if err != nil {
		return nil, internalErr()
	}
	domainKey, ok := domainPrivacyKeyFromInput(key)
	if !ok {
		return nil, privacyKeyInvalidErr()
	}
	if r.deps.Privacy == nil {
		return tdesktop.PrivacyRules(key), nil
	}
	rules, err := r.deps.Privacy.GetRules(ctx, userID, domainKey)
	if err != nil {
		return nil, privacyErr(err)
	}
	return r.tgAccountPrivacyRules(ctx, userID, rules)
}

func (r *Router) onAccountSetPrivacy(ctx context.Context, req *tg.AccountSetPrivacyRequest) (*tg.AccountPrivacyRules, error) {
	userID, _, err := r.currentUserID(ctx)
	if err != nil {
		return nil, internalErr()
	}
	domainKey, ok := domainPrivacyKeyFromInput(req.Key)
	if !ok {
		return nil, privacyKeyInvalidErr()
	}
	rules, err := r.domainPrivacyRulesFromInput(ctx, userID, req.Rules)
	if err != nil {
		return nil, err
	}
	if r.deps.Privacy == nil {
		return &tg.AccountPrivacyRules{Rules: tgPrivacyRules(rules), Users: []tg.UserClass{}, Chats: []tg.ChatClass{}}, nil
	}
	saved, err := r.deps.Privacy.SetRules(ctx, userID, domainKey, rules)
	if err != nil {
		return nil, privacyErr(err)
	}
	out, err := r.tgAccountPrivacyRules(ctx, userID, saved)
	if err != nil {
		return nil, err
	}
	r.pushUserUpdates(ctx, userID, &tg.Updates{
		Updates: []tg.UpdateClass{&tg.UpdatePrivacy{
			Key:   tgPrivacyKey(saved.Key),
			Rules: tgPrivacyRules(saved.Rules),
		}},
		Users: []tg.UserClass{},
		Chats: []tg.ChatClass{},
	})
	return out, nil
}

func (r *Router) onAccountGetAccountTTL(ctx context.Context) (*tg.AccountDaysTTL, error) {
	if _, _, err := r.currentUserID(ctx); err != nil {
		return nil, internalErr()
	}
	return &tg.AccountDaysTTL{Days: 365}, nil
}

func (r *Router) onAccountUpdateStatus(ctx context.Context, offline bool) (bool, error) {
	userID, authorized, err := r.currentUserID(ctx)
	if err != nil {
		return false, internalErr()
	}
	if !authorized || userID == 0 {
		return true, nil
	}
	status := r.setPresenceFromContext(ctx, userID, offline)
	r.pushUserStatus(ctx, userID, status)
	return true, nil
}

func (r *Router) tgAccountPrivacyRules(ctx context.Context, viewerUserID int64, rules domain.PrivacyRules) (*tg.AccountPrivacyRules, error) {
	userIDs := privacyRuleUserIDs(rules.Rules)
	users := []domain.User{}
	if r.deps.Users != nil && len(userIDs) > 0 {
		var err error
		users, err = r.deps.Users.ByIDs(ctx, viewerUserID, userIDs)
		if err != nil {
			return nil, internalErr()
		}
	}
	return &tg.AccountPrivacyRules{
		Rules: tgPrivacyRules(rules.Rules),
		Users: tgUsers(users),
		Chats: []tg.ChatClass{},
	}, nil
}

func (r *Router) domainPrivacyRulesFromInput(ctx context.Context, userID int64, in []tg.InputPrivacyRuleClass) ([]domain.PrivacyRule, error) {
	out := make([]domain.PrivacyRule, 0, len(in))
	for _, rule := range in {
		switch v := rule.(type) {
		case *tg.InputPrivacyValueAllowContacts:
			out = append(out, domain.PrivacyRule{Kind: domain.PrivacyRuleAllowContacts})
		case *tg.InputPrivacyValueAllowAll:
			out = append(out, domain.PrivacyRule{Kind: domain.PrivacyRuleAllowAll})
		case *tg.InputPrivacyValueAllowUsers:
			ids, err := r.privacyUserIDsFromInput(ctx, userID, v.Users)
			if err != nil {
				return nil, err
			}
			out = append(out, domain.PrivacyRule{Kind: domain.PrivacyRuleAllowUsers, UserIDs: ids})
		case *tg.InputPrivacyValueDisallowContacts:
			out = append(out, domain.PrivacyRule{Kind: domain.PrivacyRuleDisallowContacts})
		case *tg.InputPrivacyValueDisallowAll:
			out = append(out, domain.PrivacyRule{Kind: domain.PrivacyRuleDisallowAll})
		case *tg.InputPrivacyValueDisallowUsers:
			ids, err := r.privacyUserIDsFromInput(ctx, userID, v.Users)
			if err != nil {
				return nil, err
			}
			out = append(out, domain.PrivacyRule{Kind: domain.PrivacyRuleDisallowUsers, UserIDs: ids})
		case *tg.InputPrivacyValueAllowChatParticipants:
			out = append(out, domain.PrivacyRule{Kind: domain.PrivacyRuleAllowChatParticipants, ChatIDs: append([]int64(nil), v.Chats...)})
		case *tg.InputPrivacyValueDisallowChatParticipants:
			out = append(out, domain.PrivacyRule{Kind: domain.PrivacyRuleDisallowChatParticipants, ChatIDs: append([]int64(nil), v.Chats...)})
		case *tg.InputPrivacyValueAllowCloseFriends:
			out = append(out, domain.PrivacyRule{Kind: domain.PrivacyRuleAllowCloseFriends})
		case *tg.InputPrivacyValueAllowPremium:
			out = append(out, domain.PrivacyRule{Kind: domain.PrivacyRuleAllowPremium})
		case *tg.InputPrivacyValueAllowBots:
			out = append(out, domain.PrivacyRule{Kind: domain.PrivacyRuleAllowBots})
		case *tg.InputPrivacyValueDisallowBots:
			out = append(out, domain.PrivacyRule{Kind: domain.PrivacyRuleDisallowBots})
		default:
			return nil, privacyValueInvalidErr()
		}
	}
	return out, nil
}

func (r *Router) privacyUserIDsFromInput(ctx context.Context, currentUserID int64, inputs []tg.InputUserClass) ([]int64, error) {
	out := make([]int64, 0, len(inputs))
	seen := make(map[int64]struct{}, len(inputs))
	for _, input := range inputs {
		u, found, err := r.userFromInput(ctx, currentUserID, input)
		if err != nil {
			return nil, internalErr()
		}
		if !found || u.ID == 0 {
			return nil, userIDInvalidErr()
		}
		if _, ok := seen[u.ID]; ok {
			continue
		}
		seen[u.ID] = struct{}{}
		out = append(out, u.ID)
	}
	return out, nil
}

func domainPrivacyKeyFromInput(key tg.InputPrivacyKeyClass) (domain.PrivacyKey, bool) {
	switch key.(type) {
	case *tg.InputPrivacyKeyStatusTimestamp:
		return domain.PrivacyKeyStatusTimestamp, true
	case *tg.InputPrivacyKeyChatInvite:
		return domain.PrivacyKeyChatInvite, true
	case *tg.InputPrivacyKeyPhoneCall:
		return domain.PrivacyKeyPhoneCall, true
	case *tg.InputPrivacyKeyPhoneP2P:
		return domain.PrivacyKeyPhoneP2P, true
	case *tg.InputPrivacyKeyForwards:
		return domain.PrivacyKeyForwards, true
	case *tg.InputPrivacyKeyProfilePhoto:
		return domain.PrivacyKeyProfilePhoto, true
	case *tg.InputPrivacyKeyPhoneNumber:
		return domain.PrivacyKeyPhoneNumber, true
	case *tg.InputPrivacyKeyAddedByPhone:
		return domain.PrivacyKeyAddedByPhone, true
	case *tg.InputPrivacyKeyVoiceMessages:
		return domain.PrivacyKeyVoiceMessages, true
	case *tg.InputPrivacyKeyAbout:
		return domain.PrivacyKeyAbout, true
	case *tg.InputPrivacyKeyBirthday:
		return domain.PrivacyKeyBirthday, true
	case *tg.InputPrivacyKeyStarGiftsAutoSave:
		return domain.PrivacyKeyStarGiftsAutoSave, true
	case *tg.InputPrivacyKeyNoPaidMessages:
		return domain.PrivacyKeyNoPaidMessages, true
	case *tg.InputPrivacyKeySavedMusic:
		return domain.PrivacyKeySavedMusic, true
	default:
		return "", false
	}
}

func tgPrivacyKey(key domain.PrivacyKey) tg.PrivacyKeyClass {
	switch key {
	case domain.PrivacyKeyStatusTimestamp:
		return &tg.PrivacyKeyStatusTimestamp{}
	case domain.PrivacyKeyChatInvite:
		return &tg.PrivacyKeyChatInvite{}
	case domain.PrivacyKeyPhoneCall:
		return &tg.PrivacyKeyPhoneCall{}
	case domain.PrivacyKeyPhoneP2P:
		return &tg.PrivacyKeyPhoneP2P{}
	case domain.PrivacyKeyForwards:
		return &tg.PrivacyKeyForwards{}
	case domain.PrivacyKeyProfilePhoto:
		return &tg.PrivacyKeyProfilePhoto{}
	case domain.PrivacyKeyPhoneNumber:
		return &tg.PrivacyKeyPhoneNumber{}
	case domain.PrivacyKeyAddedByPhone:
		return &tg.PrivacyKeyAddedByPhone{}
	case domain.PrivacyKeyVoiceMessages:
		return &tg.PrivacyKeyVoiceMessages{}
	case domain.PrivacyKeyAbout:
		return &tg.PrivacyKeyAbout{}
	case domain.PrivacyKeyBirthday:
		return &tg.PrivacyKeyBirthday{}
	case domain.PrivacyKeyStarGiftsAutoSave:
		return &tg.PrivacyKeyStarGiftsAutoSave{}
	case domain.PrivacyKeyNoPaidMessages:
		return &tg.PrivacyKeyNoPaidMessages{}
	case domain.PrivacyKeySavedMusic:
		return &tg.PrivacyKeySavedMusic{}
	default:
		return &tg.PrivacyKeyStatusTimestamp{}
	}
}

func tgPrivacyRules(rules []domain.PrivacyRule) []tg.PrivacyRuleClass {
	out := make([]tg.PrivacyRuleClass, 0, len(rules))
	for _, rule := range rules {
		switch rule.Kind {
		case domain.PrivacyRuleAllowContacts:
			out = append(out, &tg.PrivacyValueAllowContacts{})
		case domain.PrivacyRuleAllowAll:
			out = append(out, &tg.PrivacyValueAllowAll{})
		case domain.PrivacyRuleAllowUsers:
			out = append(out, &tg.PrivacyValueAllowUsers{Users: append([]int64(nil), rule.UserIDs...)})
		case domain.PrivacyRuleDisallowContacts:
			out = append(out, &tg.PrivacyValueDisallowContacts{})
		case domain.PrivacyRuleDisallowAll:
			out = append(out, &tg.PrivacyValueDisallowAll{})
		case domain.PrivacyRuleDisallowUsers:
			out = append(out, &tg.PrivacyValueDisallowUsers{Users: append([]int64(nil), rule.UserIDs...)})
		case domain.PrivacyRuleAllowChatParticipants:
			out = append(out, &tg.PrivacyValueAllowChatParticipants{Chats: append([]int64(nil), rule.ChatIDs...)})
		case domain.PrivacyRuleDisallowChatParticipants:
			out = append(out, &tg.PrivacyValueDisallowChatParticipants{Chats: append([]int64(nil), rule.ChatIDs...)})
		case domain.PrivacyRuleAllowCloseFriends:
			out = append(out, &tg.PrivacyValueAllowCloseFriends{})
		case domain.PrivacyRuleAllowPremium:
			out = append(out, &tg.PrivacyValueAllowPremium{})
		case domain.PrivacyRuleAllowBots:
			out = append(out, &tg.PrivacyValueAllowBots{})
		case domain.PrivacyRuleDisallowBots:
			out = append(out, &tg.PrivacyValueDisallowBots{})
		}
	}
	return out
}

func privacyRuleUserIDs(rules []domain.PrivacyRule) []int64 {
	seen := map[int64]struct{}{}
	out := make([]int64, 0)
	for _, rule := range rules {
		for _, id := range rule.UserIDs {
			if id == 0 {
				continue
			}
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			out = append(out, id)
		}
	}
	return out
}

func privacyErr(err error) error {
	switch {
	case errors.Is(err, domain.ErrPrivacyKeyInvalid):
		return privacyKeyInvalidErr()
	case errors.Is(err, domain.ErrPrivacyRuleInvalid):
		return privacyValueInvalidErr()
	default:
		return internalErr()
	}
}

type accountReactionSettingsService interface {
	GetReactionSettings(ctx context.Context, userID int64) (domain.AccountReactionSettings, error)
	SetReactionsNotifySettings(ctx context.Context, userID int64, settings domain.ReactionsNotifySettings) (domain.AccountReactionSettings, error)
}

func (r *Router) onAccountGetReactionsNotifySettings(ctx context.Context) (*tg.ReactionsNotifySettings, error) {
	userID, _, err := r.currentUserID(ctx)
	if err != nil {
		return nil, internalErr()
	}
	if svc, ok := r.deps.Account.(accountReactionSettingsService); ok {
		settings, err := svc.GetReactionSettings(ctx, userID)
		if err != nil {
			return nil, internalErr()
		}
		return tgReactionsNotifySettings(settings.Notify), nil
	}
	return tgReactionsNotifySettings(domain.DefaultAccountReactionSettings().Notify), nil
}

func (r *Router) onAccountSetReactionsNotifySettings(ctx context.Context, settings tg.ReactionsNotifySettings) (*tg.ReactionsNotifySettings, error) {
	userID, _, err := r.currentUserID(ctx)
	if err != nil {
		return nil, internalErr()
	}
	notify := domainReactionsNotifySettings(settings)
	if svc, ok := r.deps.Account.(accountReactionSettingsService); ok {
		next, err := svc.SetReactionsNotifySettings(ctx, userID, notify)
		if err != nil {
			return nil, internalErr()
		}
		return tgReactionsNotifySettings(next.Notify), nil
	}
	return tgReactionsNotifySettings(notify), nil
}

func domainReactionsNotifySettings(settings tg.ReactionsNotifySettings) domain.ReactionsNotifySettings {
	return domain.ReactionsNotifySettings{
		MessagesFrom:  domainReactionNotifyFrom(settings.GetMessagesNotifyFrom),
		StoriesFrom:   domainReactionNotifyFrom(settings.GetStoriesNotifyFrom),
		PollVotesFrom: domainReactionNotifyFrom(settings.GetPollVotesNotifyFrom),
		ShowPreviews:  settings.ShowPreviews,
	}
}

func domainReactionNotifyFrom(get func() (tg.ReactionNotificationsFromClass, bool)) domain.ReactionNotifyFrom {
	if get == nil {
		return domain.ReactionNotifyFromNone
	}
	value, ok := get()
	if !ok || value == nil {
		return domain.ReactionNotifyFromNone
	}
	switch value.(type) {
	case *tg.ReactionNotificationsFromAll:
		return domain.ReactionNotifyFromAll
	case *tg.ReactionNotificationsFromContacts:
		return domain.ReactionNotifyFromContacts
	default:
		return domain.ReactionNotifyFromNone
	}
}

func tgReactionsNotifySettings(settings domain.ReactionsNotifySettings) *tg.ReactionsNotifySettings {
	out := &tg.ReactionsNotifySettings{
		Sound:        &tg.NotificationSoundDefault{},
		ShowPreviews: settings.ShowPreviews,
	}
	if value := tgReactionNotifyFrom(settings.MessagesFrom); value != nil {
		out.SetMessagesNotifyFrom(value)
	}
	if value := tgReactionNotifyFrom(settings.StoriesFrom); value != nil {
		out.SetStoriesNotifyFrom(value)
	}
	if value := tgReactionNotifyFrom(settings.PollVotesFrom); value != nil {
		out.SetPollVotesNotifyFrom(value)
	}
	return out
}

func tgReactionNotifyFrom(value domain.ReactionNotifyFrom) tg.ReactionNotificationsFromClass {
	switch value {
	case domain.ReactionNotifyFromAll:
		return &tg.ReactionNotificationsFromAll{}
	case domain.ReactionNotifyFromContacts:
		return &tg.ReactionNotificationsFromContacts{}
	default:
		return nil
	}
}

func (r *Router) onAccountUpdateProfile(ctx context.Context, req *tg.AccountUpdateProfileRequest) (tg.UserClass, error) {
	userID, _, err := r.currentUserID(ctx)
	if err != nil {
		return nil, internalErr()
	}
	svc, ok := r.deps.Users.(UserIdentityService)
	if !ok {
		return nil, internalErr()
	}
	firstName, hasFirstName := req.GetFirstName()
	lastName, hasLastName := req.GetLastName()
	about, hasAbout := req.GetAbout()
	u, err := svc.UpdateProfile(ctx, userID, domain.UserProfileUpdate{
		FirstName:    firstName,
		HasFirstName: hasFirstName,
		LastName:     lastName,
		HasLastName:  hasLastName,
		About:        about,
		HasAbout:     hasAbout,
	})
	if err != nil {
		return nil, profileErr(err)
	}
	r.pushUsernameUpdate(ctx, u)
	return r.tgSelfUser(u), nil
}

func (r *Router) onAccountCheckUsername(ctx context.Context, username string) (bool, error) {
	userID, _, err := r.currentUserID(ctx)
	if err != nil {
		return false, internalErr()
	}
	svc, ok := r.deps.Users.(UserIdentityService)
	if !ok {
		return false, internalErr()
	}
	okUsername, err := svc.CheckUsername(ctx, userID, username)
	if err != nil {
		return false, usernameErr(err)
	}
	return okUsername, nil
}

func (r *Router) onAccountUpdateUsername(ctx context.Context, username string) (tg.UserClass, error) {
	userID, _, err := r.currentUserID(ctx)
	if err != nil {
		return nil, internalErr()
	}
	svc, ok := r.deps.Users.(UserIdentityService)
	if !ok {
		return nil, internalErr()
	}
	u, err := svc.UpdateUsername(ctx, userID, username)
	if err != nil {
		return nil, usernameErr(err)
	}
	r.pushUsernameUpdate(ctx, u)
	return r.tgSelfUser(u), nil
}

func (r *Router) pushUsernameUpdate(ctx context.Context, u domain.User) {
	if u.ID == 0 {
		return
	}
	r.pushUserUpdates(ctx, u.ID, &tg.Updates{
		Updates: []tg.UpdateClass{&tg.UpdateUserName{
			UserID:    u.ID,
			FirstName: u.FirstName,
			LastName:  u.LastName,
			Usernames: tgUsernames(u.Username),
		}},
		Users: []tg.UserClass{r.tgSelfUser(u)},
		Date:  int(r.clock.Now().Unix()),
	})
}

func usernameErr(err error) error {
	switch {
	case errors.Is(err, domain.ErrUsernameInvalid):
		return usernameInvalidErr()
	case errors.Is(err, domain.ErrUsernameOccupied):
		return usernameOccupiedErr()
	case errors.Is(err, domain.ErrUsernameNotOccupied):
		return usernameNotOccupiedErr()
	default:
		return internalErr()
	}
}

func profileErr(err error) error {
	switch {
	case errors.Is(err, domain.ErrFirstNameInvalid):
		return firstNameInvalidErr()
	case errors.Is(err, domain.ErrAboutTooLong):
		return aboutTooLongErr()
	default:
		return internalErr()
	}
}
