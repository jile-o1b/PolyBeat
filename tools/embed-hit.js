// tools/embed-hit.js
// 把 hit.wav 处理成“可用的打击音”，并生成内嵌副本 js/hit.js
//   1. 去掉首尾静音（重要：否则每一下都会晚 150ms 左右）
//   2. 峰值归一化到 0.9
//   3. 补 1ms 淡入 / 8ms 淡出，避免爆音
//   4. 写回 hit.wav（处理后的版本），并生成 js/hit.js（base64）
//
// 用法：把新的 hit.wav 放到项目根目录，然后 node tools/embed-hit.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const WAV = path.join(root, 'hit.wav');
const OUT = path.join(root, 'js', 'hit.js');

const THRESHOLD = 30;      // 振幅阈值（16bit）
const PRE_ROLL_MS = 1;     // 起点前留一点，保住起振
const TAIL_MS = 12;        // 尾巴留一点
const TARGET_PEAK = 0.9;

function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 文件');
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('缺少 fmt 或 data 块');
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`目前只支持 16bit PCM，当前 format=${fmt.format} bits=${fmt.bits}`);
  }
  return { ...fmt, data };
}

function writeWav({ channels, sampleRate, samples }) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]))), 44 + i * 2);
  }
  return buf;
}

const raw = fs.readFileSync(WAV);
const wav = parseWav(raw);
const frameBytes = wav.channels * 2;
const frames = wav.data.length / frameBytes;

const total = frames * wav.channels;
const samples = new Int16Array(total);
for (let i = 0; i < total; i++) samples[i] = wav.data.readInt16LE(i * 2);

// 首尾有效范围
let first = 0;
let last = total - 1;
while (first < total && Math.abs(samples[first]) <= THRESHOLD) first++;
while (last > 0 && Math.abs(samples[last]) <= THRESHOLD) last--;

const preRoll = Math.round((PRE_ROLL_MS / 1000) * wav.sampleRate) * wav.channels;
const tail = Math.round((TAIL_MS / 1000) * wav.sampleRate) * wav.channels;
const start = Math.max(0, first - preRoll);
const end = Math.min(total, last + tail);

const slice = Array.from(samples.subarray(start, end));

// 归一化
let peak = 0;
for (const v of slice) peak = Math.max(peak, Math.abs(v));
const gain = peak > 0 ? (TARGET_PEAK * 32767) / peak : 1;
for (let i = 0; i < slice.length; i++) slice[i] *= gain;

// 淡入 / 淡出
const fadeIn = Math.round((1 / 1000) * wav.sampleRate) * wav.channels;
const fadeOut = Math.round((8 / 1000) * wav.sampleRate) * wav.channels;
for (let i = 0; i < fadeIn && i < slice.length; i++) slice[i] *= i / fadeIn;
for (let i = 0; i < fadeOut && i < slice.length; i++) {
  slice[slice.length - 1 - i] *= i / fadeOut;
}

const trimmed = writeWav({ channels: wav.channels, sampleRate: wav.sampleRate, samples: slice });
fs.writeFileSync(WAV, trimmed);

const b64 = trimmed.toString('base64');
const js = `/* 本文件由 tools/embed-hit.js 生成，请勿手改。
   来源：hit.wav（${wav.channels === 2 ? '立体声' : '单声道'} ${wav.sampleRate}Hz 16bit）
   已去除首尾静音并归一化，时长 ${(slice.length / wav.channels / wav.sampleRate * 1000).toFixed(0)}ms */
window.HIT_WAV_BASE64 = '${b64}';
`;
fs.writeFileSync(OUT, js, 'utf8');

const ms = (frames) => (frames / wav.channels / wav.sampleRate * 1000).toFixed(1);

console.log(`原始 ${frames} 帧 / ${ms(frames)} ms`);
console.log(`有效段 ${first}…${last} 帧（${ms(first)} → ${ms(last)} ms）`);
console.log(`裁出 ${slice.length / wav.channels} 帧（${ms(slice.length)} ms），归一化增益 x${gain.toFixed(2)}`);
console.log(`已写回 ${WAV}（${trimmed.length} 字节）`);
console.log(`已生成 ${OUT}（${Buffer.byteLength(js)} 字节）`);
