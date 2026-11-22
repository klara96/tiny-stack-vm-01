#!/usr/bin/env node

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const D = new Int32Array(256);
const C = new Int32Array(64);
const M = new Int32Array(256);
let sp = 0, csp = 0, pc = 0, steps = 0;
let output = new Uint8Array(65536), olen = 0;
let inputBuf: Uint8Array, ip = 0;
let EXIT = 0;
let trapped = false;
let program: Uint8Array;

function end(code:number){ EXIT = code; trapped = true; }

const ops: Record<number, [pops: number, pushes: number, exec: (pc: number, next: number) => number]> = {
  0x00: [0, 0, (pc, next) => { end(0); return next; }],
  0x01: [0, 1, (pc, next) => { const b = (program[pc + 1] << 24) >> 24; D[sp++] = b; return next; }],
  0x02: [0, 1, (pc, next) => { const v = program[pc + 1] | (program[pc + 2] << 8) | (program[pc + 3] << 16) | (program[pc + 4] << 24); D[sp++] = v; return next; }],
  0x03: [1, 0, (pc, next) => { sp--; return next; }],
  0x04: [1, 2, (pc, next) => { const a = D[sp - 1]; D[sp] = a; sp++; return next; }],
  0x05: [2, 2, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; D[sp - 2] = b; D[sp - 1] = a; return next; }],
  0x06: [2, 1, (pc, next) => { D[sp] = D[sp - 2]; sp++; return next; }],
  0x07: [3, 3, (pc, next) => { const c = D[sp - 1]; const b = D[sp - 2]; const a = D[sp - 3]; D[sp - 3] = b; D[sp - 2] = c; D[sp - 1] = a; return next; }],
  0x10: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = (a + b) | 0; return next; }],
  0x11: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = (a - b) | 0; return next; }],
  0x12: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = Math.imul(a, b); return next; }],
  0x13: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; if (b === 0) { end(4); return next; } if (a === -2147483648 && b === -1) { D[sp++] = -2147483648; return next; } D[sp++] = (a / b) | 0; return next; }],
  0x14: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; if (b === 0) { end(4); return next; } if (b === -1) { D[sp++] = 0; return next; } D[sp++] = a % b; return next; }],
  0x15: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; if (b === 0) { end(4); return next; } D[sp++] = (a >>> 0) / (b >>> 0) | 0; return next; }],
  0x16: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; if (b === 0) { end(4); return next; } D[sp++] = (a >>> 0) % (b >>> 0) | 0; return next; }],
  0x17: [1, 1, (pc, next) => { D[sp - 1] = (-D[sp - 1]) | 0; return next; }],
  0x18: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a & b; return next; }],
  0x19: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a | b; return next; }],
  0x1a: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a ^ b; return next; }],
  0x1b: [1, 1, (pc, next) => { D[sp - 1] = ~D[sp - 1]; return next; }],
  0x1c: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a << (b & 31); return next; }],
  0x1d: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a >> (b & 31); return next; }],
  0x1e: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = (a >>> (b & 31)) | 0; return next; }],
  0x20: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a === b ? 1 : 0; return next; }],
  0x21: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a < b ? 1 : 0; return next; }],
  0x22: [2, 1, (pc, next) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = (a >>> 0) < (b >>> 0) ? 1 : 0; return next; }],
  0x30: [0, 0, (pc, next) => { const rel = ((program[pc + 1] | (program[pc + 2] << 8)) << 16) >> 16; return next + rel; }],
  0x31: [1, 0, (pc, next) => { const v = D[--sp]; const rel = ((program[pc + 1] | (program[pc + 2] << 8)) << 16) >> 16; if (v === 0) return next + rel; return next; }],
  0x32: [1, 0, (pc, next) => { const v = D[--sp]; const rel = ((program[pc + 1] | (program[pc + 2] << 8)) << 16) >> 16; if (v !== 0) return next + rel; return next; }],
  0x33: [0, 0, (pc, next) => { if (csp === 64) { end(7); return pc; } C[csp++] = next; pc = program[pc + 1] | (program[pc + 2] << 8); return pc; }],
  0x34: [0, 0, (pc, next) => { if (csp === 0) { end(8); return pc; } pc = C[--csp]; return pc; }],
  0x40: [1, 1, (pc, next) => { const addr = D[sp - 1]; if (addr < 0 || addr > 255) { end(6); return next; } D[sp - 1] = M[addr]; return next; }],
  0x41: [2, 0, (pc, next) => { const addr = D[sp - 1]; const v = D[sp - 2]; if (addr < 0 || addr > 255) { end(6); return next; } sp -= 2; M[addr] = v; return next; }],
  0x50: [1, 0, (pc, next) => { const s = String(D[sp - 1]); if (olen + s.length > 65536) { end(11); return next; } sp--; for (let i = 0; i < s.length; i++) output[olen++] = s.charCodeAt(i); return next; }],
  0x51: [1, 0, (pc, next) => { const v = D[--sp] & 255; if (olen >= 65536) { end(11); return next; } output[olen++] = v; return next; }],
  0x52: [0, 1, (pc, next) => { D[sp++] = ip < inputBuf.length ? inputBuf[ip++] : -1; return next; }],
  0x53: [1, 0, (pc, next) => { const v = D[--sp] & 255; end(v); return next; }],
};

function run(prog: Uint8Array, input: Uint8Array): void {
  program = prog;
  inputBuf = input; ip = 0; sp = 0; csp = 0; pc = 0; steps = 0; olen = 0;
  trapped = false;
  EXIT = 0;
  for (let i = 0; i < 256; i++) M[i] = 0;

  while (true) {
    if (trapped) return;
    if (steps++ === 1000000) { end(10); return; }
    if (pc < 0 || pc >= program.length) { end(9); return; }
    const opcode = program[pc];
    if (!(opcode in ops)) { end(5); return; }
    const [pops, pushes, exec] = ops[opcode];
    const immBytes = opcode === 1 ? 1 : opcode === 2 ? 4 : (opcode >= 0x30 && opcode <= 0x33) ? 2 : 0;
    if (pc + immBytes >= program.length) { end(9); return; }
    const next = pc + 1 + immBytes;
    if (sp < pops) { end(2); return; }
    if (sp - pops + pushes > 256) { end(3); return; }
    pc = exec(pc, next);
  }
}

const fs = require('fs');
const entries = fs.readdirSync(inputDir, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name);

for (const id of entries) {
  const progPath = `${inputDir}/${id}/program.bin`;
  const inPath = `${inputDir}/${id}/input.bin`;
  const program = fs.readFileSync(progPath);
  const input = fs.readFileSync(inPath);
  run(program, input);
  fs.mkdirSync(`${outputDir}/${id}`, { recursive: true });
  fs.writeFileSync(`${outputDir}/${id}/stdout.bin`, Buffer.from(output.subarray(0, olen)));
  fs.writeFileSync(`${outputDir}/${id}/exit.txt`, EXIT + '\n');
}
