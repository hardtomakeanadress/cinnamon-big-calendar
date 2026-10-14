#!/usr/bin/env python3
"""Synthesise a mouse click at absolute screen coordinates via XTEST.

Used only during development to drive the settings dialog for screenshots.
Usage: click.py X Y
"""
import argparse
import time

from Xlib import X, display
from Xlib.ext import xtest


def click(x, y):
    d = display.Display()
    if not (0 <= x < d.screen().width_in_pixels and 0 <= y < d.screen().height_in_pixels):
        d.close()
        raise SystemExit("Coordinates must be inside the X screen")
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("x", type=int)
    parser.add_argument("y", type=int)
    args = parser.parse_args()
    click(args.x, args.y)
