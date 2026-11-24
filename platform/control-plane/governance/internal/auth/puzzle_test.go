package auth

import (
	"bytes"
	"fmt"
	"image/png"
	"testing"
)

func TestPuzzleRasterAndCommitment(t *testing.T) {
	c, encoded, err := NewPuzzle()
	if err != nil {
		t.Fatal(err)
	}
	var x, y int
	if _, err = fmt.Sscanf(c.Answer, "p:%d:%d", &x, &y); err != nil || x < 6 || x > 39 || y < 2 || y > 24 {
		t.Fatal("invalid snap cell")
	}
	img, err := png.Decode(bytes.NewReader(encoded))
	if err != nil || img.Bounds().Dx() != 336 || img.Bounds().Dy() != 208 {
		t.Fatal("invalid puzzle image")
	}
	r, _, _, _ := img.At(x*8, y*8).RGBA()
	if r>>8 != 27 {
		t.Fatal("image and answer disagree")
	}
	if !EqualCaptchaHash(CaptchaHash(c.ID, c.Answer), c.AnswerHash) || EqualCaptchaHash(CaptchaHash(c.ID, "p:2:13"), c.AnswerHash) {
		t.Fatal("wrong commitment")
	}
}
