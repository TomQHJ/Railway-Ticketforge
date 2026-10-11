/* =============================================================================
 * app.js —— 编辑器交互层
 *   · canvas 负责像素级还原票面（导出即所见）
 *   · 透明热区负责点击选择字段，就地输入框负责所见即所得地改字
 * ========================================================================== */
(function () {
  'use strict';

  var L = window.TICKET_LAYOUT;
  var R = window.TicketRenderer;
  var W = L.canvas.width;
  var H = L.canvas.height;
  var DPR = 2;

  var el = {
    stage: document.getElementById('stage'),
    wrap: document.getElementById('stageWrap'),
    canvas: document.getElementById('ticket'),
    hits: document.getElementById('hits'),
    area: document.getElementById('stageArea'),
    scroll: document.getElementById('stageScroll'),
    panel: document.getElementById('panelBody'),
    toast: document.getElementById('toast'),
    sizeInfo: document.getElementById('sizeInfo')
  };

  var state = {
    values: {},
    guides: true,
    editing: null,
    qrImage: null,
    bgImage: null,
    bgId: null,
    scale: 1
  };

  /* ------------------------------------------------------------------ 工具 */
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.classList.remove('show'); }, 2000);
  }

  function textFields() {
    return L.fields.filter(function (f) { return !f.type; });
  }

  /* 面板要展示的数据字段：普通文字字段 + 圆章这类可选装饰 */
  function dataFields() {
    return L.fields.filter(function (f) { return !f.type || f.type === 'seal'; });
  }

  /* options 支持字符串或 {value,label} 两种写法 */
  function optionValue(o) { return (o && typeof o === 'object') ? o.value : o; }
  function optionLabel(o) { return (o && typeof o === 'object') ? (o.label != null ? o.label : o.value) : o; }
  function optionValues(f) { return (f.options || []).map(optionValue); }

  function fieldById(id) {
    for (var i = 0; i < L.fields.length; i++) if (L.fields[i].id === id) return L.fields[i];
    return null;
  }

  /* 取一个临时字段副本，把动态前缀固化下来（供 spanFor 等只认 field 的接口使用） */
  function withPrefix(f, pfx) {
    var o = Object.create(f);
    o.prefix = pfx == null ? '' : pfx;
    return o;
  }

  function defaultValues() {
    var v = {};
    dataFields().forEach(function (f) {
      v[f.id] = f.value;
      if (f.prefixSource) v[f.prefixSource] = f.prefix || '';
    });
    return v;
  }

  /* --------------------------------------------------------------- 渲染 */
  var ctx = el.canvas.getContext('2d');

  function resizeCanvas() {
    el.canvas.width = W * DPR;
    el.canvas.height = H * DPR;
    el.canvas.style.width = W + 'px';
    el.canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    R.renderTicket(ctx, {
      layout: L,
      values: state.values,
      bgImage: state.bgImage,
      bgId: state.bgId,
      qrImage: state.qrImage,
      scale: 1,
      hideId: state.editing
    });
    updateQrText();
  }

  /* ------------------------------------------------------------ 底图切换 */
  var loadingTimer = null;

  function showLoading(on) {
    var m = document.getElementById('loadingMask');
    if (!m) return;
    if (on) {
      m.hidden = false;
      requestAnimationFrame(function () { m.classList.add('show'); });
    } else {
      m.classList.remove('show');
      clearTimeout(loadingTimer);
      loadingTimer = setTimeout(function () { m.hidden = true; }, 220);
    }
  }

  function loadBackground(id, animate) {
    var bg = R.findBackground(L, id);
    if (!bg) return;
    var changed = state.bgId !== bg.id;
    state.bgId = bg.id;
    refreshBgButtons();
    var started = Date.now();
    var MIN_MS = 420;              // 动画至少显示这么久，避免一闪而过
    if (animate && changed) showLoading(true);

    function done() {
      var wait = Math.max(0, MIN_MS - (Date.now() - started));
      if (animate && changed) setTimeout(function () { showLoading(false); }, wait);
    }

    var inline = window.TICKET_BGS && window.TICKET_BGS[bg.id];
    var img = new Image();
    img.onload = function () {
      state.bgImage = img;
      buildHits();      // 蓝票/CR450 的数据层有整体偏移，热区要跟着重建
      draw();
      done();
    };
    img.onerror = function () { toast('底图加载失败：' + bg.file); done(); };
    img.src = inline || bg.file;
  }

  function refreshBgButtons() {
    var box = document.getElementById('bgSwitch');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.dataset.id === state.bgId);
    });
  }

  function buildBgSwitch() {
    var box = document.getElementById('bgSwitch');
    (L.backgrounds || []).forEach(function (bg) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = bg.id;
      b.textContent = bg.label;
      b.title = bg.label + '（' + bg.file + '）';
      b.addEventListener('click', function () { loadBackground(bg.id, true); });
      box.appendChild(b);
    });
    refreshBgButtons();
  }

  /* 自适应缩放：用「票面滚动容器」的真实内容盒算比例，
     所以票面永远完整落在可视区里，不会出现滚动条。
     容器里已经留好了左侧切换按钮和底部抽屉标题栏的空间（都在 padding 里）。 */
  function fit() {
    var box = el.scroll || el.area;
    /* 留 10px 余量：元素缩放后的视觉盒可能比容器大几个像素，
       余量不足会溢出（容器已设 overflow:hidden，但留余量更稳妥） */
    var aw = box.clientWidth - 10;
    var ah = box.clientHeight - 10;
    if (aw <= 0 || ah <= 0) return;
    var s = Math.min(aw / W, ah / H);
    /* 不再限制最小 0.25：窗口再小也要完整显示，而不是靠滚动条 */
    s = Math.max(0.05, Math.min(s, 2));
    state.scale = s;
    el.stage.style.transform = 'scale(' + s + ')';
    el.wrap.style.width = (W * s) + 'px';
    el.wrap.style.height = (H * s) + 'px';
    el.sizeInfo.textContent = '票面 ' + W + '×' + H + '  ·  显示 ' + Math.round(s * 100) + '%';
  }

  /* 窄屏时面板是底部抽屉：舞台要预留出抽屉占的高度，
     票面随之缩小，始终完整可见（而不是被抽屉盖住）。 */
  function drawerMode() {
    return window.matchMedia('(max-width: 940px)').matches;
  }

  function panelCollapsed() {
    var p = document.getElementById('panel');
    return !!(p && p.classList.contains('collapsed'));
  }

  function drawerHeight() {
    return Math.round(window.innerHeight * 0.52);
  }

  function syncLayout() {
    if (el.area) {
      var padBottom = 24;
      if (drawerMode()) padBottom = panelCollapsed() ? 74 : drawerHeight() + 18;
      el.area.style.paddingBottom = padBottom + 'px';
    }
    fit();
  }

  function togglePanel(force) {
    var p = document.getElementById('panel');
    if (!p) return;
    var collapsed = force != null ? force : !p.classList.contains('collapsed');
    p.classList.toggle('collapsed', collapsed);
    var btn = document.getElementById('panelToggle');
    if (btn) {
      btn.textContent = collapsed ? '展开' : '收起';
      btn.setAttribute('aria-expanded', String(!collapsed));
    }
    var t = document.getElementById('btnPanel');
    if (t) t.setAttribute('aria-expanded', String(!collapsed));
    syncLayout();
    setTimeout(syncLayout, 280);   // 抽屉动画结束后再校一次
  }

  /* --------------------------------------------------------------- 热区 */
  function buildHits() {
    el.hits.innerHTML = '';
    var off = R.dataOffset(L, state.bgId);
    L.fields.forEach(function (f) {
      /* 按当前底图 / 当前取值解析字段的最终 box（宽度可能随下拉变化，蓝票还有覆盖） */
      var ff = R.fieldFor(L, f, state.bgId, state.values);
      var abs = R.isAbsolute(L, f, state.bgId);
      var dx = abs ? 0 : off.x;
      var dy = abs ? 0 : off.y;
      var d = document.createElement('div');
      d.className = 'hit' + (f.editable ? ' editable' : ' locked');
      var w = ff.box.w;
      /* 多选圆章：热区覆盖整排 */
      if (ff.type === 'seal' && ff.multi) {
        w = ff.box.w * (1 + ((ff.maxCount || 1) - 1) * (ff.gap || 1.14));
      }
      d.style.left = (ff.box.x + dx) + 'px';
      d.style.top = (ff.box.y + dy) + 'px';
      d.style.width = w + 'px';
      d.style.height = ff.box.h + 'px';
      d.dataset.id = f.id;
      d.title = f.label + (f.options && f.options.length ? '（点击切换固定文案）'
        : (R.resolvedPrefix(f, state.values) ? '（点击编辑「' + R.resolvedPrefix(f, state.values) + '」后面的内容）'
          : (f.editable ? '（点击编辑）' : '（固定文案，不可编辑）')));
      d.addEventListener('click', function () { onHitClick(f); });
      el.hits.appendChild(d);
    });
  }

  function onHitClick(f) {
    if (f.type === 'qr') {
      document.getElementById('fileQr').click();
      return;
    }
    if (f.options && f.options.length) {
      cycleOption(f);
      return;
    }
    if (!f.editable) {
      toast('「' + (state.values[f.id] || f.value) + '」是固定文案，不可编辑');
      return;
    }
    startInlineEdit(f, el.hits.querySelector('.hit[data-id="' + f.id + '"]'));
    highlightPanel(f.id);
  }

  /* 固定文案 + 多选项：点票面即在选项间循环切换 */
  function cycleOption(f, dir) {
    var list = optionValues(f);
    if (f.multi) {
      /* 多选：依次点亮下一个未选项，全部选满后再点则清空 */
      var cur = Array.isArray(state.values[f.id]) ? state.values[f.id].slice() : [];
      var nextIdx = -1;
      for (var i = 1; i <= list.length; i++) {
        var cand = list[(list.indexOf(cur[cur.length - 1]) + i + list.length) % list.length];
        if (cur.indexOf(cand) < 0) { nextIdx = list.indexOf(cand); break; }
      }
      if (nextIdx < 0) {
        cur = [];
        toast('已清空圆章');
      } else {
        cur.push(list[nextIdx]);
        toast('已添加圆章「' + optionLabel(f.options[nextIdx]) + '」');
      }
      state.values[f.id] = cur;
      syncPanelInput(f.id);
      highlightPanel(f.id);
      draw();
      return;
    }
    var idx = list.indexOf(state.values[f.id]);
    if (idx < 0) idx = 0;
    var next = (idx + (dir || 1) + list.length) % list.length;
    state.values[f.id] = list[next];
    syncPanelInput(f.id);
    highlightPanel(f.id);
    draw();
    var label = optionLabel(f.options[next]);
    toast(label ? '已切换为「' + label + '」' : '已关闭（不添加）');
  }

  /* --------------------------------------------------------- 就地编辑 */
  var inlineInput = null;

  function stopInlineEdit(commit) {
    if (!inlineInput) return;
    var f = fieldById(inlineInput.dataset.id);
    if (commit && f) {
      var v = inlineInput.value;
      /* 多段字段在票面上是整行编辑，提交时把分隔符归一化回固定格式 */
      if (f.split && f.split.parts > 1) {
        var parts = v.trim().split(/\s+/);
        if (parts.length === f.split.parts) v = parts.join(f.split.sep);
      }
      state.values[f.id] = v;
      syncPanelInput(f.id);
    }
    inlineInput.remove();
    inlineInput = null;
    state.editing = null;
    draw();
  }

  function startInlineEdit(f, hitEl) {
    stopInlineEdit(true);
    /* 用「当前底图 + 当前取值」下的最终字段（宽度可能随下拉变化），并叠加数据层偏移 */
    var fEff = R.fieldFor(L, f, state.bgId, state.values);
    var off = R.isAbsolute(L, f, state.bgId) ? { x: 0, y: 0 } : R.dataOffset(L, state.bgId);
    var box = fEff.box;
    var w = Math.max(box.w + 60, 120);
    var h = Math.max(box.h + 10, 30);
    var left = box.x + box.w / 2 - w / 2;
    /* 带固定前缀的字段：输入框只覆盖前缀后面的可编辑部分 */
    var pfx = R.resolvedPrefix(f, state.values);
    if (pfx || f.suffix) {
      var span = R.spanFor(ctx, withPrefix(fEff, pfx), state.values[f.id], L.fonts);
      if (span && span.x1 > span.x0) {
        var pad = 12;
        w = Math.max(span.x1 - span.x0 + pad * 2, 84);
        left = span.x0 - pad;
      }
    }
    left += off.x;
    var top = box.y + box.h / 2 - h / 2 + off.y;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-edit';
    input.dataset.id = f.id;
    input.value = state.values[f.id] != null ? state.values[f.id] : f.value;
    input.style.left = left + 'px';
    input.style.top = top + 'px';
    input.style.width = w + 'px';
    input.style.height = h + 'px';
    input.style.lineHeight = h + 'px';
    input.style.fontSize = Math.round(f.size * (f.small ? 0.85 : 0.9)) + 'px';
    input.style.letterSpacing = (f.spacing ? f.spacing * f.size : 0).toFixed(1) + 'px';
    input.style.fontFamily = L.fonts[f.font] || L.fonts.num;
    input.style.fontWeight = f.weight || 400;
    input.style.transform = 'scaleX(' + (f.scaleX || 1) + ')';
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); stopInlineEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); stopInlineEdit(false); }
    });
    input.addEventListener('blur', function () { stopInlineEdit(true); });
    input.addEventListener('input', function () { highlightPanel(f.id); syncPanelInput(f.id, input.value); });
    el.stage.appendChild(input);
    inlineInput = input;
    state.editing = f.id;
    draw();
    input.focus();
    input.select();
  }

  /* --------------------------------------------------------------- 面板 */
  var panelInputs = {};

  function buildPanel() {
    el.panel.innerHTML = '';
    panelInputs = {};
    var groups = L.groups || [];
    var rest = dataFields().filter(function (f) {
      return !groups.some(function (g) { return g.id === f.group; });
    });

    groups.forEach(function (g) {
      var list = dataFields().filter(function (f) { return f.group === g.id; });
      if (!list.length && g.id !== 'deco') return;
      el.panel.appendChild(groupTitle(g.title));
      list.forEach(function (f) { el.panel.appendChild(fieldRow(f)); });
      if (g.id === 'deco') appendQrSection();
    });
    if (rest.length) {
      el.panel.appendChild(groupTitle('其他'));
      rest.forEach(function (f) { el.panel.appendChild(fieldRow(f)); });
    }
  }

  /* 二维码相关控件（接在「装饰」分组里） */
  function appendQrSection() {
    var qrField = fieldById('qr') || {};
    // var qrRow = document.createElement('div');
    // qrRow.className = 'field';
    // qrRow.innerHTML =
    //   '<label><span>二维码内容</span><span class="tag">自动生成</span></label>' +
    //   '<div class="qr-text" id="qrText">—</div>' +
    //   '<div class="hint">由「车次」自动拼接：' + (qrField.qrPrefix || '') + ' + 车次，改车次即时更新。</div>';
    // el.panel.appendChild(qrRow);

    var qrImgRow = document.createElement('div');
    qrImgRow.className = 'field';
    qrImgRow.innerHTML =
      '<label><span>二维码图片</span><span class="tag">可选替换</span></label>' +
      '<label class="filebtn" style="width:100%;text-align:center;padding:7px 0">选择图片<input type="file" id="fileQr" accept="image/*"></label>' +
      '<div class="hint">默认按上面的内容实时生成二维码；也可以上传图片覆盖。</div>';
    el.panel.appendChild(qrImgRow);
    qrImgRow.querySelector('#fileQr').addEventListener('change', onQrFile);

    var qrResetRow = document.createElement('div');
    qrResetRow.className = 'field';
    var resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.id = 'btnQrAuto';
    resetBtn.textContent = '改回自动生成';
    resetBtn.style.width = '100%';
    resetBtn.addEventListener('click', function () {
      state.qrImage = null;
      draw();
      toast('二维码已改回自动生成');
    });
    qrResetRow.appendChild(resetBtn);
    el.panel.appendChild(qrResetRow);
  }

  /* 刷新面板里显示的二维码内容 */
  function updateQrText() {
    var box = document.getElementById('qrText');
    if (!box) return;
    var f = fieldById('qr');
    if (!f) return;
    var text = R.qrContent(L, f, state.values);
    var meta = R.qrMeta();
    box.textContent = text;
    var info = document.getElementById('qrInfo');
    if (!info) {
      info = document.createElement('div');
      info.id = 'qrInfo';
      info.className = 'hint';
      box.parentNode.appendChild(info);
    }
    info.textContent = state.qrImage
      ? '当前使用上传的图片（不再自动生成）'
      : (meta ? 'QR 版本 ' + meta.version + ' · ' + meta.modules + '×' + meta.modules +
        ' 模块 · 模块边长 ' + meta.moduleSize + 'px' : '');
  }

  function groupTitle(t) {
    var d = document.createElement('div');
    d.className = 'group-title';
    d.textContent = t;
    return d;
  }

  function fieldRow(f) {
    var row = document.createElement('div');
    var hasOptions = !!(f.options && f.options.length);
    row.className = 'field' + (f.editable || hasOptions ? '' : ' locked');
    row.dataset.id = f.id;
    var tag = hasOptions ? (f.type === 'seal' ? '可选装饰' : '固定·下拉选择')
      : (f.editable ? '可编辑' : '固定');
    row.innerHTML = '<label><span>' + f.label + '</span><span class="tag">' + tag + '</span></label>';

    var input;
    if (hasOptions && f.control === 'chips') {
      /* 多选圆章：一组可点亮的按钮 */
      var chips = document.createElement('div');
      chips.className = 'chips';
      var chipEls = [];
      f.options.forEach(function (o) {
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'chip';
        c.dataset.value = optionValue(o);
        c.textContent = optionLabel(o);
        c.addEventListener('click', function () {
          var cur = Array.isArray(state.values[f.id]) ? state.values[f.id].slice() : [];
          var v = optionValue(o);
          var i = cur.indexOf(v);
          if (i >= 0) cur.splice(i, 1); else cur.push(v);
          state.values[f.id] = cur;
          syncPanelInput(f.id);
          draw();
        });
        chipEls.push(c);
        chips.appendChild(c);
      });
      row.appendChild(chips);
      var hintC = document.createElement('div');
      hintC.className = 'hint';
      hintC.textContent = '可多选，最多 ' + (f.maxCount || f.options.length) +
        ' 个，按选择顺序并排显示；点票面圆章位置也可快速添加';
      row.appendChild(hintC);
      panelInputs[f.id] = { row: row, input: chips, chips: chipEls };
      return row;
    }
    if (hasOptions) {
      input = document.createElement('select');
      input.className = 'sel';
      f.options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = optionValue(o);
        opt.textContent = optionLabel(o);
        input.appendChild(opt);
      });
      input.value = state.values[f.id] != null ? state.values[f.id] : f.value;
      input.addEventListener('change', function () {
        state.values[f.id] = input.value;
        draw();
      });
      input.addEventListener('focus', function () { highlightPanel(f.id); });
    } else if (f.split && f.split.parts > 1) {
      /* 拆成多段独立编辑，段与段之间用固定分隔符连接 */
      buildSplitRow(row, f);
      return row;
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = state.values[f.id] != null ? state.values[f.id] : f.value;
      input.readOnly = !f.editable;
      input.addEventListener('input', function () {
        state.values[f.id] = input.value;
        draw();
      });
      input.addEventListener('focus', function () { selectField(f, true); });
      if (f.prefixSource) {
        /* 前缀由下拉框选择（无 / 检票: / 候车:），输入框只填后面的内容 */
        var psel = document.createElement('select');
        psel.className = 'sel';
        (f.prefixOptions || []).forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = optionValue(o);
          opt.textContent = optionLabel(o);
          psel.appendChild(opt);
        });
        psel.value = R.resolvedPrefix(f, state.values);
        psel.addEventListener('change', function () {
          state.values[f.prefixSource] = psel.value;
          /* 检票口 / 候车的框宽随选择变化：热区跟着重建 */
          buildHits();
          draw();
        });
        psel.addEventListener('focus', function () { highlightPanel(f.id); });
        row.appendChild(psel);
        row.appendChild(input);
        input.placeholder = '填冒号后面的内容（可不填）';
        var hintS = document.createElement('div');
        hintS.className = 'hint';
        // hintS.textContent = '前缀可选「无 / 检票 / 候车」；本项非必填，导出时可以不填';
        row.appendChild(hintS);
        panelInputs[f.id] = { row: row, input: input, prefixSelect: psel };
        return row;
      }
      if (f.prefix || f.suffix) {
        if (f.editable) {
          var fixed = [f.prefix ? '「' + f.prefix + '」' : '', f.suffix ? '「' + f.suffix + '」' : '']
            .filter(Boolean).join('和');
          var hintP = document.createElement('div');
          hintP.className = 'hint';
          // hintP.textContent = fixed + '为票面固定文字，此处只填中间内容';
          row.appendChild(hintP);
        }
        row.appendChild(input);
        panelInputs[f.id] = { row: row, input: input };
        return row;
      }
    }
    row.appendChild(input);
    if (f.prefix) {
      var hint2 = document.createElement('div');
      hint2.className = 'hint';
      // hint2.textContent = '「' + f.prefix + '」为固定文字，只能改后面的内容';
      row.appendChild(hint2);
    }
    if (hasOptions) {
      var hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = f.type === 'seal'
        ? '可选装饰，默认不添加；点票面圆章位置也可快速切换'
        : '固定文案，点票面对应文字也可快速切换';
      row.appendChild(hint);
    }
    panelInputs[f.id] = { row: row, input: input };
    return row;
  }

  function splitParts(f, value) {
    var sep = (f.split && f.split.sep) || '   ';
    var raw = String(value == null ? '' : value).trim();
    if (!raw) {
      var empty = [];
      for (var i = 0; i < f.split.parts; i++) empty.push('');
      return empty;
    }
    var parts = raw.split(/\s+/);
    if (parts.length !== f.split.parts) return null;
    return parts;
  }

  /* 多段独立编辑（如底部条码号：编码 + 尾号） */
  function buildSplitRow(row, f) {
    var parts = splitParts(f, state.values[f.id]);
    if (!parts) {
      /* 数据里没有分隔符时降级为单个输入框，避免打不开编辑 */
      var single = document.createElement('input');
      single.type = 'text';
      single.value = state.values[f.id] != null ? state.values[f.id] : f.value;
      single.addEventListener('input', function () {
        state.values[f.id] = single.value;
        draw();
      });
      row.appendChild(single);
      panelInputs[f.id] = { row: row, input: single };
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'split-row' + (f.split.parts > 2 ? ' multi' : '');
    var inputs = [];
    parts.forEach(function (p, i) {
      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'sep';
        // sep.textContent = '空格×' + ((f.split.sep || '   ').length);
        wrap.appendChild(sep);
      }
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.value = p;
      inp.title = (f.split.labels && f.split.labels[i]) || ('第 ' + (i + 1) + ' 段');
      inp.addEventListener('input', function () { commitSplit(f, inputs); });
      inp.addEventListener('focus', function () { highlightPanel(f.id); });
      inputs.push(inp);
      wrap.appendChild(inp);
    });
    row.appendChild(wrap);
    var hint = document.createElement('div');
    hint.className = 'hint';
    // hint.textContent = (f.split.labels || []).join(' / ') +
    //   ' 分开编辑，两段之间固定 ' + (f.split.sep || '   ').length + ' 个空格';
    row.appendChild(hint);
    panelInputs[f.id] = { row: row, input: inputs[0], inputs: inputs };
  }

  function commitSplit(f, inputs) {
    var parts = inputs.map(function (i) { return i.value.trim(); });
    state.values[f.id] = parts.some(function (p) { return p.length; })
      ? parts.join(f.split.sep || '   ')
      : '';
    draw();
  }

  function syncPanelInput(id, value) {
    var p = panelInputs[id];
    if (!p) return;
    var v = value != null ? value : state.values[id];
    var f = fieldById(id);
    if (p.prefixSelect && f) p.prefixSelect.value = R.resolvedPrefix(f, state.values);
    if (p.chips) {
      var cur = Array.isArray(v) ? v : [];
      p.chips.forEach(function (c) {
        c.classList.toggle('on', cur.indexOf(c.dataset.value) >= 0);
      });
      return;
    }
    if (p.inputs) {
      var fp = fieldById(id);
      var parts = splitParts(fp, v);
      if (parts) {
        for (var i = 0; i < p.inputs.length && i < parts.length; i++) p.inputs[i].value = parts[i];
      }
      return;
    }
    p.input.value = v;
  }

  function highlightPanel(id) {
    var p = panelInputs[id];
    if (!p) return;
    p.row.classList.add('flash');
    setTimeout(function () { p.row.classList.remove('flash'); }, 700);
  }

  function selectField(f, scroll) {
    if (state.editing !== f.id) {
      stopInlineEdit(true);
      highlightPanel(f.id);
    }
    if (scroll) {
      var p = panelInputs[f.id];
      if (p) p.row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /* --------------------------------------------------------------- 交互 */
  function onQrFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        state.qrImage = img;
        draw();
        toast('二维码图片已更新');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  /* --------------------------------------------------- 必填校验 / 弹窗 */
  /* 需要用户填写的字段：可编辑的文字字段（editable:false 的固定文案、
     装饰圆章不算）。可用 required:false 单独豁免。 */
  function requiredFields() {
    return dataFields().filter(function (f) {
      if (f.editable === false) return false;
      if (f.type === 'seal') return false;
      return f.required !== false;
    });
  }

  function isFilled(f, v) {
    if (f.split && f.split.parts > 1) {
      var parts = splitParts(f, v);
      return !!parts && parts.every(function (p) { return p.trim().length > 0; });
    }
    return v != null && String(v).trim().length > 0;
  }

  function missingFields() {
    return requiredFields().filter(function (f) {
      return !isFilled(f, state.values[f.id]);
    });
  }

  function showRequiredDialog(list) {
    var mask = document.getElementById('modalMask');
    var ul = document.getElementById('modalList');
    ul.innerHTML = '';
    list.forEach(function (f) {
      var li = document.createElement('li');
      li.textContent = f.label;
      li.addEventListener('click', function () {
        closeModal();
        highlightPanel(f.id);
        var p = panelInputs[f.id];
        if (p) {
          p.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
          if (p.inputs) p.inputs[0].focus(); else p.input.focus();
        }
      });
      ul.appendChild(li);
    });
    document.getElementById('modalCount').textContent = list.length;
    mask.hidden = false;
  }

  function closeModal() {
    document.getElementById('modalMask').hidden = true;
  }

  /* ------------------------------------------------------------ 导出保存
   * 自写保存逻辑：不再触发浏览器的「下载」，而是用 File System Access 拿到
   * 一个目录句柄（默认直接指向用户的「下载」文件夹），之后每张票都用
   * getFileHandle + createWritable 直接写进去 —— 不弹下载条、不产生
   * 「保留/丢弃」提示，也不再受 file:// 下 blob 下载被静默丢弃的影响。
   * 只在用户授权那一刻弹一次目录选择；句柄与授权状态会记住（内存 + IndexedDB）。
   */
  var lastExport = null;
  var dirHandle = null;          // 本会话记住的目录句柄

  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(',');
    var mime = (parts[0].match(/:(.*?);/) || [, 'application/octet-stream'])[1];
    var bin = atob(parts[1]);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* ---- 目录句柄的记住 / 恢复（IndexedDB，失败不影响使用） ---- */
  function idb() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('no idb')); return; }
      var rq = indexedDB.open('ticket-editor', 1);
      rq.onupgradeneeded = function () {
        if (!rq.result.objectStoreNames.contains('kv')) rq.result.createObjectStore('kv');
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });
  }

  function idbSet(key, val) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () { /* 记不住就算了 */ });
  }

  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('kv', 'readonly');
        var rq = tx.objectStore('kv').get(key);
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { rej(rq.error); };
      });
    }).catch(function () { return null; });
  }

  /* 取得可写目录：授权根目录下再建/复用一级 Ticket 子目录，
     最终文件都落在「下载/Ticket/」里，不再和下载文件夹里的其它文件混在一起。 */
  var SUBDIR = 'Ticket';
  var outDirHandle = null;      // <根目录>/Ticket

  function ensureDir() {
    var opts = { id: 'ticket-export', mode: 'readwrite', startIn: 'downloads' };
    if (typeof window.showDirectoryPicker !== 'function') return Promise.resolve(null);

    function sub(root) {
      return root.getDirectoryHandle(SUBDIR, { create: true }).then(function (d) {
        dirHandle = root;
        outDirHandle = d;
        return d;
      });
    }

    function ask() {
      /* 必须在用户手势里同步发起 */
      return window.showDirectoryPicker(opts).then(function (h) {
        idbSet('dir', h);
        return sub(h);
      });
    }

    function verify(h) {
      if (!h || !h.queryPermission) return Promise.resolve(null);
      return h.queryPermission({ mode: 'readwrite' }).then(function (s) {
        if (s === 'granted') return h;
        return h.requestPermission({ mode: 'readwrite' }).then(function (s2) {
          return s2 === 'granted' ? h : null;
        });
      }).catch(function () { return null; });
    }

    if (!dirHandle) return ask();
    return verify(dirHandle).then(function (h) {
      if (!h) { dirHandle = null; outDirHandle = null; return ask(); }
      if (outDirHandle) return outDirHandle;
      return sub(h);
    });
  }

  function writeInto(dir, blob, filename) {
    return dir.getFileHandle(filename, { create: true }).then(function (fh) {
      return fh.createWritable().then(function (w) {
        return w.write(blob).then(function () { return w.close(); });
      });
    });
  }

  /* 兜底一：系统「另存为」对话框 */
  function pickerSave(blob, filename, kind, onDone) {
    if (typeof window.showSaveFilePicker !== 'function') return false;
    var types = kind === 'json'
      ? [{ description: 'JSON 文件', accept: { 'application/json': ['.json'] } }]
      : [{ description: 'PNG 图片', accept: { 'image/png': ['.png'] } }];
    try {
      window.showSaveFilePicker({ suggestedName: filename, types: types })
        .then(function (h) {
          return h.createWritable().then(function (w) {
            return w.write(blob).then(function () { return w.close(); });
          }).then(function () { if (onDone) onDone('picker', h.name); });
        })
        .catch(function (err) {
          if (err && err.name === 'AbortError') { if (onDone) onDone('cancel'); return; }
          if (onDone) onDone('fail');
        });
      return true;
    } catch (e) {
      return false;
    }
  }

  /* 兜底二：走浏览器自己的下载（手机端 / Firefox / Safari 都靠它）。
     部署到 https 后 blob 下载是正常可用的；file:// 下 Chrome 会静默丢弃，
     所以桌面上优先用上面的目录写入。 */
  function browserDownload(blob, filename, onDone) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);   // 部分浏览器要求节点在文档里才触发
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 10000);
    if (onDone) onDone('download');
  }

  function saveBlob(blob, filename, kind) {
    showExportResult(blob, filename, kind);

    function viaFallback(reason) {
      /* 目录写入不可用 / 失败 → 自动退回「另存为」→ 再退回浏览器下载 */
      pickerSave(blob, filename, kind, function (how, name) {
        if (how === 'cancel') { toast('已取消保存'); return; }
        if (how === 'picker') {
          toast('已保存：' + name);
          if (lastExport) lastExport.saved = true;
          refreshExportResult();
          return;
        }
        browserDownload(blob, filename, function () {
          toast('已调用浏览器下载：' + filename);
          if (lastExport) { lastExport.saved = true; lastExport.via = 'download'; }
          refreshExportResult();
        });
      }) || browserDownload(blob, filename, function () {
        toast((reason ? reason + '，' : '') + '已调用浏览器下载：' + filename);
        if (lastExport) { lastExport.saved = true; lastExport.via = 'download'; }
        refreshExportResult();
      });
    }

    ensureDir().then(function (dir) {
      if (!dir) throw new Error('nodir');
      return writeInto(dir, blob, filename).then(function () {
        toast('已保存到「' + (dirHandle ? dirHandle.name : '') + '/' + SUBDIR + '」：' + filename);
        if (lastExport) { lastExport.saved = true; lastExport.via = 'dir'; }
        refreshExportResult();
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') { toast('已取消保存'); return; }
      if (err && err.message === 'nodir') {
        viaFallback('当前浏览器不支持直接写入文件夹');
      } else {
        viaFallback('直接写入失败');
      }
    });
  }

  function showExportResult(blob, filename, kind) {
    if (lastExport && lastExport.url) URL.revokeObjectURL(lastExport.url);
    lastExport = { blob: blob, filename: filename, kind: kind, url: URL.createObjectURL(blob), saved: false };
    refreshExportResult();
  }

  function refreshExportResult() {
    var box = document.getElementById('exportResult');
    if (!lastExport) { box.hidden = true; return; }
    var e = lastExport;
    box.hidden = false;
    box.innerHTML = '';
    var line = document.createElement('div');
    var where = '';
    if (e.saved && e.via === 'dir') where = '<br>已直接写入「' + (dirHandle ? dirHandle.name : '') + '/' + SUBDIR + '」文件夹';
    else if (e.saved && e.via === 'download') where = '<br>已调用浏览器下载';
    line.innerHTML = '上次导出：<b>' + e.filename + '</b>（' + humanSize(e.blob.size) + '）' + where;
    var acts = document.createElement('div');
    acts.className = 'acts';

    var again = document.createElement('button');
    again.type = 'button';
    again.textContent = e.saved ? '再存一次' : '保存到文件夹';
    again.addEventListener('click', function () { saveBlob(e.blob, e.filename, e.kind); });
    acts.appendChild(again);

    var open = document.createElement('a');
    open.href = e.url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = '新标签页打开';
    acts.appendChild(open);

    var as = document.createElement('button');
    as.type = 'button';
    as.textContent = '另存为…';
    as.addEventListener('click', function () {
      if (typeof window.showSaveFilePicker !== 'function') { toast('当前浏览器不支持「另存为」'); return; }
      var types = e.kind === 'json'
        ? [{ description: 'JSON 文件', accept: { 'application/json': ['.json'] } }]
        : [{ description: 'PNG 图片', accept: { 'image/png': ['.png'] } }];
      window.showSaveFilePicker({ suggestedName: e.filename, types: types }).then(function (h) {
        return h.createWritable().then(function (w) {
          return w.write(e.blob).then(function () { return w.close(); });
        }).then(function () { toast('已保存：' + h.name); });
      }).catch(function () { /* 取消 */ });
    });
    acts.appendChild(as);

    box.appendChild(line);
    box.appendChild(acts);
  }

  /* 文件名里的非法字符替换掉，避免保存失败 */
  function safeName(s) {
    return String(s == null ? '' : s)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 80);
  }

  function exportPng() {
    /* 票面信息全部必填（gate 等 required:false 的除外）：缺项就弹窗列出，不导出 */
    var missing = missingFields();
    if (missing.length) {
      showRequiredDialog(missing);
      return;
    }
    var k = parseInt(document.getElementById('pngScale').value, 10) || 2;
    var white = document.getElementById('pngWhite').checked;
    var cv = document.createElement('canvas');
    cv.width = W * k;
    cv.height = H * k;
    var c = cv.getContext('2d');
    if (white) {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, cv.width, cv.height);
    }
    R.renderTicket(c, {
      layout: L, values: state.values, bgImage: state.bgImage, bgId: state.bgId,
      qrImage: state.qrImage, scale: k
    });
    /* 文件名 = 用户输入的车次 + 模板后缀：
       红票 车次.png、蓝票 车次-blue.png、CR450 车次-CR450.png
       —— 三张模板可以依次导出，不会互相覆盖 */
    var bgNow = R.findBackground(L, state.bgId);
    var suffix = (bgNow && bgNow.fileSuffix) || '';
    var filename = (safeName(state.values.trainNo) || 'ticket') + suffix + '.png';
    try {
      // 同步取 dataURL -> Blob，保证仍在点击手势内调用「另存为」
      saveBlob(dataUrlToBlob(cv.toDataURL('image/png')), filename, 'png');
    } catch (err) {
      toast('导出失败：' + err.message);
    }
  }

  function exportJson() {
    var data = {
      version: L.version,
      canvas: L.canvas,
      paper: L.paper,
      fonts: L.fonts,
      ink: L.ink,
      accent: L.accent,
      fields: L.fields.map(function (f) {
        var o = JSON.parse(JSON.stringify(f));
        if (!f.type) o.value = state.values[f.id];
        return o;
      })
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    saveBlob(blob, 'ticket-layout.json', 'json');
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        (data.fields || []).forEach(function (nf) {
          var f = fieldById(nf.id);
          if (!f) return;
          if (f.options && f.options.length) {
            var ok = Array.isArray(nf.value)
              ? nf.value.filter(function (v) { return optionValues(f).indexOf(v) >= 0; })
              : (optionValues(f).indexOf(nf.value) >= 0 ? nf.value : null);
            if (ok != null) state.values[f.id] = ok;
            syncPanelInput(f.id);
            return;
          }
          if (f.editable === false) return;
          if (nf.value != null) state.values[f.id] = nf.value;
          if (nf.box) f.box = nf.box;
          syncPanelInput(f.id);
        });
        buildHits();
        draw();
        toast('已导入 JSON');
      } catch (e) {
        toast('JSON 解析失败：' + e.message);
      }
    };
    reader.readAsText(file);
  }

  /* --------------------------------------------------------------- 启动 */
  function boot() {
    /* ?bg=blue 可直接指定初始底图 */
    state.values = defaultValues();
    var wantBg = (location.search.match(/[?&]bg=([\w-]+)/) || [])[1];
    state.bgId = R.findBackground(L, wantBg) ? wantBg : (L.backgrounds && L.backgrounds[0] ? L.backgrounds[0].id : 'red');
    resizeCanvas();
    buildHits();
    buildPanel();
    buildBgSwitch();
    fit();
    draw();
    loadBackground(state.bgId, false);
    /* 恢复上次记住的导出目录（授权状态在真正保存时再校验） */
    idbGet('dir').then(function (h) { if (h && h.queryPermission) dirHandle = h; });

    document.getElementById('btnGuides').addEventListener('click', function () {
      state.guides = !state.guides;
      this.classList.toggle('on', state.guides);
      el.stage.classList.toggle('guides', state.guides);
    });
    document.getElementById('btnClear').addEventListener('click', function () {
      state.values = defaultValues();
      Object.keys(panelInputs).forEach(function (id) { syncPanelInput(id); });
      draw();
      toast('已清空可编辑内容');
    });
    document.getElementById('btnPng').addEventListener('click', exportPng);
    document.getElementById('btnJsonOut').addEventListener('click', exportJson);
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('modalMask').addEventListener('click', function (e) {
      if (e.target === this) closeModal();
    });
    document.getElementById('fileJson').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importJson(e.target.files[0]);
      e.target.value = '';
    });
    /* 面板：窄屏是底部抽屉，两个入口都能展开 / 收起 */
    var panelToggle = document.getElementById('panelToggle');
    if (panelToggle) {
      panelToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        togglePanel();
      });
    }
    var panelHead = document.getElementById('panelHead');
    if (panelHead) {
      panelHead.addEventListener('click', function (e) {
        if (!drawerMode()) return;
        if (e.target.closest('input, select, textarea, a')) return;
        togglePanel();
      });
    }
    var btnPanel = document.getElementById('btnPanel');
    if (btnPanel) {
      btnPanel.addEventListener('click', function () {
        if (!drawerMode()) {
          /* 宽屏下面板本来就在，按钮用来把焦点送进面板 */
          var first = el.panel.querySelector('input, select');
          if (first) first.focus();
          return;
        }
        togglePanel();
      });
    }

    /* 尺寸变化就重新自适应：窗口、面板抽屉、容器自身都算在内 */
    window.addEventListener('resize', syncLayout);
    window.addEventListener('orientationchange', function () { setTimeout(syncLayout, 120); });
    if (window.ResizeObserver) {
      new ResizeObserver(function () { fit(); }).observe(el.scroll || el.area);
    }
    syncLayout();
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!document.getElementById('modalMask').hidden) { closeModal(); return; }
        if (state.editing) stopInlineEdit(false);
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
