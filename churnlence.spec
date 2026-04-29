# PyInstaller spec — produces a single ChurnLence.exe on Windows.
# Build with:  pyinstaller churnlence.spec --noconfirm
#
# yfinance pulls in curl_cffi, frozendict, multitasking, peewee, etc; the
# collect_all() helper grabs each package's data files, binaries, and
# hidden imports automatically so we don't have to babysit the list.

from PyInstaller.utils.hooks import collect_all

datas = [
    ("templates", "templates"),
    ("static",    "static"),
]
binaries = []
hiddenimports = []

for pkg in ("yfinance", "curl_cffi", "frozendict", "multitasking",
            "peewee", "websockets", "platformdirs", "appdirs"):
    try:
        d, b, h = collect_all(pkg)
        datas        += d
        binaries     += b
        hiddenimports += h
    except Exception:
        # Optional deps that may not be present in every Python build.
        pass


block_cipher = None

a = Analysis(
    ["app.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "IPython", "notebook", "test", "unittest"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="ChurnLence",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,             # UPX shrinks size but trips antivirus heuristics; off.
    runtime_tmpdir=None,
    console=True,          # keep a console so users see logs + can Ctrl-C cleanly.
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # The Windows builder accepts .ico — we ship .png and let the
    # CI workflow convert it.  If the .ico isn't present the build
    # still works; PyInstaller just uses its default icon.
    icon="static/icon.ico" if __import__("os").path.exists("static/icon.ico") else None,
)
