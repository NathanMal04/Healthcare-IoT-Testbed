# This code is generated using PyUIbuilder: https://pyuibuilder.com
# Manually adapted: resizable grid layout, working images, expanded menus.

import os
import tkinter as tk
from tkinter import ttk, messagebox
from PIL import Image, ImageTk
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
IMG_DIR = os.path.join(BASE_DIR, "assets", "images")


class FitImageLabel(tk.Label):
    """A Label that keeps an image scaled to fit its current size, aspect-ratio preserved.
    Simpler/more reliable replacement for pyuiWidgets.ImageLabel, which has a resize-timing bug."""

    def __init__(self, master, image_path, bg="#ffffff", **kwargs):
        super().__init__(master, bg=bg, **kwargs)
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
local_gui.config(bg="#E4E2E2")

# --- Window sizing / resizing ---------------------------------------------
local_gui.geometry("1920x1025")
local_gui.minsize(1100, 650)          # don't let it shrink so far controls overlap
local_gui.resizable(True, True)       # allow resizing in both directions

# Center the window on the screen it opens on
local_gui.update_idletasks()
screen_w = local_gui.winfo_screenwidth()
screen_h = local_gui.winfo_screenheight()
win_w = min(1920, screen_w)
win_h = min(1025, screen_h)
geometryX = max(0, (screen_w - win_w) // 2)
geometryY = max(0, (screen_h - win_h) // 2)
local_gui.geometry("%dx%d+%d+%d" % (win_w, win_h, geometryX, geometryY))

# --- Window / taskbar icon (top window bar) --------------------------------
try:
    icon_image = Image.open(os.path.join(IMG_DIR, "panther_icon.png"))
    icon_photo = ImageTk.PhotoImage(icon_image)
    local_gui.iconphoto(True, icon_photo)
except Exception as e:
    print(f"Could not set window icon: {e}")

style = ttk.Style(local_gui)
style.theme_use("clam")

# ============================================================================
# Menu bar
# ============================================================================
menu = tk.Menu(local_gui)
local_gui.config(menu=menu)

# File menu
menu_file = tk.Menu(menu, tearoff=0)
menu_file.add_command(label="New Test Session", command=lambda: print("New clicked"))
menu_file.add_command(label="Open Config...", command=lambda: print("Open clicked"))
menu_file.add_command(label="Save Log...", command=lambda: print("Save Log clicked"))
menu_file.add_separator()
menu_file.add_command(label="Exit", command=local_gui.quit)
menu.add_cascade(label="File", menu=menu_file)

# Edit menu
menu_edit = tk.Menu(menu, tearoff=0)
menu_edit.add_command(label="Preferences...", command=lambda: print("Preferences clicked"))
menu_edit.add_command(label="Clear Console", command=lambda: print("Clear Console clicked"))
menu_edit.add_separator()
menu_edit.add_command(label="Copy Log", command=lambda: print("Copy Log clicked"))
menu.add_cascade(label="Edit", menu=menu_edit)

# Tools menu (mirrors the TOOL SELECT sidebar options)
menu_tools = tk.Menu(menu, tearoff=0)
for tool_name in ["Adafruit Bluetooth Sniffer", "Preloaded Script", "Custom Script", "Ghidra", "GDB"]:
    menu_tools.add_command(label=tool_name, command=lambda t=tool_name: tool_select__var.set(t))
menu.add_cascade(label="Tools", menu=menu_tools)

# Help menu
menu_help = tk.Menu(menu, tearoff=0)
menu_help.add_command(label="Documentation", command=lambda: print("Documentation clicked"))
menu_help.add_command(
    label="About",
    command=lambda: messagebox.showinfo(
        "About",
        "Healthcare IoT Cyber Testbed\nBy: Justin Bower, Nathan Maloney & Ipule Pipi"
    ),
)
menu.add_cascade(label="Help", menu=menu_help)

# ============================================================================
# Root layout: two columns -> main canvas (expands) | sidebar (fixed-ish)
# ============================================================================
local_gui.columnconfigure(0, weight=1)   # main area grows
local_gui.columnconfigure(1, weight=0, minsize=300)  # sidebar stays a consistent width
local_gui.rowconfigure(0, weight=1)

# --- Main "tooling" canvas area ---------------------------------------------
tooling = tk.Frame(master=local_gui, bg="#EDECEC")
tooling.grid(row=0, column=0, sticky="nsew", padx=(6, 6), pady=12)

# --- Sidebar -----------------------------------------------------------------
sidebar = tk.Frame(master=local_gui, bg="#E4E2E2")
sidebar.grid(row=0, column=1, sticky="nsew", padx=(0, 6), pady=12)
sidebar.columnconfigure(0, weight=1)
# row 5 (the spacer) absorbs extra vertical space, pushing the buttons to the bottom
sidebar.rowconfigure(5, weight=1)

# Tool select combobox
style.configure("tool_select_.TCombobox", fieldbackground="#000000", foreground="#ffffff", font=("Arial", 16), cursor="arrow")
tool_select__options = ["Adafruit Bluetooth Sniffer", "Preloaded Script", "Custom Script", "Ghidra", "GDB"]
tool_select__var = tk.StringVar(value="TOOL SELECT")
tool_select_ = ttk.Combobox(sidebar, textvariable=tool_select__var, values=tool_select__options, style="tool_select_.TCombobox", state="readonly")
tool_select_.grid(row=0, column=0, sticky="ew", padx=10, pady=(0, 10), ipady=20)

# Launch options combobox
style.configure("launch_options.TCombobox", fieldbackground="#000000", foreground="#ffffff", relief=tk.FLAT, font=("Arial", 16), cursor="arrow")
launch_options_options = ["Local", "Remote", "Simulation"]
launch_options_var = tk.StringVar(value="LAUNCH OPTIONS")
launch_options = ttk.Combobox(sidebar, textvariable=launch_options_var, values=launch_options_options, style="launch_options.TCombobox", state="readonly")
launch_options.grid(row=1, column=0, sticky="ew", padx=10, pady=(0, 20), ipady=20)

# FIT wordmark logo - explicit pixel size so it displays correctly (not cropped/oversized)
logo_frame = tk.Frame(sidebar, bg="#ffffff", height=140)
logo_frame.grid(row=2, column=0, sticky="ew", padx=10, pady=(0, 10))
logo_frame.grid_propagate(False)
logo_frame.columnconfigure(0, weight=1)
logo_frame.rowconfigure(0, weight=1)

_fit_logo = FitImageLabel(
    master=logo_frame,
    image_path=os.path.join(IMG_DIR, "1-hrpreview.png"),
    bg="#ffffff",
)
_fit_logo.grid(row=0, column=0, sticky="nsew")

# Student names credit
style.configure("_student_names.TLabel", background="#ffffff", foreground="#000", anchor="center")
_student_names = ttk.Label(sidebar, text="By: Justin Bower, Nathan Maloney & Ipule Pipi",
                            style="_student_names.TLabel", wraplength=260, justify="center")
_student_names.grid(row=3, column=0, sticky="ew", padx=10, pady=(0, 10), ipady=10)

# Spacer row (row 5, given weight above) pushes the buttons to the bottom of the sidebar

# START TEST button
style.configure("button1.TButton", background="#5a9f68", foreground="#ffffff", relief=tk.FLAT, font=("Arial", 20, "bold"), cursor="arrow")
style.map("button1.TButton", background=[("active", "#E4E2E2")], foreground=[("active", "#000")])
button1 = ttk.Button(sidebar, text="START TEST", style="button1.TButton")
button1.grid(row=6, column=0, sticky="ew", padx=10, pady=(0, 10), ipady=25)

# STOP APPLICATION button
style.configure("button.TButton", background="#770000", foreground="#ffffff", relief=tk.FLAT, font=("Arial", 20, "bold"), cursor="arrow")
style.map("button.TButton", background=[("active", "#E4E2E2")], foreground=[("active", "#000")])
button = ttk.Button(sidebar, text="STOP APPLICATION", style="button.TButton")
button.grid(row=7, column=0, sticky="ew", padx=10, pady=(0, 10), ipady=25)

local_gui.mainloop()
