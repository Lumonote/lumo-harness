package auth

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"math/big"
)

// The board is 336x208 logical pixels. Only the raster leaves the server;
// the snapped cell is consumed by the existing one-attempt captcha store.
func NewPuzzle() (Captcha, []byte, error) {
	id, err := RandomToken(24)
	if err != nil {
		return Captcha{}, nil, err
	}
	cell, err := rand.Int(rand.Reader, big.NewInt(34*23))
	if err != nil {
		return Captcha{}, nil, err
	}
	col, row := 6+int(cell.Int64())%34, 2+int(cell.Int64())/34
	answer := fmt.Sprintf("p:%d:%d", col, row)
	img := image.NewRGBA(image.Rect(0, 0, 336, 208))
	phase := float64(id[0])
	for y := 0; y < 208; y++ {
		for x := 0; x < 336; x++ {
			h := float64(y) / 208
			wave := math.Sin(float64(x)/45+phase) * 15
			c := color.RGBA{uint8(42 + 45*h), uint8(80 + 48*h), uint8(97 + 42*h), 255}
			if float64(y) > 101+wave {
				c = color.RGBA{71, 118, 114, 255}
			}
			if float64(y) > 143+22*math.Sin(float64(x)/66-phase) {
				c = color.RGBA{43, 83, 83, 255}
			}
			if float64(y) > 178+13*math.Cos(float64(x)/39+phase) {
				c = color.RGBA{29, 58, 66, 255}
			}
			d := int(math.Abs(float64(x-col*8)) + math.Abs(float64(y-row*8)))
			if d <= 13 {
				c = color.RGBA{27, 43, 47, 255}
			}
			if d == 13 || d == 14 {
				c = color.RGBA{238, 240, 222, 255}
			}
			img.SetRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return Captcha{}, nil, err
	}
	return Captcha{ID: id, Answer: answer, AnswerHash: CaptchaHash(id, answer)}, buf.Bytes(), nil
}
