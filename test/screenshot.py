#!/usr/bin/env python3
"""Roda o binário num pseudo-terminal de verdade e imprime a tela final como texto.
Uso: screenshot.py COLS ROWS [teclas...]   (teclas: texto cru; 'TAB' 'ENTER' 'ESC' viram as teclas)"""
import os, pty, sys, time, select, struct, fcntl, termios, re

cols, rows = int(sys.argv[1]), int(sys.argv[2])
keys = sys.argv[3:]
KEYMAP = {'TAB': '\t', 'ENTER': '\r', 'ESC': '\x1b', 'UP': '\x1b[A', 'DOWN': '\x1b[B', 'LEFT': '\x1b[D', 'RIGHT': '\x1b[C'}

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    argv = ['./anthive'] + ([os.environ['ANTHIVE_OPEN']] if os.environ.get('ANTHIVE_OPEN') else [])
    os.execvpe('./anthive', argv, {**os.environ, 'TERM': 'xterm-256color'})

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
buf = b''
def pump(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: buf += os.read(fd, 65536)
            except OSError: return False
    return True

pump(2.5)
for k in keys:
    os.write(fd, KEYMAP.get(k, k).encode()); pump(0.6)
frame_end = len(buf)                     # o que está na tela AGORA; a saída vem depois e não conta
os.write(fd, b'\x1b\x1b'); pump(0.3); os.write(fd, b'q'); pump(0.6)
try: os.kill(pid, 15)
except ProcessLookupError: pass

# --- interpretador mínimo do que o renderizador emite: CUP, clear, SGR, texto ---
text = buf[:frame_end].decode('utf-8', errors='replace')
screen = [[' '] * cols for _ in range(rows)]
row = col = 0
i = 0
while i < len(text):
    ch = text[i]
    if ch == '\x1b' and i + 1 < len(text) and text[i + 1] in '_]':
        # APC (imagem do Kitty) ou OSC: pula até o terminador ST
        end = text.find('\x1b\\', i)
        i = len(text) if end < 0 else end + 2
        continue
    if ch == '\x1b' and i + 1 < len(text) and text[i + 1] == '[':
        m = re.match(r'\x1b\[([?0-9;]*)([@-~])', text[i:])
        if not m: i += 1; continue
        params, final = m.group(1), m.group(2)
        if final == 'H':
            p = [int(x) if x else 1 for x in params.split(';')] if params else [1, 1]
            row, col = (p[0] if p else 1) - 1, (p[1] if len(p) > 1 else 1) - 1
        elif final == 'J':
            screen = [[' '] * cols for _ in range(rows)]
        i += len(m.group(0)); continue
    if ch == '\r': col = 0
    elif ch == '\n': row += 1
    elif ch >= ' ':
        if 0 <= row < rows and 0 <= col < cols: screen[row][col] = ch
        col += 1
        if col >= cols: col = 0; row += 1
    i += 1

print(f"── {cols}x{rows} · {len(buf)} bytes ──")
for r in screen: print(''.join(r).rstrip())
