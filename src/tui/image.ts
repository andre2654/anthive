/**
 * Imagem dentro do terminal pelo protocolo gráfico do Kitty (Ghostty, kitty,
 * WezTerm). Não é célula da grade: vai como sequência crua depois do diff, e
 * some com `clearImages()`. Sem suporte, quem chama mostra texto no lugar.
 */
export function supportsKittyGraphics(env: Record<string, string | undefined> = process.env): boolean {
  const tp = (env.TERM_PROGRAM ?? '').toLowerCase(), term = (env.TERM ?? '').toLowerCase();
  return tp === 'ghostty' || tp === 'wezterm' || term.includes('kitty') || term.includes('ghostty') || !!env.KITTY_WINDOW_ID;
}

/**
 * Sequência que desenha um PNG base64 ocupando `cols`×`rows` células na posição
 * atual do cursor. Dados vão em pedaços de 4096 (m=1 até o último, m=0).
 */
export function kittyImage(pngBase64: string, cols: number, rows: number, id = 1): string {
  const chunks: string[] = [];
  for (let i = 0; i < pngBase64.length; i += 4096) chunks.push(pngBase64.slice(i, i + 4096));
  return chunks.map((chunk, i) => {
    const ctl = i === 0 ? `a=T,f=100,i=${id},c=${cols},r=${rows},q=2,m=${chunks.length > 1 ? 1 : 0}` : `m=${i === chunks.length - 1 ? 0 : 1},q=2`;
    return `\x1b_G${ctl};${chunk}\x1b\\`;
  }).join('');
}

/** Posiciona o cursor (1-based no terminal) e desenha. */
export function placeImage(pngBase64: string, x: number, y: number, cols: number, rows: number, id = 1): string {
  return `\x1b[${y + 1};${x + 1}H` + kittyImage(pngBase64, cols, rows, id);
}

export const clearImages = () => `\x1b_Ga=d,d=A,q=2\x1b\\`;
