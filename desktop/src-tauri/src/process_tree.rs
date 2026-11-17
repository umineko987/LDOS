use std::{
    io,
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

pub struct ProcessTree {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl ProcessTree {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        command.stdin(Stdio::piped());
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("backend stdin pipe was not created"))?;

        Ok(Self {
            child,
            stdin: Some(stdin),
        })
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    pub fn graceful_shutdown(&mut self, grace: Duration) -> io::Result<()> {
        drop(self.stdin.take());
        if self.wait_until(grace)? {
            return Ok(());
        }

        #[cfg(unix)]
        {
            self.terminate_tree(false)?;
            if self.wait_until(Duration::from_secs(2))? {
                return Ok(());
            }
        }

        self.terminate_tree(true)?;
        let _ = self.child.wait()?;
        Ok(())
    }

    fn wait_until(&mut self, timeout: Duration) -> io::Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.child.try_wait()?.is_some() {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    #[cfg(unix)]
    fn terminate_tree(&mut self, force: bool) -> io::Result<()> {
        const SIGTERM: i32 = 15;
        const SIGKILL: i32 = 9;
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }

        let process_group = -(self.child.id() as i32);
        let signal = if force { SIGKILL } else { SIGTERM };
        // The child is created as its own process-group leader above, so a
        // negative PID targets the backend and every child that it spawned.
        if unsafe { kill(process_group, signal) } == 0 {
            return Ok(());
        }
        self.child.kill()
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            drop(self.stdin.take());
            let _ = self.terminate_tree(true);
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_the_parent_pipe_allows_a_cooperative_child_to_exit() {
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "cat >/dev/null"]);
            command
        };

        let mut process = ProcessTree::spawn(&mut command).expect("spawn cooperative child");
        process
            .graceful_shutdown(Duration::from_secs(2))
            .expect("close cooperative child");
        assert!(process.try_wait().expect("read exit status").is_some());
    }
}
