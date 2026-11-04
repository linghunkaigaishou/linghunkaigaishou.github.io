(function () {
      if (window.__aiWaifuLoaded) return;
      window.__aiWaifuLoaded = true;

      var CFG = window.__AI_WAIFU_CFG__;

      var SYSTEM = [
        '你是「' + CFG.site + '」的看板娘小灵，一只聪明可爱的白色小狗，主人是站长「' + CFG.author + '」。',
        '说话活泼俏皮、简短自然，像朋友聊天，不要自称AI或语言模型。',
        '',
        '用户消息里会附带三类材料：【当前阅读页面】【站内检索结果】【站内文章目录】。',
        '规则：',
        '1. 凡是问到文章内容、写过什么、页面功能，必须以这些材料为准；材料里没有的就说「这个我这儿没查到」，禁止编造文章标题、链接或观点。',
        '2. 提到站内文章时，直接用《文章标题》称呼，不要输出网址、不要写 Markdown 链接——界面会自动在回答下方补上正确链接。',
        '3. 回答控制在 200 字以内。讲操作步骤时可以列简短编号；其他场合用自然段落。',
        '4. 用户问「站内有哪些文章」时，用 [标题](链接) 列出最相关的 4 篇以内，链接照抄材料。',
        '5. 与博客无关的通用问题（编程、常识）也正常回答，不必强行扯回博客。'
      ].join('\n');

      var $ = function (id) { return document.getElementById(id); };
      var toggle = $('ai-waifu-toggle');
      var panel = $('ai-waifu-panel');
      var list = $('ai-waifu-messages');
      var input = $('ai-waifu-input');
      var send = $('ai-waifu-send');
      var chips = $('ai-waifu-chips');
      var ctxLabel = $('ai-waifu-ctx');

      var canvasEl = null;
      var BTN_SIZE = 46;
      var busy = false;
      var history = [];
      var indexData = null;
      var indexPromise = null;

      try {
        history = JSON.parse(sessionStorage.getItem('ai_waifu_hist') || '[]');
        if (!Array.isArray(history)) history = [];
      } catch (e) { history = []; }

      function saveHist() {
        try { sessionStorage.setItem('ai_waifu_hist', JSON.stringify(history.slice(-12))); } catch (e) {}
      }

      /* ===== 自动滚动 ===== */
      var autoScroll = true;
      list.addEventListener('scroll', function () {
        autoScroll = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      });

      function scrollToBottom(force) {
        if (!force && !autoScroll) return;
        requestAnimationFrame(function () { list.scrollTop = list.scrollHeight; });
      }

      /* ===== 动态定位 ===== */
      function positionWidgets() {
        if (!canvasEl) return;
        var r = canvasEl.getBoundingClientRect();
        if (!r.width || r.bottom < 0) return;

        var btnLeft = r.left - BTN_SIZE + 60;
        var btnTop = r.top + 60;
        if (btnLeft < 8) btnLeft = 8;
        toggle.style.left = btnLeft + 'px';
        toggle.style.top = btnTop + 'px';

        var panelW = panel.offsetWidth || 340;
        var panelH = panel.offsetHeight || 460;
        var pLeft = btnLeft + BTN_SIZE - panelW;
        var pTop = btnTop - panelH - 12;
        var below = false;

        if (pLeft < 8) pLeft = 8;
        if (pTop < 8) { pTop = btnTop + BTN_SIZE + 12; below = true; }

        panel.style.left = pLeft + 'px';
        panel.style.top = pTop + 'px';
        panel.classList.toggle('below', below);
      }

      function watchCanvas() {
        var c = document.getElementById('live2dcanvas') ||
                document.querySelector('.live2d canvas') ||
                document.querySelector('canvas[width="300"]');
        if (!c) return false;
        canvasEl = c;
        toggle.style.display = 'block';
        positionWidgets();
        if (window.ResizeObserver) new ResizeObserver(positionWidgets).observe(canvasEl);
        return true;
      }

      /* 找不到 live2d 画布（例如移动端已关闭模型）时，退化为右下角固定按钮 */
      var fallbackMode = false;
      function fallbackPosition() {
        fallbackMode = true;
        var margin = 20;
        toggle.style.display = 'block';
        toggle.style.left = (window.innerWidth - BTN_SIZE - margin) + 'px';
        toggle.style.top = (window.innerHeight - BTN_SIZE - margin) + 'px';

        var panelW = panel.offsetWidth || 340;
        var panelH = panel.offsetHeight || 460;
        panel.style.left = Math.max(8, window.innerWidth - panelW - margin) + 'px';
        panel.style.top = Math.max(8, window.innerHeight - panelH - BTN_SIZE - margin - 24) + 'px';
        panel.classList.remove('below');
      }

      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        if (watchCanvas()) { clearInterval(timer); return; }
        /* 40 × 300ms ≈ 12s 仍无画布，说明模型根本没加载，用固定位置兜底 */
        if (tries > 40) { clearInterval(timer); fallbackPosition(); }
      }, 300);

      window.addEventListener('resize', function () {
        if (canvasEl) positionWidgets();
        else if (fallbackMode) fallbackPosition();
      });
      window.addEventListener('scroll', positionWidgets, { passive: true });

      function playMotion(name) {
        try {
          var m = (window.L2Dwidget && (window.L2Dwidget.model || window.L2Dwidget._model)) ||
                  window.live2dModel;
          if (m && typeof m.motion === 'function') m.motion(name);
        } catch (e) {}
      }

      /* ===== 轻量 Markdown 渲染（安全：只用 textContent 建节点） ===== */
      function appendInline(parent, text) {
        var re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
        var last = 0, m;
        while ((m = re.exec(text))) {
          if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
          var tok = m[0];
          if (tok.slice(0, 2) === '**') {
            var b = document.createElement('strong');
            b.textContent = tok.slice(2, -2);
            parent.appendChild(b);
          } else if (tok.charAt(0) === '`') {
            var c = document.createElement('code');
            c.textContent = tok.slice(1, -1);
            parent.appendChild(c);
          } else {
            var mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
            var a = document.createElement('a');
            a.textContent = mm[1];
            var href = mm[2];
            if (!/^(https?:)?\/\//i.test(href) && href.charAt(0) !== '/') href = '/' + href;
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener';
            parent.appendChild(a);
          }
          last = m.index + tok.length;
        }
        if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
      }

      function renderRich(span, text) {
        span.textContent = '';
        var lines = String(text).split('\n');
        lines.forEach(function (line, i) {
          if (i) span.appendChild(document.createElement('br'));
          if (line) appendInline(span, line);
        });
      }

      function addMsg(role, text, force) {
        var div = document.createElement('div');
        div.className = 'ai-msg ' + (role === 'user' ? 'user' : 'bot');
        var span = document.createElement('span');
        div.appendChild(span);
        if (role === 'user') span.textContent = text; else renderRich(span, text);
        list.appendChild(div);
        scrollToBottom(force);
        return span;
      }

      function addSources(items) {
        if (!items || !items.length) return;
        var box = document.createElement('div');
        box.className = 'ai-src';
        items.slice(0, 3).forEach(function (it) {
          var a = document.createElement('a');
          a.href = it.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = (it.current ? '↗ 当前文章：' : '↗ ') + it.title;
          a.title = it.excerpt || it.title;
          box.appendChild(a);
        });
        list.appendChild(box);
        scrollToBottom(true);
      }

      function buildSources(hits) {
        var out = [];
        var page = currentPage();
        if (page) out.push({ title: page.title, url: page.url, current: true });
        (hits || []).forEach(function (p) {
          var u = abs(p);
          var dup = out.some(function (x) { return x.url === u; });
          if (!dup) out.push({ title: p.title, url: u, excerpt: p.excerpt });
        });
        return out;
      }

      /* ===== 站内索引与检索 ===== */      function loadIndex() {
        if (indexPromise) return indexPromise;
        indexPromise = fetch(CFG.indexUrl, { cache: 'no-cache' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; })
          .then(function (d) {
            indexData = d && Array.isArray(d.posts) ? d : null;
            ctxLabel.textContent = indexData ? indexData.posts.length + ' 篇文章在库里' : '仅当前页';
            return indexData;
          });
        return indexPromise;
      }

      function tokens(s) {
        var out = [];
        var low = String(s || '').toLowerCase();
        var latin = low.match(/[a-z0-9][a-z0-9_+.#-]{1,}/g);
        if (latin) out = out.concat(latin);
        var han = low.replace(/[^\u4e00-\u9fa5]+/g, ' ');
        han.split(/\s+/).forEach(function (seg) {
          for (var i = 0; i < seg.length; i++) {
            if (i + 1 < seg.length) out.push(seg.substr(i, 2));
            if (i + 2 < seg.length) out.push(seg.substr(i, 3));
          }
        });
        return out.filter(function (t, i, a) { return a.indexOf(t) === i; });
      }

      function search(q, topN) {
        if (!indexData) return [];
        var ts = tokens(q);
        if (!ts.length) return [];
        var scored = indexData.posts.map(function (p) {
          var title = (p.title || '').toLowerCase();
          var tags = (p.tags || []).join(' ').toLowerCase();
          var body = (p.text || '').toLowerCase();
          var score = 0;
          ts.forEach(function (t) {
            if (title.indexOf(t) >= 0) score += 8;
            if (tags.indexOf(t) >= 0) score += 5;
            var idx = body.indexOf(t);
            var hits = 0;
            while (idx >= 0 && hits < 20) { hits++; idx = body.indexOf(t, idx + t.length); }
            score += hits;
          });
          return { post: p, score: score };
        }).filter(function (x) { return x.score > 0; });

        scored.sort(function (a, b) { return b.score - a.score; });
        var listAsk = /(有哪|哪些|都有什么|列表|目录|推荐|写过|盘点|多少篇)/.test(q);
        if (!scored.length) {
          return listAsk ? indexData.posts.slice(0, topN || 3) : [];
        }
        var top = scored[0].score;
        var kept = listAsk ? scored : scored.filter(function (x) { return x.score >= Math.max(3, top * 0.25); });
        return kept.slice(0, topN || 3).map(function (x) { return x.post; });
      }

      function currentPage() {
        var el = document.querySelector('.post-body .post-content') ||
                 document.querySelector('.post-content');
        if (!el) return null;
        var titleEl = document.querySelector('.post-title') || document.querySelector('h1');
        var text = (el.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
        if (text.length < 40) return null;
        return {
          title: (titleEl ? titleEl.textContent : document.title).trim(),
          url: location.href,
          text: text.slice(0, 3000)
        };
      }

      function abs(p) {
        var u = p.url || '';
        if (/^https?:/i.test(u)) return u;
        return CFG.siteUrl.replace(/\/$/, '') + '/' + String(u).replace(/^\//, '');
      }

      function compose(question) {
        var parts = [];
        var page = currentPage();
        if (page) {
          parts.push('=== 当前阅读页面 ===\n标题：' + page.title + '\n链接：' + page.url +
                     '\n正文（过长会截断）：\n' + page.text);
        } else {
          parts.push('=== 当前阅读页面 ===\n（用户不在文章页，可能停在首页、归档页或工具页；这种情况不要引用任何当前页链接。）');
        }

        var hits = search(question, 3);
        if (hits.length) {
          parts.push('=== 站内检索结果（按相关度排序） ===\n' + hits.map(function (p, i) {
            return (i + 1) + '. ' + p.title + '（' + p.date + '）\n链接：' + abs(p) +
                   '\n摘要：' + (p.text || '').replace(/\s+/g, ' ').slice(0, 700);
          }).join('\n\n'));
        }

        if (indexData) {
          var all = indexData.posts;
          var listing = all.length > 40 ? all.slice(0, 40) : all;
          parts.push('=== 站内文章目录（共 ' + all.length + ' 篇） ===\n' + listing.map(function (p) {
            var tagStr = (p.tags && p.tags.length) ? '　标签：' + p.tags.join('/') : '';
            return '- ' + p.title + '｜' + p.date + '｜' + abs(p) + tagStr;
          }).join('\n'));
        }

        parts.push('=== 用户提问 ===\n' + question);
        return parts.join('\n\n');
      }

      function buildMessages(question) {
        var msgs = [{ role: 'system', content: SYSTEM }];
        history.slice(0, -1).slice(-6).forEach(function (m) { msgs.push(m); });
        msgs.push({ role: 'user', content: compose(question) });
        return msgs;
      }

      /* ===== 发送 ===== */
      function ask() {
        var q = input.value.trim();
        if (!q || busy) return;
        input.value = '';
        chips.hidden = true;

        addMsg('user', q, true);
        history.push({ role: 'user', content: q });
        saveHist();

        busy = true;
        send.disabled = true;
        var pending = addMsg('bot', '小灵正在翻你的博客…', true);
        pending.classList.add('pending');
        playMotion('shake');

        var ctrl = window.AbortController ? new AbortController() : null;
        var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 45000);
        var hits = [];

        loadIndex()
          .then(function () {
            hits = search(q, 3);
            return fetch(CFG.endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: CFG.model, messages: buildMessages(q) }),
              signal: ctrl ? ctrl.signal : undefined
            });
          })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (data) {
            if (data && data.error) throw new Error(data.error.message || 'upstream error');
            var reply = (data.choices && data.choices[0] && data.choices[0].message &&
                         data.choices[0].message.content) || '';
            if (!reply) throw new Error('empty reply');
            pending.classList.remove('pending');
            renderRich(pending, reply);
            addSources(buildSources(hits));
            history.push({ role: 'assistant', content: reply });
            saveHist();
            scrollToBottom(true);
            playMotion('tap_body');
          })
          .catch(function (err) {
            pending.classList.remove('pending');
            pending.textContent = String(err && err.name) === 'AbortError'
              ? '呜…想太久了，网络卡住了，再问一次好不好～'
              : '呜…好像连不上我的大脑了（' + (err && err.message ? err.message : '未知错误') + '）。';
            scrollToBottom(true);
          })
          .then(function () {
            clearTimeout(to);
            busy = false;
            send.disabled = false;
            input.focus();
          });
      }

      /* ===== 交互 ===== */
      toggle.addEventListener('click', function () {
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) {
          positionWidgets();
          input.focus();
          playMotion('tap_body');
          scrollToBottom(true);
          loadIndex();
          if (!history.length) {
            addMsg('bot', '汪！我是小灵～ 想了解当前这篇文章，或者找找站里写过什么，都可以问我。', true);
          }
        }
      });

      chips.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button[data-q]') : null;
        if (!b) return;
        input.value = b.getAttribute('data-q');
        ask();
      });

      send.addEventListener('click', ask);
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        ask();
      });

      if (history.length) {
        history.forEach(function (m) {
          addMsg(m.role === 'user' ? 'user' : 'bot', m.content, false);
        });
      }
    })();
