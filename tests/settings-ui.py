#!/usr/bin/env python3
"""Real GTK control tests using a temporary settings file, never personal data.
Requires Cinnamon's installed settings libraries and a graphical session.
Run: python3 tests/settings-ui.py
"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, Gtk

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, '/usr/share/cinnamon/cinnamon-settings')
sys.path.insert(0, '/usr/share/cinnamon/cinnamon-settings/bin')
from JsonSettingsWidgets import JSONSettingsHandler

spec = importlib.util.spec_from_file_location('calendar_settings', ROOT/'settingsWidgets.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def pump():
    end = time.monotonic() + .35
    while time.monotonic() < end:
        while Gtk.events_pending():
            Gtk.main_iteration()
        time.sleep(.005)


def scroll(widget, direction, delta=0):
    event = Gdk.Event.new(Gdk.EventType.SCROLL)
    event.window = widget.get_window()
    event.send_event = True
    event.direction = direction
    event.delta_y = delta
    event.set_device(Gdk.Display.get_default().get_default_seat().get_pointer())
    widget.event(event)
    pump()


with tempfile.TemporaryDirectory(prefix='big-calendar-settings-ui-') as temp:
    data = json.loads((ROOT/'settings-schema.json').read_text())
    for key, properties in data.items():
        if 'default' in properties:
            properties['value'] = properties['default']
    data['event-refresh']['value'] = 15
    path = Path(temp)/'settings.json'
    path.write_text(json.dumps(data))
    settings = JSONSettingsHandler(str(path))
    window = Gtk.Window()
    window.set_default_size(700, 300)
    page = Gtk.ScrolledWindow()
    page.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
    page.set_kinetic_scrolling(False)
    content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    rows = {}
    for key in ('font-scale', 'padding', 'event-refresh'):
        rows[key] = module.ScrollSafeControl(data[key+'-control'], key+'-control', settings)
        content.pack_start(rows[key], False, False, 0)
    filler = Gtk.Box()
    filler.set_size_request(-1, 2000)
    content.pack_start(filler, False, False, 0)
    page.add(content)
    window.add(page)
    window.show_all()
    pump()
    try:
        before = {key: settings.get_value(key) for key in rows}
        adjustment = page.get_vadjustment()
        for focused in (False, True):
            for key, row in rows.items():
                if focused:
                    row.content_widget.grab_focus()
                else:
                    window.set_focus(None)
                for direction, delta in ((Gdk.ScrollDirection.DOWN, 0),
                                         (Gdk.ScrollDirection.UP, 0),
                                         (Gdk.ScrollDirection.SMOOTH, 1),
                                         (Gdk.ScrollDirection.SMOOTH, -1)):
                    adjustment.set_value(100)
                    scroll(row.content_widget, direction, delta)
                    assert adjustment.get_value() != 100, (key, direction, 'page did not scroll')
                    assert settings.get_value(key) == before[key], (key, 'wheel changed setting')
                # At the edge the wheel must still never change the control.
                adjustment.set_value(0)
                scroll(row.content_widget, Gdk.ScrollDirection.UP)
                assert settings.get_value(key) == before[key], (key, 'edge changed setting')
        print('PASS wheel and smooth scroll move the page, not sliders, numbers or dropdowns; focused controls and page edges included')

        rows['font-scale'].content_widget.set_value(225)
        rows['padding'].content_widget.set_value(20)
        rows['event-refresh'].content_widget.set_active(0)
        pump()
        assert settings.get_value('font-scale') == 225
        assert settings.get_value('padding') == 20
        assert settings.get_value('event-refresh') == 1
        print('PASS deliberate value changes still save through Cinnamon bindings')

        reset = module.ResetSettings(data['reset-settings'], 'reset-settings', settings)
        assert settings.get_value('font-scale') == 225, 'creating button reset settings'
        reset.content_widget.clicked()
        pump()
        saved = json.loads(path.read_text())
        for key, properties in saved.items():
            if 'default' in properties:
                assert properties['value'] == properties['default'], key
        assert rows['font-scale'].content_widget.get_value() == 200
        assert settings.get_value('event-refresh') == 5
        print('PASS reset button restores defaults and updates visible controls in temporary settings only')
    finally:
        settings.pause_monitor()
        window.destroy()
