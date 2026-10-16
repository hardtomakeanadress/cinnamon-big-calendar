#!/usr/bin/env python3
"""Run offline checks; optional GUI and EDS suites are explicit opt-ins."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gui', action='store_true', help='temporary GTK controls in the graphical session')
    parser.add_argument('--isolated', action='store_true', help='synthetic events in a private EDS profile')
    parser.add_argument('--live', action='store_true', help='read calendars in the current account profile')
    args = parser.parse_args()
    cases = []
    for zone in ('UTC', 'Europe/Bucharest', 'America/New_York', 'America/Goose_Bay'):
        for suite in ('run-tests', 'timezone', 'recurrence'):
            cases.append((f'{suite} [{zone}]', ['cjs', '-m', f'tests/{suite}.js'], zone))
    for suite in ('feed', 'refresh', 'ui', 'lifecycle', 'render', 'query'):
        cases.append((suite, ['cjs', '-m', f'tests/{suite}.js'], 'Europe/Bucharest'))
    cases.append(('project', [sys.executable, 'tests/project.py'], 'Europe/Bucharest'))
    for enabled, name, command in (
        (args.gui, 'settings-ui', [sys.executable, 'tests/settings-ui.py']),
        (args.gui, 'St theme', [sys.executable, 'tests/theme.py']),
        (args.isolated, 'isolated EDS', ['bash', 'tests/isolated-refresh.sh']),
        (args.live, 'live EDS', ['cjs', '-m', 'tests/integration.js']),
    ):
        if enabled:
            cases.append((name, command, 'Europe/Bucharest'))
        else:
            print(f'NOT REQUESTED: {name}', flush=True)
    totals = {'PASS': 0, 'FAIL': 0, 'SKIP': 0}
    for name, command, zone in cases:
        print(f'\n--- {name} ---', flush=True)
        if not shutil.which(command[0]):
            print(f'SKIP: {command[0]} is unavailable')
            rc = 77
        else:
            try:
                rc = subprocess.run(command, cwd=ROOT, env={**os.environ, 'TZ': zone}, timeout=90).returncode
            except subprocess.TimeoutExpired:
                print('FAIL: suite timed out')
                rc = 1
        outcome = 'PASS' if rc == 0 else 'SKIP' if rc == 77 else 'FAIL'
        totals[outcome] += 1
        print(f'{outcome}: {name} (exit {rc})', flush=True)
    print('\nSuite runs: ' + ', '.join(f'{key}={value}' for key, value in totals.items()))
    # Incomplete verification stays distinguishable from a complete pass.
    return 1 if totals['FAIL'] else 77 if totals['SKIP'] else 0


if __name__ == '__main__':
    sys.exit(main())
