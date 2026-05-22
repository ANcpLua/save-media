# PyInstaller spec for savemedia-host.
#
# Build per-OS / per-arch by running this on the target machine (or via
# matrix CI):
#   pyinstaller build.spec --clean --noconfirm
#
# The output binary lands at dist/savemedia-host-<platform>-<arch>(.exe).

import platform
import sys

# Platform/arch suffix matches the installer's manifest path resolution.
PLAT = {
    "Darwin": "darwin",
    "Linux": "linux",
    "Windows": "windows",
}.get(platform.system(), platform.system().lower())

ARCH = {
    "arm64": "arm64",
    "aarch64": "arm64",
    "x86_64": "x64",
    "AMD64": "x64",
}.get(platform.machine(), platform.machine().lower())

EXE_NAME = f"savemedia-host-{PLAT}-{ARCH}"
EXE_SUFFIX = ".exe" if PLAT == "windows" else ""

block_cipher = None

a = Analysis(
    ["host.py"],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        "savemedia_host",
        "savemedia_host.protocol",
        "savemedia_host.schema",
        "savemedia_host.sink",
        "savemedia_host.ytdlp",
        "savemedia_host.probe",
        "savemedia_host.paths",
        "savemedia_host.logging_setup",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "pandas"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name=f"{EXE_NAME}{EXE_SUFFIX}",
    debug=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
