//go:build windows

package computerbridge

import (
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

func lockGeneration(path string) (func(), error) {
	before, err := os.Lstat(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err == nil && (!before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0) {
		return nil, os.ErrPermission
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || before != nil && !os.SameFile(before, after) {
		file.Close()
		return nil, os.ErrPermission
	}
	overlap := &syscall.Overlapped{}
	// A synchronous handle plus LOCKFILE_FAIL_IMMEDIATELY cannot leave a pending
	// overlapped request referencing Go memory after this function returns.
	locked, _, callErr := syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx").Call(file.Fd(), 3, 0, 1, 0, uintptr(unsafe.Pointer(overlap)))
	runtime.KeepAlive(overlap)
	if locked == 0 {
		file.Close()
		if callErr == syscall.Errno(0) {
			return nil, syscall.EINVAL
		}
		return nil, callErr
	}
	return retainGeneration(file), nil
}
