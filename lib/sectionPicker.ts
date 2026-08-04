/**
 * BÖLÜM SEÇİCİ — önizlemeye enjekte edilen küçük script.
 *
 * Amaç: kullanıcı önizlemede bir bölümü tıklayıp "sadece burayı değiştir"
 * diyebilsin. Script önizleme iframe'inin İÇİNE gömülür (hem /yeni srcDoc'u hem
 * repo modu proxy'si), ana pencereyle `postMessage` üzerinden konuşur:
 *
 *   ana pencere → iframe : "rukible:pick:on" / "rukible:pick:off"
 *   iframe → ana pencere : { type:"rukible:selected", tag, label, selector, text, html }
 *
 * `postMessage` cross-origin çalıştığı için repo modundaki farklı-origin dev
 * sunucusu önizlemesinde de sorunsuz. Script AÇILANA KADAR ATIL durur — sadece
 * bir message dinleyici kurar; enable gelene dek sayfaya hiç dokunmaz.
 *
 * "En yakın bölüm": tıklanan öğeden yukarı çıkıp ilk anlamlı kapsayıcıyı seçer
 * (section/article/header/footer/nav/main ya da body/main'in doğrudan çocuğu) —
 * böylece küçük bir metne yanlışlıkla kilitlenmezsin.
 */
export const SECTION_PICKER_JS = `(function(){
  if (window.__rukiblePicker) return;
  window.__rukiblePicker = true;
  var on = false, overlay = null, tagEl = null, current = null;
  var SECTION_TAGS = {SECTION:1,ARTICLE:1,HEADER:1,FOOTER:1,ASIDE:1,MAIN:1,NAV:1,FORM:1};

  function ensureOverlay(){
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.setAttribute('data-rukible-overlay','1');
    overlay.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #fb923c;background:rgba(251,146,60,0.12);border-radius:6px;box-shadow:0 0 0 2px rgba(251,146,60,0.25);display:none';
    tagEl = document.createElement('div');
    tagEl.style.cssText='position:absolute;top:-20px;left:0;background:#fb923c;color:#fff;font:600 11px/1.4 ui-sans-serif,system-ui,sans-serif;padding:1px 6px;border-radius:4px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis';
    overlay.appendChild(tagEl);
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  function nearestSection(el){
    var node = el;
    while (node && node !== document.body) {
      if (SECTION_TAGS[node.tagName]) return node;
      var p = node.parentElement;
      if (p && (p.tagName === 'BODY' || p.tagName === 'MAIN')) return node;
      node = p;
    }
    return el;
  }

  function label(el){
    var t = el.tagName.toLowerCase();
    if (el.id) return t + '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      var c = el.className.trim().split(/\\s+/).slice(0,2).join('.');
      if (c) return t + '.' + c;
    }
    return t;
  }

  function selectorPath(el){
    var parts = [], node = el, depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 5) {
      var s = node.tagName.toLowerCase();
      if (node.id){ parts.unshift(s + '#' + node.id); break; }
      var par = node.parentElement;
      if (par){
        var same = Array.prototype.filter.call(par.children, function(c){ return c.tagName === node.tagName; });
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(s);
      node = par; depth++;
    }
    return parts.join(' > ');
  }

  function draw(el){
    var o = ensureOverlay();
    var r = el.getBoundingClientRect();
    o.style.display = 'block';
    o.style.top = r.top + 'px'; o.style.left = r.left + 'px';
    o.style.width = r.width + 'px'; o.style.height = r.height + 'px';
    tagEl.textContent = label(el);
  }
  function hide(){ if (overlay) overlay.style.display = 'none'; }

  function onMove(e){
    if (!on) return;
    var el = nearestSection(e.target);
    if (el) { current = el; draw(el); }
  }
  function onClick(e){
    if (!on) return;
    e.preventDefault(); e.stopPropagation();
    var el = current || nearestSection(e.target);
    if (!el) return;
    parent.postMessage({
      type: 'rukible:selected',
      tag: el.tagName.toLowerCase(),
      label: label(el),
      selector: selectorPath(el),
      text: (el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,160),
      html: (el.outerHTML || '').slice(0,600)
    }, '*');
  }
  function onReflow(){ if (on && current) draw(current); }

  function enable(){
    if (on) return; on = true;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow, true);
    if (document.body) document.body.style.cursor = 'crosshair';
  }
  function disable(){
    on = false; hide(); current = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('scroll', onReflow, true);
    window.removeEventListener('resize', onReflow, true);
    if (document.body) document.body.style.cursor = '';
  }

  window.addEventListener('message', function(e){
    if (e.data === 'rukible:pick:on') enable();
    else if (e.data === 'rukible:pick:off') disable();
  });
})();`;

/**
 * Seçici script'ini HTML'e gömer. Önce </head> (en güvenli: React uygulamasının
 * gövde hidrasyonuna karışmaz), yoksa </body> öncesi, o da yoksa sona ekler.
 * Script atıl durduğu için her sayfaya gömülmesi zararsız.
 */
export function injectPicker(html: string): string {
  const tag = `<script data-rukible-picker="1">${SECTION_PICKER_JS}</script>`;
  const head = html.indexOf("</head>");
  if (head !== -1) return html.slice(0, head) + tag + html.slice(head);
  const body = html.lastIndexOf("</body>");
  if (body !== -1) return html.slice(0, body) + tag + html.slice(body);
  return html + tag;
}

/** İstemciden gelen seçim; prompt'a eklenir. Sunucuda uzunluklar sınırlanır. */
export type SectionSelection = {
  tag?: string;
  label?: string;
  selector?: string;
  text?: string;
  html?: string;
};

/**
 * Seçimi modele verilecek Türkçe yönergeye çevirir (yoksa boş string). Ham
 * uzunlukları burada da sınırlarız (istemciye güvenme).
 */
export function selectionInstruction(sel: SectionSelection | undefined | null): string {
  if (!sel || (!sel.html && !sel.text && !sel.label)) return "";
  const label = String(sel.label ?? sel.tag ?? "öğe").slice(0, 120);
  const text = sel.text ? String(sel.text).slice(0, 200) : "";
  const html = sel.html ? String(sel.html).slice(0, 2000) : "";
  return (
    "KULLANICI SAYFADAN BELİRLİ BİR BÖLÜM SEÇTİ. Değişikliği SADECE bu bölüme " +
    "uygula; sayfanın/dosyanın geri kalanını BİREBİR koru.\n" +
    `Seçilen öğe: ${label}\n` +
    (text ? `İçindeki metin: "${text}"\n` : "") +
    (html ? `HTML (kısaltılmış, ilgili kaynağı bulmak için bu parçayı ara):\n${html}` : "")
  );
}
