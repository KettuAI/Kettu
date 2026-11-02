import { describe, expect, it } from 'vitest'
import {
  commandSteps,
  unsafeArgvPrefix,
  unsafeCommand,
  unsafeCommandPrefix,
} from './command-safety'

describe('commandSteps', () => {
  it('splits the steps and removes the quotes', () => {
    expect(
      commandSteps(`pnpm build && git commit -m "fix: it's done" || echo 'a b' ; ls | wc`),
    ).toEqual([
      ['pnpm', 'build'],
      ['git', 'commit', '-m', "fix: it's done"],
      ['echo', 'a b'],
      ['ls'],
      ['wc'],
    ])
    expect(commandSteps('r"m" \\-rf x')).toEqual([['rm', '-rf', 'x']])
    expect(commandSteps('echo "a \\$b \\"c\\""')).toEqual([['echo', 'a $b "c"']])
  })

  it('reads nothing that could hide another command', () => {
    for (const command of [
      '$(rm -rf x)',
      'echo `rm -rf x`',
      'echo "$(rm -rf x)"',
      'echo "`rm`"',
      '(rm -rf x)',
      '{ rm -rf x; }',
      'true & rm -rf x',
      'ls &> out',
      'ls |& cat',
      '! rm x',
      'echo "!x"',
      'ls > out',
      'cat < in',
      'ls\nrm -rf x',
      'ls \\\nrm',
      'echo ok # rm',
      'rm *',
      'ls ?',
      'ls [ab]',
      'case x in a) ;; esac',
      'echo "open',
      "echo 'open",
      'ls &&',
      '&& ls',
      'ls ;',
      '',
      '   ',
    ]) {
      expect(commandSteps(command), command).toBeNull()
    }
  })

  it('keeps backslashes as written in PowerShell', () => {
    expect(commandSteps('C:\\Windows\\cmd.exe /c del x', 'powershell')).toEqual([
      ['C:\\Windows\\cmd.exe', '/c', 'del', 'x'],
    ])
    expect(commandSteps('Write-Host `$x', 'powershell')).toBeNull()
  })
})

describe('unsafeCommand', () => {
  const unsafe = (command: string) => expect(unsafeCommand(command), command).toBe(true)
  const safe = (command: string) => expect(unsafeCommand(command), command).toBe(false)

  it('flags commands that delete, change rights or stop, in any step and by any path', () => {
    for (const command of [
      'rm -rf x',
      'pnpm build && rm -rf dist',
      'ls | xargs rm',
      '/bin/rm -r out',
      './rm x',
      'RM x',
      'rm.exe x',
      'C:/Windows/System32/del.exe x',
      'shred x',
      'mkfs.ext4 /dev/sda1',
      'newfs_apfs disk2',
      'sudo ls',
      'doas ls',
      'chmod -R 777 .',
      'chown me x',
      'kill 1',
      'pkill node',
      'shutdown -h now',
      'rimraf dist',
    ]) {
      unsafe(command)
    }
  })

  it('reads quoted heads as the command they run', () => {
    unsafe('"rm" -rf x')
    unsafe("'rm' -rf x")
    unsafe('r"m" -rf x')
    unsafe('\\rm -rf x')
  })

  it('flags shell syntax and keywords', () => {
    for (const command of [
      '(rm -rf x)',
      '{ rm -rf x; }',
      '$(rm -rf x)',
      '`rm -rf x`',
      'true & rm -rf x',
      '! rm x',
      'if true; then rm -rf x; fi',
      'for f in a; do ls; done',
      'while true; do ls; done',
      '=rm -rf x',
      'pnpm dev 2>&1',
    ]) {
      unsafe(command)
    }
  })

  it('looks through wrappers, and flags those that hide what they run', () => {
    for (const command of [
      'env rm -rf x',
      'env -i PATH=/bin rm x',
      'env -S "rm -rf x"',
      'env -u HOME rm x',
      'command rm x',
      'command -p rm x',
      'builtin eval rm x',
      'exec rm x',
      'nohup rm x',
      'time rm x',
      'time -p rm x',
      'timeout 5 rm x',
      'timeout -s KILL 5s rm x',
      'timeout --foo 5 ls',
      'nice rm x',
      'nice -n 10 rm x',
      'nice -10 rm x',
      'noglob rm x',
      'busybox rm x',
      'eval rm x',
      'source ./x.sh',
      '. ./x.sh',
      'watch rm x',
      'ssh host rm -rf x',
      'xargs -n 1 rm',
      'xargs -0 -n1 rm',
      'xargs -P 4 rm',
      'xargs -L 1 rm',
      'xargs -d , rm',
      'xargs -E END rm',
      'xargs -s 100 rm',
      'xargs -a list rm',
      'xargs --max-args=1 rm',
      'xargs --eof rm x',
      'xargs -I X X',
      'xargs -i rm',
      'xargs --replace rm',
      'xargs git',
      'xargs',
      'env',
    ]) {
      unsafe(command)
    }
    for (const command of [
      'env CI=1 pnpm test',
      'time pnpm test',
      'timeout 60 pnpm test',
      'nice -n 5 pnpm build',
      'nohup pnpm dev',
      'xargs grep foo',
      'xargs -0 -n 1 wc -l',
      'ls | xargs git log',
    ]) {
      safe(command)
    }
  })

  it('flags variables that change what runs', () => {
    for (const command of [
      'PATH=. ls',
      'LD_PRELOAD=x.so ls',
      'DYLD_INSERT_LIBRARIES=x ls',
      'GIT_PAGER=less git log',
      'NODE_OPTIONS=--require=./x.js pnpm test',
      'HOME=/tmp git log',
      'X=1',
    ]) {
      unsafe(command)
    }
    safe('CI=1 NODE_ENV=test pnpm test')
    safe('VITE_API=http://x pnpm dev')
  })

  it('flags interpreters given code instead of a script file', () => {
    for (const command of [
      'bash -c "rm -rf x"',
      'sh -c ls',
      'zsh -lc ls',
      'bash',
      'bash -s',
      'bash /dev/stdin',
      'node -e "1"',
      'node --eval 1',
      'node -p 1',
      'node',
      'node -',
      'python3 -c "print(1)"',
      'python -Bc "1"',
      'python -m',
      'perl -e 1',
      'ruby -e 1',
      'php -r 1',
      'pwsh -c ls',
      'powershell -Command ls',
      'cmd /c del x',
      'deno eval 1',
      'deno run https://example.com/x.ts',
      'bun -e 1',
      'bun exec "rm -rf x"',
    ]) {
      unsafe(command)
    }
    for (const command of [
      'bash scripts/build.sh',
      'node scripts/build.mjs --watch',
      'python3 -m pytest -x',
      'python3 manage.py migrate',
      'node --version',
      'deno run main.ts',
      'deno test',
      'bun test',
      'bun run dev',
    ]) {
      safe(command)
    }
  })

  it('judges the program a package runner starts', () => {
    for (const command of [
      'npx rimraf dist',
      'npx -y rimraf@5 dist',
      'npx -c "rm -rf x"',
      'pnpm dlx rimraf dist',
      'pnpm exec rm -rf x',
      'npm exec -- rm -rf x',
      'npm x rimraf',
      'npm explore pkg -- rm -rf x',
      'yarn dlx rimraf',
      'bunx rimraf',
      'bun x rimraf',
      'uvx rimraf',
      'uv run rm -rf x',
      'uv tool run rm x',
      'pipx run rm x',
      'poetry run rm x',
      'pnpm rimraf dist',
      'pnpm git reset --hard',
      'yarn node -e 1',
      'pnpm --filter web exec rm -rf x',
      'pnpm exec',
    ]) {
      unsafe(command)
    }
    for (const command of [
      'npm test',
      'npm run build',
      'npm install rimraf',
      'pnpm start',
      'pnpm rm lodash',
      'pnpm exec tsc --noEmit',
      'npx tsc --noEmit',
      'pnpm dlx create-vite@latest app',
      'uv run pytest',
      'uv sync',
      'pnpm --version',
    ]) {
      safe(command)
    }
  })

  it('flags find, rsync and awk when they delete, write or run a command', () => {
    unsafe('find . -delete')
    unsafe("find . -exec rm '{}' \\;")
    unsafe('find . -execdir rm x')
    unsafe('find . -ok rm')
    unsafe('find . -fprint out')
    unsafe('rsync -a --delete src/ dst/')
    unsafe('rsync -avze ssh src host:dst')
    unsafe('awk \'BEGIN { system("rm -rf x") }\'')
    unsafe('awk \'{ print > "x" }\' f')
    safe("find . -name '*.ts' -type f")
    safe('rsync -a src/ dst/')
    safe("awk '{ print $1 }' f")
  })

  it('allows git only to read or add', () => {
    for (const command of [
      'git -C repo reset --hard',
      'git -c x=y clean -fd',
      'git -c core.pager=less log',
      'git --exec-path=. status',
      'git checkout -- .',
      'git checkout main',
      'git restore .',
      'git reset --hard',
      'git clean -fd',
      'git push',
      'git push --force',
      'git pull',
      'git rebase main',
      'git branch -D main',
      'git branch -d main',
      'git branch new',
      'git tag -d v1',
      'git remote remove origin',
      'git stash',
      'git stash clear',
      'git stash drop',
      'git rm -rf .',
      'git worktree remove x',
      'git config alias.x "!rm"',
      'git add -f x',
      'git diff --output=src/index.ts',
      'git fetch --upload-pack=x origin',
      'git grep -O foo',
      'git st',
      'git Reset --hard',
    ]) {
      unsafe(command)
    }
    for (const command of [
      'git',
      'git status',
      'git -C repo log',
      'git --no-pager diff',
      'git --git-dir=.git --work-tree=. status',
      'git diff -- .',
      'git log --oneline -n 5',
      'git show HEAD^',
      'git add .',
      'git commit -m "fix: it"',
      'git fetch origin',
      'git grep -n foo',
      'git branch',
      'git branch -a -v',
      'git tag -l',
      'git remote -v',
      'git remote get-url origin',
      'git stash list',
      'git worktree list',
      'git rev-parse HEAD',
    ]) {
      safe(command)
    }
  })

  it('reads PowerShell cmdlets and aliases in any case', () => {
    const ps = (command: string) => unsafeCommand(command, 'powershell')
    expect(ps('Remove-Item -Recurse dist')).toBe(true)
    expect(ps('ri x')).toBe(true)
    expect(ps('Get-ChildItem | Remove-Item')).toBe(true)
    expect(ps('del x')).toBe(true)
    expect(ps('Stop-Process -Name node')).toBe(true)
    expect(ps('iex "rm x"')).toBe(true)
    expect(ps('C:\\Windows\\System32\\cmd.exe /c dir')).toBe(true)
    expect(ps('Get-ChildItem src')).toBe(false)
  })

  it('passes everyday commands', () => {
    for (const command of [
      'ls -la',
      'cat package.json',
      'npm test',
      'pnpm vitest run src',
      'git status',
      'cd src && ls',
      'grep -rn "foo bar" src',
      'mkdir -p out',
      'touch a',
      'cargo test',
      'go test ./...',
    ]) {
      safe(command)
    }
  })
})

describe('unsafeCommandPrefix', () => {
  const unsafe = (command: string) => expect(unsafeCommandPrefix(command), command).toBe(true)
  const safe = (command: string) => expect(unsafeCommandPrefix(command), command).toBe(false)

  it('flags a prefix that leaves open what runs', () => {
    for (const command of [
      'git',
      'git -C repo',
      'git branch',
      'git remote',
      'git stash',
      'git tag',
      'git fetch',
      'git grep',
      'xargs',
      'xargs -0',
      'sh',
      'bash',
      'node',
      'python3',
      'python3 -m',
      'find',
      'find . -name x',
      'rsync -a',
      'awk',
      'env',
      'env CI=1',
      'CI=1',
      'npx',
      'pnpm',
      'npm',
      'pnpm exec',
      'pnpm --filter web',
      'uv tool',
      'bun',
      'bun run',
      'deno run',
      'sudo',
      'rm',
      'git status && rm -rf x',
    ]) {
      unsafe(command)
    }
  })

  it('passes a prefix whose command is fixed', () => {
    for (const command of [
      'pnpm dev',
      'pnpm vitest run',
      'npm test',
      'npm run build',
      'git diff',
      'git log',
      'git add',
      'git commit',
      'git stash list',
      'git -C repo status',
      'node scripts/build.mjs',
      'python3 -m pytest',
      'cargo test',
      'ls',
      'pnpm build && pnpm test',
    ]) {
      safe(command)
    }
  })
})

describe('unsafeArgvPrefix', () => {
  it('judges the words as a prefix of a command', () => {
    expect(unsafeArgvPrefix(['touch'])).toBe(false)
    expect(unsafeArgvPrefix(['pnpm', 'test'])).toBe(false)
    expect(unsafeArgvPrefix(['git', 'status'])).toBe(false)
    expect(unsafeArgvPrefix([])).toBe(true)
    expect(unsafeArgvPrefix(['rm'])).toBe(true)
    expect(unsafeArgvPrefix(['/bin/rm', '-rf'])).toBe(true)
    expect(unsafeArgvPrefix(['git'])).toBe(true)
    expect(unsafeArgvPrefix(['git', 'reset'])).toBe(true)
    expect(unsafeArgvPrefix(['bash', '-lc'])).toBe(true)
    expect(unsafeArgvPrefix(['xargs'])).toBe(true)
    expect(unsafeArgvPrefix(['find', '.'])).toBe(true)
  })

  it('flags words a shell would read differently, or the option could not show', () => {
    expect(unsafeArgvPrefix(['echo', '$(rm -rf x)'])).toBe(true)
    expect(unsafeArgvPrefix(['echo', 'a b'])).toBe(true)
    expect(unsafeArgvPrefix(['echo', '`x`'])).toBe(true)
    expect(unsafeArgvPrefix(['echo', 'x\ny'])).toBe(true)
  })
})
