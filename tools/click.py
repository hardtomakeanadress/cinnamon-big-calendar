#!/usr/bin/env python3
"""Synthesise a mouse click at absolute screen coordinates via XTEST.

Used only during development to drive the settings dialog for screenshots.
Usage: click.py X Y
"""
import sys
import time

from Xlib import X, display
from Xlib.ext import xtest


def click(x, y):
    d = display.Display()
    root = d.screen().root
    root.warp_pointer(x, y)
    d.sync()
    time.sleep(0.15)
    xtest.fake_input(d, X.ButtonPress, 1)
    d.sync()
    time.sleep(0.05)
    xtest.fake_input(d, X.ButtonRelease, 1)
    d.sync()
    time.sleep(0.2)
    d.close()


if __name__ == "__main__":
    click(int(sys.argv[1]), int(sys.argv[2]))
