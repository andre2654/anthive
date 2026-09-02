import { parseLsof, discover, stats, alive } from '../src/core/services.ts';
let fails = 0;
const must = (l: string, c: boolean) => { console.log(c ? `✓ ${l}` : `✗ ${l}`); if (!c) fails++; };

const canned = `COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      41321 saraiva   23u  IPv6 0x1234567890abcdef      0t0  TCP *:3000 (LISTEN)
postgres    812 saraiva    7u  IPv4 0xabcdef1234567890      0t0  TCP 127.0.0.1:5432 (LISTEN)
postgres    812 saraiva    8u  IPv6 0xabcdef1234567891      0t0  TCP [::1]:5432 (LISTEN)
bun       50022 saraiva   14u  IPv4 0x00000000deadbeef      0t0  TCP 127.0.0.1:8787 (LISTEN)
`;
const r = parseLsof(canned);
must('três services, sem duplicar a porta do postgres', r.length === 3 && r.filter((x) => x.pid === 812).length === 1);
must('porta e comando certos', r.find((x) => x.port === 3000)?.command === 'node');
must('endereço do postgres', r.find((x) => x.port === 5432)?.addr === '127.0.0.1');
must('ordenado por porta', r.map((x) => x.port).join(',') === '3000,5432,8787');
must('cabeçalho não vira serviço', !r.some((x) => Number.isNaN(x.pid)));

const real = await discover();
must(`descoberta real não quebra (${real.length} escutando)`, Array.isArray(real));
const me = await stats(process.pid);
must('stats do próprio processo', !!me && me.rssMb > 0 && me.command.length > 0);
must('alive do próprio processo', alive(process.pid) && !alive(999999));
console.log(fails ? `\n${fails} falha(s)` : '\ntudo verde');
process.exit(fails ? 1 : 0);
