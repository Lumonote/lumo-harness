//! Own the SDK process tree before its first instruction. No desktop APIs run here.
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only");
    std::process::exit(64);
}

#[cfg(windows)]
mod windows {
    use std::os::windows::ffi::OsStrExt;
    use std::{
        ffi::c_void,
        io::{self, BufRead, Read, Write},
        mem::{size_of, zeroed},
        ptr::{null, null_mut},
        thread,
        time::Duration,
    };
    type Handle = *mut c_void;
    #[repr(C)]
    struct Security {
        length: u32,
        descriptor: Handle,
        inherit: i32,
    }
    #[repr(C)]
    struct Startup {
        size: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        xchars: u32,
        ychars: u32,
        fill: u32,
        flags: u32,
        show: u16,
        reserved_size: u16,
        reserved_bytes: *mut u8,
        stdin: Handle,
        stdout: Handle,
        stderr: Handle,
    }
    #[repr(C)]
    struct Process {
        process: Handle,
        thread: Handle,
        pid: u32,
        tid: u32,
    }
    #[repr(C)]
    struct Limits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_limit: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    struct ExtendedLimits {
        basic: Limits,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[repr(C)]
    struct Accounting {
        user: i64,
        kernel: i64,
        user_period: i64,
        kernel_period: i64,
        faults: u32,
        processes: u32,
        active: u32,
        terminated: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const Security, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, data: *const c_void, bytes: u32)
            -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            class: i32,
            data: *mut c_void,
            bytes: u32,
            length: *mut u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CreatePipe(
            read: *mut Handle,
            write: *mut Handle,
            security: *const Security,
            bytes: u32,
        ) -> i32;
        fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
        fn CreateProcessW(
            app: *const u16,
            command: *mut u16,
            process_security: *const Security,
            thread_security: *const Security,
            inherit: i32,
            flags: u32,
            environment: Handle,
            directory: *const u16,
            startup: *const Startup,
            process: *mut Process,
        ) -> i32;
        fn ResumeThread(thread: Handle) -> u32;
        fn TerminateProcess(process: Handle, code: u32) -> i32;
        fn WaitForMultipleObjects(
            count: u32,
            handles: *const Handle,
            all: i32,
            milliseconds: u32,
        ) -> u32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn GetStdHandle(kind: u32) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn WriteFile(
            handle: Handle,
            buffer: *const u8,
            bytes: u32,
            written: *mut u32,
            overlapped: Handle,
        ) -> i32;
    }
    struct Owned(Handle);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }
    fn quote(value: &std::ffi::OsStr) -> String {
        let mut result = String::from("\"");
        let mut slashes = 0;
        for ch in value.to_string_lossy().chars() {
            if ch == '\\' {
                slashes += 1;
                continue;
            }
            if ch == '"' {
                result.push_str(&"\\".repeat(slashes * 2 + 1));
            } else {
                result.push_str(&"\\".repeat(slashes));
            }
            slashes = 0;
            result.push(ch);
        }
        result.push_str(&"\\".repeat(slashes * 2));
        result.push('"');
        result
    }
    fn failure() -> io::Error {
        io::Error::last_os_error()
    }
    pub fn run() -> io::Result<()> {
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        if args.len() != 3 {
            return Err(io::Error::other(
                "expected parent PID, Node executable and worker module",
            ));
        }
        let pid = args[0]
            .to_string_lossy()
            .parse::<u32>()
            .map_err(|_| io::Error::other("invalid parent PID"))?;
        unsafe {
            let parent = Owned(OpenProcess(0x0010_0000, 0, pid));
            if parent.0.is_null() {
                return Err(failure());
            }
            let job = Owned(CreateJobObjectW(null(), null()));
            if job.0.is_null() {
                return Err(failure());
            }
            let mut limits: ExtendedLimits = zeroed();
            limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE, without breakaway.
            if SetInformationJobObject(
                job.0,
                9,
                &limits as *const _ as _,
                size_of::<ExtendedLimits>() as u32,
            ) == 0
            {
                return Err(failure());
            }
            let security = Security {
                length: size_of::<Security>() as u32,
                descriptor: null_mut(),
                inherit: 1,
            };
            let (mut input, mut writer) = (null_mut(), null_mut());
            if CreatePipe(&mut input, &mut writer, &security, 0) == 0 {
                return Err(failure());
            }
            let input = Owned(input);
            let writer = Owned(writer);
            if SetHandleInformation(writer.0, 1, 0) == 0 {
                return Err(failure());
            }
            let mut startup: Startup = zeroed();
            startup.size = size_of::<Startup>() as u32;
            startup.flags = 0x100; // USESTDHANDLES.
            startup.stdin = input.0;
            startup.stdout = GetStdHandle((-11i32) as u32);
            startup.stderr = GetStdHandle((-12i32) as u32);
            let application = wide(&args[1]);
            let mut command = wide(std::ffi::OsStr::new(&format!(
                "{} {}",
                quote(&args[1]),
                quote(&args[2])
            )));
            let mut process: Process = zeroed();
            // Suspended creation closes the race in which native code could spawn an unowned child.
            if CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                0x0800_0004,
                null_mut(),
                null(),
                &startup,
                &mut process,
            ) == 0
            {
                return Err(failure());
            }
            let child = Owned(process.process);
            let primary = Owned(process.thread);
            if AssignProcessToJobObject(job.0, child.0) == 0 {
                TerminateProcess(child.0, 1);
                WaitForSingleObject(child.0, u32::MAX);
                return Err(failure());
            }
            if ResumeThread(primary.0) == u32::MAX {
                TerminateJobObject(job.0, 1);
                WaitForSingleObject(child.0, u32::MAX);
                return Err(failure());
            }
            drop(primary);
            drop(input);
            let job_raw = job.0 as usize;
            let writer_raw = writer.0 as usize;
            thread::spawn(move || {
                let mut reader = io::stdin().lock();
                loop {
                    let mut bytes = Vec::new();
                    let read = Read::by_ref(&mut reader)
                        .take(64 * 1024 * 1024 + 1)
                        .read_until(b'\n', &mut bytes);
                    if !matches!(read, Ok(n) if n > 0)
                        || bytes.len() > 64 * 1024 * 1024
                        || bytes == b"{\"supervisor\":\"stop\"}\n"
                    {
                        break;
                    }
                    let mut offset = 0;
                    while offset < bytes.len() {
                        let mut written = 0;
                        if WriteFile(
                            writer_raw as Handle,
                            bytes[offset..].as_ptr(),
                            (bytes.len() - offset) as u32,
                            &mut written,
                            null_mut(),
                        ) == 0
                            || written == 0
                        {
                            TerminateJobObject(job_raw as Handle, 1);
                            return;
                        }
                        offset += written as usize;
                    }
                }
                TerminateJobObject(job_raw as Handle, 1);
            });
            let handles = [child.0, parent.0];
            let result = WaitForMultipleObjects(2, handles.as_ptr(), 0, u32::MAX);
            if result > 1 {
                return Err(failure());
            }
            if TerminateJobObject(job.0, 1) == 0 {
                return Err(failure());
            }
            // Process exit alone does not prove descendant cleanup. Confirm the whole job is empty.
            loop {
                let mut accounting: Accounting = zeroed();
                if QueryInformationJobObject(
                    job.0,
                    1,
                    &mut accounting as *mut _ as _,
                    size_of::<Accounting>() as u32,
                    null_mut(),
                ) == 0
                {
                    return Err(failure());
                }
                if accounting.active == 0 {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            println!("{{\"supervisor\":\"quiet\"}}");
            io::stdout().flush()?;
            drop(writer);
            Ok(())
        }
    }
}
#[cfg(windows)]
fn main() {
    if let Err(error) = windows::run() {
        eprintln!("Windows CUA supervisor failed: {error}");
        std::process::exit(1);
    }
}
