(function () {
  var BOX_ID = 'visitor-geo';
  var CACHE_KEY = 'visitor_geo_v1';
  var TTL = 30 * 60 * 1000;
  var last = null;

  /* 常见运营商 / 云厂商关键词（用于从中文字段里识别） */
  var ISP_RE = /电信|联通|移动|铁通|教育网|广电|有线|长城宽带|鹏博士|歌华|中科院|科技网|阿里|腾讯|华为|百度|金山|京东|字节|世纪互联|光环|优刻得|青云|UCloud/i;

  /* 国家码 → 中文 */
  var CC = {
    CN: '中国', HK: '中国香港', MO: '中国澳门', TW: '中国台湾',
    US: '美国', JP: '日本', SG: '新加坡', KR: '韩国', GB: '英国',
    DE: '德国', FR: '法国', CA: '加拿大', AU: '澳大利亚', RU: '俄罗斯',
    IN: '印度', NL: '荷兰', MY: '马来西亚', TH: '泰国', VN: '越南'
  };

  /* 英文运营商 → 中文 */
  var MAP = [
    [/China Education and Research Network|CERNET/i, '教育网'],
    [/China Telecom|Chinanet/i, '中国电信'],
    [/China Unicom/i, '中国联通'],
    [/China Mobile|CMNET/i, '中国移动'],
    [/China TieTong/i, '中国铁通'],
    [/Alibaba|Aliyun/i, '阿里云'],
    [/Tencent/i, '腾讯云'],
    [/Huawei/i, '华为云'],
    [/Baidu/i, '百度云'],
    [/Cloudflare/i, 'Cloudflare'],
    [/Amazon|AWS/i, 'AWS'],
    [/Microsoft|Azure/i, 'Azure'],
    [/Google/i, 'Google'],
    [/Tsinghua/i, '清华大学'],
    [/Peking University/i, '北京大学']
  ];

  function clean(v) {
    return String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  }
  function uniq(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && out.indexOf(arr[i]) === -1) out.push(arr[i]);
    }
    return out;
  }
  function cnIsp(s) {
    s = clean(s);
    if (!s) return '';
    for (var i = 0; i < MAP.length; i++) {
      if (MAP[i][0].test(s)) return MAP[i][1];
    }
    return s;
  }
  function pickIsp(list) {
    for (var i = list.length - 1; i >= 0; i--) {
      if (ISP_RE.test(list[i])) return list[i];
    }
    return list.length ? list[list.length - 1] : '';
  }

  /* ---------- 各数据源解析 ---------- */
  function fromIpip(j) {
    if (!j || j.ret !== 'ok' || !j.data || !j.data.ip) return null;
    var L = (j.data.location || []).map(clean).filter(Boolean);
    if (!L.length) return null;
    var head = uniq(L.slice(0, 3));
    var tail = L.slice(3);
    var isp = pickIsp(tail);
    var extra = tail.filter(function (x) { return x !== isp; }).join(' ');
    return { ip: clean(j.data.ip), region: head.join(' '), isp: isp, extra: extra };
  }

  function fromZxinc(j) {
    if (!j || j.code !== 0 || !j.data) return null;
    var d = j.data;
    var ip = clean(d.myip || (d.ip && d.ip.query));
    if (!ip) return null;
    var seg = String(d.location || d.country || '').split(/[\u2013\u2014]/).map(clean).filter(Boolean);
    var head = seg.slice(0, 3);
    var tail = seg.slice(3);
    /* 第三段可能写成「北京 清华大学」，把单位拆出来 */
    if (!tail.length && head.length === 3) {
      var bits = head[2].split(' ').filter(Boolean);
      if (bits.length > 1) { head[2] = bits[0]; tail = bits.slice(1); }
    }
    if (!tail.length && d.local) tail = [clean(d.local)];
    var isp = pickIsp(tail);
    var extra = tail.filter(function (x) { return x !== isp; }).join(' ');
    return { ip: ip, region: uniq(head).join(' '), isp: isp, extra: extra };
  }

  function fromWhois(j) {
    if (!j || j.success === false || !j.ip) return null;
    var c = j.connection || {};
    var region = uniq([CC[j.country_code] || clean(j.country), clean(j.region), clean(j.city)]);
    return { ip: clean(j.ip), region: region.join(' '), isp: cnIsp(c.isp || c.org), extra: '' };
  }

  function fromInfo(j) {
    if (!j || !j.ip || j.bogon) return null;
    var region = uniq([CC[j.country] || clean(j.country), clean(j.region), clean(j.city)]);
    var org = clean(j.org).replace(/^AS\\d+\\s+/, '');
    return { ip: clean(j.ip), region: region.join(' '), isp: cnIsp(org), extra: '' };
  }

  var SRC = [
    ['https://myip.ipip.net/json', fromIpip, 4000],
    ['https://ip.zxinc.org/api.php?type=json', fromZxinc, 3500],
    ['https://ipwho.is/', fromWhois, 3500],
    ['https://ipinfo.io/json', fromInfo, 3500]
  ];

  function getJSON(url, ms) {
    return new Promise(function (resolve, reject) {
      var ctrl = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('timeout'));
      }, ms);
      fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (j) { clearTimeout(timer); resolve(j); })
        .catch(function (e) { clearTimeout(timer); reject(e); });
    });
  }

  /* ---------- 缓存 ---------- */
  function readCache() {
    try {
      var c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (c && c.v && Date.now() - c.t < TTL) return c.v;
    } catch (e) {}
    return null;
  }
  function writeCache(v) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), v: v })); } catch (e) {}
  }

  /* ---------- 渲染 ---------- */
  function paint(info) {
    var box = document.getElementById(BOX_ID);
    if (!box || !info) return;
    last = info;
    var ipEl = box.querySelector('.vg-ip');
    var locEl = box.querySelector('.vg-loc');
    var dot = box.querySelector('.vg-dot');

    ipEl.textContent = info.ip || '未知';
    ipEl.setAttribute('data-ip', info.ip || '');
    ipEl.title = '点击复制 IP';

    var loc = [info.region, info.isp].filter(Boolean).join(' · ');
    locEl.textContent = loc || '归属地未知';
    locEl.title = [info.region, info.extra, info.isp].filter(Boolean).join(' · ') || '归属地未知';
    dot.classList.remove('warn');
  }

  function fail() {
    var box = document.getElementById(BOX_ID);
    if (!box) return;
    box.querySelector('.vg-ip').textContent = '识别失败';
    box.querySelector('.vg-loc').textContent = '（第三方接口暂无响应）';
    box.querySelector('.vg-dot').classList.add('warn');
  }

  function load(hasCache) {
    var i = 0;
    (function next() {
      if (i >= SRC.length) { if (!hasCache) fail(); return; }
      var s = SRC[i++];
      var url = s[0] + (s[0].indexOf('?') > -1 ? '&' : '?') + '_t=' + Date.now();
      getJSON(url, s[2])
        .then(function (j) {
          var info = s[1](j);
          if (!info || !info.ip) throw new Error('bad payload');
          info.src = s[0];
          paint(info);
          writeCache(info);
        })
        .catch(next);
    })();
  }

  /* ---------- 挂载 ---------- */
  function mount() {
    var footer = document.getElementById('footer');
    if (!footer) return null;
    var exist = document.getElementById(BOX_ID);
    if (exist && footer.contains(exist)) return exist;

    var box = document.createElement('div');
    box.id = BOX_ID;
    box.className = 'visitor-geo';
    box.setAttribute('title', '这里显示的是你本次访问的公网 IP 与归属地，仅你可见；本站不做记录');
    box.innerHTML =
      '<span class="vg-dot"></span>' +
      '<span class="vg-who">' +
        '<span class="vg-label">当前访问 IP：</span>' +
        '<span class="vg-ip">正在识别…</span>' +
      '</span>' +
      '<span class="vg-sep">｜</span>' +
      '<span class="vg-loc">正在识别…</span>';

    /* 锚点：「总访问量 #busuanzi」之后（公安备案之前）
       主题未开访问统计时退到运行时长之后，再退到 footer 末尾 */
    var host = footer.querySelector('#busuanzi') || footer.querySelector('.live-time');
    if (host && host.parentNode) {
      host.parentNode.insertBefore(box, host.nextSibling);
    } else {
      footer.appendChild(box);
    }

    /* 点击复制 IP */
    var ipEl = box.querySelector('.vg-ip');
    ipEl.addEventListener('click', function () {
      var ip = ipEl.getAttribute('data-ip');
      if (!ip) return;
      var done = function () {
        var old = ipEl.textContent;
        ipEl.textContent = '已复制';
        ipEl.classList.add('copied');
        setTimeout(function () {
          ipEl.textContent = old;
          ipEl.classList.remove('copied');
        }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ip).then(done, function () {});
      } else {
        var ta = document.createElement('textarea');
        ta.value = ip;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });

    return box;
  }

  function start() {
    if (!mount()) return;
    var cached = readCache();
    if (cached) paint(cached);
    load(!!cached);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  /* PJAX / 主题局部刷新后自愈：元素被替换则重新挂载并回填已有数据 */
  setInterval(function () {
    if (document.getElementById(BOX_ID)) return;
    if (!document.getElementById('footer')) return;
    if (mount() && last) paint(last);
  }, 2000);
})();
