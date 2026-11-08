//go:build !darwin && !linux && !windows

package computerbridge

import "errors"

func lockGeneration(string) (func(), error) {
	return nil, errors.New("computer bridge generation locking is unsupported on this platform")
}
