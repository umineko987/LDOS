//go:build !windows

package modelservice

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func prepareProcess(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func signalProcess(cmd *exec.Cmd, signal syscall.Signal) error {
	e := syscall.Kill(-cmd.Process.Pid, signal)
	if errors.Is(e, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	return e
}
func terminateProcess(cmd *exec.Cmd) error { return signalProcess(cmd, syscall.SIGTERM) }
func killProcess(cmd *exec.Cmd) error      { return signalProcess(cmd, syscall.SIGKILL) }
