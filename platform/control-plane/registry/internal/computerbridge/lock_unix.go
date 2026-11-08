//go:build darwin || linux

package computerbridge

import (
	"os"
	"syscall"
)

// Keep the inode: unlinking a locked file would let a second process lock a
// different inode at the same path. The kernel releases it on process exit.
func lockGeneration(path string) (func(), error) {
	fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 {
		file.Close()
		return nil, os.ErrPermission
	}
	if err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, err
	}
	return retainGeneration(file), nil
}
