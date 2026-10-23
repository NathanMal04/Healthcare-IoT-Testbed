# This code is generated using PyUIbuilder: https://pyuibuilder.com
# Manually adapted: resizable grid layout, working images, expanded menus.

import os
import fcntl
import pty
import sys
import termios
import tkinter as tk
import tkinter.font as tkfont
from tkinter import ttk, messagebox, filedialog, scrolledtext
from PIL import Image, ImageTk

import ctypes
import shutil
import signal
import subprocess
import threading
import time
import queue

from tools import (
    CATEGORIES,
    get_tool,
    is_category_header,
    parse_extra_args,
    recommended_tools,
    tool_dropdown_values,
    tools_in_category,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
IMG_DIR = os.path.join(BASE_DIR, "assets", "images")

# Dark palette
COLORS = {
    "bg": "#1e1e1e",
    "bg_raised": "#252526",
    "bg_sidebar": "#2d2d30",
    "bg_input": "#3c3c3c",
    "fg": "#cccccc",
    "fg_muted": "#9d9d9d",
    "accent": "#5a9f68",
    "accent_active": "#4a8a58",
    "danger": "#770000",
    "danger_active": "#990000",
    "border": "#3e3e42",
    "menu_active_bg": "#094771",
}

# ANSI / xterm-ish palette used when rendering pwndbg-style colored output
_ANSI_BASIC = [
    "#000000", "#cd3131", "#0dbc79", "#e5e510",
    "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
]
_ANSI_BRIGHT = [
    "#666666", "#f14c4c", "#23d18b", "#f5f543",
    "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
]


def _console_font(size=11):
    """Prefer a monospace font with solid Unicode/box-drawing coverage."""
    preferred = (
        "DejaVu Sans Mono",
        "Noto Sans Mono",
        "FreeMono",
        "Liberation Mono",
        "Consolas",
        "Courier New",
        "TkFixedFont",
    )
    available = set(tkfont.families())
    for name in preferred:
        if name in available:
            return (name, size)
    return ("TkFixedFont", size)


class AnsiConsole:
    """Apply a subset of ANSI SGR codes to a Tk Text widget; strip the rest.

    Uses a byte state machine (not regex) so CSI sequences split across PTY
    reads — e.g. b'\\x1b[' then b'31m' — are buffered instead of being eaten
    by a catch-all ESC matcher (which previously leaked literal '31m'/'0m').
    """

    def __init__(self, text: tk.Text):
        self.text = text
        self._fg = None
        self._bg = None
        self._bold = False
        self._carry = b""
        self._ensure_base_tags()

    def _ensure_base_tags(self):
        self.text.tag_configure("ansi", font=_console_font())

    def reset_style(self):
        self._fg = None
        self._bg = None
        self._bold = False

    def clear(self):
        self.reset_style()
        self._carry = b""
        self.text.delete("1.0", "end")

    def write(self, data: bytes | str):
        if isinstance(data, str):
            data = data.encode("utf-8", errors="replace")
        data = self._carry + data
        self._carry = b""
        i = 0
        n = len(data)
        while i < n:
            b = data[i]
            if b == 0x1B:
                if i + 1 >= n:
                    self._carry = data[i:]
                    return
                nxt = data[i + 1]
                if nxt == 0x5B:  # CSI: ESC [
                    j = i + 2
                    while j < n and 0x20 <= data[j] <= 0x3F:
                        j += 1  # parameter / intermediate bytes
                    if j >= n:
                        self._carry = data[i:]
                        return
                    if 0x40 <= data[j] <= 0x7E:
                        self._csi(data[i : j + 1])
                        i = j + 1
                    else:
                        i += 1  # malformed; skip ESC
                    continue
                if nxt == 0x5D:  # OSC: ESC ] ... BEL or ST
                    j = i + 2
                    while j < n:
                        if data[j] == 0x07:
                            j += 1
                            break
                        if data[j] == 0x1B and j + 1 < n and data[j + 1] == 0x5C:
                            j += 2
                            break
                        j += 1
                    else:
                        self._carry = data[i:]
                        return
                    i = j
                    continue
                # Other 2-byte ESC sequences (charset selects, etc.) — drop
                i += 2
                continue
            if b == 0x0D:
                if i + 1 < n and data[i + 1] == 0x0A:
                    self._insert("\n")
                    i += 2
                else:
                    self.text.mark_set("insert", "insert linestart")
                    self.text.delete("insert", "insert lineend")
                    i += 1
                continue
            if b == 0x0A:
                self._insert("\n")
                i += 1
                continue
            # Plain text run
            j = i + 1
            while j < n and data[j] not in (0x1B, 0x0D, 0x0A):
                j += 1
            chunk = data[i:j]
            if j == n:
                chunk, hold = self._split_incomplete_utf8(chunk)
                self._carry = hold
                self._insert(chunk.decode("utf-8", errors="replace"))
                return
            self._insert(chunk.decode("utf-8", errors="replace"))
            i = j

    @staticmethod
    def _split_incomplete_utf8(data: bytes) -> tuple[bytes, bytes]:
        if not data:
            return b"", b""
        # Hold back a trailing partial UTF-8 code unit
        for size in range(1, min(4, len(data)) + 1):
            lead = data[-size]
            if lead & 0x80 == 0:
                break
            if lead & 0xE0 == 0xC0 and size < 2:
                return data[:-size], data[-size:]
            if lead & 0xF0 == 0xE0 and size < 3:
                return data[:-size], data[-size:]
            if lead & 0xF8 == 0xF0 and size < 4:
                return data[:-size], data[-size:]
        return data, b""

    def _csi(self, seq: bytes):
        try:
            body = seq[2:-1].decode("ascii", errors="ignore")
            final = chr(seq[-1])
        except Exception:
            return
        # Strip intermediate bytes from body for SGR (keep digits/;/? only)
        if final == "m":
            cleaned = "".join(ch for ch in body if ch.isdigit() or ch in ";?")
            self._sgr(cleaned)
        elif final == "J":
            code = "".join(ch for ch in body if ch.isdigit()) or "0"
            if code in ("2", "3"):
                self.text.delete("1.0", "end")
                self.text.mark_set("insert", "end")
        elif final == "K":
            self.text.delete("insert", "insert lineend")
        # ignore cursor movement and other CSI

    def _sgr(self, body: str):
        params = [int(p) if p else 0 for p in body.split(";")] if body else [0]
        i = 0
        while i < len(params):
            p = params[i]
            if p == 0:
                self.reset_style()
            elif p == 1:
                self._bold = True
            elif p == 22:
                self._bold = False
            elif p == 39:
                self._fg = None
            elif p == 49:
                self._bg = None
            elif 30 <= p <= 37:
                self._fg = _ANSI_BASIC[p - 30]
            elif 90 <= p <= 97:
                self._fg = _ANSI_BRIGHT[p - 90]
            elif 40 <= p <= 47:
                self._bg = _ANSI_BASIC[p - 40]
            elif 100 <= p <= 107:
                self._bg = _ANSI_BRIGHT[p - 100]
            elif p == 38 and i + 1 < len(params):
                i += 1
                mode = params[i]
                if mode == 5 and i + 1 < len(params):
                    i += 1
                    self._fg = self._xterm256(params[i])
                elif mode == 2 and i + 3 < len(params):
                    r, g, b = params[i + 1], params[i + 2], params[i + 3]
                    i += 3
                    self._fg = f"#{max(0, min(255, r)):02x}{max(0, min(255, g)):02x}{max(0, min(255, b)):02x}"
            elif p == 48 and i + 1 < len(params):
                i += 1
                mode = params[i]
                if mode == 5 and i + 1 < len(params):
                    i += 1
                    self._bg = self._xterm256(params[i])
                elif mode == 2 and i + 3 < len(params):
                    r, g, b = params[i + 1], params[i + 2], params[i + 3]
                    i += 3
                    self._bg = f"#{max(0, min(255, r)):02x}{max(0, min(255, g)):02x}{max(0, min(255, b)):02x}"
            i += 1

    @staticmethod
    def _xterm256(n: int) -> str:
        n = max(0, min(255, n))
        if n < 16:
            return (_ANSI_BASIC + _ANSI_BRIGHT)[n]
        if n < 232:
            levels = [0, 95, 135, 175, 215, 255]
            n -= 16
            return f"#{levels[n // 36]:02x}{levels[(n // 6) % 6]:02x}{levels[n % 6]:02x}"
        grey = 8 + (n - 232) * 10
        return f"#{grey:02x}{grey:02x}{grey:02x}"

    def _tag_for_current(self) -> str:
        if not self._fg and not self._bg and not self._bold:
            return ""
        key = f"fg={self._fg}|bg={self._bg}|b={int(self._bold)}"
        if key not in self.text.tag_names():
            opts = {}
            if self._fg:
                opts["foreground"] = self._fg
            if self._bg:
                opts["background"] = self._bg
            if self._bold:
                opts["font"] = (_console_font()[0], 11, "bold")
            self.text.tag_configure(key, **opts)
        return key

    def _insert(self, s: str):
        if not s:
            return
        tag = self._tag_for_current()
        if tag:
            self.text.insert("insert", s, (tag,))
        else:
            self.text.insert("insert", s)
        self.text.see("end")


class _HostX:
    """Reparents a Xephyr window into the tooling pane and keeps its screen in sync."""

    def __init__(self):
        lib = ctypes.CDLL("libX11.so.6")
        lib.XOpenDisplay.restype = ctypes.c_void_p
        lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
        lib.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.XReparentWindow.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int
        ]
        lib.XMoveResizeWindow.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint
        ]
        lib.XMapWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        lib.XUnmapWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        self._lib = lib

    def reparent(self, child, parent, width, height):
        lib = self._lib
        display = lib.XOpenDisplay(None)
        if not display:
            raise OSError("Could not open the host display")
        try:
            lib.XUnmapWindow(display, child)
            lib.XReparentWindow(display, child, parent, 0, 0)
            lib.XMoveResizeWindow(display, child, 0, 0, width, height)
            lib.XMapWindow(display, child)
            lib.XSync(display, False)
        finally:
            lib.XCloseDisplay(display)

    def resize(self, child, width, height):
        lib = self._lib
        display = lib.XOpenDisplay(None)
        if not display:
            return
        try:
            lib.XMoveResizeWindow(display, child, 0, 0, width, height)
            lib.XSync(display, False)
        finally:
            lib.XCloseDisplay(display)

_hostx = _HostX()

class ToolRunner:
    """CLI tools use the console. GUI tools run on a nested X screen parented to the viewport."""

    def __init__(self, parent):
        self.proc = None
        self.output_q = queue.Queue()
        self._poll_job = None
        self._xephyr = None
        self._gui_procs = []
        self._gui_groups = []
        self._gui_display = None
        self._xephyr_win = None
        self._fit_job = None
        self._starting = False
        self._pty_master = None

        self.viewport = tk.Frame(parent, bg=COLORS["bg"], highlightthickness=0)
        self.viewport.bind("<Configure>", self._on_viewport_configure)

        self.console = scrolledtext.ScrolledText(
            parent,
            height=20,
            state="disabled",
            bg=COLORS["bg"],
            fg="#d4d4d4",
            insertbackground=COLORS["fg"],
            selectbackground=COLORS["menu_active_bg"],
            font=_console_font(),
            borderwidth=0,
            highlightthickness=0,
        )
        self.console.pack(fill="both", expand=True, padx=6, pady=6)
        self.ansi = AnsiConsole(self.console)

        self.input_var = tk.StringVar()
        self.input_entry = ttk.Entry(parent, textvariable=self.input_var)
        self.input_entry.pack(fill="x", padx=6, pady=(0, 6))
        self.input_entry.bind("<Return>", self.send_input)
        # Ctrl+C -> PTY VINTR (\x03) so gdb/pwndbg interrupt the inferior
        for widget in (self.input_entry, self.console, parent):
            widget.bind("<Control-c>", self.send_interrupt)
            widget.bind("<Control-C>", self.send_interrupt)

    def start_tool(self, cmd: list[str], gui: bool = False):
        """cmd example: ["tshark", "-i", "eth0", "-l"]  ( -l = line buffered)"""
        if self._busy():
            messagebox.showwarning("Already running", "Stop the current tool first", parent=self._window())
            return
        if gui:
            self._start_gui(cmd)
        else:
            self._start_cli(cmd)

    def _cli_env(self):
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env.setdefault("LANG", "C.UTF-8")
        env.setdefault("LC_ALL", "C.UTF-8")
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        # Size hint for tools that query the TTY (pwndbg context width, etc.)
        try:
            cols = max(80, self.console.winfo_width() // 8)
            rows = max(24, self.console.winfo_height() // 16)
        except tk.TclError:
            cols, rows = 120, 40
        env["COLUMNS"] = str(cols)
        env["LINES"] = str(rows)
        return env

    def _start_cli(self, cmd: list[str]):
        self._show_console()
        self._drain_queue()
        self._close_pty()
        self.console.configure(state="normal")
        self.ansi.clear()
        self.console.mark_set("insert", "end")
        self.console.configure(state="disabled")

        env = self._cli_env()
        # PTY so pwndbg/gdb detect a real terminal (colors, Unicode, line editing).
        # Child must make the slave its controlling TTY; otherwise Ctrl+C is just
        # another byte and never becomes SIGINT for gdb's process group.
        master, slave = pty.openpty()

        def _child_setup():
            os.setsid()
            try:
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            except OSError:
                try:
                    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
                except OSError:
                    pass
            try:
                os.tcsetpgrp(0, os.getpid())
            except OSError:
                pass

        try:
            self.proc = subprocess.Popen(
                cmd,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                env=env,
                close_fds=True,
                preexec_fn=_child_setup,
            )
        except OSError as exc:
            os.close(master)
            os.close(slave)
            self._safe_error("Tool error", f"Could not start process:\n{exc}")
            return
        os.close(slave)

        self._pty_master = master
        threading.Thread(target=self._reader_pty, daemon=True).start()
        self._poll_output()

    def _start_gui(self, cmd: list[str]):
        self._starting = True
        try:
            self._start_gui_session(cmd)
        finally:
            self._starting = False

    def _start_gui_session(self, cmd: list[str]):
        if not shutil.which("Xephyr"):
            self._safe_error(
                "GUI tool",
                "Xephyr is required to keep GUI tools inside this window.\n"
                "Install it with: sudo apt-get install xserver-xephyr",
            )
            return

        self._show_viewport()
        width, height = self.viewport.winfo_width(), self.viewport.winfo_height()
        if width < 50 or height < 50:
            self._show_console()
            self._safe_error("GUI tool", "The tooling pane is not visible yet.")
            return

        display = self._free_display()
        if display is None:
            self._show_console()
            self._safe_error("GUI tool", "No free X display for the embedded session.")
            return

        stderr_lines = []
        try:
            self._xephyr = subprocess.Popen(
                [
                    "Xephyr",
                    "-ac",
                    "-br",
                    "-noreset",
                    "-resizeable",
                    "-no-host-grab",
                    # No +X+Y here. Xephyr reapplies that offset on every resize,
                    # which would slide the screen out of the viewport.
                    "-screen", f"{width}x{height}",
                    display,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
        except OSError as exc:
            self._show_console()
            self._safe_error("GUI tool", f"Could not start Xephyr: {exc}")
            return

        threading.Thread(target=self._drain, args=(self._xephyr.stderr, stderr_lines), daemon=True).start()
        self._remember(self._xephyr)

        if not self._wait_for_display(display, self._xephyr):
            detail = "".join(stderr_lines).strip() or "Xephyr exited before the embedded display was ready."
            self._stop_gui()
            self._safe_error("GUI tool", detail)
            return

        xephyr_win = self._wait_for_xephyr_window(display, self._xephyr)
        if xephyr_win is None:
            self._stop_gui()
            self._safe_error(
                "GUI tool",
                "Could not find the Xephyr window to embed.\n"
                "xwininfo is required (package x11-utils).",
            )
            return

        width, height = self.viewport.winfo_width(), self.viewport.winfo_height()
        try:
            _hostx.reparent(xephyr_win, self.viewport.winfo_id(), width, height)
        except OSError as exc:
            self._stop_gui()
            self._safe_error("GUI tool", f"Could not embed the tool window: {exc}")
            return
        self._xephyr_win = xephyr_win

        self._gui_display = display
        env = self._nested_env(display)

        wm = shutil.which("matchbox-window-manager")
        if wm:
            self._remember(subprocess.Popen(
                [wm, "-use_dialog_mode", "free"],
                env=env,
                start_new_session=True,
            ))
            time.sleep(0.2)
        else:
            messagebox.showwarning(
                "GUI tool",
                "matchbox-window-manager is not installed, so dialogs may not be arranged inside the frame.\n"
                "Install it with: sudo apt-get install matchbox-window-manager",
            )

        try:
            self._remember(subprocess.Popen(cmd, env=env, start_new_session=True))
        except OSError as exc:
            self._stop_gui()
            self._safe_error("GUI tool", f"Could not start the tool: {exc}")

    def _reader_pty(self):
        master = self._pty_master
        while master is not None:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            self.output_q.put(chunk)
        self.output_q.put(None)

    def _poll_output(self):
        try:
            while True:
                chunk = self.output_q.get_nowait()
                if chunk is None:
                    self._on_process_ended()
                    return
                self.console.configure(state="normal")
                self.ansi.write(chunk)
                self.console.configure(state="disabled")
        except queue.Empty:
            pass
        self._poll_job = self.console.after(50, self._poll_output)

    def send_input(self, event=None):
        text = self.input_var.get() + "\n"
        data = text.encode("utf-8", errors="replace")
        if self._pty_master is not None:
            try:
                os.write(self._pty_master, data)
            except OSError:
                pass
            self.input_var.set("")
            return
        if self.proc and self.proc.poll() is None and self.proc.stdin:
            try:
                self.proc.stdin.write(text)
                self.proc.stdin.flush()
            except (BrokenPipeError, OSError):
                pass
            self.input_var.set("")

    def send_interrupt(self, event=None):
        """Interrupt the CLI session the way a real terminal does (SIGINT + VINTR)."""
        if not self.proc or self.proc.poll() is not None:
            return None  # no running CLI tool — allow normal copy binding

        # Primary: signal gdb/pwndbg's process group (interrupts a running inferior)
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGINT)
        except OSError:
            try:
                self.proc.send_signal(signal.SIGINT)
            except OSError:
                pass

        # Also inject VINTR on the PTY (works once the slave is the controlling TTY)
        if self._pty_master is not None:
            try:
                os.write(self._pty_master, b"\x03")
            except OSError:
                pass
        return "break"  # stop Tk from treating this as Copy

    def stop_tool(self):
        self._cancel_poll()
        if self.proc and self.proc.poll() is None:
            self._terminate(self.proc)
        self.proc = None
        self._close_pty()
        self._stop_gui()

    def _close_pty(self):
        master = self._pty_master
        self._pty_master = None
        if master is not None:
            try:
                os.close(master)
            except OSError:
                pass

    def _on_process_ended(self):
        self._poll_job = None
        self._close_pty()
        self.console.configure(state="normal")
        self.console.mark_set("insert", "end")
        self.ansi.reset_style()
        self.ansi.write(b"\n--- process ended ---\n")
        self.console.configure(state="disabled")
        self.proc = None

    def _busy(self):
        if self._starting:
            return True
        if self.proc and self.proc.poll() is None:
            return True
        if self._xephyr and self._xephyr.poll() is None:
            return True
        if self._xephyr is not None:
            self._stop_gui()
        return False

    def _show_console(self):
        self.viewport.pack_forget()
        if not self.console.winfo_ismapped():
            self.console.pack(fill="both", expand=True, padx=6, pady=6)
        if not self.input_entry.winfo_ismapped():
            self.input_entry.pack(fill="x", padx=6, pady=(0, 6))

    def _show_viewport(self):
        self.console.pack_forget()
        self.input_entry.pack_forget()
        if not self.viewport.winfo_ismapped():
            self.viewport.pack(fill="both", expand=True, padx=6, pady=6)
        self.viewport.update_idletasks()
        self._window().update()

    def _window(self):
        return self.viewport.winfo_toplevel()

    def _safe_error(self, title, message):
        """showerror that doesn't blow up if the app was closed meanwhile."""
        try:
            win = self._window()
            if win.winfo_exists():
                messagebox.showerror(title, message, parent=win)
        except tk.TclError:
            pass

    def _free_display(self):
        for number in range(2, 64):
            socket_path = f"/tmp/.X11-unix/X{number}"
            lock_path = f"/tmp/.X{number}-lock"
            if os.path.exists(socket_path):
                continue
            if os.path.exists(lock_path):
                try:
                    os.remove(lock_path)
                except OSError:
                    continue
            return f":{number}"
        return None

    def _wait_for_display(self, display, proc, timeout=5.0):
        socket_path = f"/tmp/.X11-unix/X{display[1:]}"
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                return False
            if os.path.exists(socket_path):
                return True
            time.sleep(0.05)
        return False

    def _wait_for_xephyr_window(self, display, proc, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                return None
            window = self._find_xephyr_window(display)
            if window is not None:
                return window
            time.sleep(0.05)
        return None

    def _find_xephyr_window(self, display):
        if not shutil.which("xwininfo"):
            return None
        needle = f"Xephyr on {display}."
        result = subprocess.run(["xwininfo", "-root", "-tree"], capture_output=True, text=True)
        for line in result.stdout.splitlines():
            if needle not in line:
                continue
            token = line.strip().split()[0]
            try:
                return int(token, 16)
            except ValueError:
                return None
        return None

    def _on_viewport_configure(self, event):
        if self._xephyr_win is None or event.widget is not self.viewport:
            return
        if event.width < 50 or event.height < 50:
            return
        if self._fit_job is not None:
            self.viewport.after_cancel(self._fit_job)
        width, height = event.width, event.height
        self._fit_job = self.viewport.after(80, lambda: self._fit_xephyr(width, height))

    def _fit_xephyr(self, width, height):
        self._fit_job = None
        window = self._xephyr_win
        if window is None or width < 50 or height < 50:
            return
        if self._xephyr is None or self._xephyr.poll() is not None:
            return
        _hostx.resize(window, width, height)

    def _nested_env(self, display):
        env = os.environ.copy()
        env["DISPLAY"] = display
        env.pop("WAYLAND_DISPLAY", None)
        env["QT_QPA_PLATFORM"] = "xcb"
        env["GDK_BACKEND"] = "x11"
        env["SDL_VIDEODRIVER"] = "x11"
        return env

    def _remember(self, proc):
        self._gui_procs.append(proc)
        try:
            group = os.getpgid(proc.pid)
        except OSError:
            return
        if group != os.getpgrp():
            self._gui_groups.append(group)

    def _stop_gui(self):
        display = self._gui_display
        groups = self._gui_groups
        procs = self._gui_procs
        self._gui_display = None
        self._gui_groups = []
        self._gui_procs = []
        self._xephyr = None
        self._xephyr_win = None
        if self._fit_job is not None:
            self.viewport.after_cancel(self._fit_job)
            self._fit_job = None

        if display:
            self._signal_pids(self._pids_on_display(display), signal.SIGTERM)
        for group in groups:
            self._signal_group(group, signal.SIGTERM)
        for proc in procs:
            if proc.poll() is None:
                proc.terminate()

        if display or procs:
            time.sleep(0.3)

        if display:
            self._signal_pids(self._pids_on_display(display), signal.SIGKILL)
        for group in groups:
            self._signal_group(group, signal.SIGKILL)
        for proc in procs:
            if proc.poll() is None:
                proc.kill()

        self._show_console()

    def _pids_on_display(self, display):
        want = f"DISPLAY={display}".encode()
        me = os.getpid()
        found = []
        for name in os.listdir("/proc"):
            if not name.isdigit():
                continue
            pid = int(name)
            if pid == me:
                continue
            try:
                raw = open(f"/proc/{pid}/environ", "rb").read()
            except OSError:
                continue
            if want in raw.split(b"\0"):
                found.append(pid)
        return found

    def _signal_pids(self, pids, sig):
        for pid in pids:
            try:
                os.kill(pid, sig)
            except OSError:
                pass

    def _signal_group(self, group, sig):
        if group == os.getpgrp():
            return
        try:
            os.killpg(group, sig)
        except OSError:
            pass

    def _terminate(self, proc):
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()

    def _cancel_poll(self):
        if self._poll_job is not None:
            self.console.after_cancel(self._poll_job)
            self._poll_job = None

    def _drain_queue(self):
        try:
            while True:
                self.output_q.get_nowait()
        except queue.Empty:
            pass

    @staticmethod
    def _drain(pipe, bucket):
        for line in iter(pipe.readline, ""):
            bucket.append(line)
            del bucket[:-30]


def apply_dark_window_frame(window: tk.Tk) -> None:
    """Best-effort dark title/frame: Windows DWM immersive dark mode, or GTK variant on Linux."""
    window.update_idletasks()
    try:
        if sys.platform == "win32":
            hwnd = ctypes.windll.user32.GetParent(window.winfo_id())
            # DWMWA_USE_IMMERSIVE_DARK_MODE = 20 (Win10 1903+); also try 19 on older builds
            value = ctypes.c_int(1)
            for attr in (20, 19):
                ctypes.windll.dwmapi.DwmSetWindowAttribute(
                    hwnd, attr, ctypes.byref(value), ctypes.sizeof(value)
                )
        elif sys.platform.startswith("linux"):
            # Mutter / some WMs honor _GTK_THEME_VARIANT on the frame
            if shutil.which("xprop"):
                wid = hex(window.winfo_id())
                subprocess.run(
                    [
                        "xprop", "-id", wid,
                        "-f", "_GTK_THEME_VARIANT", "8u",
                        "-set", "_GTK_THEME_VARIANT", "dark",
                    ],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
    except Exception as exc:
        print(f"Could not set dark window frame: {exc}")


def apply_dark_ttk_theme(root: tk.Tk) -> ttk.Style:
    style = ttk.Style(root)
    if "clam" in style.theme_names():
        style.theme_use("clam")

    style.configure(".", background=COLORS["bg"], foreground=COLORS["fg"], fieldbackground=COLORS["bg_input"])
    style.configure("TFrame", background=COLORS["bg"])
    style.configure("TLabel", background=COLORS["bg_sidebar"], foreground=COLORS["fg"])
    style.configure(
        "TCombobox",
        fieldbackground=COLORS["bg_input"],
        background=COLORS["bg_input"],
        foreground=COLORS["fg"],
        arrowcolor=COLORS["fg"],
        bordercolor=COLORS["border"],
        lightcolor=COLORS["border"],
        darkcolor=COLORS["border"],
    )
    style.map(
        "TCombobox",
        fieldbackground=[("readonly", COLORS["bg_input"])],
        foreground=[("readonly", COLORS["fg"])],
        selectbackground=[("readonly", COLORS["menu_active_bg"])],
        selectforeground=[("readonly", "#ffffff")],
        background=[("readonly", COLORS["bg_input"]), ("active", COLORS["bg_input"])],
        arrowcolor=[("readonly", COLORS["fg"]), ("disabled", COLORS["fg_muted"])],
    )
    # Dropdown list (popdown Listbox) — not covered by ttk.Style alone
    root.option_add("*TCombobox*Listbox.background", COLORS["bg_input"])
    root.option_add("*TCombobox*Listbox.foreground", COLORS["fg"])
    root.option_add("*TCombobox*Listbox.selectBackground", COLORS["menu_active_bg"])
    root.option_add("*TCombobox*Listbox.selectForeground", "#ffffff")
    root.option_add("*TCombobox*Listbox.font", "Arial 12")
    root.option_add("*TCombobox*Listbox.borderWidth", 0)
    style.configure(
        "TEntry",
        fieldbackground=COLORS["bg_input"],
        foreground=COLORS["fg"],
        insertcolor=COLORS["fg"],
        bordercolor=COLORS["border"],
    )
    style.configure(
        "TButton",
        background=COLORS["bg_raised"],
        foreground=COLORS["fg"],
        bordercolor=COLORS["border"],
        focusthickness=0,
    )
    style.map("TButton", background=[("active", COLORS["border"])], foreground=[("active", "#ffffff")])
    return style


class FitImageLabel(tk.Label):
    """A Label that keeps an image scaled to fit its current size, aspect-ratio preserved.
    Simpler/more reliable replacement for pyuiWidgets.ImageLabel, which has a resize-timing bug."""

    def __init__(self, master, image_path, bg=None, **kwargs):
        super().__init__(master, bg=bg or COLORS["bg_sidebar"], **kwargs)
        self._original = Image.open(image_path)
        self._photo = None
        self._resize_job = None
        self.bind("<Configure>", self._on_resize)

    def _on_resize(self, event):
        if self._resize_job:
            self.after_cancel(self._resize_job)
        self._resize_job = self.after(40, lambda: self._render(event.width, event.height))

    def _render(self, width, height):
        if width < 5 or height < 5:
            return
        img_w, img_h = self._original.size
        scale = min(width / img_w, height / img_h)
        new_w = max(1, int(img_w * scale))
        new_h = max(1, int(img_h * scale))
        resized = self._original.resize((new_w, new_h), Image.LANCZOS)
        self._photo = ImageTk.PhotoImage(resized)
        self.config(image=self._photo)

local_gui = tk.Tk()
local_gui.title("Healthcare IoT Cyber Testbed")
local_gui.config(bg=COLORS["bg"])

# --- Window sizing / resizing ---------------------------------------------
local_gui.geometry("1920x1025")
local_gui.minsize(1100, 650)
local_gui.resizable(True, True)

local_gui.update_idletasks()
screen_w = local_gui.winfo_screenwidth()
screen_h = local_gui.winfo_screenheight()
win_w = min(1920, screen_w)
win_h = min(1025, screen_h)
geometryX = max(0, (screen_w - win_w) // 2)
geometryY = max(0, (screen_h - win_h) // 2)
local_gui.geometry("%dx%d+%d+%d" % (win_w, win_h, geometryX, geometryY))

try:
    icon_image = Image.open(os.path.join(IMG_DIR, "panther_icon.png"))
    icon_photo = ImageTk.PhotoImage(icon_image)
    local_gui.iconphoto(True, icon_photo)
except Exception as e:
    print(f"Could not set window icon: {e}")

style = apply_dark_ttk_theme(local_gui)
apply_dark_window_frame(local_gui)

# ============================================================================
# Menu bar
# ============================================================================
_menu_kwargs = dict(
    bg=COLORS["bg_raised"],
    fg=COLORS["fg"],
    activebackground=COLORS["menu_active_bg"],
    activeforeground="#ffffff",
    tearoff=0,
    bd=0,
)
menu = tk.Menu(local_gui, **_menu_kwargs)
local_gui.config(menu=menu)

menu_file = tk.Menu(menu, **_menu_kwargs)
menu_file.add_command(label="New Test Session", command=lambda: print("New clicked"))
menu_file.add_command(label="Open Config...", command=lambda: print("Open clicked"))
menu_file.add_command(label="Save Log...", command=lambda: print("Save Log clicked"))
menu_file.add_separator()
menu_file.add_command(label="Exit", command=local_gui.quit)
menu.add_cascade(label="File", menu=menu_file)

menu_edit = tk.Menu(menu, **_menu_kwargs)
menu_edit.add_command(label="Preferences...", command=lambda: print("Preferences clicked"))
menu_edit.add_command(label="Clear Console", command=lambda: print("Clear Console clicked"))
menu_edit.add_separator()
menu_edit.add_command(label="Copy Log", command=lambda: print("Copy Log clicked"))
menu.add_cascade(label="Edit", menu=menu_edit)

menu_tools = tk.Menu(menu, **_menu_kwargs)
menu.add_cascade(label="Tools", menu=menu_tools)

menu_help = tk.Menu(menu, **_menu_kwargs)
menu_help.add_command(label="Documentation", command=lambda: print("Documentation clicked"))
menu_help.add_command(
    label="About",
    command=lambda: messagebox.showinfo(
        "About",
        "Healthcare IoT Cyber Testbed\nBy: Justin Bower, Nathan Maloney, Ipule Pipi & Jordan Chesley",
    ),
)
menu.add_cascade(label="Help", menu=menu_help)

# ============================================================================
# Root layout: two columns -> main canvas (expands) | sidebar (fixed-ish)
# ============================================================================
local_gui.columnconfigure(0, weight=1)
local_gui.columnconfigure(1, weight=0, minsize=300)
local_gui.rowconfigure(0, weight=1)

tooling = tk.Frame(master=local_gui, bg=COLORS["bg"])
tooling.grid(row=0, column=0, sticky="nsew", padx=(6, 6), pady=12)

sidebar = tk.Frame(master=local_gui, bg=COLORS["bg_sidebar"])
sidebar.grid(row=0, column=1, sticky="nsew", padx=(0, 6), pady=12)
sidebar.columnconfigure(0, weight=1)
# Spacer row pushes Start/Stop to the bottom
sidebar.rowconfigure(8, weight=1)

# --- Sidebar controls (logo → credits → file → tool → launch → args) --------

# FIT wordmark logo
logo_frame = tk.Frame(sidebar, bg=COLORS["bg_raised"], height=140)
logo_frame.grid(row=0, column=0, sticky="ew", padx=10, pady=(0, 10))
logo_frame.grid_propagate(False)
logo_frame.columnconfigure(0, weight=1)
logo_frame.rowconfigure(0, weight=1)

_fit_logo = FitImageLabel(
    master=logo_frame,
    image_path=os.path.join(IMG_DIR, "1-hrpreview.png"),
    bg=COLORS["bg_raised"],
)
_fit_logo.grid(row=0, column=0, sticky="nsew")

style.configure(
    "_student_names.TLabel",
    background=COLORS["bg_sidebar"],
    foreground=COLORS["fg_muted"],
    anchor="center",
)
_student_names = ttk.Label(
    sidebar,
    text="By: Justin Bower, Nathan Maloney, Ipule Pipi & Jordan Chesley",
    style="_student_names.TLabel",
    wraplength=260,
    justify="center",
)
_student_names.grid(row=1, column=0, sticky="ew", padx=10, pady=(0, 14), ipady=6)

# Selected input file (opened by the chosen tool)
selected_file_var = tk.StringVar(value="")
selected_file_label_var = tk.StringVar(value="No file selected")

style.configure(
    "file_btn.TButton",
    background=COLORS["bg_input"],
    foreground=COLORS["fg"],
    relief=tk.FLAT,
    font=("Arial", 12, "bold"),
    cursor="arrow",
)
style.map(
    "file_btn.TButton",
    background=[("active", COLORS["border"])],
    foreground=[("active", "#ffffff")],
)
style.configure(
    "clear_file_btn.TButton",
    background=COLORS["bg_input"],
    foreground=COLORS["fg"],
    relief=tk.FLAT,
    font=("Arial", 12, "bold"),
    cursor="arrow",
)
style.map(
    "clear_file_btn.TButton",
    background=[("active", COLORS["border"]), ("disabled", COLORS["bg_raised"])],
    foreground=[("active", "#ffffff"), ("disabled", COLORS["fg_muted"])],
)


def _enlarge_open_dialogs(width=960, height=640):
    """Tk's open dialog is a transient Toplevel; grow it once it appears."""
    for widget in local_gui.winfo_children():
        if not isinstance(widget, tk.Toplevel):
            continue
        try:
            widget.minsize(720, 480)
            widget.geometry(f"{width}x{height}")
        except tk.TclError:
            pass


def _set_selected_file(path: str):
    selected_file_var.set(path)
    if path:
        display = path if len(path) <= 42 else "…" + path[-41:]
        selected_file_label_var.set(display)
        clear_file_btn.state(["!disabled"])
    else:
        selected_file_label_var.set("No file selected")
        clear_file_btn.state(["disabled"])
    refresh_tool_picker()


def choose_file():
    # "*" matches extensionless names; "*.*" does not.
    # Avoid putting "*.elf" (or similar) first in a filter — some dialogs append
    # that extension to the chosen path when confirming.
    for delay in (30, 80, 160, 300):
        local_gui.after(delay, _enlarge_open_dialogs)

    path = filedialog.askopenfilename(
        parent=local_gui,
        title="Select a file for the tool",
        initialdir=BASE_DIR,
        filetypes=[
            ("All files", "*"),
            ("Binaries / ELF", "*.elf *.bin *.so"),
            ("Scripts", "*.py *.sh"),
            ("Captures", "*.pcap *.pcapng"),
        ],
        defaultextension="",
    )
    if not path:
        return
    # Strip a spuriously appended extension if the dialog still added one
    # for an otherwise matching on-disk name without that suffix.
    if not os.path.exists(path):
        root, ext = os.path.splitext(path)
        if ext and os.path.exists(root):
            path = root
    _set_selected_file(path)


def clear_file():
    _set_selected_file("")


file_row = tk.Frame(sidebar, bg=COLORS["bg_sidebar"])
file_row.grid(row=2, column=0, sticky="ew", padx=10, pady=(0, 4))
file_row.columnconfigure(0, weight=1)
file_row.columnconfigure(1, weight=0)

file_btn = ttk.Button(file_row, text="SELECT FILE…", style="file_btn.TButton", command=choose_file)
file_btn.grid(row=0, column=0, sticky="ew", padx=(0, 6), ipady=10)

clear_file_btn = ttk.Button(file_row, text="CLEAR", style="clear_file_btn.TButton", command=clear_file)
clear_file_btn.grid(row=0, column=1, sticky="ew", ipady=10)
clear_file_btn.state(["disabled"])

style.configure(
    "file_label.TLabel",
    background=COLORS["bg_sidebar"],
    foreground=COLORS["fg_muted"],
    font=("Arial", 10),
    anchor="w",
)
file_label = ttk.Label(sidebar, textvariable=selected_file_label_var, style="file_label.TLabel", wraplength=260)
file_label.grid(row=3, column=0, sticky="ew", padx=12, pady=(0, 10))

style.configure(
    "tool_select_.TCombobox",
    fieldbackground=COLORS["bg_input"],
    foreground=COLORS["fg"],
    font=("Arial", 14),
    cursor="arrow",
)
style.map(
    "tool_select_.TCombobox",
    fieldbackground=[("readonly", COLORS["bg_input"])],
    foreground=[("readonly", COLORS["fg"])],
    selectbackground=[("readonly", COLORS["menu_active_bg"])],
    selectforeground=[("readonly", "#ffffff")],
)
tool_select__var = tk.StringVar(value="TOOL SELECT")
tool_select_ = ttk.Combobox(
    sidebar,
    textvariable=tool_select__var,
    values=tool_dropdown_values(),
    style="tool_select_.TCombobox",
    state="readonly",
)
tool_select_.grid(row=4, column=0, sticky="ew", padx=10, pady=(0, 10), ipady=16)


def _style_combobox_listbox(combo: ttk.Combobox):
    """Force dark colors on the popdown list when it is created.

    The popdown is a Tcl-created widget, so Tkinter's nametowidget() can't
    resolve it (KeyError: 'popdown'). Configure it through Tcl directly.
    """
    try:
        popdown = str(combo.tk.call("ttk::combobox::PopdownWindow", str(combo)))
        combo.tk.call(
            f"{popdown}.f.l", "configure",
            "-background", COLORS["bg_input"],
            "-foreground", COLORS["fg"],
            "-selectbackground", COLORS["menu_active_bg"],
            "-selectforeground", "#ffffff",
            "-highlightthickness", 0,
            "-borderwidth", 0,
            "-font", ("Arial", 12),
        )
    except tk.TclError:
        pass


def refresh_tool_picker():
    """Rebuild tool dropdown + Tools menu; keep selection when still valid."""
    path = selected_file_var.get().strip() or None
    current = tool_select__var.get()
    values = tool_dropdown_values(path)
    tool_select_.configure(values=values)
    if current not in ("TOOL SELECT", "") and not is_category_header(current) and get_tool(current):
        tool_select__var.set(current)
    elif is_category_header(current):
        tool_select__var.set("TOOL SELECT")
    rebuild_tools_menu()


def on_tool_selected(_event=None):
    name = tool_select__var.get()
    if is_category_header(name):
        tool_select__var.set("TOOL SELECT")
        return
    _style_combobox_listbox(tool_select_)


def rebuild_tools_menu():
    menu_tools.delete(0, "end")
    path = selected_file_var.get().strip() or None
    # Mirror dropdown: Recommended (if any), then category cascades
    recommended = recommended_tools(path)
    if recommended:
        menu_rec = tk.Menu(menu_tools, **_menu_kwargs)
        for tool in recommended:
            menu_rec.add_command(
                label=tool.name,
                command=lambda t=tool.name: tool_select__var.set(t),
            )
        menu_tools.add_cascade(label="Recommended", menu=menu_rec)
        menu_tools.add_separator()

    for cat_id, cat_label in CATEGORIES:
        group = tools_in_category(cat_id)
        if not group:
            continue
        submenu = tk.Menu(menu_tools, **_menu_kwargs)
        for tool in group:
            submenu.add_command(
                label=tool.name,
                command=lambda t=tool.name: tool_select__var.set(t),
            )
        menu_tools.add_cascade(label=cat_label, menu=submenu)


tool_select_.bind("<<ComboboxSelected>>", on_tool_selected)
tool_select_.bind("<Button-1>", lambda _e: local_gui.after(10, lambda: _style_combobox_listbox(tool_select_)))

style.configure(
    "launch_options.TCombobox",
    fieldbackground=COLORS["bg_input"],
    foreground=COLORS["fg"],
    relief=tk.FLAT,
    font=("Arial", 14),
    cursor="arrow",
)
style.map(
    "launch_options.TCombobox",
    fieldbackground=[("readonly", COLORS["bg_input"])],
    foreground=[("readonly", COLORS["fg"])],
    selectbackground=[("readonly", COLORS["menu_active_bg"])],
    selectforeground=[("readonly", "#ffffff")],
)
launch_options_var = tk.StringVar(value="LAUNCH OPTIONS")
launch_options = ttk.Combobox(
    sidebar,
    textvariable=launch_options_var,
    values=["Local", "Remote", "Simulation"],
    style="launch_options.TCombobox",
    state="readonly",
)
launch_options.grid(row=5, column=0, sticky="ew", padx=10, pady=(0, 10), ipady=16)
launch_options.bind(
    "<Button-1>",
    lambda _e: local_gui.after(10, lambda: _style_combobox_listbox(launch_options)),
)

style.configure(
    "args_label.TLabel",
    background=COLORS["bg_sidebar"],
    foreground=COLORS["fg"],
    font=("Arial", 11),
    anchor="w",
)
args_label = ttk.Label(sidebar, text="Optional arguments", style="args_label.TLabel")
args_label.grid(row=6, column=0, sticky="ew", padx=12, pady=(0, 2))

extra_args_var = tk.StringVar(value="")
style.configure(
    "args_entry.TEntry",
    fieldbackground=COLORS["bg_input"],
    foreground=COLORS["fg"],
    insertcolor=COLORS["fg"],
    font=("Consolas", 11),
)
extra_args_entry = ttk.Entry(sidebar, textvariable=extra_args_var, style="args_entry.TEntry")
extra_args_entry.grid(row=7, column=0, sticky="ew", padx=10, pady=(0, 16), ipady=8)

style.configure(
    "button1.TButton",
    background=COLORS["accent"],
    foreground="#ffffff",
    relief=tk.FLAT,
    font=("Arial", 18, "bold"),
    cursor="arrow",
)
style.map(
    "button1.TButton",
    background=[("active", COLORS["accent_active"])],
    foreground=[("active", "#ffffff")],
)
button1 = ttk.Button(sidebar, text="START TEST", style="button1.TButton")
button1.grid(row=9, column=0, sticky="ew", padx=10, pady=(0, 10), ipady=22)

style.configure(
    "button.TButton",
    background=COLORS["danger"],
    foreground="#ffffff",
    relief=tk.FLAT,
    font=("Arial", 18, "bold"),
    cursor="arrow",
)
style.map(
    "button.TButton",
    background=[("active", COLORS["danger_active"])],
    foreground=[("active", "#ffffff")],
)
button = ttk.Button(sidebar, text="STOP APPLICATION", style="button.TButton")
button.grid(row=10, column=0, sticky="ew", padx=10, pady=(0, 10), ipady=22)

runner = ToolRunner(tooling)
rebuild_tools_menu()


def on_start():
    name = tool_select__var.get()
    if is_category_header(name):
        tool_select__var.set("TOOL SELECT")
        name = ""
    tool = get_tool(name)
    if tool is None:
        messagebox.showwarning(
            "Select a tool",
            "Choose a tool from the TOOL SELECT list first.",
            parent=local_gui,
        )
        return

    file_path = selected_file_var.get().strip() or None
    try:
        extra = parse_extra_args(extra_args_var.get())
    except ValueError as exc:
        messagebox.showerror("Invalid arguments", f"Could not parse optional arguments:\n{exc}", parent=local_gui)
        return

    try:
        cmd = tool.build(file_path, extra)
    except Exception as exc:
        messagebox.showerror("Tool error", f"Could not build command for {tool.name}:\n{exc}", parent=local_gui)
        return

    if not cmd:
        messagebox.showerror("Tool error", f"{tool.name} produced an empty command.", parent=local_gui)
        return

    runner.start_tool(cmd, gui=tool.gui)


button1.configure(command=on_start)
button.configure(command=runner.stop_tool)


def on_close():
    runner.stop_tool()
    local_gui.destroy()


local_gui.protocol("WM_DELETE_WINDOW", on_close)
menu_file.entryconfigure("Exit", command=on_close)

# Re-apply frame hint after map (some WMs only honor it once the window exists)
local_gui.after(200, lambda: apply_dark_window_frame(local_gui))

local_gui.mainloop()
