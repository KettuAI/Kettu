// Whether a shell command is one never to allow always: one that deletes, changes rights, stops
// processes or the machine, or could run a command its text does not show. Whatever this cannot
// read with confidence counts as unsafe, since a wrong "safe" persists a rule that runs such a
// command without asking, while a wrong "unsafe" only leaves the user to allow it once.

/** How a command's text is quoted: as in a POSIX shell, or as in PowerShell, where `\` is literal. */
export type Shell = 'posix' | 'powershell'

/** Characters that expand, group, redirect or glob, and so could hide what runs. */
const SYNTAX = new Set([...'$`(){}<>!*?[]'])

/**
 * A command line's steps, split on `&&`, `||`, `;` and `|`, as words with their quotes removed.
 * Null for anything else: expansions, subshells, groups, redirections, globs, background jobs,
 * comments, line breaks, unterminated quotes and empty steps.
 */
export function commandSteps(command: string, shell: Shell = 'posix'): string[][] | null {
  const steps: string[][] = []
  let words: string[] = []
  let word: string | null = null
  const endWord = (): void => {
    if (word !== null) words.push(word)
    word = null
  }
  const endStep = (): boolean => {
    endWord()
    if (words.length === 0) return false
    steps.push(words)
    words = []
    return true
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    const next = command[i + 1]
    if (c === ' ' || c === '\t') {
      endWord()
    } else if (c === "'") {
      const close = command.indexOf("'", i + 1)
      if (close === -1) return null
      word = (word ?? '') + command.slice(i + 1, close)
      i = close
    } else if (c === '"') {
      let text = ''
      let j = i + 1
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j]!
        const escaped = command[j + 1]
        if (d === '\\' && shell === 'posix' && escaped !== undefined && '$`"\\'.includes(escaped)) {
          text += escaped
          j++
        } else if (d === '$' || d === '`' || d === '!' || d < ' ') {
          return null
        } else {
          text += d
        }
      }
      if (j >= command.length) return null
      word = (word ?? '') + text
      i = j
    } else if (c === '\\' && shell === 'posix') {
      if (next === undefined || next < ' ') return null
      word = (word ?? '') + next
      i++
    } else if (c === '&' || c === '|' || c === ';') {
      if (c === '&') {
        if (next !== '&') return null
        i++
      } else if (c === '|') {
        if (next === '&') return null
        if (next === '|') i++
      } else if (next === ';') {
        return null
      }
      if (!endStep()) return null
    } else if (c < ' ' || c === '\x7f' || SYNTAX.has(c) || (c === '#' && word === null)) {
      return null
    } else {
      word = (word ?? '') + c
    }
  }
  return endStep() ? steps : null
}

/** Whether running `command` as written could delete, change rights, stop or run what it hides. */
export function unsafeCommand(command: string, shell: Shell = 'posix'): boolean {
  return unsafeLine(command, false, shell)
}

/** The same for a rule that allows `command` and anything after it, such as `pnpm dev:*`. */
export function unsafeCommandPrefix(command: string, shell: Shell = 'posix'): boolean {
  return unsafeLine(command, true, shell)
}

/** A word as a program receives it, with nothing a shell would read differently. */
const PLAIN_WORD = /^[^\s\p{Cc}'"`$\\;&|<>(){}!*?[\]#]+$/u

/** The same for the first words of a command and anything after them, as an exec policy rule. */
export function unsafeArgvPrefix(words: readonly string[]): boolean {
  return (
    words.length === 0 || !words.every((word) => PLAIN_WORD.test(word)) || unsafeStep(words, true)
  )
}

function unsafeLine(command: string, open: boolean, shell: Shell): boolean {
  const steps = commandSteps(command, shell)
  return (
    steps === null || steps.some((words, i) => unsafeStep(words, open && i === steps.length - 1))
  )
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/

// Variables that only pass a value on; others, such as PATH, HOME, LD_PRELOAD, GIT_* or
// NODE_OPTIONS, can make the command load or run something else.
const PLAIN_VARIABLE =
  /^(?:CI|NODE_ENV|DEBUG|PORT|HOST|TZ|LANG|LANGUAGE|LC_[A-Z]+|TERM|COLUMNS|LINES|FORCE_COLOR|NO_COLOR|CLICOLOR(?:_FORCE)?|VERBOSE|LOG_LEVEL|RUST_LOG|RUST_BACKTRACE|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|NODE_NO_WARNINGS|GOOS|GOARCH|CGO_ENABLED|(?:VITE|NEXT_PUBLIC|REACT_APP|PUBLIC)_[A-Z0-9_]+)$/

/**
 * Whether one step is unsafe, past its variable assignments. `open` when words may follow, which
 * makes a step unsafe whenever what follows could still choose what runs.
 */
function unsafeStep(words: readonly string[], open: boolean): boolean {
  let i = 0
  for (; i < words.length; i++) {
    const name = ASSIGNMENT.exec(words[i]!)?.[1]
    if (name === undefined) break
    if (!PLAIN_VARIABLE.test(name)) return true
  }
  return i === words.length ? open : unsafeArgs(words.slice(i), open)
}

const DESTRUCTIVE = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'srm',
  'dd',
  'mkfs',
  'newfs',
  'format',
  'truncate',
  'wipefs',
  'fdisk',
  'sfdisk',
  'parted',
  'diskutil',
  'diskpart',
  'rimraf',
  'trash',
  'del',
  'erase',
  'rd',
  'remove-item',
  'ri',
  'remove-itemproperty',
  'rp',
  'clear-content',
  'clc',
  'clear-item',
  'cli',
  'format-volume',
  'clear-disk',
  'remove-partition',
  'sudo',
  'su',
  'doas',
  'gsudo',
  'run0',
  'pkexec',
  'runas',
  'chmod',
  'chown',
  'chgrp',
  'chattr',
  'chflags',
  'setfacl',
  'icacls',
  'takeown',
  'kill',
  'killall',
  'pkill',
  'taskkill',
  'stop-process',
  'spps',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'stop-computer',
  'restart-computer',
])

/** Commands that run another one this cannot judge, or change how later ones resolve. */
const OPAQUE = new Set([
  'eval',
  'exec',
  'source',
  '.',
  'busybox',
  'toybox',
  'watch',
  'ssh',
  'chroot',
  'nsenter',
  'unshare',
  'setsid',
  'stdbuf',
  'ionice',
  'chrt',
  'taskset',
  'caffeinate',
  'arch',
  'script',
  'flock',
  'cpio',
  'parallel',
  'strace',
  'ltrace',
  'dtruss',
  'gdb',
  'lldb',
  'valgrind',
  'firejail',
  'systemd-run',
  'trap',
  'alias',
  'unalias',
  'hash',
  'enable',
  'export',
  'declare',
  'typeset',
  'readonly',
  'local',
  'set',
  'shopt',
  'setopt',
  'unsetopt',
  'autoload',
  'zmodload',
  'emulate',
  'cmd',
  'call',
  'start',
  'start-process',
  'saps',
  'invoke-expression',
  'iex',
  'invoke-command',
  'icm',
  'invoke-item',
  'ii',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'for',
  'foreach',
  'repeat',
  'case',
  'esac',
  'select',
  'function',
  'coproc',
  'in',
  'end',
])

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'mksh',
  'csh',
  'tcsh',
  'ash',
  'yash',
  'nu',
  'xonsh',
  'elvish',
  'pwsh',
  'powershell',
])
const SCRIPTS = new Set([
  'node',
  'nodejs',
  'py',
  'perl',
  'ruby',
  'php',
  'lua',
  'luajit',
  'osascript',
  'rscript',
  'tclsh',
  'julia',
])
const PYTHON = /^(?:python|pypy)[\d.]*$/

const WRAPPERS = new Set([
  'env',
  'command',
  'builtin',
  'nohup',
  'nice',
  'time',
  'timeout',
  'xargs',
  'noglob',
  'nocorrect',
])

/** Package managers, the subcommands that run any program, and whether they run a binary too. */
const PACKAGE_MANAGERS = new Map<string, { runners: string[][]; bins: boolean }>([
  ['npm', { runners: [['exec'], ['x'], ['explore']], bins: false }],
  ['pnpm', { runners: [['exec'], ['dlx']], bins: true }],
  ['yarn', { runners: [['exec'], ['dlx']], bins: true }],
  ['uv', { runners: [['run'], ['tool', 'run']], bins: false }],
  ['pipx', { runners: [['run']], bins: false }],
  ['poetry', { runners: [['run']], bins: false }],
])
/** Their own subcommands that share a name with a command judged here. */
const OWN_SUBCOMMANDS = new Set(['start', 'set', 'rm', 'unlink'])
const RUNNER_FLAGS = new Set(['--', '-y', '--yes', '-q', '--quiet', '--silent'])
const VERSION_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h'])

const FIND_ACTIONS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
])

/** A command word as the program it runs: its file name, in lower case, without `.exe`. */
function commandName(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, '')
}

function unsafeArgs(words: readonly string[], open: boolean): boolean {
  const head = commandName(words[0]!)
  const args = words.slice(1)
  if (head === '' || /^[-=]/.test(head) || /^(?:mkfs|newfs)[._]/.test(head)) return true
  if (DESTRUCTIVE.has(head) || OPAQUE.has(head)) return true
  if (SHELLS.has(head) || SCRIPTS.has(head) || PYTHON.test(head)) {
    return unsafeInterpreter(args, open, PYTHON.test(head))
  }
  if (WRAPPERS.has(head)) {
    const inner = unwrap(head, args)
    if (inner === null || inner.length === 0 || inner[0]!.startsWith('-')) return true
    // xargs adds what it reads to the command's words.
    return unsafeStep(inner, open || head === 'xargs')
  }
  const manager = PACKAGE_MANAGERS.get(head)
  if (manager) return unsafePackageManager(manager, args, open)
  switch (head) {
    case 'git':
      return unsafeGit(args, open)
    case 'find':
      return open || args.some((arg) => FIND_ACTIONS.has(arg))
    case 'rsync':
      return open || args.some((arg) => /^--(?:del|remove-|rsh|rsync-path)|^-[A-Za-z]*e/.test(arg))
    case 'tar':
      return open || unsafeTar(args)
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk':
      return open || args.some((arg) => /system|getline|[|>]/.test(arg))
    case 'npx':
    case 'pnpx':
    case 'bunx':
    case 'uvx':
      return unsafeRunner(args, open)
    case 'bun':
      return unsafeBun(args, open)
    case 'deno':
      return unsafeDeno(args, open)
    default:
      return false
  }
}

/**
 * An interpreter is safe only running a script file named first, so no option before it can
 * take code from its words or from standard input.
 */
function unsafeInterpreter(args: readonly string[], open: boolean, python: boolean): boolean {
  if (!open && args.length === 1 && args[0] === '--version') return false
  const first = python && args[0] === '-m' ? args[1] : args[0]
  return (
    first === undefined ||
    first.startsWith('-') ||
    /^[A-Za-z][\w+.-]*:|^\/(?:dev|proc)\//.test(first)
  )
}

/** The command a wrapper runs, past the options it is known to take; null for a value it lacks. */
function unwrap(head: string, args: readonly string[]): readonly string[] | null {
  if (head === 'xargs') return xargsCommand(args)
  let i = 0
  switch (head) {
    case 'env':
      for (;;) {
        const arg = args[i]
        if (arg === undefined) break
        if (['-i', '-', '--ignore-environment', '-0', '--null'].includes(arg)) i++
        else if (arg === '-u' || arg === '--unset') i += 2
        else if (/^(?:-u|--unset=)./.test(arg)) i++
        else break
      }
      break
    case 'nice':
      for (;;) {
        const arg = args[i]
        if (arg === '-n' || arg === '--adjustment') i += 2
        else if (arg !== undefined && /^(?:-n-?\d+|--adjustment=-?\d+|-\d+)$/.test(arg)) i++
        else break
      }
      break
    case 'timeout':
      for (;;) {
        const arg = args[i]
        if (arg === undefined) break
        if (['--preserve-status', '--foreground', '-v', '--verbose'].includes(arg)) i++
        else if (['-s', '--signal', '-k', '--kill-after'].includes(arg)) i += 2
        else if (/^(?:-[sk].|--(?:signal|kill-after)=)/.test(arg)) i++
        else break
      }
      if (!/^\d+(?:\.\d+)?[smhd]?$/.test(args[i] ?? '')) return null
      i++
      break
    case 'command':
    case 'time':
      while (args[i] === '-p') i++
      break
  }
  if (args[i] === '--') i++
  return args.slice(i)
}

/** The command xargs runs, past its options; null for `-I`, which lets the input be the command. */
function xargsCommand(args: readonly string[]): readonly string[] | null {
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--') return args.slice(i + 1)
    if (!arg.startsWith('-') || arg === '-') break
    if (arg.startsWith('--')) {
      const name = arg.replace(/=.*$/, '')
      if (
        [
          '--null',
          '--no-run-if-empty',
          '--verbose',
          '--interactive',
          '--exit',
          '--open-tty',
        ].includes(arg) ||
        ['--eof', '--max-lines'].includes(name)
      ) {
        i++
      } else if (
        ['--max-args', '--max-procs', '--max-chars', '--delimiter', '--arg-file'].includes(name)
      ) {
        i += name === arg ? 2 : 1
      } else {
        return null
      }
      continue
    }
    let skip = 1
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j]!
      if ('0rtpxo'.includes(flag)) continue
      // -n 1 or -n1; -e and -l take a value only when it is attached.
      if ('nPLsdEa'.includes(flag)) {
        if (j === arg.length - 1) skip = 2
        break
      }
      if ('el'.includes(flag)) break
      return null
    }
    i += skip
  }
  return args.slice(i)
}

/**
 * Tar runs a program given to -I, -F, --use-compress-program, --to-command or the like, and
 * --remove-files deletes what it archived. Its first word may be options without a dash.
 */
function unsafeTar(args: readonly string[]): boolean {
  return args.some(
    (arg, i) =>
      /^--(?:use-compress|to-command|info-script|new-volume-script|checkpoint-action|rsh-command|rmt-command|remove-files)/.test(
        arg,
      ) || (i === 0 || /^-[^-]/.test(arg) ? /^-?[A-Za-z]*[IF]/.test(arg) : false),
  )
}

/** A package runner such as npx: safe only when the package it runs is. */
function unsafeRunner(args: readonly string[], open: boolean): boolean {
  let i = 0
  while (args[i] !== undefined && RUNNER_FLAGS.has(args[i]!)) i++
  const name = args[i]
  if (name === undefined || name.startsWith('-')) return true
  return unsafeArgs([name.replace(/(.)@[^/]*$/, '$1'), ...args.slice(i + 1)], open)
}

function unsafePackageManager(
  manager: { runners: string[][]; bins: boolean },
  args: readonly string[],
  open: boolean,
): boolean {
  const sub = args[0]
  if (sub === undefined) return open
  // Options before the subcommand may take values, which hides which word is the subcommand.
  if (sub.startsWith('-')) return open || args.length > 1 || !VERSION_FLAGS.has(sub)
  for (const runner of manager.runners) {
    if (!runner.slice(0, args.length).every((word, i) => args[i] === word)) continue
    if (args.length < runner.length) return open
    if (runner[0] === 'explore') return true
    return unsafeRunner(args.slice(runner.length), open)
  }
  // pnpm and yarn run a binary, or a command from PATH, named as the subcommand.
  return manager.bins && !OWN_SUBCOMMANDS.has(sub) && unsafeArgs(args, open)
}

function unsafeBun(args: readonly string[], open: boolean): boolean {
  const sub = args[0]
  if (sub === undefined) return true
  if (sub.startsWith('-')) return open || args.length > 1 || !VERSION_FLAGS.has(sub)
  if (sub === 'x') return unsafeRunner(args.slice(1), open)
  if (sub === 'exec' || sub === 'repl') return true
  if (sub === 'run') {
    const target = args[1]
    return target === undefined || target.startsWith('-') || unsafeArgs(args.slice(1), open)
  }
  return !OWN_SUBCOMMANDS.has(sub) && unsafeArgs(args, open)
}

function unsafeDeno(args: readonly string[], open: boolean): boolean {
  const sub = args[0]
  if (sub === undefined) return true
  if (sub.startsWith('-')) return open || args.length > 1 || !VERSION_FLAGS.has(sub)
  if (sub === 'eval' || sub === 'repl') return true
  if (sub === 'x') return unsafeRunner(args.slice(1), open)
  if (sub === 'run') return unsafeInterpreter(args.slice(1), open, false)
  return false
}

const GIT_OPTIONS = new Set([
  '--no-pager',
  '-P',
  '-p',
  '--paginate',
  '--bare',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-advice',
])
const GIT_VALUE_OPTIONS = new Set(['-C', '--git-dir', '--work-tree', '--namespace'])

/** Subcommands that only read or add, whatever follows them. */
const GIT_OPEN = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'annotate',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'rev-list',
  'describe',
  'shortlog',
  'cat-file',
  'show-ref',
  'merge-base',
  'name-rev',
  'for-each-ref',
  'check-ignore',
  'check-attr',
  'whatchanged',
  'range-diff',
  'cherry',
  'show-branch',
  'count-objects',
  'diff-tree',
  'diff-files',
  'diff-index',
  'version',
  'help',
  'add',
  'commit',
])
const GIT_FORCE = /^(?:--force|--hard|-f|-D)$|^--force-/
const BRANCH_LISTING = new Set([
  '-a',
  '-r',
  '-v',
  '-vv',
  '-l',
  '--all',
  '--remotes',
  '--verbose',
  '--list',
  '--show-current',
  '--color',
  '--no-color',
])

/**
 * Git is safe only with a subcommand that reads or adds. Others discard work or history, and a
 * `-c` option can name a command git runs, as an alias, pager or fsmonitor.
 */
function unsafeGit(args: readonly string[], open: boolean): boolean {
  let i = 0
  for (; i < args.length && args[i]!.startsWith('-'); i++) {
    const arg = args[i]!
    if (GIT_VALUE_OPTIONS.has(arg)) i++
    else if (!GIT_OPTIONS.has(arg) && !/^--(?:git-dir|work-tree|namespace)=/.test(arg)) return true
  }
  const sub = args[i]
  if (sub === undefined) return open
  const rest = args.slice(i + 1)
  if (!open && rest.some((arg) => GIT_FORCE.test(arg))) return true
  if (GIT_OPEN.has(sub)) return !open && rest.some((arg) => arg.startsWith('--output'))
  switch (sub) {
    case 'fetch':
      return open || rest.some((arg) => arg.startsWith('--upload-pack'))
    case 'ls-remote':
      return open || rest.some((arg) => /^(?:--upload-pack|-u)/.test(arg))
    case 'grep':
      return open || rest.some((arg) => /^-[^-]*O|^--open-files-in-pager/.test(arg))
    case 'branch':
      return open || !rest.every((arg) => BRANCH_LISTING.has(arg))
    case 'tag':
      return open || !rest.every((arg) => arg === '-l' || arg === '--list')
    case 'remote':
      return (
        open ||
        !(
          rest.length === 0 ||
          (rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose')) ||
          (rest.length === 2 &&
            (rest[0] === 'show' || rest[0] === 'get-url') &&
            !rest[1]!.startsWith('-'))
        )
      )
    case 'stash':
      return rest[0] !== 'list' && rest[0] !== 'show'
    case 'worktree':
      return rest[0] !== 'list'
    default:
      return true
  }
}
