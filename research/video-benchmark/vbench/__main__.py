import sys

from .cli import main

if __name__ == "__main__":
    # Windows consoles default to a legacy code page; Chinese output needs UTF-8.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
