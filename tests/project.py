#!/usr/bin/env python3
"""Project regression checks. All installation/removal uses a temporary HOME.
No real D-Bus, gsettings, calendar accounts, or desktop are accessed.
"""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
UUID = 'bigCalendar@adis'

class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='big-calendar-project-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.repo = self.base / 'source'
        shutil.copytree(ROOT, self.repo, ignore=shutil.ignore_patterns('.git', 'dist', '__pycache__'))
        self.home = self.base / 'home'; self.home.mkdir()
        self.bin = self.base / 'bin'; self.bin.mkdir()
        self.state = self.base / 'enabled'; self.state.write_text("['other:1:10:20', 'bigCalendar@adis:2:950:50']")
        self.writes = self.base / 'writes'
        self.dest = self.home / '.local/share/cinnamon/desklets' / UUID
        (self.dest / 'lib').mkdir(parents=True)
        (self.dest / 'desklet.js').write_text('old code')
        (self.dest / 'lib/old.js').write_text('old library')
        (self.dest / 'custom.txt').write_text('keep me')
        self.env = {**os.environ, 'HOME': str(self.home), 'PATH': str(self.bin)+':'+os.environ['PATH'],
            'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/nonexistent-big-calendar-test-bus',
            'XDG_DATA_HOME': str(self.home/'.local/share'), 'XDG_CONFIG_HOME': str(self.home/'.config'),
            'TEST_ENABLED': str(self.state), 'TEST_WRITES': str(self.writes)}
        self.mock('cinnamon', '#!/bin/sh\necho Cinnamon 6.6.9\n')
        self.mock('gsettings', '''#!/usr/bin/python3
import os,sys
from pathlib import Path
state=Path(os.environ['TEST_ENABLED'])
if sys.argv[1]=='get': print(state.read_text())
else:
 if os.environ.get('TEST_LOCKED'): sys.exit(1)
 state.write_text(sys.argv[-1]);Path(os.environ['TEST_WRITES']).write_text('written')
''')
    def mock(self, name, code):
        path=self.bin/name;path.write_text(code);path.chmod(0o755)
    def run_script(self, name, *args, ok=True, env=None):
        result=subprocess.run(['bash',str(self.repo/name),*args],env={**self.env,**(env or {})},cwd=self.repo,
            text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
        if ok: self.assertEqual(result.returncode,0,result.stdout)
        else: self.assertNotEqual(result.returncode,0,result.stdout)
        return result
    def tree(self):
        return {str(p.relative_to(self.dest)):hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.dest.rglob('*') if p.is_file()}
    def installer_probe(self, command):
        # Source the real functions, replacing only desktop detection/reload.
        source=(self.repo/'install.sh').read_text().split('[[ $# -le 1 ]]')[0]
        (self.repo/'probe.sh').write_text(source+'\ncinnamon_running() { return 0; }\n'
            +'reload_running() { return 0; }\n'+command+'\n')
        return 'probe.sh'
    def test_unknown_version_is_not_reported_as_absent_cinnamon(self):
        self.mock('cinnamon','#!/bin/sh\necho Cinnamon unknown-version\n')
        result=self.run_script('install.sh','--check',ok=False)
        self.assertIn('could not determine the installed Cinnamon version',result.stdout)
        self.assertNotIn('Cinnamon is not installed',result.stdout)
    def test_library_probe_distinguishes_missing_libraries_and_unusable_runtime(self):
        for code,expected in [(3,'calendar libraries the desklet'),(126,'could not run the library check')]:
            self.mock('cjs',f'#!/bin/sh\nexit {code}\n')
            result=self.run_script('install.sh','--check',ok=False)
            self.assertIn(expected,result.stdout)
    def test_repeated_install_keeps_only_latest_recovery_copy(self):
        for number in range(3):
            (self.dest/'desklet.js').write_text(f'old {number}')
            self.run_script('install.sh')
            backups=list(self.dest.parent.glob('.*.previous'))
            self.assertEqual(len(backups),1)
            self.assertEqual((backups[0]/'desklet.js').read_text(),f'old {number}')
    def test_repeated_spices_build_keeps_one_backup_and_failure_preserves_build(self):
        for _ in range(3):self.run_script('tools/make-spice.sh')
        backups=list((self.repo/'dist/spice').glob('.build.*.previous'))
        self.assertEqual(len(backups),1)
        built=self.repo/'dist/spice'/UUID/'files'/UUID/'desklet.js'
        before=built.read_bytes()
        self.mock('xgettext','#!/bin/sh\necho failed >&2\nexit 1\n')
        self.run_script('tools/make-spice.sh',ok=False)
        self.assertEqual(built.read_bytes(),before)
        self.assertTrue(backups[0].exists())
    def test_malformed_list_preflight_preserves_installed_files(self):
        self.state.write_text('broken');before=self.tree()
        self.run_script(self.installer_probe('do_install'),ok=False)
        self.assertEqual(self.tree(),before)
        self.assertFalse(self.writes.exists())
    def test_enable_failure_rolls_back_files(self):
        self.state.write_text("['other:1:10:20']");before=self.tree()
        result=self.run_script(self.installer_probe('do_install'),ok=False,env={'TEST_LOCKED':'1'})
        self.assertEqual(self.tree(),before)
        self.assertIn('installed files were rolled back',result.stdout)
    def test_existing_entry_does_not_rewrite_the_list(self):
        before=self.state.read_text()
        self.run_script(self.installer_probe('edit_enabled add'))
        self.assertEqual(self.state.read_text(),before)
        self.assertFalse(self.writes.exists())
    def test_enabled_list_retries_a_concurrent_move_and_add(self):
        self.state.write_text("['other:1:10:20']")
        self.mock('gsettings','''#!/usr/bin/python3
import os,sys
from pathlib import Path
state=Path(os.environ['TEST_ENABLED']);marker=Path(os.environ['TEST_WRITES'])
if sys.argv[1]=='get':
 print(state.read_text())
 if not marker.exists():
  marker.write_text('changed')
  state.write_text("['other:1:999:999', 'new:2:1:1']")
else:state.write_text(sys.argv[-1])
''')
        self.run_script(self.installer_probe('edit_enabled add'))
        self.assertEqual(json.loads(self.state.read_text()),['other:1:999:999','new:2:1:1',UUID+':3:400:200'])
    def test_screenshot_expiry_never_publishes_or_reports_success(self):
        self.mock('gdbus','''#!/usr/bin/python3
import sys
from pathlib import Path
if 'org.Cinnamon.ScreenshotArea' in sys.argv:
 Path(sys.argv[-1]).write_bytes(b'invalid capture after recovery')
 print('(true,)')
elif "s.restore();return 'restored'" in sys.argv[-1]:print('(true, \\'"nothing"\\')')
else:print('(true, \\'"500x400"\\')')
''')
        out=self.base/'expired.png'
        result=self.run_script('shot.sh',str(out),ok=False)
        self.assertFalse(out.exists());self.assertNotIn('Wrote ',result.stdout)
        self.assertIn('Capture expired',result.stdout)
    def test_screenshot_success_restores_before_publication(self):
        out=self.base/'success.png';self.env['TEST_OUTPUT']=str(out)
        self.mock('gdbus','''#!/usr/bin/python3
import os,sys
from pathlib import Path
if 'org.Cinnamon.ScreenshotArea' in sys.argv:
 Path(sys.argv[-1]).write_bytes(b'valid synthetic capture')
 print('(true,)')
elif "s.restore();return 'restored'" in sys.argv[-1]:
 assert not Path(os.environ['TEST_OUTPUT']).exists()
 print('(true, \\'"restored"\\')')
else:print('(true, \\'"500x400"\\')')
''')
        result=self.run_script('shot.sh',str(out))
        self.assertEqual(out.read_bytes(),b'valid synthetic capture');self.assertIn('Wrote ',result.stdout)
    def test_runner_distinguishes_skipped_and_failed_suites(self):
        # Isolate orchestration from the suites themselves, including this file.
        (self.repo/'tests/project.py').write_text('pass\n')
        for code,outcome in [(77,'SKIP=18'),(139,'FAIL=18')]:
            self.mock('cjs',f'#!/bin/sh\nexit {code}\n')
            result=subprocess.run(['python3','tests/run.py'],cwd=self.repo,env=self.env,
                text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=15)
            self.assertEqual(result.returncode,77 if code==77 else 1,result.stdout)
            self.assertIn(outcome,result.stdout)
    def test_missing_source_preserves_install(self):
        before=self.tree();(self.repo/'lib/calendarUtils.js').unlink()
        self.run_script('install.sh',ok=False);self.assertEqual(self.tree(),before)
    def test_copy_failure_preserves_install(self):
        before=self.tree();self.mock('cp','#!/bin/sh\nexit 28\n')
        self.run_script('install.sh',ok=False);self.assertEqual(self.tree(),before)
    def test_rename_failure_rolls_back(self):
        before=self.tree()
        self.mock('mv','''#!/bin/sh
case "$2" in *.stage.??????) exit 1;; esac
exec /usr/bin/mv "$@"
''')
        self.run_script('install.sh',ok=False);self.assertEqual(self.tree(),before)
    def test_success_replaces_library_and_keeps_extra_files_and_backup(self):
        self.run_script('install.sh');self.assertEqual((self.dest/'desklet.js').read_bytes(),(ROOT/'desklet.js').read_bytes())
        self.assertFalse((self.dest/'lib/old.js').exists());self.assertEqual((self.dest/'custom.txt').read_text(),'keep me')
        backups=list(self.dest.parent.glob('.*.previous'));self.assertEqual(len(backups),1)
        self.assertEqual((backups[0]/'desklet.js').read_text(),'old code')
        self.assertEqual((self.dest/'settingsWidgets.py').read_bytes(),(ROOT/'settingsWidgets.py').read_bytes())
    def test_bad_desklet_list_never_written_or_uninstalled(self):
        for raw in ['broken', '{}', '[1]']:
            self.state.write_text(raw);before=self.tree()
            self.run_script('deploy.sh','--disable',ok=False)
            self.assertFalse(self.writes.exists());self.assertEqual(self.tree(),before)
    def test_locked_settings_never_uninstall_files(self):
        before=self.tree();self.run_script('install.sh','--uninstall',ok=False,env={'TEST_LOCKED':'1'})
        self.assertEqual(self.tree(),before)
    def test_uninstall_preserves_other_desklets_and_configuration(self):
        cfg=self.home/'.config/cinnamon/spices'/UUID/'settings.json';cfg.parent.mkdir(parents=True);cfg.write_text('keep settings')
        mo=self.home/'.local/share/locale/ro/LC_MESSAGES'/f'{UUID}.mo';mo.parent.mkdir(parents=True);mo.write_text('old translation')
        self.run_script('deploy.sh','--disable')
        self.assertEqual(json.loads(self.state.read_text()),['other:1:10:20'])
        self.assertTrue(cfg.exists());self.assertFalse(self.dest.exists());self.assertFalse(mo.exists())
    def test_unknown_arguments_never_mutate(self):
        before=self.tree();self.run_script('deploy.sh','--typo',ok=False)
        self.run_script('install.sh','--uninstall','extra',ok=False);self.assertEqual(self.tree(),before)
    def test_translation_failure_keeps_previous_binary(self):
        (self.repo/'po/test.po').write_text('bad catalog')
        mo=self.home/'.local/share/locale/test/LC_MESSAGES'/f'{UUID}.mo';mo.parent.mkdir(parents=True);mo.write_text('valid old catalog')
        self.mock('msgfmt','#!/bin/sh\nexit 1\n')
        self.run_script('install.sh');self.assertEqual(mo.read_text(),'valid old catalog')
    def test_packaging_and_failed_build_preserve_previous_archive(self):
        self.run_script('tools/make-dist.sh');archive=self.repo/'dist'/f'{UUID}.zip';before=archive.read_bytes()
        import zipfile
        with zipfile.ZipFile(archive) as z:
            self.assertIn(f'{UUID}/screenshot.png',z.namelist())
            self.assertIn(f'{UUID}/settingsWidgets.py',z.namelist())
            for lib in ('calendarUtils','eventIndex','calendarSource'):self.assertIn(f'{UUID}/lib/{lib}.js',z.namelist())
        self.mock('zip','#!/bin/sh\nexit 1\n');self.run_script('tools/make-dist.sh',ok=False)
        self.assertEqual(archive.read_bytes(),before)
    def test_screenshot_rejects_existing_output_and_unknown_options(self):
        out=self.base/'existing.png';out.write_bytes(b'keep')
        self.run_script('shot.sh',str(out),ok=False);self.assertEqual(out.read_bytes(),b'keep')
        self.run_script('shot.sh','--opaqe',ok=False)
    def test_screenshot_failure_restores_actor(self):
        log=self.base/'dbus-log';self.env['TEST_DBUS_LOG']=str(log)
        self.mock('gdbus','''#!/usr/bin/python3
import os,sys
from pathlib import Path
with Path(os.environ['TEST_DBUS_LOG']).open('a') as f:f.write(sys.argv[-1]+'\\n')
if 'org.Cinnamon.ScreenshotArea' in sys.argv: sys.exit(1)
print('(true, \'"restored"\')' if "s.restore();return 'restored'" in sys.argv[-1] else '(true, \'"500x400"\')')
''')
        self.run_script('shot.sh',str(self.base/'new.png'),ok=False)
        self.assertIn("s.restore();return 'restored'",log.read_text())
    def test_settings_layout_defaults_bindings_and_translation_template(self):
        schema=json.loads((ROOT/'settings-schema.json').read_text());layout=schema['layout'];visible=[]
        for page in layout['pages']:
            for section in layout[page]['sections']:visible.extend(layout[section]['keys'])
        self.assertEqual(len(visible),len(set(visible)))
        bindings=set(re.findall(r's.bind\("([^"]+)"',(ROOT/'desklet.js').read_text()))
        desklet_source=(ROOT/'desklet.js').read_text()
        palette=json.loads(re.search(r'const COLOR_DEFAULTS = (\{.*?\});',desklet_source,re.S)[1])
        expected={prop:schema[key]['default'] for key,prop in re.findall(r's.bind\("([^"]+)", "([^"]+)"',desklet_source)
                  if schema[key].get('type')=='colorchooser'}
        self.assertEqual(palette,expected)

        self.assertEqual(bindings,{k for k,v in schema.items() if 'default' in v}-{'last-view'})
        self.assertEqual({schema[k].get('setting',k) for k in visible}-{'reset-settings'},bindings)
        for key,value in schema.items():
            if value.get('type') in ('scale','spinbutton','combobox'):
                wrapper=schema[key+'-control']
                self.assertIn(key+'-control',visible)
                self.assertNotIn(key,visible)
                self.assertEqual(wrapper['setting'],key)
                self.assertEqual(wrapper.get('dependency'),value.get('dependency'))
                self.assertTrue((ROOT/wrapper['file']).is_file())
        for key,value in schema.items():
            if key=='layout':continue
            if 'min' in value:self.assertTrue(value['min']<=value['default']<=value['max'],key)
            if 'options' in value:self.assertIn(value['default'],value['options'].values(),key)
        self.run_script('tools/make-pot.sh')
        pot=(self.repo/'po'/f'{UUID}.pot').read_text()
        for text in ['Size and spacing','Calendars','pixels','Background refresh interval','5 minutes (recommended)','(no title)','AM','PM']:
            self.assertIn('msgid '+json.dumps(text),pot)

if __name__=='__main__':unittest.main(verbosity=2)
