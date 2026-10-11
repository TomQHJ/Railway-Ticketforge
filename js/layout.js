/* =============================================================================
 * 火车票版式定义 (layout.js)
 * -----------------------------------------------------------------------------
 * 坐标系：以底图 assets/ticket-blank.webp 的原始像素为准，画布 1062 x 720。
 *   - 票面（粉红纸面）区域 paper: x 53, y 49, w 966, h 623
 *   - 每个字段的 box 是「墨迹框」(ink box)：文字实际着墨的矩形，
 *     由参考票实拍图透视校正后逐像素量测得到（原图不随项目分发）。
 *   - 渲染器会把文字的实际墨迹精确对齐到该 box；size 与 scaleX 由
 *     tools/calibrate.html 自动校准（把渲染墨迹盒缩放到参考墨迹盒）。
 *
 * 默认值策略：所有「用户数据型」字段的 value 一律为空串，页面打开时票面是干净的；
 * 固定文案（usage / note1 / note2）与二维码前缀不受影响。
 *
 * 字段结构:
 *   id        唯一标识（同时是取值对象的 key）
 *   label     中文名（编辑面板用）
 *   group     面板分组
 *   box       {x,y,w,h} 墨迹框（画布像素）
 *   align     left | center | right   —— 文字与 box 的对齐方式
 *   font      非中日韩字符使用的字体：num（数字/字母）| cjk | pin（拼音衬线）
 *   size      字号（画布像素，已校准）
 *   scaleX    横向压缩系数（模拟票面印刷的窄体字，已校准）
 *   spacing   字间距，单位 em（相对 size），随 size / scaleX 一起缩放
 *   small     需要小一号显示的字符：{chars:'站', ratio:0.64, spacingBefore:0.04}
 *   editable  false 表示固定文案，不可编辑
 *   prefix    固定前缀，渲染在 value 前面（如「检票:」），编辑时只能改后半段
 *   suffix    固定后缀，渲染在 value 后面（如票价的「元」），同样不可编辑
 *   split     把 value 拆成多段独立编辑：{parts:2, sep:'   ', labels:['甲','乙']}
 *   stroke    轻微加粗：按字号比例描边一圈（0.015 ≈ 轻微加粗，不改字重）
 *   options   固定文案/装饰的可选项；面板里用下拉框选择
 *   showWhen  指定字段为空时本字段整体不渲染（如车次为空则不画箭头）
 *   value     当前默认内容（用户数据字段为空串）
 *   type      'text'(默认) | 'qr' | 'seal' | 'dashed' | 'arrow'
 * ========================================================================== */
(function (global) {
  'use strict';

  var FONTS = {
    cjk: '"SimHei","Heiti SC","Microsoft YaHei","PingFang SC","Noto Sans SC","Source Han Sans SC",sans-serif',
    num: '"Arial","Helvetica Neue",Helvetica,"Liberation Sans",sans-serif',
    pin: '"Times New Roman",Times,"Liberation Serif",Georgia,serif'
  };

  var LAYOUT = {
    version: 1,
    canvas: { width: 1062, height: 720 },
    paper: { x: 53, y: 49, w: 966, h: 623 },
    background: 'assets/ticket-blank.webp',

    /* 底图（票面样式）。src 是原图里要取的区域，dst 是落在画布上的位置。
       红票保持原样铺满画布；蓝票 / CR450 的原图较大（1735×1067），
       整张映射到票面区域，这样同一套版面坐标对三张图都成立。
       centerData：把「数据层」（所有字段）水平居中到票面（红票不设，保持原样）。
       fieldOverrides：某张底图对个别字段的覆盖（如蓝票的二维码要缩小）。 */
    backgrounds: [
      {
        id: 'red', label: '红票', file: 'assets/ticket-blank.webp',
        src: { x: 0, y: 0, w: 1062, h: 720 },
        dst: { x: 0, y: 0, w: 1062, h: 720 }
      },
      {
        id: 'blue', label: '蓝票', file: 'assets/Blue ticket.png',
        src: { x: 0, y: 0, w: 1735, h: 1067 },
        dst: { x: 53, y: 49, w: 966, h: 623 },
        centerData: true,
        fieldOverrides: {
          /* 二维码：上边 441、右边 972 不动，底边对齐固定文案虚线框的下沿（604），等比缩小 */
          qr: { absolute: true, box: { x: 809, y: 441, w: 163, h: 163 } }
        }
      },
      {
        id: 'cr450', label: 'CR450版', file: 'assets/CR450.png',
        src: { x: 0, y: 0, w: 1735, h: 1067 },
        dst: { x: 53, y: 49, w: 966, h: 623 },
        centerData: true,
        fieldOverrides: {
          qr: { absolute: true, box: { x: 809, y: 441, w: 163, h: 163 } }
        }
      }
    ],

    ink: '#241c17',
    accent: '#c2382a',
    fonts: FONTS,

    fields: [
      /* ---------- 顶部：票号 / 检票口 ---------- */
      {
        id: 'serial', label: '票号', group: 'ticket',
        box: { x: 87, y: 92, w: 339, h: 41 },
        align: 'center', font: 'num', size: 54.77, scaleX: 0.963, spacing: 0.164,
        color: 'accent', weight: 700, editable: true,
        value: ''
      },
      {
        id: 'gate', label: '检票口 / 候车', group: 'ticket',
        /* 右对齐（文字紧贴右边界）。右边界 971 是按原票「检票:」那行墨迹（791..969）
           反推的：right-aligned 时字形右侧还有约 2px 边距，所以框右边界放在 971 */
        box: { x: 801.5, y: 84, w: 169.5, h: 42 },
        align: 'right', font: 'cjk', size: 44.94, scaleX: 0.963, spacing: 0.163,
        weight: 700, editable: true, calibrate: false,
        /* 字号不随框宽变化：缩字阈值下限固定 190（原框宽），
           这样「检票 / 候车」切换时文字大小一模一样，只是框变宽变窄 */
        fitMin: 190,
        required: false,                 // 非必填：导出时可以不填
        /* 框宽随下拉选择变化（右边界不动）：
           检票 / 无 = 票号宽度的一半，候车 = 与票号一致 */
        widthFrom: { field: 'serial', byPrefix: { '': 0.5, '检票:': 0.5, '候车:': 1 } },
        /* 前缀由下拉框决定：无 / 检票: / 候车: */
        prefixSource: 'gatePrefix',
        prefix: '',
        prefixOptions: [
          { value: '', label: '无' },
          { value: '检票:', label: '检票' },
          { value: '候车:', label: '候车' }
        ],
        value: ''
      },

      /* ---------- 行程主行：出发站 / 车次 / 到达站 ---------- */
      {
        id: 'fromStation', label: '出发站', group: 'trip',
        /* 可编辑区宽度与「到达站」对齐（340）；中心点保持不变，所以文字位置不动 */
        box: { x: 64.5, y: 139, w: 340, h: 62 },
        align: 'center', font: 'cjk', size: 63.77, scaleX: 1.008, spacing: 1.176,
        weight: 700, editable: true, calibrate: false,
        /* 两字按原票撑开到 198.5 宽；字多了自动收紧，最长 360 不溢出票面 */
        fitSpacing: { width: 198.5, max: 1.176 },
        small: { chars: '站', ratio: 0.64, spacingBefore: 0.157 },
        value: ''
      },
      {
        id: 'fromPinyin', label: '出发站拼音', group: 'trip',
        /* 同上：宽度与「到达站拼音」对齐（233），中心点不变 */
        box: { x: 117, y: 205, w: 233, h: 37 },
        align: 'center', font: 'cjk', size: 43.00, scaleX: 0.935, spacing: 0,
        weight: 700, editable: true, calibrate: false,
        value: ''
      },
      {
        id: 'trainNo', label: '车次', group: 'trip',
        box: { x: 443, y: 154, w: 168, h: 42 },
        align: 'center', font: 'num', size: 57.72, scaleX: 0.964, spacing: 0.05,
        weight: 700, editable: true,
        value: ''
      },
      {
        id: 'toStation', label: '到达站', group: 'trip',
        /* 与出发站完全同一套规格（字号 / 压缩 / 撑开目标），两边站名永远成对 */
        /* 居中对齐：站名在框内左右匀开，长短名字都以中点为准 */
        box: { x: 630, y: 139, w: 340, h: 62 },
        align: 'center', font: 'cjk', size: 63.77, scaleX: 1.008, spacing: 1.176,
        weight: 700, editable: true, calibrate: false,
        fitSpacing: { width: 198.5, max: 1.176 },
        /* 「站」的样式与出发站保持一致 */
        small: { chars: '站', ratio: 0.64, spacingBefore: 0.157 },
        value: ''
      },
      {
        id: 'toPinyin', label: '到达站拼音', group: 'trip',
        box: { x: 669, y: 205, w: 233, h: 36 },
        align: 'center', font: 'cjk', size: 42.45, scaleX: 0.873, spacing: 0,
        weight: 700, editable: true,
        value: ''
      },

      /* ---------- 中部：日期 / 时间 / 车厢席位 / 票价 / 席别 ---------- */
      {
        id: 'date', label: '乘车日期', group: 'trip',
        box: { x: 72, y: 252, w: 312, h: 40 },
        align: 'center', font: 'num', size: 50.23, scaleX: 0.967, spacing: 0,
        weight: 700, editable: true,
        small: { chars: '年月日', ratio: 0.70 },
        value: ''
      },
      {
        id: 'time', label: '发车时间', group: 'trip',
        box: { x: 407, y: 251, w: 141, h: 38 },
        align: 'center', font: 'num', size: 48.20, scaleX: 0.951, spacing: 0,
        weight: 700, editable: true,
        small: { chars: '开', ratio: 0.62 },
        value: ''
      },
      {
        id: 'carSeat', label: '车厢席位', group: 'trip',
        box: { x: 645, y: 253, w: 189, h: 36 },
        align: 'center', font: 'num', size: 45.00, scaleX: 1.014, spacing: 0,
        weight: 700, editable: true,
        small: { chars: '车号', ratio: 0.68 },
        value: ''
      },
      {
        id: 'price', label: '票价', group: 'ticket',
        box: { x: 82, y: 307, w: 152, h: 39 },
        align: 'center', font: 'num', size: 50.14, scaleX: 0.993, spacing: 0,
        weight: 700, editable: true, calibrate: false,
        prefix: '¥',             // 固定前缀：人民币符号
        suffix: '元',            // 固定后缀：元
        small: { chars: '元', ratio: 0.57 },
        value: ''
      },
      {
        id: 'seatClass', label: '席别', group: 'trip',
        box: { x: 759, y: 304, w: 113, h: 37 },
        align: 'center', font: 'cjk', size: 37.84, scaleX: 1.019, spacing: 0,
        weight: 700, editable: true,
        value: ''
      },

      /* ---------- 下部：固定文案 / 证件号 / 姓名 / 说明 / 条码号 ---------- */
      {
        id: 'usage', label: '使用说明（固定，不可编辑）', group: 'fixed',
        box: { x: 75, y: 405, w: 239, h: 40 },
        align: 'center', font: 'cjk', size: 43.95, scaleX: 0.920, spacing: 0.02,
        weight: 400, stroke: 0.015, editable: false,
        value: '仅供收藏使用'
      },
      {
        id: 'idNumber', label: '证件号码', group: 'passenger',
        box: { x: 74, y: 457, w: 419, h: 42 },
        align: 'left', font: 'num', size: 56.80, scaleX: 0.793, spacing: 0,
        weight: 700, editable: true,
        value: ''
      },
      {
        id: 'passenger', label: '乘客姓名', group: 'passenger',
        box: { x: 512, y: 457, w: 131, h: 42 },
        align: 'left', font: 'cjk', size: 43.94, scaleX: 0.973, spacing: 0.05,
        weight: 700, editable: true,
        value: ''
      },
      {
        id: 'note1', label: '报销凭证说明', group: 'fixed',
        box: { x: 131, y: 519, w: 540, h: 35 },
        align: 'center', font: 'cjk', size: 36.79, scaleX: 0.942, spacing: 0,
        weight: 400, stroke: 0.015, editable: false, calibrate: false,
        control: 'select', value: '欢度国庆 祝福祖国',
        options: [
          '欢度国庆 祝福祖国',
          '买票请到12306 发货请到95306'
        ]
      },
      {
        id: 'note2', label: '退票改签说明', group: 'fixed',
        box: { x: 130.5, y: 563, w: 540, h: 35 },
        align: 'center', font: 'cjk', size: 37.84, scaleX: 0.913, spacing: 0,
        weight: 400, stroke: 0.015, editable: false, calibrate: false,
        value: '中国铁路祝您旅途愉快'
      },
      {
        id: 'bottomCode', label: '底部条码号', group: 'ticket',
        box: { x: 80, y: 619, w: 458, h: 37 },
        align: 'left', font: 'num', size: 50.78, scaleX: 0.700, spacing: 0,
        weight: 700, editable: true, calibrate: false,
        /* 拆成两段独立编辑，中间固定 3 个空格 */
        split: { parts: 2, sep: '   ', labels: ['条码编码', '尾号'] },
        value: ''
      },

      /* ---------- 非文字元素 ---------- */
      {
        id: 'seal', label: '时间下方圆章', group: 'deco', type: 'seal',
        box: { x: 419, y: 297, w: 48, h: 48 },
        ringWidth: 2.6, charRatio: 0.62, weight: 400,
        gap: 1.14,               // 多个圆章之间的间距（相对圆径）
        color: 'ink', editable: false,
        control: 'chips', multi: true, maxCount: 4,
        value: [],
        options: [
          { value: '惠', label: '惠' },
          { value: '学', label: '学' },
          { value: '网', label: '网' },
          { value: '支', label: '支' }
        ]
      },
      {
        id: 'dashedBox', label: '虚线框（装饰）', group: 'deco', type: 'dashed',
        box: { x: 118, y: 513, w: 586, h: 91 }, lineWidth: 2, dash: [7, 5],
        color: 'ink', editable: false
      },
      {
        id: 'trainRule', label: '车次下箭头（装饰）', group: 'deco', type: 'arrow',
        box: { x: 446, y: 205, w: 163, h: 14 },
        /* 实线 + 末端只有上半支的箭头（与参考票一致）；headFull 可切成完整箭头 */
        lineWidth: 2.6, headLength: 17, headHalf: 5.5,
        color: 'ink', editable: false
      },
      {
        id: 'qr', label: '二维码', group: 'deco', type: 'qr',
        box: { x: 754, y: 441, w: 218, h: 220 },
        /* 二维码内容 = qrPrefix + 指定字段的值（默认取「车次」） */
        qrPrefix: 'https://rail.re/#',
        qrSource: 'trainNo',
        qrEcc: 'M',
        editable: false
      }
    ],

    /* 编辑面板分组标题 */
    groups: [
      { id: 'ticket', title: '票面信息' },
      { id: 'trip', title: '行程信息' },
      { id: 'passenger', title: '乘客信息' },
      { id: 'fixed', title: '固定文案' },
      { id: 'deco', title: '装饰 / 二维码' }
    ]
  };

  global.TICKET_LAYOUT = LAYOUT;
  global.TICKET_FONTS = FONTS;
})(window);
