// Portions adapted from crynta/terax-ai at
// fd99bf6e70e30a43b720d6e2e5f1fbb154208719.
// Copyright 2026 Crynta. Licensed under Apache-2.0.
// Modified by LobeHub.

//! Windows Job Object with `KILL_ON_JOB_CLOSE` for PTY child process trees.

#![cfg(windows)]

use std::io;
use std::mem::{size_of, zeroed};

use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

pub struct ProcessJob {
    handle: HANDLE,
}

// SAFETY: The Job Object handle may be closed from any thread, and this type
// exposes no operation that mutates handle-owned state after construction.
unsafe impl Send for ProcessJob {}
// SAFETY: `terminate` does not mutate Rust-owned handle state, and Windows
// synchronizes operations on the underlying Job Object.
unsafe impl Sync for ProcessJob {}

impl ProcessJob {
    pub fn create_for(pid: u32) -> io::Result<Self> {
        // SAFETY: Every handle returned here is checked and closed on every
        // failure path. Structures and byte sizes match the Windows API.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() || job == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &raw const info as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if configured == 0 {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }

            let process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, FALSE, pid);
            if process.is_null() {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }

            let assigned = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if assigned == 0 {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }

            Ok(Self { handle: job })
        }
    }

    pub fn terminate(&self, exit_code: u32) -> io::Result<()> {
        // SAFETY: `handle` remains owned by this ProcessJob for the duration
        // of the call, and `TerminateJobObject` does not take ownership.
        let terminated = unsafe { TerminateJobObject(self.handle, exit_code) };
        if terminated == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
            // SAFETY: `handle` is an owned, live Job Object handle and is
            // closed exactly once from this destructor.
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::process::Command;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    use super::*;
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    #[test]
    fn invalid_process_cannot_be_assigned() {
        assert!(ProcessJob::create_for(0xffff_fffe).is_err());
    }

    #[test]
    fn closing_job_terminates_assigned_process_tree() {
        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 > nul"])
            .spawn()
            .expect("spawn cmd.exe");
        let job = ProcessJob::create_for(child.id()).expect("create process job");

        drop(job);

        let deadline = Instant::now() + Duration::from_secs(3);
        while child.try_wait().expect("poll child").is_none() {
            if Instant::now() >= deadline {
                let _ = child.kill();
                panic!("process tree survived after its Job Object closed");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn explicit_termination_stops_descendants_while_job_handle_remains_open() {
        let pid_file = std::env::temp_dir().join(format!(
            "lobe-pty-job-child-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        let _ = fs::remove_file(&pid_file);
        let mut shell = Command::new("cmd.exe")
            .args(["/Q", "/D", "/K"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn cmd.exe");
        let job = ProcessJob::create_for(shell.id()).expect("create process job");

        let escaped_pid_file = pid_file.to_string_lossy().replace('\'', "''");
        let command = format!(
            "powershell.exe -NoProfile -NonInteractive -Command \"[IO.File]::WriteAllText('{escaped_pid_file}', [string]$PID); Start-Sleep -Seconds 30\"\r\n"
        );
        shell
            .stdin
            .as_mut()
            .expect("cmd stdin")
            .write_all(command.as_bytes())
            .expect("start descendant");

        let deadline = Instant::now() + Duration::from_secs(5);
        let descendant_pid = loop {
            if let Ok(contents) = fs::read_to_string(&pid_file)
                && let Ok(pid) = contents.trim().parse::<u32>()
            {
                break pid;
            }
            assert!(
                Instant::now() < deadline,
                "descendant did not report its pid"
            );
            std::thread::sleep(Duration::from_millis(25));
        };

        job.terminate(1).expect("terminate process job");

        let deadline = Instant::now() + Duration::from_secs(5);
        while shell.try_wait().expect("poll shell").is_none() || !process_has_exited(descendant_pid)
        {
            assert!(
                Instant::now() < deadline,
                "shell process tree survived TerminateJobObject"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(process_has_exited(descendant_pid));

        // The explicit termination path must not consume the handle; Drop
        // still closes it and preserves KILL_ON_JOB_CLOSE as a backstop.
        drop(job);
        let _ = fs::remove_file(pid_file);
    }

    fn process_has_exited(pid: u32) -> bool {
        // SAFETY: The returned process handle, when present, is closed exactly
        // once after a zero-time wait and is never shared.
        unsafe {
            let process = OpenProcess(PROCESS_SYNCHRONIZE, FALSE, pid);
            if process.is_null() {
                return true;
            }
            let result = WaitForSingleObject(process, 0);
            CloseHandle(process);
            result == WAIT_OBJECT_0
        }
    }
}
