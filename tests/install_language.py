#!/usr/bin/env python3
"""Exercise real installer download failure before any user settings are written."""
import os
from pathlib import Path
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='gdm-install-language-') as directory:
    scratch = Path(directory)
    curl = scratch / 'curl'
    curl.write_text('#!/bin/sh\nexit 22\n')
    curl.chmod(0o755)
    for choice, locale, korean in [('en', 'ko_KR.UTF-8', False), ('ko', 'en_US.UTF-8', True), ('auto', 'fr_FR.UTF-8', False), ('auto', 'ko_KR.UTF-8', True)]:
        env = os.environ.copy()
        env.update(PATH=str(scratch) + os.pathsep + env['PATH'], GDM_LANGUAGE=choice, LC_ALL=locale)
        result = subprocess.run(['bash', str(root / 'install.sh')], env=env, capture_output=True, text=True, timeout=15)
        assert result.returncode == 1, result
        output = result.stdout + result.stderr
        assert ('gdm 설치 실패' if korean else 'gdm installation failed') in output, output
        assert ('릴리스 다운로드' if korean else 'Downloading release') in output, output
        if not korean:
            assert not re.search('[가-힣]', output), output
        print(f'Installer failure and cleanup passed: language={choice}, locale={locale}')
