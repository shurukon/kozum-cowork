const fs = require('fs');
const p = 'D:/kozum-cowork-0.5.0/kozum-cowork-0.5.0/src/renderer/components/ToolCard.tsx';
const raw = fs.readFileSync(p, 'utf-8');
const EOL = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

const hdRe = /^\s*\{hasDetail && \(\s*$/;
const btnRe = /^\s*<\/button>\s*$/;

let btn = lines.findIndex((l) => btnRe.test(l));
let hd = -1;
for (let i = 0; i < btn; i++) {
  if (hdRe.test(lines[i])) { hd = i; break; }
}
if (hd === -1 || btn === -1) {
  console.error('hd=', hd, 'btn=', btn);
  process.exit(1);
}

const desired = [
  '        {hasDetail && (',
  '          <span className={styles.chevron}>',
  '            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}',
  '      </span>',
  '        )}',
  '',
  '        {isRunning && (',
  '          <span',
  '            className={`${styles.headerProgress} kz-tool-stream`}',
  '            aria-hidden={true}',
  '          />',
  '        )}',
];

lines.splice(hd, btn - hd, ...desired);
fs.writeFileSync(p, lines.join(EOL));
console.log('rewrote', btn - hd, 'lines from', hd + 1);
