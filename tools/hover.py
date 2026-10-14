#!/usr/bin/env python3
"""Move the pointer to absolute screen coordinates via XTEST, without clicking.

Used only during development to check hover behaviour, such as the event
tooltips. Usage: hover.py X Y
"""
import argparse
import time

from Xlib import display


def hover(x, y):
    d = display.Display()
    if not (0 <= x < d.screen().width_in_pixels and 0 <= y < d.screen().height_in_pixels):
        d.close()
        raise SystemExit("Coordinates must be inside the X screen")
    d.screen().root.warp_pointer(x, y)
    d.sync()
    time.sleep(0.2)
    d.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("x", type=int)
    parser.add_argument("y", type=int)
    args = parser.parse_args()
    hover(args.x, args.y)
