// Tiny DOM morph: patch an element to match an HTML string while reusing the nodes that
// are already there. Unchanged cards stay put, CSS transitions run, and only elements that
// are genuinely new get their enter animation. `data-key` pins a node's identity.
// `data-num` on an element makes its number count up/down instead of jumping.

const tpl = document.createElement('template');

export function morph(el, html) {
  tpl.innerHTML = html;
  patchChildren(el, tpl.content);
}

const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-key') : null);
const same = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);

function patchChildren(from, to) {
  const keyed = new Map();
  for (const n of from.childNodes) { const k = keyOf(n); if (k) keyed.set(k, n); }
  const want = [...to.childNodes];
  want.forEach((w, j) => {
    let cur = from.childNodes[j];
    const k = keyOf(w);
    if (k && keyed.has(k) && keyed.get(k) !== cur) {
      const m = keyed.get(k);
      from.insertBefore(m, cur || null);
      cur = m;
    }
    if (cur && same(cur, w)) patchNode(cur, w);
    else from.insertBefore(w, cur || null);
  });
  while (from.childNodes.length > want.length) from.lastChild.remove();
}

function patchNode(a, b) {
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  const oldNum = a.getAttribute('data-num');
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  if (a.tagName === 'INPUT') {
    if (document.activeElement !== a && a.value !== b.value) a.value = b.value;
    a.checked = b.hasAttribute('checked');
    return;
  }
  if (a.tagName === 'SELECT') {
    patchChildren(a, b);
    const sel = b.querySelector('option[selected]');
    if (sel && document.activeElement !== a) a.value = sel.value;
    return;
  }
  patchChildren(a, b);
  const newNum = b.getAttribute('data-num');
  if (oldNum != null && newNum != null && oldNum !== newNum) countTo(a, +oldNum, +newNum);
}

// Animate a money figure from `from` to `to`. The final text is already in place; this
// only rewrites it during the tween.
const tweens = new WeakMap();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

function countTo(el, from, to) {
  if (reduced.matches || !Number.isFinite(from) || !Number.isFinite(to)) return;
  const finalText = el.textContent;
  const prefix = finalText.match(/^[^\d−-]*/)[0];
  cancelAnimationFrame(tweens.get(el));
  const t0 = performance.now(), dur = 450;
  const frame = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    if (k >= 1) { el.textContent = finalText; return; }
    el.textContent = prefix + Math.round(from + (to - from) * e).toLocaleString();
    tweens.set(el, requestAnimationFrame(frame));
  };
  tweens.set(el, requestAnimationFrame(frame));
}
