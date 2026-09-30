"""Run a command inside a Windows Job Object that is destroyed together with its parent.

    python job_guard.py --parent-pid <N> -- <command> [args...]

Problem: when the orchestrator is force-killed (Task Manager, a crash, taskkill /F), Windows does not
stop its child processes. A speech server or an image server would keep running as an orphan and keep
holding the GPU. This guard closes that gap:

  1. It creates a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and puts ITSELF into it. The
     command it starts, and everything that command starts, then belong to the job from their first
     instruction. (Assigning the child afterwards would leave a window in which a fast grandchild
     escapes.)
  2. It runs the command with inherited stdio and environment and waits for it.
  3. It polls the parent process. When the parent is gone, the guard terminates the job, which kills
     the whole tree, grandchildren included. When the command ends on its own, the guard exits with
     the same code and Windows reaps whatever the command left behind.

Exit status: the command's exit code; 2 bad arguments; 3 the parent is gone (at start or later);
4 not running on Windows; 127 the command could not be started.

Standard library only (ctypes). Windows only.
"""

import argparse
import ctypes
import os
import subprocess
import sys
from ctypes import wintypes

POLL_SECONDS = 0.2

EXIT_USAGE = 2
EXIT_PARENT_GONE = 3
EXIT_NOT_WINDOWS = 4
EXIT_CANNOT_START = 127

SYNCHRONIZE = 0x00100000  # the only right needed to wait on the parent process
WAIT_TIMEOUT = 0x102
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9  # the JOBOBJECTINFOCLASS value


class BasicLimits(ctypes.Structure):  # JOBOBJECT_BASIC_LIMIT_INFORMATION
    _fields_ = [
        ('PerProcessUserTimeLimit', wintypes.LARGE_INTEGER),
        ('PerJobUserTimeLimit', wintypes.LARGE_INTEGER),
        ('LimitFlags', wintypes.DWORD),
        ('MinimumWorkingSetSize', ctypes.c_size_t),
        ('MaximumWorkingSetSize', ctypes.c_size_t),
        ('ActiveProcessLimit', wintypes.DWORD),
        ('Affinity', ctypes.c_size_t),
        ('PriorityClass', wintypes.DWORD),
        ('SchedulingClass', wintypes.DWORD),
    ]


class ExtendedLimits(ctypes.Structure):  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    _fields_ = [
        ('BasicLimitInformation', BasicLimits),
        ('IoInfo', ctypes.c_ulonglong * 6),  # IO_COUNTERS: six 64-bit counters, unused here
        ('ProcessMemoryLimit', ctypes.c_size_t),
        ('JobMemoryLimit', ctypes.c_size_t),
        ('PeakProcessMemoryUsed', ctypes.c_size_t),
        ('PeakJobMemoryUsed', ctypes.c_size_t),
    ]


def load_kernel32():
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.OpenProcess.restype = wintypes.HANDLE
    k.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k.WaitForSingleObject.restype = wintypes.DWORD
    k.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    k.CreateJobObjectW.restype = wintypes.HANDLE
    k.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    k.SetInformationJobObject.restype = wintypes.BOOL
    k.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    k.AssignProcessToJobObject.restype = wintypes.BOOL
    k.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    k.TerminateJobObject.restype = wintypes.BOOL
    k.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
    k.GetCurrentProcess.restype = wintypes.HANDLE
    return k


def enter_kill_on_close_job(k):
    """Create the job and move this process into it. Returns the job handle, or None on failure."""
    job = k.CreateJobObjectW(None, None)
    if not job:
        return None
    info = ExtendedLimits()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not k.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ctypes.byref(info), ctypes.sizeof(info)):
        return None
    if not k.AssignProcessToJobObject(job, k.GetCurrentProcess()):
        return None
    return job


def exit_status(code):
    """Windows exit codes are unsigned 32-bit; sys.exit wants a signed C int."""
    return code - 2**32 if code >= 2**31 else code


def main(argv):
    if sys.platform != 'win32':
        print('job_guard: this guard needs Windows Job Objects', file=sys.stderr)
        return EXIT_NOT_WINDOWS
    cut = argv.index('--') if '--' in argv else len(argv)  # everything after the first -- is the command
    head, command = argv[:cut], argv[cut + 1:]
    parser = argparse.ArgumentParser(prog='job_guard.py', usage='%(prog)s --parent-pid N -- command [args...]')
    parser.add_argument('--parent-pid', type=int, required=True)
    args = parser.parse_args(head)
    if args.parent_pid <= 0 or not command:
        parser.error('a positive --parent-pid and a command after -- are required')

    k = load_kernel32()
    parent = k.OpenProcess(SYNCHRONIZE, False, args.parent_pid)
    if not parent or k.WaitForSingleObject(parent, 0) != WAIT_TIMEOUT:
        return EXIT_PARENT_GONE  # holding the handle also stops the pid from being reused under us

    job = enter_kill_on_close_job(k)
    if job is None:
        print('job_guard: cannot use a job object; falling back to taskkill /T', file=sys.stderr)

    try:
        proc = subprocess.Popen(command)  # inherits stdio, environment and working directory
    except OSError as exc:
        print(f'job_guard: cannot start {command[0]!r}: {exc}', file=sys.stderr)
        return EXIT_CANNOT_START

    while True:
        try:
            return exit_status(proc.wait(timeout=POLL_SECONDS))
        except subprocess.TimeoutExpired:
            pass
        if k.WaitForSingleObject(parent, 0) == WAIT_TIMEOUT:
            continue
        # The parent is gone: nobody will ever stop the command, so take the whole tree down.
        if job is not None:
            k.TerminateJobObject(job, EXIT_PARENT_GONE)  # kills this process too
        taskkill = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'taskkill.exe')
        subprocess.run([taskkill, '/PID', str(proc.pid), '/T', '/F'], capture_output=True)
        return EXIT_PARENT_GONE


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
