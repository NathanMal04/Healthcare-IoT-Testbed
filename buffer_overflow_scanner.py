#Buffer Overflow Scanner & Exploitation Helper - Vulnerability Research Script Template
#@author Justin Bower
#@category Vulnerability Research
#@keybinding 
#@menupath Tools.Vuln Research.Scan Buffer Overflows

from ghidra.app.script import GhidraScript
from ghidra.program.model.symbol import FlowType

print("--- Buffer Overflow/Exploitation Scanner Utility ---")

DANGEROUS_FUNCTIONS = {
    'gets':          "UNBOUNDED stack buffer overflow (classic)",
    'scanf':         "Format string or unbounded input",
    'sprintf':       "Format string / buffer overflow",
    'strcpy':        "Buffer overflow if dest not sized",
    'strcat':        "Buffer overflow",
    'memcpy':        "Buffer overflow / arbitrary write",
    'strncpy':       "Still dangerous if n is user-controlled",
    'read':          "Buffer overflow on stack/heap",
    'fgets':         "Safer but still overflow if size wrong",
    'realloc':       "Heap overflow / use-after-free risk"
}

fm = currentProgram.getFunctionManager()

for func_name, description in DANGEROUS_FUNCTIONS.items():
    if monitor.isCancelled():
        break
    
    funcs = [f for f in fm.getFunctions(True) if f.getName() == func_name]
    for f in funcs:
        print("\n[!] %s found at 0x%x" % (func_name, f.getEntryPoint().getOffset()))
        print("    → %s" % description)
        
        #Show callers
        for ref in getReferencesTo(f.getEntryPoint()):
            if ref.getReferenceType() == FlowType.UNCONDITIONAL_CALL:
                caller = ref.getFromAddress()
                print("    Called from: 0x%x" % caller.getOffset())

#Bonus: ret2* primitives
print("\n --- Check for ret2* Primitives ---")

#Find system / execve for ret2libc
for name in ["system", "execve"]:
    for f in [f for f in fm.getFunctions(True) if name in f.getName().lower()]:
        print("[+] ret2libc candidate: %s @ 0x%x" % (f.getName(), f.getEntryPoint().getOffset()))

#Find /bin/sh string
mem = currentProgram.getMemory()
addr = mem.findBytes(currentProgram.getMinAddress(), "/bin/sh", None, True, monitor)
if addr:
    print("[+] ret2libc /bin/sh string @ 0x%x" % addr.getOffset())

#ret2win functions
for f in fm.getFunctions(True):
    if "win" in f.getName().lower() or "flag" in f.getName().lower() or "success" in f.getName().lower():
        print("[+] ret2win candidate: %s @ 0x%x" % (f.getName(), f.getEntryPoint().getOffset()))

#ret2syscall
for instr in currentProgram.getListing().getInstructions(True):
    if "syscall" in instr.getMnemonicString() or ("int" in instr.getMnemonicString() and "80" in str(instr)):
        print("[+] ret2syscall candidate @ 0x%x" % instr.getAddress().getOffset())
        break  #one candidate is enough for the template

print("\n --- Scan Complete --- ")
print("Next step: Use the ROP script above to build a chain to the chosen primitives.")