/* =============================================================================
 * render.js —— 票面渲染器（canvas，纯函数式）
 * 渲染顺序：底图 -> 文字字段 -> 装饰（虚线框、下划线、二维码）
 * 文字定位规则：把「文字的实际墨迹包围盒」放进字段的 box 里（居中/左/右对齐），
 * 因此 box 就等于原票上量到的墨迹框，版面天然 1:1。
 * ========================================================================== */
(function (global) {
  'use strict';

  var CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

  function familyFor(ch, field, fonts) {
    if (CJK_RE.test(ch)) return fonts.cjk;
    return fonts[field.font] || fonts.num;
  }

  function sizeFor(ch, field) {
    var base = field.size;
    if (field.small && field.small.chars && field.small.chars.indexOf(ch) >= 0) {
      return base * field.small.ratio;
    }
    return base;
  }

  function fontStr(ch, field, fonts) {
    var size = sizeFor(ch, field);
    var style = field.italic ? 'italic ' : '';
    var weight = field.weight || 400;
    return style + weight + ' ' + size.toFixed(2) + 'px ' + familyFor(ch, field, fonts);
  }

  /* 把一段文字拆成「字符 -> 版面参数」并算好字间距，再给出墨迹包围盒。
     fitSpacing：把「主字」（未被 small.chars 命中的字）均匀铺到目标宽度，
                 单个间距有上限；主字太少就撑开、字太多就自动收紧——这样
                 短站名保留原票的宽字距，长站名也不会溢出票面。 */
  function layoutText(ctx, field, value, fonts) {
    var chars = Array.from(value == null ? '' : String(value));
    var sx = field.scaleX || 1;
    var items = [];
    var i;

    /* 1) 逐字量测（字宽与墨迹偏移和间距无关） */
    for (i = 0; i < chars.length; i++) {
      var ch = chars[i];
      var chSize = sizeFor(ch, field);
      var font = fontStr(ch, field, fonts);
      ctx.font = font;
      var m = ctx.measureText(ch);
      items.push({
        ch: ch,
        font: font,
        size: chSize,
        w: m.width * sx,
        inkL: -(m.actualBoundingBoxLeft || 0) * sx,
        inkR: (m.actualBoundingBoxRight || m.width) * sx,
        asc: m.actualBoundingBoxAscent || 0,
        desc: m.actualBoundingBoxDescent || 0
      });
    }

    /* 2) 字间距 */
    var smallChars = (field.small && field.small.chars) || '';
    var emSpacing = (field.spacing || 0) * field.size * sx;
    var gaps = [];
    for (i = 0; i + 1 < items.length; i++) {
      var sp = emSpacing;
      if (smallChars.indexOf(chars[i + 1]) >= 0 && field.small.spacingBefore != null) {
        sp = field.small.spacingBefore * field.size * sx;
      }
      gaps.push(sp);
    }

    var fs = field.fitSpacing;
    if (fs && items.length > 1) {
      var mainIdx = [];
      for (i = 0; i < chars.length; i++) {
        if (smallChars.indexOf(chars[i]) < 0) mainIdx.push(i);
      }
      var contiguous = mainIdx.length > 1;
      for (i = 1; i < mainIdx.length; i++) {
        if (mainIdx[i] !== mainIdx[i - 1] + 1) contiguous = false;
      }
      if (contiguous) {
        var first = mainIdx[0];
        var last = mainIdx[mainIdx.length - 1];
        var pos = 0, left = 0, right = 0;
        for (i = 0; i <= last; i++) {
          if (i === first) left = pos + items[i].inkL;
          if (i === last) { right = pos + items[i].inkR; break; }
          pos += items[i].w;            // 间距按 0 计算，得到「自然宽度」
        }
        var ngap = last - first;
        var cap = (fs.max != null ? fs.max : 1) * field.size * sx;
        var px = ngap > 0 ? (fs.width - (right - left)) / ngap : 0;
        px = Math.max(0, Math.min(px, cap));
        for (i = first; i < last; i++) gaps[i] = px;
      }
    }

    /* 3) 排位 */
    var pen = 0;
    var placed = [];
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      placed.push({
        ch: it.ch,
        font: it.font,
        size: it.size,
        x: pen,
        w: it.w,
        inkL: pen + it.inkL,
        inkR: pen + it.inkR,
        asc: it.asc,
        desc: it.desc
      });
      pen += it.w + (gaps[i] || 0);
    }

    if (!placed.length) return null;

    var inkL = Infinity, inkR = -Infinity, asc = 0, desc = 0;
    for (i = 0; i < placed.length; i++) {
      inkL = Math.min(inkL, placed[i].inkL);
      inkR = Math.max(inkR, placed[i].inkR);
      asc = Math.max(asc, placed[i].asc);
      desc = Math.max(desc, placed[i].desc);
    }
    return { items: placed, inkL: inkL, inkR: inkR, asc: asc, desc: desc, scaleX: sx };
  }

  /* 文字比允许宽度宽时等比缩小字号（墨迹宽度与字号成正比），最多迭代两次保证精确。
     允许宽度默认就是字段自己的 box.w —— 也就是「不能超格」：任何长度的输入
     都会被压回框内，绝不会盖到别的字段或跑出票面。
     两个例外：
       maxWidth —— 显式指定阈值，完全覆盖 box.w；
       fitMin   —— 阈值下限，用于「框宽会变，但字号别跟着变」的字段
                   （检票口的框在「检票 / 候车」之间切换，字号必须保持一致）。 */
  function fitSize(ctx, field, value, fonts) {
    var cap;
    if (field.maxWidth != null) cap = field.maxWidth;
    else if (field.box) cap = Math.max(field.box.w, field.fitMin || 0);
    else cap = Infinity;
    if (!(cap > 0) || !isFinite(cap)) return field;
    var f = field;
    for (var i = 0; i < 2; i++) {
      var lay = layoutText(ctx, f, value, fonts);
      if (!lay) return f;
      var w = lay.inkR - lay.inkL;
      if (w <= cap + 0.5) return f;
      var next = Object.create(f);
      next.size = f.size * (cap / w);
      if (next.size === f.size) return f;
      f = next;
    }
    return f;
  }

  /* 字段实际渲染的文本 = 固定前缀 + 可编辑值 + 固定后缀。
     前缀可以由 prefixSource 指定的取值动态决定（如「无 / 检票: / 候车:」）。 */
  function resolvedPrefix(field, values) {
    if (field.prefixSource && values && values[field.prefixSource] != null) {
      return values[field.prefixSource];
    }
    return field.prefix || '';
  }

  function fieldText(field, values) {
    var v = values && values[field.id] != null ? values[field.id] : field.value;
    return resolvedPrefix(field, values) + (v == null ? '' : v) + (field.suffix || '');
  }

  /* 找底图配置（含原图取景区域与画布落位） */
  function findBackground(layout, id) {
    var list = layout.backgrounds || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return list[0] || null;
  }

  function fieldById(layout, id) {
    var fs = layout.fields || [];
    for (var i = 0; i < fs.length; i++) if (fs[i].id === id) return fs[i];
    return null;
  }

  /* 字段的「实际宽度」可以随取值变化（如检票口 / 候车的框宽随下拉选择而变），
     规则是 widthFrom:{ field:'serial', byPrefix:{ '检票:':0.5, '候车:':1 } }：
     取参照字段 box.w 的一定比例，并保持自己的右边界不变。 */
  function applyWidthFrom(layout, field, values) {
    var rule = field.widthFrom;
    if (!rule) return field;
    var src = fieldById(layout, rule.field);
    if (!src || !src.box) return field;
    var key = '';
    if (field.prefixSource && values) key = values[field.prefixSource] || '';
    var ratio = (rule.byPrefix && rule.byPrefix[key] != null) ? rule.byPrefix[key] : 1;
    var w = src.box.w * ratio;
    if (Math.abs(w - field.box.w) < 0.01) return field;
    var f = Object.create(field);
    f.box = {
      x: field.box.x + field.box.w - w,   // 右边界保持不动
      y: field.box.y, w: w, h: field.box.h
    };
    return f;
  }

  /* 当前底图下字段的最终形态 = 动态宽度 + 该底图的局部覆盖 */
  function fieldFor(layout, field, bgId, values) {
    var f = applyWidthFrom(layout, field, values);
    var bg = findBackground(layout, bgId);
    var ov = bg && bg.fieldOverrides && bg.fieldOverrides[field.id];
    if (!ov) return f;
    var o = Object.create(f);
    for (var k in ov) if (k !== 'absolute') o[k] = ov[k];
    o.__absolute = !!ov.absolute;
    return o;
  }

  /* 数据层整体偏移：底图标了 centerData 时，把「数据字段的包围盒」水平居中到票面。
     只统计数据字段（文字 + 圆章），二维码 / 虚线框 / 箭头这类装饰不参与，
     否则二维码的位置会把整层带偏。红票没有这个标记，所以坐标一点不动。 */
  function dataOffset(layout, bgId) {
    var bg = findBackground(layout, bgId);
    if (!bg || !bg.centerData || !bg.dst) return { x: 0, y: 0 };
    var x0 = Infinity, x1 = -Infinity;
    var fs = layout.fields || [];
    for (var i = 0; i < fs.length; i++) {
      var t = fs[i].type;
      if (t === 'qr' || t === 'dashed' || t === 'arrow') continue;
      if (!fs[i].box) continue;
      var ff = fieldFor(layout, fs[i], bgId, null);
      x0 = Math.min(x0, ff.box.x);
      x1 = Math.max(x1, ff.box.x + ff.box.w);
    }
    if (!isFinite(x0) || !isFinite(x1)) return { x: 0, y: 0 };
    var dx = (bg.dst.x + bg.dst.w / 2) - (x0 + x1) / 2;
    return { x: Math.round(dx * 100) / 100, y: 0 };
  }

  /* 某个字段是否跟随数据层偏移（覆盖里标了 absolute 的钉死在票面坐标上） */
  function isAbsolute(layout, field, bgId) {
    var bg = findBackground(layout, bgId);
    var ov = bg && bg.fieldOverrides && bg.fieldOverrides[field.id];
    return !!(ov && ov.absolute);
  }

  /* 计算字段排版结果（画布坐标）：文字墨迹、基线，以及可编辑段的横向范围 */
  function spanFor(ctx, field, value, fonts) {
    var text = (field.prefix || '') + (value == null ? '' : value) + (field.suffix || '');
    var eff = fitSize(ctx, field, text, fonts);
    var lay = layoutText(ctx, eff, text, fonts);
    if (!lay) return null;
    var box = field.box;
    var inkW = lay.inkR - lay.inkL;
    var inkH = lay.asc + lay.desc;
    var dx;
    if (field.align === 'left') dx = box.x - lay.inkL;
    else if (field.align === 'right') dx = box.x + box.w - lay.inkR;
    else dx = box.x + (box.w - inkW) / 2 - lay.inkL;
    var baseline = box.y + (box.h - inkH) / 2 + lay.asc + (field.dy || 0);
    var n = (field.prefix || '').length;
    var end = lay.items.length - (field.suffix || '').length;
    var out = {
      x0: dx + lay.inkL, x1: dx + lay.inkR,
      y: box.y, h: box.h, baseline: baseline, inkW: inkW, inkH: inkH
    };
    if (n < end) {
      out.x0 = dx + lay.items[n].inkL;        // 可编辑段起点（跳过固定前缀）
      out.x1 = dx + lay.items[end - 1].inkR;  // 可编辑段终点（跳过固定后缀）
    } else {
      /* 可编辑值为空：把输入框放在固定前缀与后缀之间 */
      out.x0 = n > 0 ? dx + lay.items[n - 1].inkR : dx + lay.inkL;
      out.x1 = end < lay.items.length ? dx + lay.items[end].inkL : out.x0 + 40;
    }
    return out;
  }

  function drawText(ctx, field, value, fonts, color) {
    var eff = fitSize(ctx, field, value, fonts);
    var lay = layoutText(ctx, eff, value, fonts);
    if (!lay) return;
    var box = field.box;
    var inkW = lay.inkR - lay.inkL;
    var inkH = lay.asc + lay.desc;
    var dx;
    if (field.align === 'left') dx = box.x - lay.inkL;
    else if (field.align === 'right') dx = box.x + box.w - lay.inkR;
    else dx = box.x + (box.w - inkW) / 2 - lay.inkL;
    var baseline = box.y + (box.h - inkH) / 2 + lay.asc + (field.dy || 0);
    var sx = lay.scaleX;

    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    for (var i = 0; i < lay.items.length; i++) {
      var it = lay.items[i];
      ctx.font = it.font;
      ctx.save();
      ctx.translate(dx + it.x, baseline);
      if (sx !== 1) ctx.scale(sx, 1);
      ctx.fillText(it.ch, 0, 0);
      /* 轻微加粗：同色描一圈细边（比直接加字重更克制，也能跨字体生效） */
      if (eff.stroke) {
        ctx.lineWidth = Math.max(0.4, eff.stroke * it.size) / Math.max(sx, 0.2);
        ctx.strokeText(it.ch, 0, 0);
      }
      ctx.restore();
    }
    ctx.restore();
    return { inkL: lay.inkL + dx, inkR: lay.inkR + dx, top: baseline - lay.asc, bottom: baseline + lay.desc };
  }

  function drawDashed(ctx, field, color) {
    var b = field.box;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = field.lineWidth || 2;
    ctx.setLineDash(field.dash || [7, 5]);
    ctx.strokeRect(b.x + ctx.lineWidth / 2, b.y + ctx.lineWidth / 2, b.w - ctx.lineWidth, b.h - ctx.lineWidth);
    ctx.restore();
  }

  /* 车次下方的装饰线：实线 + 末端只有上半支的箭头（与参考票一致） */
  function drawArrow(ctx, field, color) {
    var b = field.box;
    var y = b.y + b.h / 2;
    var head = Math.min(field.headLength || 16, b.w * 0.6);
    var half = field.headHalf || 5.5;
    var lw = field.lineWidth || 2.6;
    var x0 = b.x;
    var x1 = b.x + b.w;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    if (field.headFull) {
      /* 需要完整箭头时（上下两支）打开这个开关 */
      ctx.beginPath();
      ctx.moveTo(x1 - head, y + half);
      ctx.lineTo(x1, y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(x1 - head, y - half);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.restore();
  }

  /* 圆圈单字章（如「惠」）；支持并排多个 */
  function drawSeal(ctx, field, value, color, fonts) {
    var chars = Array.isArray(value)
      ? value.filter(Boolean)
      : String(value == null ? '' : value).split(/[\s,]+/).filter(Boolean);
    if (!chars.length) return;
    if (field.maxCount) chars = chars.slice(0, field.maxCount);
    var step = field.box.w * (field.gap || 1.14);
    for (var i = 0; i < chars.length; i++) {
      drawOneSeal(ctx, field, chars[i], color, fonts, field.box.x + i * step);
    }
  }

  function drawOneSeal(ctx, field, ch, color, fonts, x) {
    var b = field.box;
    var cx = x + b.w / 2;
    var cy = b.y + b.h / 2;
    var lw = field.ringWidth || 2.6;
    var r = Math.min(b.w, b.h) / 2 - lw / 2;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    var size = r * 2 * (field.charRatio || 0.62);
    ctx.font = (field.weight || 400) + ' ' + size.toFixed(2) + 'px ' + fonts.cjk;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, cx, cy + size * 0.04);
    ctx.restore();
  }

  function drawQr(ctx, field, qrImage, content) {
    var b = field.box;
    ctx.save();
    if (qrImage && qrImage.complete !== false) {
      ctx.drawImage(qrImage, b.x, b.y, b.w, b.h);
    } else if (content && global.QRCode) {
      var side = Math.min(b.w, b.h);
      var info = global.QRCode.draw(ctx, content, b.x + (b.w - side) / 2, b.y + (b.h - side) / 2,
        side, '#241c17', field.qrEcc || 'M');
      qrMeta = { content: content, version: info.version, modules: info.size, moduleSize: info.moduleSize };
    } else {
      ctx.fillStyle = 'rgba(36,28,23,0.05)';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = 'rgba(36,28,23,0.35)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(36,28,23,0.45)';
      ctx.font = '400 26px ' + 'SimHei,"Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('二维码', b.x + b.w / 2, b.y + b.h / 2);
    }
    ctx.restore();
  }

  /* 最后一次二维码渲染的元信息，供界面显示（内容 / 版本 / 模块数） */
  var qrMeta = null;

  function qrContent(layout, field, values) {
    var src = field.qrSource;
    var tail = src && values[src] != null ? values[src] : '';
    return (field.qrPrefix || '') + tail;
  }

  /* 取某字段当前的值（用于 showWhen 依赖判断） */
  function valueOf(layout, values, id) {
    var list = layout.fields;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return values[id] != null ? values[id] : list[i].value;
    }
    return '';
  }

  /* showWhen 指定的依赖字段为空时，本字段整体不渲染（如车次为空则箭头也隐藏） */
  function isVisible(layout, field, values) {
    if (!field.showWhen) return true;
    var v = valueOf(layout, values, field.showWhen);
    return v != null && String(v).trim().length > 0;
  }

  /**
   * 渲染整张票。
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} opts {layout, values, bgImage, qrImage, scale, hideId, guides}
   */
  function renderTicket(ctx, opts) {
    var layout = opts.layout;
    var values = opts.values || {};
    var fonts = layout.fonts;
    var scale = opts.scale || 1;
    var W = layout.canvas.width;
    var H = layout.canvas.height;

    ctx.save();
    ctx.scale(scale, scale);
    ctx.clearRect(0, 0, W, H);

    if (opts.bgImage) {
      var bg = findBackground(layout, opts.bgId);
      if (bg && bg.src && bg.dst) {
        ctx.drawImage(opts.bgImage,
          bg.src.x, bg.src.y, bg.src.w, bg.src.h,
          bg.dst.x, bg.dst.y, bg.dst.w, bg.dst.h);
      } else {
        ctx.drawImage(opts.bgImage, 0, 0, W, H);
      }
    }

    var fields = layout.fields;
    var i, f, color;
    var off = dataOffset(layout, opts.bgId);
    qrMeta = null;

    /* 每个字段按「动态宽度 + 底图覆盖 + 数据层偏移」定位；absolute 的字段不吃偏移 */
    function place(field) {
      var ff = fieldFor(layout, field, opts.bgId, values);
      var abs = ff.__absolute || isAbsolute(layout, field, opts.bgId);
      ctx.save();
      if (!abs && (off.x || off.y)) ctx.translate(off.x, off.y);
      return ff;
    }

    // 先画装饰性框线，再画文字，避免压字
    for (i = 0; i < fields.length; i++) {
      f = fields[i];
      if (f.type !== 'dashed' && f.type !== 'arrow') continue;
      if (!isVisible(layout, f, values)) continue;
      color = f.color === 'accent' ? layout.accent : layout.ink;
      var fd = place(f);
      if (fd.type === 'dashed') drawDashed(ctx, fd, color);
      else drawArrow(ctx, fd, color);
      ctx.restore();
    }
    for (i = 0; i < fields.length; i++) {
      f = fields[i];
      if (f.type === 'dashed' || f.type === 'arrow') continue;
      var val = values[f.id] != null ? values[f.id] : f.value;
      if (f.type === 'qr') {
        var tail = f.qrSource && values[f.qrSource] != null ? String(values[f.qrSource]).trim() : '';
        var fq = place(f);
        drawQr(ctx, fq, opts.qrImage, tail ? qrContent(layout, f, values) : '');
        ctx.restore();
        continue;
      }
      if (f.type === 'seal') {
        var fsl = place(f);
        drawSeal(ctx, fsl, val, fsl.color === 'accent' ? layout.accent : layout.ink, fonts);
        ctx.restore();
        continue;
      }
      if (opts.hideId && f.id === opts.hideId) continue;
      /* 整段文字（含固定前后缀）为空才跳过：所以 ¥ / 元 / 检票: 默认就显示 */
      var full = fieldText(f, values);
      if (!full) continue;
      if (!isVisible(layout, f, values)) continue;
      color = f.color === 'accent' ? layout.accent : layout.ink;
      var ft = place(f);
      drawText(ctx, ft, full, fonts, color);
      ctx.restore();
    }

    ctx.restore();
  }

  /* 供校准/调试使用：返回某字段渲染后的墨迹包围盒 */
  function measureField(ctx, layout, field, value) {
    ctx.save();
    var color = field.color === 'accent' ? layout.accent : layout.ink;
    var r = drawText(ctx, field, value, layout.fonts, color);
    ctx.restore();
    return r;
  }

  global.TicketRenderer = {
    renderTicket: renderTicket,
    measureField: measureField,
    layoutText: layoutText,
    fieldText: fieldText,
    resolvedPrefix: resolvedPrefix,
    findBackground: findBackground,
    fieldFor: fieldFor,
    dataOffset: dataOffset,
    isAbsolute: isAbsolute,
    spanFor: spanFor,
    qrContent: qrContent,
    qrMeta: function () { return qrMeta; }
  };
})(window);
