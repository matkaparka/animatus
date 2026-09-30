// Process roles for the job guard tests.
//
//   node guard-fixture.mjs parent <python|-> <guard-script|-> <pid-file>
//       Starts `node guard-fixture.mjs tree <pid-file>` DETACHED, through the job guard when <python> is
//       given (with this process as the guard's parent), directly when it is "-". Then idles until it is killed.
//       Detached matters: on Windows libuv puts every non-detached child of a Node process into a job that
//       dies with the Node process, which would make the guard look unnecessary.
//   node guard-fixture.mjs tree <pid-file> [--exit-now]
//       Starts a long-lived grandchild and writes { child, grandchild, guard } pids to <pid-file>.
//       With --exit-now it exits right away with code 5, leaving the grandchild behind.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [role, ...rest] = process.argv.slice(2)

if (role === 'tree') {
  const [pidFile] = rest
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }))
  if (rest.includes('--exit-now')) process.exit(5)
  setInterval(() => {}, 1000)
} else if (role === 'parent') {
  const [python, guard, pidFile] = rest
  const tree = [process.execPath, process.argv[1], 'tree', pidFile]
  const launched =
    python === '-'
      ? spawn(tree[0], tree.slice(1), { stdio: 'ignore', windowsHide: true, detached: true })
      : spawn(python, [guard, '--parent-pid', String(process.pid), '--', ...tree], {
          stdio: 'ignore',
          windowsHide: true,
          detached: true,
        })
  writeFileSync(`${pidFile}.launched`, String(launched.pid))
  setInterval(() => {}, 1000)
} else {
  console.error('unknown role')
  process.exit(2)
}
