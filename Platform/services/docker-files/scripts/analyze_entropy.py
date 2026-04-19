#analyze_entropy.py
#utilizes binwalk to analyze entropy

import argparse
import subprocess
from pathlib import Path

def analyze_entropy(firmware_path, output_dir=None):
    path = Path(firmware_path)
    if not path.is_file():
        print('Firmware file not found')
        return

    cmd = ['binwalk', '-E', '-J', str(path)]

    #FIX: Initialize result to None before the try block so it is always
    #defined when we reach the output_dir section below. Previously, a
    #CalledProcessError would leave result unbound and crash with NameError.
    result = None
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        print(result.stdout)
    except subprocess.CalledProcessError as e:
        print('Binwalk error:', e.stderr)

    #FIX: Guard the write with "if result" so we only attempt to save output
    #when the command actually succeeded.
    if output_dir and result:
        Path(output_dir).mkdir(exist_ok=True)
        log_file = Path(output_dir) / f'{path.name}_entropy.txt'
        log_file.write_text(result.stdout)

def main():
    p = argparse.ArgumentParser(description='Binwalk entropy analysis of firmware')
    p.add_argument('firmware', help='Path to firmware binary')
    p.add_argument('--out', help='Output dir for logs and plot')
    args = p.parse_args()

    analyze_entropy(args.firmware, args.out)

if __name__ == "__main__":
    main()
