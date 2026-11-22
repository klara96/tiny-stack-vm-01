#!/usr/bin/env node
// Tiny stack VM interpreter for make.fun ISA v1
// Usage: node main.ts <input_dir> [output_dir]
// Reads from <input_dir>/<id>/program.bin and <id>/input.bin
// Writes to <output_dir>/<id>/stdout.bin and <id>/exit.txt

const inputDir = process.env.MAKEFUN_INPUT_DIR || process.argv[2] || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || process.argv[3] || '/output';

const D = new Int32Array(256); // data stack
const C = new Int32Array(64);  // call stack
const M = new Int32Array(256); // memory (zeroed)
let sp = 0, csp = 0, pc = 0, steps = 0;
let output = new Uint8Array(65536), olen = 0;
let inputBuf: Uint8Array, ip = 0;
let EXIT = 0;
let trapped = false;

function end(code:number){ EXIT = code; trapped = true; }

const ops: Record<number, [pops: number, pushes: number, exec: (pc: number) => number]> = {
  0x00: [0, 0, (pc) => { end(0); return pc; }], // HALT
  0x01: [0, 1, (pc) => { const b = (program[pc + 1] << 24) >> 24; D[sp++] = b; return pc + 2; }], // PUSH8
  0x02: [0, 1, (pc) => { const v = program[pc + 1] | (program[pc + 2] << 8) | (program[pc + 3] << 16) | (program[pc + 4] << 24); D[sp++] = v; return pc + 5; }], // PUSH32
  0x03: [1, 0, (pc) => { sp--; return pc; }], // POP
  0x04: [1, 2, (pc) => { const a = D[sp - 1]; D[sp] = a; D[sp + 1] = a; sp += 2; return pc; }], // DUP
  0x05: [2, 2, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; D[sp - 2] = b; D[sp - 1] = a; return pc; }], // SWAP
  0x06: [2, 3, (pc) => { const c = D[sp - 1]; const b = D[sp - 2]; const a = D[sp - 3]; D[sp - 3] = b; D[sp - 2] = c; D[sp - 1] = a; return pc; }], // OVER
  0x07: [3, 3, (pc) => { const c = D[sp - 1]; const b = D[sp - 2]; const a = D[sp - 3]; D[sp - 3] = b; D[sp - 2] = c; D[sp - 1] = a; return pc; }], // ROT
  0x10: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = (a + b) | 0; return pc; }], // ADD
  0x11: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = (a - b) | 0; return pc; }], // SUB
  0x12: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = Math.imul(a, b); return pc; }], // MUL
  0x13: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; if (b === 0) { end(4); return pc; } if (a === -2147483648 && b === -1) { D[sp++] = -2147483648; return pc; } D[sp++] = (a / b) | 0; return pc; }], // DIV
  0x14: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; if (b === 0) { end(4); return pc; } if (b === -1) { D[sp++] = 0; return pc; } D[sp++] = a % b; return pc; }], // MOD
  0x15: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; if (b === 0) { end(4); return pc; } D[sp++] = (a >>> 0) / (b >>> 0) | 0; return pc; }], // DIVU
  0x16: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; if (b === 0) { end(4); return pc; } D[sp++] = (a >>> 0) % (b >>> 0) | 0; return pc; }], // MODU
  0x17: [1, 1, (pc) => { const a = D[--sp]; D[sp] = (-a) | 0; return pc; }], // NEG
  0x18: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a & b; return pc; }], // AND
  0x19: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a | b; return pc; }], // OR
  0x1a: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a ^ b; return pc; }], // XOR
  0x1b: [1, 1, (pc) => { const a = D[--sp]; D[sp] = ~a; return pc; }], // NOT
  0x1c: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a << (b & 31); return pc; }], // SHL
  0x1d: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a >> (b & 31); return pc; }], // SHR
  0x1e: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = (a >>> (b & 31)) | 0; return pc; }], // SHRU
  0x20: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a === b ? 1 : 0; return pc; }], // EQ
  0x21: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = a < b ? 1 : 0; return pc; }], // LT
  0x22: [2, 1, (pc) => { const b = D[sp - 1]; const a = D[sp - 2]; sp -= 2; D[sp++] = (a >>> 0) < (b >>> 0) ? 1 : 0; return pc; }], // LTU
  0x30: [0, 0, (pc) => { const rel = ((program[pc + 1] | (program[pc + 2] << 8)) << 16) >> 16; return pc + 3 + rel; }], // JMP
  0x31: [1, 0, (pc) => { const v = D[--sp]; const rel = ((program[pc + 1] | (program[pc + 2] << 8)) << 16) >> 16; if (v === 0) return pc + 3 + rel; return pc + 3; }], // JZ
  0x32: [1, 0, (pc) => { const v = D[--sp]; const rel = ((program[pc + 1] | (program[pc + 2] << 8)) << 16) >> 16; if (v !== 0) return pc + 3 + rel; return pc + 3; }], // JNZ
  0x33: [0, 0, (pc) => { if (csp === 64) { end(7); return pc; } const next = pc + 3; C[csp++] = next; pc = program[pc + 1] | (program[pc + 2] << 8); return pc; }], // CALL
  0x34: [0, 0, (pc) => { if (csp === 0) { end(8); return pc; } pc = C[--csp]; return pc; }], // RET
  0x40: [1, 1, (pc) => { const addr = D[sp - 1]; if (addr < 0 || addr > 255) { end(6); return pc; } D[sp - 1] = M[addr]; return pc; }], // LOAD
  0x41: [2, 0, (pc) => { const addr = D[sp - 1]; const v = D[sp - 2]; if (addr < 0 || addr > 255) { end(6); return pc; } sp -= 2; M[addr] = v; return pc; }], // STORE
  0x50: [1, 0, (pc) => { const s = String(D[sp - 1]); if (olen + s.length > 65536) { end(11); return pc; } sp--; for (let i = 0; i < s.length; i++) output[olen++] = s.charCodeAt(i); return pc; }], // PRINT
  0x51: [1, 0, (pc) => { const v = D[--sp] & 255; if (olen >= 65536) { end(11); return pc; } output[olen++] = v; return pc; }], // PUTC
  0x52: [0, 1, (pc) => { D[sp++] = ip < inputBuf.length ? inputBuf[ip++] : -1; return pc; }], // IN
  0x53: [1, 0, (pc) => { const v = D[--sp] & 255; end(v); return pc; }], // EXIT
};

function run(program: Uint8Array, input: Uint8Array): void {
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
    if (sp < pops) { end(2); return; }
    if (sp - pops + pushes > 256) { end(3); return; }
    pc = exec(pc);
  }
}

// Main driver
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
