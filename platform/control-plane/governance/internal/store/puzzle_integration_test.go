package store

import (
	"context"
	"testing"
	"time"
)

func TestPuzzleLoginSingleUse(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	user := BootstrapAuthUser{Realm: "test", UserID: "puzzle-user", Username: "puzzle-user", DisplayName: "Test", Password: "isolated-test-password"}
	if err := s.EnsureBootstrapAuthUser(ctx, user); err != nil {
		t.Fatal(err)
	}
	for _, valid := range []bool{true, false} {
		c, img, err := s.CreatePuzzle(ctx, time.Minute)
		if err != nil || len(img) == 0 {
			t.Fatal("issue puzzle", err)
		}
		req := LoginRequest{Realm: user.Realm, Username: user.Username, Password: user.Password, CaptchaID: c.ID, CaptchaCode: c.Answer}
		if !valid {
			req.CaptchaCode = "p:2:13"
		}
		res, err := s.Login(ctx, req, AuthPolicy{})
		if valid != (err == nil && res.Token != "") {
			t.Fatal("unexpected authentication result", err)
		}
		req.CaptchaCode = c.Answer
		if res, err = s.Login(ctx, req, AuthPolicy{}); err == nil || res.Token != "" {
			t.Fatal("consumed challenge accepted")
		}
	}
}
