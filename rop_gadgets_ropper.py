#ROP Gadgets Analysis with Ropper Integration - Vulnerability Research Script Template
#@author Justin Bower
#@category Vulnerability Research
#@keybinding 
#@menupath Tools.Vuln Research.Find ROP Gadgets (Ropper)
#@toolbar 

from ghidra.app.script import GhidraScript
import subprocess
from java.io import File

print("--- ROP Gadget Finder w/ Ropper (ret2libc / ret2win / ret2syscall) Utility ---")

#Get Ghidra's image base (required for correct offsets)
image_base = currentProgram.getImageBase().getOffset()
print("Ghidra Image Base: 0x%x" % image_base)

#Ask user for the original binary file (ropper needs the raw ELF/PE on disk)
binary_file = askFile("Select ORIGINAL binary file for ropper", "Select")
if not binary_file:
    print("Cancelled.")
    exit()

binary_path = binary_file.getAbsolutePath()
print("Analyzing: %s" % binary_path)

#Common gadget patterns relevant to exploitation techniques
gadgets_to_search = [
    "pop rdi; ret",
    "pop rsi; ret",
    "pop rdx; ret",
    "pop rax; ret",
    "pop rbx; ret",
    "syscall",
    "int 0x80",
    "pop rsp; ret",          #stack pivot
    "leave; ret",
    "system",                #ret2libc
    "execve"
]

try:
    for gadget in gadgets_to_search:
        if monitor.isCancelled():
            break
        print("\n[+] Searching for: %s" % gadget)
        
        cmd = [
            "ropper", "--file", binary_path,
            "-I", hex(image_base),
            "--search", gadget,
            "--nocolor", "--quiet"
        ]
        
        output = subprocess.check_output(cmd, stderr=subprocess.STDOUT, universal_newlines=True)
        if output.strip():
            print(output)
        else:
            print("   No matches found.")
            
    print("\n--- ROP analysis complete ---")
    print("Tip: Use these gadgets for ret2libc (system + /bin/sh), ret2syscall, or ret2win chains.")

except subprocess.CalledProcessError as e:
    print("Ropper error: %s" % e.output)
except OSError:
    print("ERROR: ropper not found in PATH.")
except Exception as e:
    print("Unexpected error: %s" % str(e))