#!/usr/bin/env node
// Tiny stack VM interpreter for make.fun ISA v1
// Usage: node main.ts <input_dir> [output_dir]
// Reads from <input_dir>/<id>/program.bin and <id>/input.bin
// Writes to <output_dir>/<id>/stdout.bin and <id>/exit.txt

const inputDir = process.env.MAKEFUN_INPUT_DIR || process.argv[2] || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || process.argv[3] || '/output';

type Trap = (code: number) => never;

const D = new Int32Array(256); // data stack
const C = new Int32Array(64);  // call stack
const M = new Int32Array(256); // memory (zeroed)
let sp = 0, csp = 0, pc = 0, steps = 0;
let output = new Uint8Array(65536), olen = 0;
let inputBuf: Uint8Array, ip = 0;

const traps: Record<number, Trap> = {
  0: (code: number) => { console.log(code); process.exit(code); },
  2: () => trap(2),
  3: () => trap(3),
  4: () => trap(4),
  5: () => trap(5),
  6: () => trap(6),
  7: () => trap(7),
  8: () => trap(8),
  9: () => trap(9),
  10: () => trap(10),
  11: () => trap(11),
};

function trap(code: number): never {
  // Ensure output is flushed before exit
  const cwd = process.cwd();
  const instanceId = cwd.split('/').pop() || 'default';
  console.error(`[trap] cwd=${cwd}, instanceId=${instanceId}`);
  const outPath = `${outputDir}/${instanceId}/stdout.bin`;
  const exitPath = `${outputDir}/${instanceId}/exit.txt`;
  const fs = require('fs');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(`${outputDir}/${instanceId}`, { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(output.subarray(0, olen)));
  fs.writeFileSync(exitPath, code + '\n');
  process.exit(code);
}

function pop(): number { if (sp < 1) traps[2](2); return D[--sp]; }
function pop2(): number[] { const a = pop(); const b = pop(); return [a, b]; }
function pop1(): number { if (sp < 1) traps[2](2); return D[--sp]; }
function push(v: number) { if (sp >= 256) traps[3](3); D[sp++] = v; }
function peek(): number { return D[sp - 1]; }
function peek2(): number { return D[sp - 2]; }
function peek3(): number { return D[sp - 3]; }

function readU8(): number { return inputBuf[ip++]; }
function readU32LE(): number {
  const b = inputBuf; return b[ip++] | (b[ip++] << 8) | (b[ip++] << 16) | (b[ip++] << 24);
}

const ops: Record<number, [pops: number, pushes: number, exec: (pc: number) => number]> = {
  0x00: [0, 0, (pc) => { traps[0](0); return pc; }], // HALT
  0x01: [1, 1, (pc) => { const b = inputBuf[pc + 1]; push((b << 24) >> 24); return pc + 2; }], // PUSH8
  0x02: [4, 1, (pc) => { push(readU32LE()); return pc + 5; }], // PUSH32
  0x03: [0, 1, (pc) => { sp--; return pc; }], // POP
  0x04: [0, 2, (pc) => { const a = D[sp - 1]; D[sp - 1] = a; push(a); return pc; }], // DUP
  0x05: [0, 2, (pc) => { const a = D[sp - 2]; const b = D[sp - 1]; D[sp - 1] = a; D[sp] = b; return pc; }], // SWAP
  0x06: [0, 3, (pc) => { const a = D[sp - 3]; const b = D[sp - 2]; const c = D[sp - 1]; D[sp - 3] = b; D[sp - 2] = c; D[sp - 1] = a; return pc; }], // OVER
  0x07: [0, 3, (pc) => { const a = D[sp - 3]; const b = D[sp - 2]; const c = D[sp - 1]; D[sp - 3] = b; D[sp - 2] = c; D[sp - 1] = a; return pc; }], // ROT
  0x10: [2, 1, (pc) => { const [a, b] = pop2(); push((a + b) | 0); return pc; }], // ADD
  0x11: [2, 1, (pc) => { const [a, b] = pop2(); push((a - b) | 0); return pc; }], // SUB
  0x12: [2, 1, (pc) => { const [a, b] = pop2(); push(Math.imul(a, b)); return pc; }], // MUL
  0x13: [2, 1, (pc) => { const [a, b] = pop2(); if (b === 0) traps[4](4); if (a === -2147483648 && b === -1) { push(-2147483648); return pc; } push((a / b) | 0); return pc; }], // DIV
  0x14: [2, 1, (pc) => { const [a, b] = pop2(); if (b === 0) traps[4](4); if (b === -1) { push(0); return pc; } push(a % b); return pc; }], // MOD
  0x15: [2, 1, (pc) => { const [a, b] = pop2(); if (b === 0) traps[4](4); push((a >>> 0) / (b >>> 0) | 0); return pc; }], // DIVU
  0x16: [2, 1, (pc) => { const [a, b] = pop2(); if (b === 0) traps[4](4); push((a >>> 0) % (b >>> 0) | 0); return pc; }], // MODU
  0x17: [1, 1, (pc) => { push((-pop()) | 0); return pc; }], // NEG
  0x18: [2, 1, (pc) => { const [a, b] = pop2(); push(a & b); return pc; }], // AND
  0x19: [2, 1, (pc) => { const [a, b] = pop2(); push(a | b); return pc; }], // OR
  0x1a: [2, 1, (pc) => { const [a, b] = pop2(); push(a ^ b); return pc; }], // XOR
  0x1b: [1, 1, (pc) => { push(~pop()); return pc; }], // NOT
  0x1c: [2, 1, (pc) => { const [a, b] = pop2(); push(a << (b & 31)); return pc; }], // SHL
  0x1d: [2, 1, (pc) => { const [a, b] = pop2(); push(a >> (b & 31)); return pc; }], // SHR
  0x1e: [2, 1, (pc) => { const [a, b] = pop2(); push((a >>> (b & 31)) | 0); return pc; }], // SHRU
  0x20: [2, 1, (pc) => { const [a, b] = pop2(); push(a === b ? 1 : 0); return pc; }], // EQ
  0x21: [2, 1, (pc) => { const [a, b] = pop2(); push(a < b ? 1 : 0); return pc; }], // LT
  0x22: [2, 1, (pc) => { const [a, b] = pop2(); push((a >>> 0) < (b >>> 0) ? 1 : 0); return pc; }], // LTU
  0x30: [2, 0, (pc) => { const rel = inputBuf[pc + 1] | (inputBuf[pc + 2] << 8); return pc + 3 + rel; }], // JMP
  0x31: [1, 0, (pc) => { if (pop() === 0) { const rel = inputBuf[pc + 1] | (inputBuf[pc + 2] << 8); return pc + 3 + rel; } return pc + 3; }], // JZ
  0x32: [1, 0, (pc) => { if (pop() !== 0) { const rel = inputBuf[pc + 1] | (inputBuf[pc + 2] << 8); return pc + 3 + rel; } return pc + 3; }], // JNZ
  0x33: [2, 1, (pc) => { if (csp >= 64) traps[7](7); push(pc + 3); pc = readU32LE(); return pc; }], // CALL
  0x34: [0, 1, (pc) => { if (csp === 0) traps[8](8); pc = C[--csp]; return pc; }], // RET
  0x40: [0, 1, (pc) => { const addr = D[sp - 1]; if (addr < 0 || addr > 255) traps[6](6); push(M[addr]); return pc; }], // LOAD
  0x41: [0, 1, (pc) => { const addr = D[sp - 1]; const v = D[sp - 2]; if (addr < 0 || addr > 255) traps[6](6); sp -= 2; M[addr] = v; return pc; }], // STORE
  0x50: [0, 1, (pc) => { const v = pop(); const str = v < 0 ? '-' : v.toString(); if (olen + str.length > 65536) traps[11](11); for (const ch of str) output[olen++] = ch.charCodeAt(0); return pc; }], // PRINT
  0x51: [0, 1, (pc) => { const v = pop() & 255; if (olen >= 65536) traps[11](11); output[olen++] = v; return pc; }], // PUTC
  0x52: [0, 1, (pc) => { push(ip < inputBuf.length ? inputBuf[ip++] : -1); return pc; }], // IN
  0x53: [0, 1, (pc) => { const v = pop() & 255; traps[0](v); return pc; }], // EXIT
};

function run(program: Uint8Array, input: Uint8Array): void {
  inputBuf = input; ip = 0; sp = 0; csp = 0; pc = 0; steps = 0; olen = 0;
  for (let i = 0; i < 256; i++) M[i] = 0;

  while (true) {
    if (steps++ === 1000000) traps[10](10);
    if (pc < 0 || pc >= program.length) traps[9](9);
    const opcode = program[pc];
    if (!(opcode in ops)) traps[5](5);
    const [pops, pushes, exec] = ops[opcode];
    const immBytes = opcode <= 0x02 ? opcode + 1 : opcode <= 0x1e ? 2 : opcode <= 0x33 ? 2 : opcode <= 0x41 ? 1 : 0;
    if (pc + immBytes > program.length) traps[9](9);
    const next = pc + 1 + immBytes;
    if (sp < pops) traps[2](2);
    if (sp - pops + pushes > 256) traps[3](3);
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
  const stdoutPath = `${outputDir}/${id}/stdout.bin`;
  const exitPath = `${outputDir}/${id}/exit.txt`;
  const program = fs.readFileSync(progPath);
  const input = fs.readFileSync(inPath);
  run(program, input);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(stdoutPath, Buffer.from(output.subarray(0, olen)));
  fs.writeFileSync(exitPath, '0\n');
}
