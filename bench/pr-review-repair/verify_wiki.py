"""Validate only this experiment's authorized Obsidian update and source capture."""
import re
from pathlib import Path
from common import HERE,load,sha

def capture(text):
 out=[];fenced=False
 for line in text.splitlines(keepends=True):
  if line.startswith('```'):fenced=not fenced
  if not fenced:line=re.sub(r'^(#{1,5}) ',lambda m:'#'*min(len(m[1])+2,6)+' ',line)
  out.append(line)
 return ''.join(out)

def main():
 r=load(HERE/'obsidian-update-receipt.json');root=Path(r['vaultRoot']);backup=Path(r['backup'])
 assert len(r['files'])==7
 for f in r['files']:
  p=root/f['path'];assert p.suffix=='.md' and Path(f['path']).parts[0] in ['Wiki','Sources']
  assert sha(p.read_bytes())==f['afterSha256']
  if f['beforeSha256']:assert sha((backup/f['path']).read_bytes())==f['beforeSha256']
  text=p.read_text();assert text.startswith('---\n') and re.search(r'^tags: \[.+\]$',text,re.M)
  for target in re.findall(r'\[\[([^\]|]+)(?:\|[^\]]*)?\]\]',text):
   target=target.split('#')[0]
   if not target:continue
   dest=root/(target if target.endswith('.md') else target+'.md');assert dest.is_file(),(str(p),target)
 source=(root/r['newSource']).read_text();wiki=(root/r['newWiki']).read_text()
 for n,digest in r['capturedSources'].items():assert sha((HERE/n).read_bytes())==digest and digest in source,n
 for n in ['results-2026-09-09.md','README.md','methodology-qa.md']:assert capture((HERE/n).read_text()) in source,n
 for text in [source,wiki]:
  assert '**' not in text and text.count('```')%2==0
  assert '| 사후 BOM 복구 검사 | 1/3 | 2/3 | 3/3 |' in text
  assert '사람' in text and '미확정' in text and 'P16' in text
 overview=(root/'Wiki/AI 에이전트/GDM 하네스 측정 총정리 - 2026-09.md').read_text()
 assert '다섯 차례 실험' in overview and '144개' in overview and 'Astra 정상 리뷰는 5회' in overview
 assert r['newWiki'][:-3] in overview and r['newSource'][:-3] in overview
 for text in [overview,(root/'Wiki/AI 에이전트/코딩 에이전트 품질 측정 기준.md').read_text()]:
  # No isolated appended table rows after a blank line with no header.
  assert not re.search(r'\|\n\n\| (?:E5 |실제 PR 리뷰를)',text)
 print('OBSIDIAN PASS: 2 new notes, 5 updated notes; backups, source capture, hashes, numbers and all wikilinks verified')

if __name__=='__main__':main()
