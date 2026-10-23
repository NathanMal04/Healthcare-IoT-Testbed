#Unsanitized Text/Input Scanner - Vulnerability Research Template
#@author Justin Bower
#@category Vulnerability Research
#@keybinding 
#@menupath Tools.Vuln Research.Scan Unsanitized Input

from ghidra.app.script import GhidraScript
from ghidra.program.model.symbol import FlowType

print("--- Unsanitized Text/Input Scanner Utility ---")

INPUT_FUNCTIONS = {
    'gets':       "NEVER safe - unbounded stack read",
    'scanf':      "Unbounded %s or missing width",
    'fscanf':     "Same as scanf",
    'sscanf':     "Same as scanf",
    'read':       "Raw read into buffer (check size)",
    'recv':       "Network input - check length",
    'fgets':      "Safer only if size is constant & correct",
    'getline':    "Dynamic but still needs bounds checking",
    'getchar':    "Loop risk if not bounded"
}

fm = currentProgram.getFunctionManager()

for func_name, risk in INPUT_FUNCTIONS.items():
    if monitor.isCancelled():
        break
    
    funcs = [f for f in fm.getFunctions(True) if func_name in f.getName()]
    for f in funcs:
        print(f"\n[!] Unsanitized input: {f.getName()} @ 0x{f.getEntryPoint().getOffset():x}")
        print(f"    Risk: {risk}")
        
        for ref in getReferencesTo(f.getEntryPoint()):
            if ref.getReferenceType() == FlowType.UNCONDITIONAL_CALL:
                caller = ref.getFromAddress()
                print(f"    → Called from: 0x{caller.getOffset():x} (check sanitization here)")

#Quick string check for user-controlled text
print("\n--- Potential User-Controlled Strings ---")
for data in currentProgram.getListing().getDefinedData(True):
    if data.isString():
        s = str(data.getValue())
        if len(s) > 10 and any(kw in s.lower() for kw in ["input", "user", "name", "pass", "cmd"]):
            print(f"    Suspicious string @ 0x{data.getAddress().getOffset():x}: {s[:60]}")

print("\n--- Unsanitized input scan complete ---")
print("Tip: Cross-reference these calls with the buffer overflow scanner for full exploit paths.")
