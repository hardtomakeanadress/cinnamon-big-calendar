#!/usr/bin/env python3
"""Move the pointer to absolute screen coordinates via XTEST, without clicking.

Used only during development to check hover behaviour, such as the event
tooltips. Usage: hover.py X Y
"""
import sys
import time

from Xlib import display


def hover(x, y):
    d = display.Display()
    d.screen().root.warp_pointer(x, y)
    d.sync()
    time.sleep(0.2)
    d.close()


if __name__ == "__main__":
    hover(int(sys.argv[1]), int(sys.argv[2]))
