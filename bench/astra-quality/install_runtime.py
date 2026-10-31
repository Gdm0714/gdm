"""Back up current installed files, apply approved runtime and record exact parity."""
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
from common import HERE, ROOT, save, load, sha

def main():
    home=Path.home();base=home/'projects/harness-bench-runs'
    # Preserve the measured installation and smoke before a later telemetry patch.
    if (HERE/'installation.json').exists():
        previous=load(HERE/'installation.json')['version']
        for stem in ['installation','backup','live-role-probe']:
            source=HERE/f'{stem}.json';archive=HERE/f'{stem}-{previous}.json'
            if source.exists() and not archive.exists():shutil.copy2(source,archive)
    backup=Path(tempfile.mkdtemp(prefix='gdm-pi-quality-backup-',dir=base));backup.chmod(0o700)
    roots=[home/'.codex/skills',home/'.claude/skills',home/'.pi/agent/skills']
    paths=[home/'.local/bin/gdm',home/'.local/bin/gdm-pi',home/'.pi/agent/settings.json',home/'.codex/config.toml',home/'.codex/hooks.json']
    paths += [p for root in roots for p in root.glob('gdm-*')]
    records=[]
    for path in paths:
        if not(path.exists() or path.is_symlink()):continue
        target=backup/path.relative_to(home);target.parent.mkdir(parents=True,exist_ok=True)
        if path.is_symlink():target.symlink_to(os.readlink(path))
        elif path.is_dir():shutil.copytree(path,target,symlinks=True)
        else:
            shutil.copy2(path,target)
            if path.suffix in ['.json','.toml']:target.chmod(0o600)
        records.append({'path':str(path),'backup':str(target),'originalMode':stat.S_IMODE(path.lstat().st_mode)})
    save(HERE/'backup.json',{'path':str(backup),'files':records})
    settings=sha((home/'.pi/agent/settings.json').read_bytes())
    r=subprocess.run(['./install/install.sh'],cwd=ROOT,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    (backup/'install.log').write_bytes(r.stdout)
    print('install exit',r.returncode,'log',str(backup/'install.log'),flush=True)
    assert r.returncode==0,'installation failed; see preserved log'
    assert settings==sha((home/'.pi/agent/settings.json').read_bytes()),'settings changed'
    files=[]
    for path in [home/'.local/bin/gdm',home/'.local/bin/gdm-pi']+[p for root in roots for d in root.glob('gdm-*') for p in d.rglob('*') if p.is_file()]:
        files.append({'path':str(path),'sha256':sha(path.read_bytes())})
    save(HERE/'installation.json',{'version':load(ROOT/'cli/package.json')['version'],'backup':str(backup),'files':files,'settingsSha256':settings,
       'settings':{k:load(home/'.pi/agent/settings.json').get(k) for k in ['defaultProvider','defaultModel','defaultThinkingLevel']}})
    print('installed version',load(ROOT/'cli/package.json')['version'],'files',len(files))
if __name__ == "__main__":
    raise SystemExit('Retired benchmark: Pi integration was removed. Historical results are preserved; use the native GDM/gid benchmarks for new runs.')
if __name__=='__main__':main()
