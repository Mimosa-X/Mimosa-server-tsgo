package rpc

import (
	"testing"

	"github.com/gotd/td/tg"

	"telesrv/internal/domain"
)

func TestTGMessagesMessagesMarksViewerSelfAndKeepsProjectedPhone(t *testing.T) {
	const viewerID int64 = 1001
	res := tgMessagesMessages(viewerID, domain.MessageList{
		Users: []domain.User{
			{ID: viewerID, AccessHash: 11, Phone: "15550000001", FirstName: "Owner"},
			{ID: 1002, AccessHash: 22, Phone: "", FirstName: "Peer"},
		},
	})
	full, ok := res.(*tg.MessagesMessages)
	if !ok {
		t.Fatalf("result = %T, want *tg.MessagesMessages", res)
	}
	self, ok := full.Users[0].(*tg.User)
	if !ok || !self.Self || self.Phone != "15550000001" {
		t.Fatalf("self user = %+v ok=%v, want self with phone", full.Users[0], ok)
	}
	peer, ok := full.Users[1].(*tg.User)
	if !ok || peer.Self || peer.Phone != "" || peer.FirstName != "Peer" {
		t.Fatalf("peer user = %+v ok=%v, want projected non-self without phone", full.Users[1], ok)
	}
}

func TestTGMessagesDialogsIncludesUserProfilePhoto(t *testing.T) {
	const viewerID int64 = 1001
	const peerID int64 = 1002
	res := tgMessagesDialogs(viewerID, domain.DialogList{
		Dialogs: []domain.Dialog{{
			Peer:           domain.Peer{Type: domain.PeerTypeUser, ID: peerID},
			TopMessage:     1,
			TopMessageDate: 10,
		}},
		Users: []domain.User{{
			ID:            peerID,
			AccessHash:    22,
			FirstName:     "Alice A",
			PhotoID:       9301,
			PhotoDCID:     2,
			PhotoStripped: []byte{9, 10},
		}},
	})
	full, ok := res.(*tg.MessagesDialogs)
	if !ok {
		t.Fatalf("result = %T, want *tg.MessagesDialogs", res)
	}
	peer, ok := full.Users[0].(*tg.User)
	if !ok {
		t.Fatalf("user = %T, want *tg.User", full.Users[0])
	}
	photo, ok := peer.Photo.(*tg.UserProfilePhoto)
	if !ok || photo.PhotoID != 9301 || photo.DCID != 2 || string(photo.StrippedThumb) != string([]byte{9, 10}) {
		t.Fatalf("photo = %+v ok=%v, want userProfilePhoto 9301/2/[9 10]", peer.Photo, ok)
	}
}
