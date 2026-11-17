/* ==========================================================================
   zip.js · 极简 ZIP 读取器（给 RPE 的 .pez 用）
   .pez 就是一个 zip：谱面 json + 音乐 + 曲绘 + info.txt
   支持 stored(0) 与 deflate(8) 两种压缩方式
   ========================================================================== */

const Zip = (function () {
  const SIG_EOCD = 0x06054b50;
  const SIG_CEN = 0x02014b50;
  const SIG_LOC = 0x04034b50;

  function u16(d, o) { return d[o] | (d[o + 1] << 8); }
  function u32(d, o) {
    return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
  }

  function isZip(bytes) {
    if (!bytes || bytes.length < 4) return false;
    return bytes[0] === 0x50 && bytes[1] === 0x4b &&
      (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
  }

  /** 找到中央目录，返回条目列表 */
  function list(bytes) {
    const d = bytes;
    if (!isZip(d)) throw new Error('不是 zip 文件');

    let eocd = -1;
    const start = Math.max(0, d.length - 65558);
    for (let i = d.length - 22; i >= start; i--) {
      if (u32(d, i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('压缩包损坏（找不到目录）');

    const count = u16(d, eocd + 10);
    let off = u32(d, eocd + 16);
    const out = [];
    for (let i = 0; i < count; i++) {
      if (u32(d, off) !== SIG_CEN) break;
      const method = u16(d, off + 10);
      const csize = u32(d, off + 20);
      const usize = u32(d, off + 24);
      const nameLen = u16(d, off + 28);
      const extraLen = u16(d, off + 30);
      const commentLen = u16(d, off + 32);
      const localOff = u32(d, off + 42);
      const name = new TextDecoder('utf-8').decode(d.subarray(off + 46, off + 46 + nameLen));
      out.push({ name, method, csize, usize, localOff });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('这个浏览器不支持解压，请换新的 Chrome / Edge / Firefox'));
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then((buf) => new Uint8Array(buf));
  }

  /** 取出一个条目的原始字节 */
  function read(bytes, name) {
    const entry = list(bytes).find((e) => e.name === name);
    if (!entry) return Promise.reject(new Error('压缩包里没有 ' + name));

    const d = bytes;
    const o = entry.localOff;
    if (u32(d, o) !== SIG_LOC) return Promise.reject(new Error('条目损坏：' + name));

    const nameLen = u16(d, o + 26);
    const extraLen = u16(d, o + 28);
    const dataStart = o + 30 + nameLen + extraLen;
    const raw = d.subarray(dataStart, dataStart + entry.csize);
    const copy = new Uint8Array(raw.length);
    copy.set(raw);                    // 复制一份，buffer 就是干净的数据

    if (entry.method === 0) return Promise.resolve(copy);
    if (entry.method === 8) return inflateRaw(copy);
    return Promise.reject(new Error(`不支持的压缩方式 ${entry.method}：${name}`));
  }

  return { isZip, list, read };
})();
