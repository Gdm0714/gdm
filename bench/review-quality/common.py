import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

def sha(data):
    return hashlib.sha256(data).hexdigest()

def load(path):
    return json.loads(Path(path).read_text())

def save(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def hashes(root):
    return {str(p.relative_to(root)): sha(p.read_bytes()) for p in sorted(root.rglob('*'))
            if p.is_file() and '__pycache__' not in p.parts}

def active():
    pointer = load(HERE / 'active-run.json')
    run = Path(pointer['path'])
    assert sha((run / 'manifest.json').read_bytes()) == pointer['manifestSha256']
    return run, load(run / 'manifest.json')

def function(source, name):
    import re
    match = re.search(r'^(?:export )?(?:async )?function ' + name + r'\b[\s\S]*?^}[ \t]*$', source, re.M)
    assert match, name
    return match.group() + '\n'
