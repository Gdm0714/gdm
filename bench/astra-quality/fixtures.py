"""Four reviewed multi-module tasks. Only materialize() is exposed to model workspaces."""
from importlib import import_module
from pathlib import Path
import json
TASKS = {t['id']: t for t in [import_module('tasks.' + n).TASK for n in ['authorization', 'outbox', 'pagination', 'reservations']]}
TASK_IDS = list(TASKS)
def materialize(task_id, workspace):
    t = TASKS[task_id]; workspace = Path(workspace); workspace.mkdir(parents=True, exist_ok=True)
    files = {**t['files'], 'package.json': json.dumps({'type':'module','scripts':{'test':'bun test'}}),
             'test/visible.test.ts':t['visible'], 'TASK.md':t['brief']}
    for name, content in files.items():
        path=workspace/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(content)
    return t['brief'], t['hidden']
def apply(workspace, changes):
    for name, change in changes.items():
        path=Path(workspace)/name
        if isinstance(change,str): path.write_text(change)
        else:
            text=path.read_text()
            for old,new in change:
                assert old in text, (name,old)
                text=text.replace(old,new)
            path.write_text(text)
def oracle(task_id, workspace): apply(workspace,TASKS[task_id]['oracle'])
def mutant(task_id,name,workspace): apply(workspace,TASKS[task_id]['mutants'][name])
