"""One-time, owner-authorized removal of the inventoried previous collection refs."""
import json, os, subprocess
from pathlib import Path

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

expected_main = os.environ['GITHUB_SHA']
if os.environ['GITHUB_REPOSITORY'] != 'etovova/coolbears':
    raise RuntimeError('Wrong repository')
refs = dict(line.split('\t', 1)[::-1] for line in git('ls-remote', '--heads', 'origin').splitlines())
if refs.get('refs/heads/main') != expected_main:
    raise RuntimeError('main changed; preserve new work')
deleted = absent = 0
for branch in json.loads(Path('scripts/old-branches.json').read_text()):
    name, sha = branch['name'], branch['sha']
    if name == 'main':
        raise RuntimeError('Never delete main')
    ref = 'refs/heads/' + name
    if ref not in refs:
        absent += 1
        continue
    if refs[ref] != sha:
        raise RuntimeError('Previous branch changed; preserve it: ' + name)
    subprocess.run(['git', 'push', 'origin', '--force-with-lease=' + ref + ':' + sha, ':' + ref], check=True)
    deleted += 1
page = Path('.github/workflows/pages.yml')
text = page.read_text()
start, end = text.index('  # RESET_ONLY_START'), text.index('  # RESET_ONLY_END')
page.write_text(text[:start] + text[end + len('  # RESET_ONLY_END'):].lstrip('\n'))
status = Path('docs/STATUS.md')
status.write_text(status.read_text() + f'\nЗавершён сброс GitHub: удалено {deleted} старых веток, ранее отсутствовало {absent}. main создан заново без родительских коммитов; сайт и новая сборка сохранены.\n')
git('rm', 'scripts/reset-git-history.py', 'scripts/old-branches.json')
git('add', '.github/workflows/pages.yml', 'docs/STATUS.md')
git('config', 'user.name', 'github-actions[bot]')
git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
tree = git('write-tree')
commit = git('commit-tree', tree, '-m', 'CoolBears Solana: clean project and preserved original media')
subprocess.run(['git', 'push', 'origin', '--force-with-lease=refs/heads/main:' + expected_main, commit + ':refs/heads/main'], check=True)
print(json.dumps({'deletedBranches': deleted, 'alreadyAbsent': absent, 'main': commit, 'historyParents': 0}))
