/* =============================================================================
 * qrcode.js —— 极简 QR Code 编码器（无依赖、离线可用）
 * -----------------------------------------------------------------------------
 * 支持：字节模式(Byte)、纠错等级 L/M/Q/H、版本 1~40 自动选择、8 种掩码按
 *      标准罚分自动挑选。仅供本项目生成票面二维码使用。
 * 对外接口：
 *   QRCode.encode(text, ecl) -> { size, modules }   modules[y][x] === true 表示黑点
 *   QRCode.draw(ctx, text, x, y, size, color, ecl)  在 canvas 上按整数模块尺寸绘制
 * ========================================================================== */
(function (global) {
  'use strict';

  /* 每个纠错块的纠错码字数（下标 = 版本号，0 位占位） */
  var ECC_CODEWORDS_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  };

  /* 纠错块数量 */
  var NUM_ERROR_CORRECTION_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 5, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  };

  var ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  /* ---------------- GF(256) 运算 ---------------- */
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
  }

  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var d = 0; d < degree; d++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ result.shift();
      result.push(0);
      for (var j = 0; j < divisor.length; j++) result[j] ^= gfMul(divisor[j], factor);
    }
    return result;
  }

  /* ---------------- 容量计算 ---------------- */
  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
  }

  function alignPositions(ver) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return out;
  }

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  /* ---------------- 编码 ---------------- */
  function encode(text, ecl) {
    ecl = ECL_FORMAT_BITS[ecl] != null ? ecl : 'M';
    var bytes = utf8Bytes(String(text));
    var version, bits = [];

    function appendBits(val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    }

    for (version = 1; version <= 40; version++) {
      var need = 4 + (version < 10 ? 8 : 16) + bytes.length * 8;
      if (need <= numDataCodewords(version, ecl) * 8) break;
    }
    if (version > 40) throw new Error('二维码内容过长');

    var dataCapacityBits = numDataCodewords(version, ecl) * 8;
    appendBits(0x4, 4);
    appendBits(bytes.length, version < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) appendBits(bytes[i], 8);
    appendBits(0, Math.min(4, dataCapacityBits - bits.length));
    appendBits(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < dataCapacityBits; pad ^= 0xEC ^ 0x11) appendBits(pad, 8);

    var dataCw = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
      dataCw.push(v);
    }

    /* 分块 + RS 纠错 + 交织 */
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][version];
    var rawCodewords = Math.floor(numRawDataModules(version) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);
    var blocks = [];
    var p = 0;
    for (var bi = 0; bi < numBlocks; bi++) {
      var datLen = shortBlockLen - blockEccLen + (bi < numShortBlocks ? 0 : 1);
      var dat = dataCw.slice(p, p + datLen);
      p += datLen;
      var ecc = rsRemainder(dat, rsDivisor(blockEccLen));
      if (bi < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var allCw = [];
    for (var idx = 0; idx < blocks[0].length; idx++) {
      for (var b2 = 0; b2 < blocks.length; b2++) {
        if (idx !== shortBlockLen - blockEccLen || b2 >= numShortBlocks) allCw.push(blocks[b2][idx]);
      }
    }

    /* 矩阵 */
    var size = version * 4 + 17;
    var modules = [], isFn = [];
    for (var y0 = 0; y0 < size; y0++) {
      modules.push(new Array(size).fill(false));
      isFn.push(new Array(size).fill(false));
    }
    function setFn(x, y, dark) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = dark;
      isFn[y][x] = true;
    }
    function drawFinder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
        }
      }
    }
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);
    for (var t = 0; t < size; t++) {
      setFn(6, t, t % 2 === 0);
      setFn(t, 6, t % 2 === 0);
    }
    var ap = alignPositions(version);
    var na = ap.length;
    for (var ai = 0; ai < na; ai++) {
      for (var aj = 0; aj < na; aj++) {
        if ((ai === 0 && aj === 0) || (ai === 0 && aj === na - 1) || (ai === na - 1 && aj === 0)) continue;
        for (var dy2 = -2; dy2 <= 2; dy2++) {
          for (var dx2 = -2; dx2 <= 2; dx2++) {
            setFn(ap[ai] + dx2, ap[aj] + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
          }
        }
      }
    }

    function drawFormat(mask) {
      var data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
      var rem = data;
      for (var m = 0; m < 10; m++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var fbits = ((data << 10) | rem) ^ 0x5412;
      for (var a = 0; a <= 5; a++) setFn(8, a, getBit(fbits, a));
      setFn(8, 7, getBit(fbits, 6));
      setFn(8, 8, getBit(fbits, 7));
      setFn(7, 8, getBit(fbits, 8));
      for (var c = 9; c < 15; c++) setFn(14 - c, 8, getBit(fbits, c));
      for (var d = 0; d < 8; d++) setFn(size - 1 - d, 8, getBit(fbits, d));
      for (var e = 8; e < 15; e++) setFn(8, size - 15 + e, getBit(fbits, e));
      setFn(8, size - 8, true);
    }

    if (version >= 7) {
      var vrem = version;
      for (var vr = 0; vr < 12; vr++) vrem = (vrem << 1) ^ ((vrem >>> 11) * 0x1F25);
      var vbits = (version << 12) | vrem;
      for (var vb = 0; vb < 18; vb++) {
        var bit = getBit(vbits, vb);
        var aa = size - 11 + vb % 3, bb = Math.floor(vb / 3);
        setFn(aa, bb, bit);
        setFn(bb, aa, bit);
      }
    }

    /* 先占位画一遍格式信息：让这 15 个模块 + 固定黑点被登记为功能图形，
       否则填数据时会被当成数据模块，导致数据位错位（扫不出来）。 */
    drawFormat(0);

    /* 数据区 */
    var bitIdx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var jj = 0; jj < 2; jj++) {
          var x = right - jj;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && bitIdx < allCw.length * 8) {
            modules[y][x] = getBit(allCw[bitIdx >>> 3], 7 - (bitIdx & 7));
            bitIdx++;
          }
        }
      }
    }

    function maskFn(mask, x, y) {
      switch (mask) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
        case 5: return (x * y) % 2 + (x * y) % 3 === 0;
        case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
        default: return (((x + y) % 2) + (x * y) % 3) % 2 === 0;
      }
    }

    function applyMask(mask) {
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          if (!isFn[y][x] && maskFn(mask, x, y)) modules[y][x] = !modules[y][x];
        }
      }
    }

    function penalty() {
      var score = 0, x, y, run, color;
      var P1 = '10111010000', P2 = '00001011101';
      for (y = 0; y < size; y++) {
        run = 1; color = modules[y][0];
        var rowStr = '';
        for (x = 0; x < size; x++) {
          rowStr += modules[y][x] ? '1' : '0';
          if (x > 0) {
            if (modules[y][x] === color) {
              run++;
              if (run === 5) score += 3; else if (run > 5) score += 1;
            } else { color = modules[y][x]; run = 1; }
          }
        }
        for (var s = 0; s + 11 <= size; s++) {
          var sub = rowStr.substr(s, 11);
          if (sub === P1 || sub === P2) score += 40;
        }
      }
      for (x = 0; x < size; x++) {
        run = 1; color = modules[0][x];
        var colStr = '';
        for (y = 0; y < size; y++) {
          colStr += modules[y][x] ? '1' : '0';
          if (y > 0) {
            if (modules[y][x] === color) {
              run++;
              if (run === 5) score += 3; else if (run > 5) score += 1;
            } else { color = modules[y][x]; run = 1; }
          }
        }
        for (var s2 = 0; s2 + 11 <= size; s2++) {
          var sub2 = colStr.substr(s2, 11);
          if (sub2 === P1 || sub2 === P2) score += 40;
        }
      }
      for (y = 0; y < size - 1; y++) {
        for (x = 0; x < size - 1; x++) {
          var c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
        }
      }
      var dark = 0;
      for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (modules[y][x]) dark++;
      var total = size * size;
      score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
      return score;
    }

    var bestMask = 0, bestScore = Infinity;
    for (var mk = 0; mk < 8; mk++) {
      applyMask(mk);
      drawFormat(mk);
      var sc = penalty();
      if (sc < bestScore) { bestScore = sc; bestMask = mk; }
      applyMask(mk); // 还原
    }
    applyMask(bestMask);
    drawFormat(bestMask);

    return { size: size, modules: modules, version: version, mask: bestMask, ecl: ecl };
  }

  /* 简单缓存：内容不变时不重复编码 */
  var cache = { text: null, ecl: null, result: null };

  function encodeCached(text, ecl) {
    if (cache.text === text && cache.ecl === ecl) return cache.result;
    var r = encode(text, ecl);
    cache.text = text;
    cache.ecl = ecl;
    cache.result = r;
    return r;
  }

  /**
   * 在 canvas 上绘制二维码。
   * 模块边长为整数像素以保证锐利；整体在 (x,y,size,size) 内居中。
   */
  function draw(ctx, text, x, y, size, color, ecl) {
    var qr = encodeCached(text, ecl);
    var moduleSize = Math.max(1, Math.floor(size / qr.size));
    var full = moduleSize * qr.size;
    var ox = x + Math.round((size - full) / 2);
    var oy = y + Math.round((size - full) / 2);
    ctx.save();
    ctx.fillStyle = color;
    for (var my = 0; my < qr.size; my++) {
      for (var mx = 0; mx < qr.size; mx++) {
        if (qr.modules[my][mx]) ctx.fillRect(ox + mx * moduleSize, oy + my * moduleSize, moduleSize, moduleSize);
      }
    }
    ctx.restore();
    return { size: qr.size, version: qr.version, moduleSize: moduleSize, ox: ox, oy: oy, full: full };
  }

  global.QRCode = { encode: encode, encodeCached: encodeCached, draw: draw };
})(window);
