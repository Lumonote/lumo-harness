// Package auth contains the cryptographic primitives used by the governance
// user component. Persistence and HTTP stay in their owning packages; this
// package deliberately has no database or transport dependencies.
package auth

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"math/big"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

const (
	// CaptchaGridSize is the number of seven-segment tiles in the 3x3
	// interactive click-captcha grid (digits 1..9, each shown exactly once).
	CaptchaGridSize = 9
	// CaptchaClickCount is how many distinct tiles must be clicked, in the
	// prompted digit order, to satisfy the challenge.
	CaptchaClickCount = 3
	MinPasswordLen    = 10
	MaxPasswordLen    = 256
)

// A process-local dummy hash keeps unknown users on the bcrypt path without
// storing a magic credential in the database.
var dummyPasswordHash = func() string {
	hash, err := bcrypt.GenerateFromPassword([]byte("lumo-dummy-password-never-valid"), bcrypt.DefaultCost)
	if err != nil {
		panic(err)
	}
	return string(hash)
}()

type Captcha struct {
	ID         string
	Tiles      [CaptchaGridSize]int
	Targets    [CaptchaClickCount]int
	Answer     string
	AnswerHash string
}

func HashPassword(password string) (string, error) {
	if len(password) < MinPasswordLen || len(password) > MaxPasswordLen {
		return "", fmt.Errorf("password must contain %d-%d characters", MinPasswordLen, MaxPasswordLen)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(hash), nil
}

// VerifyPassword intentionally accepts an empty stored hash so callers can
// use the same cost path for an unknown username.
func VerifyPassword(storedHash, password string) bool {
	if storedHash == "" {
		storedHash = dummyPasswordHash
	}
	return bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(password)) == nil
}

func NewCaptcha() (Captcha, error) {
	id, err := RandomToken(24)
	if err != nil {
		return Captcha{}, err
	}
	// Tiles: a shuffled 3x3 grid of digits 1..9, each shown exactly once.
	var tiles [CaptchaGridSize]int
	for i := range CaptchaGridSize {
		tiles[i] = i + 1
	}
	for i := CaptchaGridSize - 1; i > 0; i-- {
		j, err := rand.Int(rand.Reader, big.NewInt(int64(i+1)))
		if err != nil {
			return Captcha{}, fmt.Errorf("captcha entropy: %w", err)
		}
		k := int(j.Int64())
		tiles[i], tiles[k] = tiles[k], tiles[i]
	}
	// Targets: CaptchaClickCount distinct digits in click order.
	var targets [CaptchaClickCount]int
	var used [CaptchaGridSize + 1]bool
	for i := range CaptchaClickCount {
		for {
			digit, err := rand.Int(rand.Reader, big.NewInt(CaptchaGridSize))
			if err != nil {
				return Captcha{}, fmt.Errorf("captcha entropy: %w", err)
			}
			value := int(digit.Int64()) + 1
			if used[value] {
				continue
			}
			used[value] = true
			targets[i] = value
			break
		}
	}
	// Answer: the grid index of each target digit, in click order. The
	// browser never receives the tile layout, so only a human reading the
	// image can reconstruct the sequence.
	var positions [CaptchaGridSize + 1]int
	for index, digit := range tiles {
		positions[digit] = index
	}
	var answer strings.Builder
	answer.Grow(CaptchaClickCount)
	for _, digit := range targets {
		answer.WriteByte(byte('0' + positions[digit]))
	}
	value := answer.String()
	return Captcha{ID: id, Tiles: tiles, Targets: targets, Answer: value, AnswerHash: CaptchaHash(id, value)}, nil
}

// Prompt returns the digits the user must click, in order, e.g. "352".
func Prompt(targets [CaptchaClickCount]int) string {
	var prompt strings.Builder
	prompt.Grow(CaptchaClickCount)
	for _, digit := range targets {
		prompt.WriteByte(byte('0' + digit))
	}
	return prompt.String()
}

// Prompt returns the digits the user must click, in order, e.g. "352".
func (c Captcha) Prompt() string { return Prompt(c.Targets) }

// ValidCaptchaAnswer reports whether answer is a plausible click sequence:
// exactly CaptchaClickCount distinct tile indices in 0..GridSize-1.
func ValidCaptchaAnswer(answer string) bool {
	if len(answer) != CaptchaClickCount {
		return false
	}
	var seen [CaptchaGridSize]bool
	for i := 0; i < len(answer); i++ {
		index := answer[i] - '0'
		if index < 0 || index >= CaptchaGridSize || seen[index] {
			return false
		}
		seen[index] = true
	}
	return true
}

func CaptchaHash(id, answer string) string {
	sum := sha256.Sum256([]byte(id + ":" + strings.TrimSpace(answer)))
	return hex.EncodeToString(sum[:])
}

func EqualCaptchaHash(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func RandomToken(bytes int) (string, error) {
	value := make([]byte, bytes)
	if _, err := io.ReadFull(rand.Reader, value); err != nil {
		return "", fmt.Errorf("random token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func TokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// RenderCaptchaGridPNG draws the interactive 3x3 click-captcha. Each tile is
// a seven-segment digit rendered as pixels (not text nodes), so the answer
// cannot be recovered by reading markup. Tile i sits at row i/3, column i%3.
func RenderCaptchaGridPNG(tiles [CaptchaGridSize]int) ([]byte, error) {
	const (
		cell    = 64
		width   = cell * 3
		height  = cell * 3
		marginX = (cell - 21) / 2
		marginY = (cell - 44) / 2
	)
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	fillRect(canvas, canvas.Bounds(), color.RGBA{R: 239, G: 235, B: 218, A: 255})

	// Deterministic geometry with cryptographic color/position jitter. The
	// background noise crosses segments, making simple threshold OCR costly
	// while retaining human readability.
	palette := []color.RGBA{
		{R: 24, G: 45, B: 48, A: 255},
		{R: 31, G: 84, B: 77, A: 255},
		{R: 108, G: 55, B: 37, A: 255},
	}
	for i := 0; i < 14; i++ {
		x1, y1 := randomInt(width), randomInt(height)
		x2, y2 := randomInt(width), randomInt(height)
		drawLine(canvas, x1, y1, x2, y2, color.RGBA{R: 121, G: 119, B: 101, A: 90})
	}
	for i := 0; i < 260; i++ {
		x, y := randomInt(width), randomInt(height)
		canvas.SetRGBA(x, y, color.RGBA{R: 94, G: 112, B: 105, A: 130})
	}
	for index, digit := range tiles {
		cellX := (index % 3) * cell
		cellY := (index / 3) * cell
		x := cellX + marginX + randomInt(7) - 3
		y := cellY + marginY + randomInt(7) - 3
		drawDigit(canvas, x, y, digit, palette[randomInt(len(palette))])
	}
	// Faint separators keep the 3x3 structure readable at a glance.
	for i := 1; i < 3; i++ {
		drawLine(canvas, i*cell, 0, i*cell, height, color.RGBA{R: 94, G: 112, B: 105, A: 60})
		drawLine(canvas, 0, i*cell, width, i*cell, color.RGBA{R: 94, G: 112, B: 105, A: 60})
	}

	var output bytes.Buffer
	if err := png.Encode(&output, canvas); err != nil {
		return nil, fmt.Errorf("encode captcha: %w", err)
	}
	return output.Bytes(), nil
}

var digitSegments = [10][7]bool{
	{true, true, true, true, true, true, false},
	{false, true, true, false, false, false, false},
	{true, true, false, true, true, false, true},
	{true, true, true, true, false, false, true},
	{false, true, true, false, false, true, true},
	{true, false, true, true, false, true, true},
	{true, false, true, true, true, true, true},
	{true, true, true, false, false, false, false},
	{true, true, true, true, true, true, true},
	{true, true, true, true, false, true, true},
}

func drawDigit(target *image.RGBA, x, y, digit int, ink color.RGBA) {
	segments := [7]image.Rectangle{
		image.Rect(x+4, y, x+18, y+4),
		image.Rect(x+17, y+3, x+21, y+21),
		image.Rect(x+17, y+23, x+21, y+41),
		image.Rect(x+4, y+40, x+18, y+44),
		image.Rect(x+1, y+23, x+5, y+41),
		image.Rect(x+1, y+3, x+5, y+21),
		image.Rect(x+4, y+20, x+18, y+24),
	}
	for index, enabled := range digitSegments[digit] {
		if enabled {
			fillRect(target, segments[index], ink)
		}
	}
}

func fillRect(target *image.RGBA, rect image.Rectangle, ink color.RGBA) {
	rect = rect.Intersect(target.Bounds())
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			target.SetRGBA(x, y, ink)
		}
	}
}

func drawLine(target *image.RGBA, x0, y0, x1, y1 int, ink color.RGBA) {
	dx, sx := abs(x1-x0), -1
	if x0 < x1 {
		sx = 1
	}
	dy, sy := -abs(y1-y0), -1
	if y0 < y1 {
		sy = 1
	}
	err := dx + dy
	for {
		if image.Pt(x0, y0).In(target.Bounds()) {
			target.SetRGBA(x0, y0, ink)
		}
		if x0 == x1 && y0 == y1 {
			return
		}
		e2 := 2 * err
		if e2 >= dy {
			err += dy
			x0 += sx
		}
		if e2 <= dx {
			err += dx
			y0 += sy
		}
	}
}

func randomInt(limit int) int {
	if limit <= 1 {
		return 0
	}
	value, err := rand.Int(rand.Reader, big.NewInt(int64(limit)))
	if err != nil {
		return 0
	}
	return int(value.Int64())
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
