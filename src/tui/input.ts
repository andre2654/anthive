import { Key } from './screen.ts';
import { t } from '../i18n.ts';

/** Campo de texto de uma linha. Guarda o cursor em índice de caractere, não de byte. */
export class TextInput {
  chars: string[] = [];
  cursor = 0;

  constructor(initial = '') { this.set(initial); }

  set(v: string) { this.chars = [...v]; this.cursor = this.chars.length; }
  /** Texto colado: entra inteiro no cursor, sem virar tecla a tecla. */
  insert(v: string) { const cs = [...v]; this.chars.splice(this.cursor, 0, ...cs); this.cursor += cs.length; }
  get value() { return this.chars.join(''); }
  get empty() { return this.chars.length === 0; }

  /** Devolve true se consumiu a tecla. */
  handle(k: Key): boolean {
    switch (k.k) {
      case 'left':  this.cursor = Math.max(0, this.cursor - 1); return true;
      case 'right': this.cursor = Math.min(this.chars.length, this.cursor + 1); return true;
      case 'backspace':
        if (this.cursor > 0) { this.chars.splice(this.cursor - 1, 1); this.cursor--; }
        return true;
      case 'char': {
        const c = k.c;
        if (c === '\x01') { this.cursor = 0; return true; }                    // ctrl-a
        if (c === '\x05') { this.cursor = this.chars.length; return true; }    // ctrl-e
        if (c === '\x15') { this.chars.splice(0, this.cursor); this.cursor = 0; return true; } // ctrl-u
        if (c === '\x17') {                                                     // ctrl-w
          let i = this.cursor;
          while (i > 0 && this.chars[i - 1] === ' ') i--;
          while (i > 0 && this.chars[i - 1] !== ' ') i--;
          this.chars.splice(i, this.cursor - i); this.cursor = i; return true;
        }
        if (c === '\x04') { this.chars.splice(this.cursor, 1); return true; }   // ctrl-d
        if (c < ' ') return false;
        this.chars.splice(this.cursor, 0, c); this.cursor++; return true;
      }
      default: return false;
    }
  }

  /** Janela visível de largura `w`, com o cursor sempre dentro. */
  window(w: number): { text: string; cursorAt: number } {
    if (this.chars.length <= w) return { text: this.value, cursorAt: this.cursor };
    let start = Math.max(0, this.cursor - w + 1);
    start = Math.min(start, this.chars.length - w);
    return { text: this.chars.slice(start, start + w).join(''), cursorAt: this.cursor - start };
  }
}

export interface Field {
  label: string;
  input: TextInput;
  hint?: string;
  required?: boolean;
  /** Sugestões oferecidas com tab. */
  options?: string[];
  /** Prefixo digitado quando o ciclo de tab começou — sem isso o filtro colapsa. */
  cycleFrom?: string;
  /** Valor sugerido ainda não tocado: a primeira tecla o substitui, não o acumula. */
  preset?: boolean;
}

export type FormResult = 'pending' | 'submit' | 'cancel';

/** Formulário modal: vários campos, um ativo por vez. */
export class Form {
  fields: Field[];
  active = 0;
  error = '';

  constructor(public title: string, fields: { label: string; value?: string; hint?: string; required?: boolean; options?: string[] }[]) {
    this.fields = fields.map((f) => ({
      label: f.label, input: new TextInput(f.value ?? ''),
      hint: f.hint, required: f.required, options: f.options,
      preset: !!f.value,
    }));
  }

  get current(): Field { return this.fields[this.active]!; }
  values(): string[] { return this.fields.map((f) => f.input.value.trim()); }
  value(i: number): string { return this.fields[i]?.input.value.trim() ?? ''; }

  private missing(): Field | null {
    return this.fields.find((f) => f.required && !f.input.value.trim()) ?? null;
  }

  handle(k: Key): FormResult {
    this.error = '';
    if (k.k === 'esc') return 'cancel';

    if (k.k === 'tab') {
      // tab completa a partir das opções; sem opção, anda para o próximo campo
      const f = this.current;
      if (f.options?.length) {
        const cur = f.input.value.trim();
        // valor sugerido que já é uma opção: o tab percorre a lista inteira,
        // senão ele filtra por si mesmo e fica preso
        if (f.cycleFrom === undefined) f.cycleFrom = f.options.includes(cur) ? '' : cur;
        else if (!f.options.includes(cur)) f.cycleFrom = cur;
        const pref = f.cycleFrom.toLowerCase();
        const pool = pref ? f.options.filter((o) => o.toLowerCase().startsWith(pref)) : f.options;
        if (pool.length) {
          const i = pool.indexOf(cur);
          f.input.set(pool[(i + 1) % pool.length]!);
          f.preset = false;
          return 'pending';
        }
        f.cycleFrom = undefined;
      }
      this.active = (this.active + 1) % this.fields.length;
      return 'pending';
    }

    if (k.k === 'up')   { this.active = (this.active - 1 + this.fields.length) % this.fields.length; return 'pending'; }
    if (k.k === 'down') { this.active = (this.active + 1) % this.fields.length; return 'pending'; }

    if (k.k === 'enter') {
      if (this.active < this.fields.length - 1 && !this.current.input.empty) {
        this.active++;
        return 'pending';
      }
      const miss = this.missing();
      if (miss) {
        this.error = t('"{0}" is required', miss.label);
        this.active = this.fields.indexOf(miss);
        return 'pending';
      }
      return 'submit';
    }

    const f = this.current;
    // digitar por cima de um valor sugerido substitui; editar de propósito não
    if (f.preset && k.k === 'char' && k.c >= ' ') { f.input.set(''); }
    f.preset = false;
    if (f.input.handle(k)) f.cycleFrom = undefined;
    return 'pending';
  }
}
