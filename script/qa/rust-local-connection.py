#!/usr/bin/env python3
"""Read-only smoke of the installed native CLI and explicitly configured MCP."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[2]

def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True, timeout=60).strip()

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--published', action='store_true')
    args = parser.parse_args()
    installed = Path.home() / '.local/bin/gdm'
    assert Path(shutil.which('gdm')).resolve() == installed.resolve()
    assert digest(installed) == digest(ROOT / 'target/release/gdm')
    assert installed.read_bytes()[:4] in (b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\x7fELF')
    version = run(str(installed), '--version')
    run(str(installed), 'device', '--help')
    doctor = run(str(installed), 'doctor')
    assert doctor
    codex_path = Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex'))) / 'config.toml'
    codex = tomllib.loads(codex_path.read_text())['mcp_servers']['gdm-computer-use']
    claude = json.loads((Path.home()/'.claude.json').read_text())['mcpServers']['gdm-computer-use']
    for config in (codex, claude):
        assert config['command'] == str(installed)
        assert config['args'][:3] == ['computer-use', 'mcp', '--env-file']
        assert len(config['args']) == 4 and Path(config['args'][3]).is_file()
    assert codex['args'] == claude['args']
    requests = [
        {'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'gdm-local-qa','version':'1'}}},
        {'jsonrpc':'2.0','method':'notifications/initialized'},
        {'jsonrpc':'2.0','id':2,'method':'tools/list'},
        {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'gdm_computer_use','arguments':{'action':'status'}}},
    ]
    result = subprocess.run([str(installed), *codex['args']], input=''.join(json.dumps(r)+'\n' for r in requests), capture_output=True, text=True, timeout=30, check=True)
    responses = {r['id']: r for r in map(json.loads, result.stdout.splitlines())}
    assert all('error' not in r for r in responses.values())
    assert responses[1]['result']['serverInfo']['version'] == version
    names = sorted(t['name'] for t in responses[2]['result']['tools'])
    assert names == ['gdm_computer_choose','gdm_computer_step','gdm_computer_use']
    assert not responses[3]['result'].get('isError', False)
    status = json.loads(responses[3]['result']['content'][0]['text'])
    assert status['state'] == 'stopped' and not status['owned']
    output = {'version':version,'installedSha256':digest(installed),'doctor':'passed','mcpConfigs':['codex','claude'],'tools':names,'vm':'stopped (status only)'}
    if args.published:
        branch = run('git','branch','--show-current')
        head = run('git','rev-parse','HEAD')
        remote = run('git','-c','credential.helper=','-c','credential.helper=!gh auth git-credential','ls-remote','origin','refs/heads/'+branch)
        assert remote.split()[0] == head
        visibility = json.loads(run('gh','repo','view','Gdm0714/gdm','--json','visibility'))['visibility']
        assert visibility == 'PRIVATE'
        output.update(remoteHead=head, visibility=visibility)
    print(json.dumps(output, indent=2))

if __name__ == '__main__':
    main()
