// ==UserScript==
// @name         视频嗅探下载器 (Video Sniffer v2.2)
// @namespace    local.video.sniffer
// @version      2.2
// @description  嗅探 mp4/m3u8/webm/flv/ts 直链（支持 iframe 内嵌播放器与 Shadow DOM）；m3u8 可抓链列出全部分片地址、或纯前端合流成 mp4（AES-128 解密）。仅自用存档。
// @author       整合：local + Momo707577045(m3u8-downloader)
// @match        *://*/*
// @allFrames    true
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ── 配置 ─────────────────────────────────────────────
  const VIDEO_RE   = /\.(mp4|m3u8|webm|flv|ts|mov|mkv|m4s|mpd)(\?|#|$)/i;
  const MAX_FOUND  = 80;
  const POLL_MS    = 3000;
  const VERIFY_M3U8 = true;

  // 在线工具（第一版的能力，保留为兜底）
  const ONLINE_TOOL = 'https://blog.luckly-mjw.cn/tool-show/m3u8-downloader/index.html?source=';
  const MAX_CONCURRENCY = 6;      // 分片并发数
  const MAX_SEGMENTS    = 20000;  // 安全上限

  // ── 状态 ─────────────────────────────────────────────
  const found = new Map();
  const verifiedCache = new Map();
  let panel = null;
  let busy = false;               // 合流任务进行中

  // ══════════════════════════════════════════════════════
  //  工具函数（含从第一版搬来的 getTitle）
  // ══════════════════════════════════════════════════════
  function getTitle() {
    let title = document.title;
    try { title = window.top.document.title; } catch (e) { /* 跨域 iframe，忽略 */ }
    return (title || 'video').trim();
  }

  function safeName(s) {
    return String(s).replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video';
  }

  // 用页面标题命名，保留原扩展名（第一版的 title 能力）
  function fileNameFor(url, overrideExt) {
    const base = safeName(getTitle());
    if (overrideExt) return base.replace(/\.[a-z0-9]{2,4}$/i, '') + '.' + overrideExt;
    const seg = decodeURIComponent((url.split('?')[0].split('/').pop() || ''));
    const ext = (seg.match(/\.([a-z0-9]{2,4})$/i) || [, 'mp4'])[1];
    if (/^[a-z0-9]{2,4}$/i.test(ext) && !/^[0-9]+$/.test(ext)) {
      return base.replace(/\.[a-z0-9]{2,4}$/i, '') + '.' + ext;
    }
    return base + '.mp4';
  }

  // 绝对化 URL（m3u8 清单内部大量相对路径，靠它解析）
  function absUrl(u, base) {
    try { return new URL(u, base || location.href).href; } catch (e) { return null; }
  }

  // 统一请求：优先 GM_xmlhttpRequest（绕过 CORS，能带 Referer），退化为 fetch
  function request(url, asText) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: asText ? 'text' : 'arraybuffer',
          headers: { Referer: location.origin + '/' },
          timeout: 30000,
          onload: r => {
            if (r.status >= 200 && r.status < 300 || r.status === 0) resolve(asText ? r.responseText : r.response);
            else reject(new Error('HTTP ' + r.status));
          },
          onerror: () => reject(new Error('网络错误（可能需 Referer/Cookie）')),
          ontimeout: () => reject(new Error('超时')),
        });
      } else {
        fetch(url, { credentials: 'include' })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return asText ? r.text() : r.arrayBuffer(); })
          .then(resolve, reject);
      }
    });
  }

  // ══════════════════════════════════════════════════════
  //  嗅探主体（第二版能力，原样保留）
  // ══════════════════════════════════════════════════════
  function addUrl(url, source) {
    if (!url) return;
    url = absUrl(url);
    if (!url) return;

    if (url.startsWith('blob:')) {
      if (!found.has('__blob__')) {
        found.set('__blob__', {
          url: 'blob：MSE 流（无直链）', source: 'blob', ts: Date.now(),
          kind: 'media', detail: '页面用 MediaSource 播放，真实地址需在 F12 → Network 里看 XHR',
        });
        renderPanel();
      }
      return;
    }
    if (url.startsWith('data:')) return;
    if (!VIDEO_RE.test(url) && !/m3u8|mp4|m4s|\.ts\b/i.test(url)) return;
    if (found.has(url)) return;
    if (found.size >= MAX_FOUND) return;

    const kind = /\.m3u8/i.test(url) ? 'm3u8' : 'file';
    found.set(url, { url, source, ts: Date.now(), kind, verified: null, detail: '' });
    renderPanel();
    console.log('[VideoSniffer] +', source, url);

    if (VERIFY_M3U8 && kind === 'm3u8') verifyM3U8(url);
  }

  function verifyM3U8(url) {
    if (verifiedCache.has(url)) return;
    verifiedCache.set(url, 'pending');

    const finish = (status, detail) => {
      const item = found.get(url);
      if (item) { item.verified = status; item.detail = detail; renderPanel(); }
      console.log('[VideoSniffer] m3u8 验证:', status, url, detail);
    };

    request(url, true).then(txt => {
      txt = (txt || '').slice(0, 30000);
      const isReal = /#EXTM3U|#EXTINF/i.test(txt);
      const segTypes = {};
      (txt.match(/^[^#\s].*$/gm) || []).forEach(u => {
        const m = String(u).trim().split('?')[0].match(/\.([a-z0-9]{2,4})$/i);
        if (m) { const k = m[1].toLowerCase(); segTypes[k] = (segTypes[k] || 0) + 1; }
      });
      const summary = Object.entries(segTypes).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => k + '×' + v).join(' ');
      const enc = /#EXT-X-KEY[^\n]*METHOD=AES/i.test(txt) ? ' · AES加密' : '';
      finish(isReal ? 'real' : 'suspect',
        (isReal ? '清单正常' : '不含 EXTINF，疑似陷阱') + (summary ? ' (' + summary + ')' : '') + enc);
    }).catch(e => finish('error', String(e.message || e)));
  }

  function scanDom() {
    // 普通 video / source
    document.querySelectorAll('video').forEach(v => {
      addUrl(v.currentSrc || v.src, 'video标签');
      v.querySelectorAll('source').forEach(s => addUrl(s.src, 'source标签'));
    });

    // Shadow DOM 里的 video（自定义播放器常把 video 藏在 shadow root 里，
    // querySelectorAll 穿不透，必须逐元素检查 shadowRoot）
    try {
      document.querySelectorAll('*').forEach(el => {
        if (!el.shadowRoot) return;
        el.shadowRoot.querySelectorAll('video').forEach(v => addUrl(v.currentSrc || v.src, 'shadow-video'));
      });
    } catch (e) {}

    // 链接
    document.querySelectorAll('a[href]').forEach(a => { if (VIDEO_RE.test(a.href)) addUrl(a.href, '链接'); });

    // 源码里的视频字面量（部分站把地址直接写死在 HTML / 内联 script 里）
    try {
      if (!scanDom._litDone) {
        scanDom._litDone = true;
        const html = document.documentElement.innerHTML;
        const re = /(https?:\/\/[^"'\s\\]+?\.(?:m3u8|mp4|m4s|flv|webm)(?:\?[^"'\s\\]*)?)/gi;
        let m, n = 0;
        while ((m = re.exec(html)) && n < 20) { addUrl(m[1], '源码字面量'); n++; }
      }
    } catch (e) {}
  }

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
        addUrl(u, 'fetch');
      } catch (e) {}
      return origFetch.apply(this, args);
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  