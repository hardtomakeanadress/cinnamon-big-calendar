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
        self.assertEqual(bindings,set(schema)-{'layout','last-view'})
        self.assertEqual(set(visible),bindings)
        for key,value in schema.items():
            if key=='layout':continue
            if 'min' in value:self.assertTrue(value['min']<=value['default']<=value['max'],key)
            if 'options' in value:self.assertIn(value['default'],value['options'].values(),key)
        self.run_script('tools/make-pot.sh')
        pot=(self.repo/'po'/f'{UUID}.pot').read_text()
        for text in ['Size and spacing','Calendars','pixels','minutes','(no title)','AM','PM']:
            self.assertIn('msgid '+json.dumps(text),pot)

if __name__=='__main__':unittest.main(verbosity=2)
