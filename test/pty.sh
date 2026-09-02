#!/bin/bash
# Roda a TUI num pty real, manda 'q' e confere que a saída restaura o terminal.
out=$(mktemp)
script -q "$out" bash -c '
  bun run src/index.ts &
  P=$!
  sleep 2.5
  kill -TERM $P 2>/dev/null
  wait $P 2>/dev/null
' >/dev/null 2>&1
echo "bytes capturados: $(wc -c < "$out")"
grep -q $'\x1b\[?1049h' "$out" && echo "✓ entrou na tela alternativa" || echo "✗ NAO entrou na tela alternativa"
grep -q $'\x1b\[?1049l' "$out" && echo "✓ saiu da tela alternativa"   || echo "✗ NAO restaurou a tela"
grep -q $'\x1b\[?25h'   "$out" && echo "✓ cursor devolvido"           || echo "✗ cursor NAO devolvido"
grep -q $'\x1b\[?1006h' "$out" && echo "✓ mouse ligado"               || echo "✗ mouse nao ligou"
grep -q $'\x1b\[?1006l' "$out" && echo "✓ mouse desligado"            || echo "✗ mouse NAO desligou"
grep -q 'anthive'      "$out" && echo "✓ desenhou o mapa"            || echo "✗ nao desenhou"
grep -q '38;2;'         "$out" && echo "✓ truecolor emitido"          || echo "✗ sem truecolor"
rm -f "$out"
