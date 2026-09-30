"""The subprocess runner and the cross-process lock, against real (tiny, local) processes.

The point of both is what happens when things go wrong: a step that hangs must be killed with its children, a
cancelled step must stop at once, and a lock somebody else holds must not hold the waiter for ever.
"""

import os
import subprocess
import sys
import threading
import time
import unittest

from singing_service.control import Cancel
from singing_service.errors import Abandoned, GpuBusy, StepFailed, StepTimeout
from singing_service.locks import FileLock
from singing_service.runner import ProcessRunner, last_json

from .support import TempCase, wait_until

PY = sys.executable

# Writes its own name to a file about every 30 ms, so a test can see when it stopped running.
HEARTBEAT = (
    'import sys,time\n'
    'path=sys.argv[1]\n'
    'while True:\n'
    '    open(path,"w").write(str(time.time()))\n'
    '    time.sleep(0.03)\n'
)

# Starts a child that beats too, then beats itself.
PARENT_WITH_CHILD = (
    'import subprocess,sys,time\n'
    'subprocess.Popen([sys.executable,"-c",{child!r},sys.argv[2]])\n'
    'path=sys.argv[1]\n'
    'while True:\n'
    '    open(path,"w").write(str(time.time()))\n'
    '    time.sleep(0.03)\n'
)


def stopped(path: str, quiet: float = 0.4) -> bool:
    """True when nothing has written to the file for `quiet` seconds (and something did before)."""
    try:
        return time.time() - os.path.getmtime(path) > quiet
    except OSError:
        return False


class Run(TempCase):
    def run_cmd(self, code: str, *args: str, timeout: float = 20.0, cancel: Cancel | None = None):
        return ProcessRunner().run(
            [PY, '-c', code, *args], cwd=None, env=None, timeout=timeout, cancel=cancel, what='the test step'
        )

    def test_a_step_that_succeeds_returns_its_output(self):
        result = self.run_cmd('print("hello"); print(\'{"a": 1}\')')
        self.assertIn('hello', result.stdout)
        self.assertEqual(last_json(result.stdout), {'a': 1})

    def test_a_failing_step_raises_with_the_end_of_its_output(self):
        with self.assertRaises(StepFailed) as caught:
            self.run_cmd('import sys; print("boom detail", file=sys.stderr); sys.exit(3)')
        self.assertIn('exit code 3', caught.exception.reason)
        self.assertIn('boom detail', caught.exception.detail)

    def test_a_program_that_cannot_start_is_a_step_failure(self):
        with self.assertRaises(StepFailed) as caught:
            ProcessRunner().run(
                [os.path.join(self.tmpdir(), 'no-such-program')], cwd=None, env=None, timeout=5, cancel=None, what='x'
            )
        self.assertIn('could not be started', caught.exception.reason)

    def in_thread(self, code: str, *args: str, timeout: float = 60.0, cancel: Cancel | None = None):
        """Runs the step in a thread, so the test can act while it runs. `outcome` gets the exception or the result."""
        outcome: dict[str, object] = {}

        def target() -> None:
            try:
                outcome['result'] = self.run_cmd(code, *args, timeout=timeout, cancel=cancel)
            except BaseException as error:  # noqa: BLE001 - the test looks at what came out
                outcome['error'] = error

        thread = threading.Thread(target=target)
        thread.start()
        self.addCleanup(thread.join, 30)
        return thread, outcome

    def test_a_step_that_hangs_is_killed_when_its_time_is_up(self):
        beat = os.path.join(self.tmpdir(), 'beat')
        t0 = time.monotonic()
        with self.assertRaises(StepTimeout) as caught:
            self.run_cmd(HEARTBEAT, beat, timeout=3.0)
        self.assertLess(time.monotonic() - t0, 12)
        self.assertIn('longer than 3 s', caught.exception.reason)
        self.assertTrue(caught.exception.retryable)
        self.assertTrue(os.path.exists(beat), 'the step never started: the test proves nothing')
        wait_until(lambda: stopped(beat), 5, 'the killed process to stop writing')

    def test_the_children_of_a_step_are_killed_with_it(self):
        folder = self.tmpdir()
        parent_beat, child_beat = os.path.join(folder, 'parent'), os.path.join(folder, 'child')
        cancel = Cancel()
        thread, outcome = self.in_thread(PARENT_WITH_CHILD.format(child=HEARTBEAT), parent_beat, child_beat, cancel=cancel)
        wait_until(lambda: os.path.exists(parent_beat) and os.path.exists(child_beat), 20, 'parent and child to be running')
        cancel.set('stop')
        thread.join(20)
        self.assertIsInstance(outcome.get('error'), Abandoned)
        wait_until(lambda: stopped(parent_beat) and stopped(child_beat), 8, 'parent and child to stop')

    def test_a_cancelled_step_stops_at_once(self):
        beat = os.path.join(self.tmpdir(), 'beat')
        cancel = Cancel()
        thread, outcome = self.in_thread(HEARTBEAT, beat, cancel=cancel)
        wait_until(lambda: os.path.exists(beat), 20, 'the step to be running')
        t0 = time.monotonic()
        cancel.set('removed')
        thread.join(20)
        self.assertLess(time.monotonic() - t0, 6)
        self.assertIsInstance(outcome.get('error'), Abandoned)
        wait_until(lambda: stopped(beat), 5, 'the cancelled process to stop writing')

    def test_a_step_already_cancelled_never_runs(self):
        marker = os.path.join(self.tmpdir(), 'ran')
        cancel = Cancel()
        cancel.set()
        with self.assertRaises(Abandoned):
            self.run_cmd('open(%r,"w").close()' % marker, cancel=cancel)
        time.sleep(0.3)
        self.assertFalse(os.path.exists(marker))

    def test_the_last_json_line_is_the_result_and_noise_is_ignored(self):
        self.assertEqual(last_json('progress 10%\n{"x": 1}\n{not json}\n'), {'x': 1})
        self.assertEqual(last_json('[1, 2]\n'), {})
        self.assertEqual(last_json(''), {})


class Locks(TempCase):
    def test_a_second_holder_waits_and_then_gets_it(self):
        path = os.path.join(self.tmpdir(), 'gpu.lock')
        first, second = FileLock(path), FileLock(path)
        got: list[float] = []

        def later():
            with second.hold(5):
                got.append(time.monotonic())

        with first.hold(1):
            thread = threading.Thread(target=later)
            thread.start()
            time.sleep(0.4)
            self.assertEqual(got, [])
            released = time.monotonic()
        thread.join(5)
        self.assertEqual(len(got), 1)
        self.assertGreaterEqual(got[0], released - 0.01)

    def test_waiting_for_a_lock_that_is_never_released_ends_with_the_error_asked_for(self):
        path = os.path.join(self.tmpdir(), 'gpu.lock')
        first, second = FileLock(path), FileLock(path)
        with first.hold(1):
            t0 = time.monotonic()
            with self.assertRaises(GpuBusy):
                with second.hold(0.5, on_timeout=lambda: GpuBusy('the GPU stayed busy')):
                    pass
            self.assertLess(time.monotonic() - t0, 3)
        with second.hold(1):  # and the lock is free again afterwards
            pass

    def test_a_waiter_gives_up_at_once_when_cancelled(self):
        path = os.path.join(self.tmpdir(), 'gpu.lock')
        first, second = FileLock(path), FileLock(path)
        cancel = Cancel()
        with first.hold(1):
            threading.Timer(0.3, cancel.set, args=('removed',)).start()
            t0 = time.monotonic()
            with self.assertRaises(Abandoned):
                with second.hold(30, cancel=cancel):
                    pass
            self.assertLess(time.monotonic() - t0, 3)

    def test_a_lock_held_by_another_process_is_respected_and_released_when_that_process_dies(self):
        path = os.path.join(self.tmpdir(), 'gpu.lock')
        code = (
            'import sys,time\n'
            f'sys.path.insert(0, {os.path.dirname(os.path.dirname(os.path.abspath(__file__)))!r})\n'
            'from singing_service.locks import FileLock\n'
            'with FileLock(sys.argv[1]).hold(5):\n'
            '    print("locked", flush=True)\n'
            '    time.sleep(60)\n'
        )
        proc = subprocess.Popen([PY, '-c', code, path], stdout=subprocess.PIPE, text=True)
        self.addCleanup(proc.kill)
        assert proc.stdout is not None
        self.addCleanup(proc.stdout.close)
        self.assertEqual(proc.stdout.readline().strip(), 'locked')
        with self.assertRaises(TimeoutError):
            with FileLock(path).hold(0.4):
                pass
        proc.kill()
        proc.wait(10)
        with FileLock(path).hold(5):  # the operating system let go with the process
            pass


if __name__ == '__main__':
    unittest.main()
