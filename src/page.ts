// HTML for the public key pages: the key page, its empty state, the server's home page and the 404 page.
// Tessh "ASCII blue" look: an ASCII field at the top, an install
// card with copy buttons, the key list and a FAQ. Everything is inline (the CSP allows no other origin).
import { NAMESPACE, type KeyKind } from "./keypage.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const svg = (body: string, cls = "ic") => `<svg class="${cls}" viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`;
const I = {
  copy: svg(
    `<rect x="7" y="7" width="9" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13 4.5V4a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 4v8a1.5 1.5 0 0 0 1.5 1.5H7" fill="none" stroke="currentColor" stroke-width="1.6"/>`,
  ),
  tick: svg(
    `<path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    "ic tick",
  ),
  shield: svg(
    `<path d="M10 2.5l6 2.2v4.6c0 3.8-2.6 6.6-6 8.2-3.4-1.6-6-4.4-6-8.2V4.7zM7.2 10l2 2 3.8-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  key: svg(
    `<path d="M8 12a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zM10.5 10.5l6 6M14 14l1.5-1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  chip: svg(
    `<rect x="5" y="5" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.5V5M12 2.5V5M8 15v2.5M12 15v2.5M2.5 8H5M2.5 12H5M15 8h2.5M15 12h2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
  ),
  revoked: svg(`<circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 14.5l9-9" stroke="currentColor" stroke-width="1.5"/>`),
  out: `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5h6.5V10M12.2 3.8 4 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  arrow: `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const MARK = `<span class="mark" aria-hidden="true">t<i>›</i><u></u></span>`;
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23141414'/%3E%3Ctext x='5' y='22' font-family='Menlo,monospace' font-weight='700' font-size='15' fill='%23ededed'%3Et%E2%80%BA%3C/text%3E%3Crect x='24' y='10' width='2.4' height='13' rx='1' fill='%2360a5fa'/%3E%3C/svg%3E";

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return isNaN(+d) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

const copyBtn = (text: string, label: string, ghost = false) =>
  `<button type="button" class="copy${ghost ? " mini" : ""}" data-copy="${esc(text)}" aria-label="${esc(label)}"><span class="swap">${I.copy}${I.tick}</span>${
    ghost ? "" : `<span class="lbl"><span>Copy</span><span>Copied</span></span>`
  }</button>`;

type Kind = { hw: boolean; label: string; icon: string };

/** Device keys are P-256 keys made in a device's security chip; Synced and Standard keys are Ed25519 or RSA. */
function kindOf(kind: KeyKind): Kind {
  if (kind === "device") return { hw: true, label: "Device key", icon: I.chip };
  return { hw: false, label: kind === "synced" ? "Synced key" : "Standard key", icon: I.key };
}

const algorithm = (type: string) =>
  type === "ssh-ed25519" ? "Ed25519" : type === "ssh-rsa" ? "RSA" : type === "ecdsa-sha2-nistp256" ? "ECDSA P-256" : type;

/** One key as the public page shows it: no device name or label, only what's here. */
export interface PublicKey {
  /** Neutral `tessh-<fingerprint start>`, also the key's own address. */
  name: string;
  type: string;
  fingerprint: string;
  kind: KeyKind;
  addedAt: string;
  /** The signed line with the neutral name as its comment, for the copy button. */
  line: string;
}

export interface PageData {
  username: string;
  /** The server's host, e.g. `sync.example.com`. Also the signer identity domain. */
  host: string;
  /** `<PUBLIC_URL>/<username>` */
  origin: string;
  install: string;
  keys: PublicKey[];
  revokedCount: number;
  updated: string;
}

const STYLE = `
:root{
  color-scheme:dark;interpolate-size:allow-keywords;
  --bg:#0a0a0a;--ink:#ededed;--muted:#9a9a9a;--soft:#6f6f6f;--line:#212121;--panel:#141414;
  --pill:rgba(255,255,255,.06);--pill-h:rgba(255,255,255,.11);
  --blue:#60a5fa;--blue-d:#1e3fd8;--blue-l:#7cc4ff;--blue-t:rgba(96,165,250,.12);--ok:#4ade80;
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --spring:cubic-bezier(.3,1.35,.5,1);
}
*{box-sizing:border-box}
html{height:100%}
body{margin:0;height:100vh;height:100dvh;overflow-y:auto;-webkit-overflow-scrolling:touch;background:var(--bg);color:var(--ink);font:400 15px/1.55 var(--sans);-webkit-font-smoothing:antialiased;position:relative}
a{color:inherit;text-decoration:none}
button{font:inherit;color:inherit;border:0;background:none;cursor:pointer;padding:0}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:6px}
.ic{width:16px;height:16px;flex:none;display:block}
.field{position:absolute;inset:0 0 auto;height:340px;pointer-events:none;z-index:0;
  -webkit-mask-image:linear-gradient(#000 0,rgba(0,0,0,.75) 45%,transparent 100%);mask-image:linear-gradient(#000 0,rgba(0,0,0,.75) 45%,transparent 100%)}
.field canvas{display:block;width:100%;height:100%;opacity:.8}
.wrap{position:relative;z-index:1;max-width:760px;margin:0 auto;padding:0 20px;min-height:100%;display:flex;flex-direction:column}
main{flex:1 0 auto}
.top{display:flex;align-items:center;justify-content:space-between;padding:20px 0}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:500;font-size:15px}
.mark{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:#141414;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);font:700 13px/1 var(--mono);letter-spacing:-.06em;color:#f5f5f5}
.mark i{font-style:normal;color:var(--muted)}
.mark u{display:inline-block;width:2px;height:12px;margin-left:2px;border-radius:1px;background:var(--blue);text-decoration:none;animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.get{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:9px;background:var(--pill);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);font-size:13.5px;font-weight:500;transition:background .15s}
.get:hover{background:var(--pill-h)}
.get .ic{width:13px;height:13px;color:var(--muted)}
.hero{padding:64px 0 28px}
.eyebrow{display:inline-flex;align-items:center;gap:7px;margin-bottom:14px;font:500 12px/1 var(--mono);letter-spacing:.02em;color:var(--blue-l);background:rgba(10,10,10,.55);padding:6px 10px 6px 8px;border-radius:8px;box-shadow:inset 0 0 0 1px rgba(96,165,250,.22);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px rgba(74,222,128,.15)}
.dot.off{background:var(--soft);box-shadow:0 0 0 3px rgba(255,255,255,.06)}
h1{font-weight:500;font-size:clamp(30px,6vw,44px);line-height:1.1;letter-spacing:-.025em;margin:0 0 12px;overflow-wrap:anywhere}
h1 b{font-weight:500;color:var(--blue)}
.lede{margin:0;max-width:520px;font-size:16.5px;color:var(--muted)}
.card{background:var(--panel);border-radius:14px;box-shadow:inset 0 0 0 1px var(--line),0 24px 60px -30px rgba(0,0,0,.8)}
.bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px}
.seg{position:relative;display:inline-flex;padding:3px;border-radius:10px;background:rgba(255,255,255,.045)}
.seg button{position:relative;z-index:1;height:30px;padding:0 12px;border-radius:7px;font-size:13px;font-weight:500;color:var(--muted);transition:color .2s}
.seg button[aria-selected="true"]{color:var(--ink)}
.seg .thumb{position:absolute;top:3px;bottom:3px;left:3px;width:0;border-radius:7px;background:rgba(255,255,255,.1);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);transition:transform .32s var(--spring),width .32s var(--spring)}
.kinds{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:8px;background:var(--pill);font-size:12px;color:var(--muted);white-space:nowrap}
.chip .ic{width:13px;height:13px}
.chip.hw{color:var(--blue-l);background:var(--blue-t)}
.cmdrow{display:flex;align-items:center;gap:12px;padding:16px 10px 16px 18px;border-top:1px solid var(--line)}
.cmd{flex:1;min-width:0;margin:0;font:13.5px/1.6 var(--mono);color:#d4d4d4;white-space:pre-wrap;overflow-wrap:anywhere}
.cmd .p{color:var(--soft);user-select:none;-webkit-user-select:none}
.hint{margin:0;padding:0 18px 14px;font-size:12.5px;color:var(--muted)}
.trust{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 18px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
.trust .sig{display:inline-flex;align-items:center;gap:7px;color:var(--ink)}
.trust .sig .ic{color:var(--blue);width:15px;height:15px}
.trust .sig span{color:var(--muted)}
.trust a,.revoked a{color:var(--muted);text-decoration:underline;text-decoration-color:rgba(255,255,255,.2);text-underline-offset:3px;white-space:nowrap}
.trust a:hover,.revoked a:hover{color:var(--ink)}
.copy{position:relative;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;border-radius:9px;background:#fafafa;color:#0a0a0a;font-size:13px;font-weight:500;flex:none;transition:transform .2s var(--spring),background .2s}
.copy:hover{background:#fff}
.copy:active{transform:scale(.96)}
.copy.mini{height:30px;width:30px;padding:0;justify-content:center;background:none;color:var(--soft)}
.copy.mini:hover{background:var(--pill);color:var(--ink)}
.swap{position:relative;display:grid;place-items:center}
.swap .ic{grid-area:1/1;transition:opacity .2s,transform .3s var(--spring),filter .2s}
.swap .ic+.ic{opacity:0;transform:scale(.5) rotate(-20deg);filter:blur(2px)}
.copy .lbl{display:grid}
.copy .lbl span{grid-area:1/1;transition:opacity .2s,transform .25s var(--spring)}
.copy .lbl span+span{opacity:0;transform:translateY(6px)}
.copy.done .swap .ic:first-child{opacity:0;transform:scale(.4);filter:blur(2px)}
.copy.done .swap .ic+.ic{opacity:1;transform:none;filter:none}
.copy.done .lbl span:first-child{opacity:0;transform:translateY(-6px)}
.copy.done .lbl span+span{opacity:1;transform:none}
.copy.mini.done{color:var(--ok)}
.tick path{stroke-dasharray:20;stroke-dashoffset:20}
.done .tick path{animation:draw .35s .05s ease-out forwards}
@keyframes draw{to{stroke-dashoffset:0}}
.sec{margin-top:44px}
.sech{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 2px 12px}
h2{margin:0;font-size:17px;font-weight:500;letter-spacing:-.01em}
h2 small{margin-left:8px;font-size:13px;font-weight:400;color:var(--soft)}
.sech a{font-size:12.5px;color:var(--muted)}
.sech a:hover{color:var(--ink)}
.keys{list-style:none;margin:0;padding:0}
.key{display:grid;grid-template-columns:36px 1fr auto;gap:4px 14px;align-items:start;padding:16px 12px 16px 16px}
.key+.key{border-top:1px solid var(--line)}
.kicon{grid-row:span 3;display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--pill);color:var(--muted)}
.kicon.hw{background:var(--blue-t);color:var(--blue)}
.kicon .ic{width:18px;height:18px}
.ktop{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.kname{font-weight:500;font-size:14.5px;overflow-wrap:anywhere}
.kind{font-size:11.5px;font-weight:500;padding:2px 7px;border-radius:6px;background:var(--pill);color:var(--muted);white-space:nowrap}
.kind.hw{background:var(--blue-t);color:var(--blue-l)}
.kmeta{grid-column:2;font-size:12.5px;color:var(--muted)}
.kfp{grid-column:2;font:12px/1.5 var(--mono);color:var(--soft);overflow-wrap:anywhere}
.key .copy{grid-row:1/span 3;grid-column:3;align-self:center}
.revoked{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;padding:12px 16px;border-top:1px solid var(--line);font-size:12.5px;color:var(--soft)}
.revoked .ic{width:14px;height:14px}
.blank{padding:44px 24px;text-align:center}
.blank .glyph{display:inline-grid;place-items:center;width:52px;height:52px;border-radius:14px;background:var(--pill);color:var(--muted);margin-bottom:16px}
.blank .glyph .ic{width:22px;height:22px}
.blank h3{margin:0 0 6px;font-size:16px;font-weight:500}
.blank p{margin:0 auto;max-width:400px;font-size:14px;color:var(--muted)}
.lost{text-align:center;padding-top:80px}
.lost h1{font-size:clamp(22px,4.5vw,30px)}
.lost .lede{margin:0 auto}
.big{font:500 clamp(64px,16vw,120px)/1 var(--mono);letter-spacing:-.06em;color:var(--ink);margin:0 0 6px}
.big u{display:inline-block;width:.09em;height:.72em;margin-left:.06em;border-radius:3px;background:var(--blue);vertical-align:-.04em;text-decoration:none;animation:blink 1.1s steps(1) infinite}
.cta{display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 16px;margin-top:22px;border-radius:10px;background:#fafafa;color:#0a0a0a;font-weight:500;font-size:14px}
.cta:hover{background:#fff}
.faq{border-top:1px solid var(--line)}
.faq details{border-bottom:1px solid var(--line)}
.faq summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 2px;cursor:pointer;font-weight:500;font-size:15px}
.faq summary::-webkit-details-marker{display:none}
.faq summary:hover .pm{background:var(--pill-h);color:var(--ink)}
.pm{position:relative;flex:none;width:26px;height:26px;border-radius:8px;background:var(--pill);color:var(--muted);transition:background .15s,transform .32s var(--spring)}
.pm:before,.pm:after{content:"";position:absolute;left:50%;top:50%;width:11px;height:1.5px;margin:-.75px 0 0 -5.5px;border-radius:1px;background:currentColor}
.pm:after{transform:rotate(90deg)}
details[open] .pm{transform:rotate(45deg);color:var(--blue)}
.faq details::details-content{block-size:0;overflow:hidden;transition:block-size .32s cubic-bezier(.2,.8,.2,1),content-visibility .32s allow-discrete}
.faq details[open]::details-content{block-size:auto}
.ans{padding:0 44px 20px 2px;font-size:14.5px;color:var(--muted)}
.ans p{margin:0 0 10px}.ans p:last-child{margin:0}
.ans b{color:var(--ink);font-weight:500}
.ans code{font-family:var(--mono);font-size:12.5px;color:var(--ink);background:var(--pill);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
.ans pre{margin:10px 0;padding:12px 14px;border-radius:10px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);font:12.5px/1.6 var(--mono);color:#d4d4d4;white-space:pre-wrap;overflow-wrap:anywhere}
.ans a{color:var(--blue)}
.ans a:hover{text-decoration:underline}
footer{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:14px;margin-top:64px;padding:22px 0 calc(28px + env(safe-area-inset-bottom));border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
footer .made{display:inline-flex;align-items:center;gap:8px}
footer .made .mark{width:22px;height:22px;border-radius:6px;font-size:10px}
footer .made .mark u{height:9px;width:1.5px}
footer .made a{color:var(--ink)}
footer nav{display:flex;flex-wrap:wrap;gap:4px 16px}
footer nav a{font-family:var(--mono);font-size:12px}
footer a:hover{color:var(--ink)}
.rise{animation:rise .7s cubic-bezier(.2,.8,.2,1) both}
.rise:nth-child(2){animation-delay:.06s}.rise:nth-child(3){animation-delay:.12s}.rise:nth-child(4){animation-delay:.18s}
@keyframes rise{from{opacity:0;transform:translateY(10px)}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:640px){
  .wrap{padding:0 16px}
  .field{height:300px}
  .hero{padding:40px 0 22px}
  .lede{font-size:15.5px}
  .bar{flex-wrap:wrap}
  .kinds{justify-content:flex-start;padding:0 2px 2px}
  .cmdrow{flex-direction:column;align-items:stretch;padding:14px}
  .cmdrow .copy{justify-content:center;height:40px}
  .cmd{font-size:12px;white-space:pre;overflow-x:auto;overflow-wrap:normal;scrollbar-width:none;padding-bottom:2px}
  .cmd::-webkit-scrollbar{display:none}
  .hint{padding:0 14px 14px}
  .trust{flex-direction:column;align-items:flex-start;gap:6px;padding:12px 14px}
  .trust .sig{flex-wrap:wrap;gap:4px 7px}
  .key{grid-template-columns:32px 1fr auto;gap:3px 12px;padding:14px 8px 14px 12px}
  .kicon{width:32px;height:32px}
  .ans{padding-right:8px}
}
@media (prefers-reduced-motion:reduce){
  .rise,.mark u,.big u,.done .tick path{animation:none}
  .tick path{stroke-dashoffset:0}
  *,::details-content{transition-duration:0s!important}
}`;

const SCRIPT = `
(function(){
  var live=document.getElementById('live');
  function legacy(t){var a=document.createElement('textarea');a.value=t;a.setAttribute('readonly','');a.style.cssText='position:fixed;top:0;left:0;opacity:0';document.body.appendChild(a);a.select();a.setSelectionRange(0,t.length);var ok=false;try{ok=document.execCommand('copy')}catch(e){}document.body.removeChild(a);return ok}
  function show(b,msg){b.classList.remove('done');void b.offsetWidth;b.classList.add('done');var l=b.querySelector('.lbl span+span');if(l)l.textContent=msg;live.textContent=msg;clearTimeout(b._t);b._t=setTimeout(function(){b.classList.remove('done')},1600)}
  document.addEventListener('click',function(e){
    var b=e.target.closest('[data-copy]');if(!b)return;var t=b.getAttribute('data-copy');
    var ok=function(){show(b,'Copied')},bad=function(){show(b,legacy(t)?'Copied':'Copy blocked')};
    if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(t).then(ok,bad);else bad();
  });
})();
(function(){
  var seg=document.querySelector('.seg');if(!seg)return;
  var th=seg.querySelector('.thumb'),tabs=[].slice.call(seg.querySelectorAll('[role=tab]')),cur=0;
  function sel(i,focus){cur=i;tabs.forEach(function(t,j){t.setAttribute('aria-selected',i===j);t.tabIndex=i===j?0:-1});
    document.querySelectorAll('[data-pane]').forEach(function(p){p.hidden=p.getAttribute('data-pane')!=i});
    var t=tabs[i];th.style.width=t.offsetWidth+'px';th.style.transform='translateX('+(t.offsetLeft-3)+'px)';if(focus)t.focus()}
  tabs.forEach(function(t,i){t.addEventListener('click',function(){sel(i)})});
  seg.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();sel((cur+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length,true)}});
  sel(0);addEventListener('resize',function(){sel(cur)});
})();
/* Tessh ASCII field. Horizon shape, blue ramp.
   About 30 fps, paused when the tab is hidden or the field is off screen, one still frame for Reduce Motion. */
(function(){
  var cv=document.getElementById('field'),ctx=cv&&cv.getContext&&cv.getContext('2d');if(!ctx)return;
  var STOPS=['#0b1a5e','#1e3fd8','#2f8fe0','#7cc4ff'].map(function(h){var n=parseInt(h.slice(1),16);return[n>>16,(n>>8)&255,n&255]});
  var G=' .:-=+*xX#',N=G.length-1,CELL=14,CW=CELL*.62;
  var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  function ramp(t){t=Math.max(0,Math.min(1,t))*(STOPS.length-1);var i=Math.min(STOPS.length-2,Math.floor(t)),f=t-i,a=STOPS[i],b=STOPS[i+1];return[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f,a[2]+(b[2]-a[2])*f]}
  function h2(x,y){var s=Math.sin(x*127.1+y*311.7)*43758.5453;return s-Math.floor(s)}
  function noise(x,y){var xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi,u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf),a=h2(xi,yi),b=h2(xi+1,yi),c=h2(xi,yi+1),d=h2(xi+1,yi+1);return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v}
  function field(nx,ny,t){
    var wob=(noise(nx*3+t*.07,ny*3-t*.05)-.5)*.18,bow=.30-.24*Math.pow((nx-.5)*2,2),d=(ny-bow+wob)/.16;
    var v=Math.exp(-d*d)*(.55+.5*Math.exp(-Math.pow(nx-.5,2)*9));
    v+=Math.exp(-(Math.pow(nx-.5,2)*5+Math.pow(ny-.1,2)*14))*.4;
    v*=.9+.35*noise(nx*4-t*.1,ny*4);
    v+=(noise(nx*14-t*.12,ny*14+t*.09)-.5)*.22;return v*.78}
  var w=0,h=0,dpr=1,off=document.createElement('canvas'),raf=0,last=0,t0=performance.now(),vis=true;
  function size(){dpr=Math.min(2,devicePixelRatio||1);w=cv.clientWidth;h=cv.clientHeight;cv.width=Math.max(1,w*dpr);cv.height=Math.max(1,h*dpr)}
  function draw(now){
    var t=reduce?3:(now-t0)/1000;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    var cols=Math.ceil(w/CW),rows=Math.ceil(h/CELL),V=new Float32Array(cols*rows),r,c,i;
    if(!cols||!rows)return;
    for(r=0;r<rows;r++)for(c=0;c<cols;c++)V[r*cols+c]=field((c+.5)/cols,(r+.5)/rows,t);
    if(off.width!==cols||off.height!==rows){off.width=cols;off.height=rows}
    var ox=off.getContext('2d'),img=ox.createImageData(cols,rows);
    for(i=0;i<V.length;i++){var v=Math.max(0,V[i]),p=ramp(v*.9);img.data[i*4]=p[0];img.data[i*4+1]=p[1];img.data[i*4+2]=p[2];img.data[i*4+3]=Math.min(255,v*v*255*.5)}
    ox.putImageData(img,0,0);ctx.save();ctx.imageSmoothingEnabled=true;ctx.filter='blur('+(CELL*1.4)+'px)';ctx.drawImage(off,0,0,cols*CW,rows*CELL);ctx.restore();
    ctx.font='500 '+(CELL*.86)+'px ui-monospace,"SF Mono",Menlo,monospace';ctx.textBaseline='top';
    for(r=0;r<rows;r++)for(c=0;c<cols;c++){
      var x=V[r*cols+c]*.8;x+=(h2(c+Math.floor(t*2)*.37,r)-.5)*.16*(x>.1?1:0);if(x<.1)continue;
      var gi=Math.min(N,Math.max(1,Math.round(x*N))),q=ramp(x);
      ctx.fillStyle='rgba('+(q[0]|0)+','+(q[1]|0)+','+(q[2]|0)+','+Math.min(.9,Math.pow(x,1.3)*.9)+')';ctx.fillText(G[gi],c*CW,r*CELL)}
  }
  function loop(now){raf=0;if(document.hidden||!vis)return;if(now-last>=33){last=now;draw(now)}raf=requestAnimationFrame(loop)}
  function start(){if(reduce)return;if(!raf&&vis&&!document.hidden)raf=requestAnimationFrame(loop)}
  size();draw(performance.now());
  if('ResizeObserver' in window)new ResizeObserver(function(){size();draw(performance.now())}).observe(cv);
  if('IntersectionObserver' in window)new IntersectionObserver(function(e){vis=e[0].isIntersecting;start()}).observe(cv);
  document.addEventListener('visibilitychange',start);start();
})();`;

function shell(title: string, description: string, main: string, nav: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0a0a">
<link rel="icon" href="${FAVICON}">
<style>${STYLE}
</style>
</head>
<body>
<div class="field" aria-hidden="true"><canvas id="field"></canvas></div>
<div class="wrap">
<header class="top">
  <a class="brand" href="https://tessh.dev">${MARK}Tessh</a>
  <a class="get" href="https://tessh.dev">Get Tessh${I.out}</a>
</header>
<main>
${main}
</main>
<footer>
  <span class="made">${MARK}<span>Key page by <a href="https://tessh.dev">Tessh</a>, SSH for Mac and iPhone</span></span>
  ${nav}
</footer>
</div>
<p id="live" class="sr" aria-live="polite"></p>
<script>${SCRIPT}
</script>
</body>
</html>
`;
}

function faq(u: string, host: string, origin: string, base: string, exampleKey: string | null): string {
  const q = (title: string, body: string) =>
    `<details><summary>${title}<span class="pm" aria-hidden="true"></span></summary><div class="ans">${body}</div></details>`;
  return `<section class="sec rise" aria-labelledby="fq">
  <div class="sech"><h2 id="fq">Questions</h2></div>
  <div class="faq">
    ${q(
      "What does the install command do?",
      `<p>It downloads a short shell script that checks the signature on ${u}'s key lists, then <b>adds keys that are missing and removes revoked ones</b> in <code>~/.ssh/authorized_keys</code>. Every other line stays as it is, and it backs up the file first.</p>
      <p>If the signature doesn't check out, or the list is older than the one already installed, it changes nothing. Running it again is safe. Preview first with a dry run:</p>
      <pre>curl -fsSL ${origin}/install.sh | sh -s -- --dry-run</pre>`,
    )}
    ${q(
      "Is it safe to pipe curl into sh?",
      `<p>Read it first: <a href="${base}/install.sh">install.sh</a> is plain text and under 200 lines. It only touches <code>~/.ssh</code>, needs no root, and never runs anything it downloads.</p>
      <p>The first run trusts the signing key served here (trust on first use) and saves <code>~/.ssh/tessh-update-${u}.sh</code> with that key built in. Use that file from then on: it never trusts the network again.</p>`,
    )}
    ${q(
      "Where do these keys come from?",
      `<p>Each key was made in Tessh on one of ${u}'s devices. Only the public half is published. The private half never leaves the device.</p>`,
    )}
    ${q(
      "What is a Device key?",
      `<p>A key made in the device's security chip (the Secure Enclave in a Mac or iPhone). It <b>never leaves the device</b>, not even Tessh can copy it, and every sign-in needs ${u}'s face or fingerprint. It shows up as <code>ecdsa-sha2-nistp256</code>.</p>
      <p>A <b>Synced key</b> is a regular Ed25519 or RSA key, end-to-end encrypted and synced between ${u}'s devices. A <b>Standard key</b> is one kept on a single device.</p>`,
    )}
    ${q(
      "Why are there no device names?",
      `<p>This page is public, so it shows only each key's type, fingerprint and date. Each key's comment is a neutral <code>tessh-</code> name.</p>`,
    )}
    ${q(
      "Why can't this server add keys?",
      `<p>The lists are signed on ${u}'s devices with a signing key the server never sees. The server checks the signature before it stores anything, and the install script checks it again on your server. A list changed anywhere along the way fails the check, and nothing is installed.</p>
      <p>Check it yourself with <a href="${base}/allowed_signers">allowed_signers</a>:</p>
      <pre>ssh-keygen -Y verify -f allowed_signers -I ${u}@${host} \\
  -n ${NAMESPACE} -s authorized_keys.sig &lt; authorized_keys</pre>`,
    )}
    ${q(
      "How does revoking a key work?",
      `<p>When ${u} deletes a key in Tessh, it moves to the signed <a href="${base}/revoked">revoked list</a>. The next run of the install script on a server removes it there. To keep servers current on their own, add the updater to cron:</p>
      <pre>17 * * * * sh ~/.ssh/tessh-update-${u}.sh &gt;/dev/null 2&gt;&amp;1</pre>`,
    )}
    ${q(
      "How do I remove these keys from a server?",
      `<p>Delete the lines in <code>~/.ssh/authorized_keys</code> that hold these keys. Match them by the key itself: the comment at the end can differ, as older lists used a key name. Then remove the cron line, if you added one, and the files the script saved:</p>
      <pre>rm ~/.ssh/tessh-update-${u}.sh ~/.ssh/tessh-signer-${u} ~/.ssh/tessh-seq-${u}</pre>`,
    )}
    ${q(
      "Can I get the keys as plain text or JSON?",
      `<p>Yes. <a href="${base}/authorized_keys">/authorized_keys</a> is the raw list, <a href="${base}/keys.json">/keys.json</a> has every key with its fingerprint and date${
        exampleKey ? `, and each key has its own address, like <a href="${base}/${exampleKey}">${base}/${exampleKey}</a>` : ""
      }. Fetching this page with curl returns the raw list too.</p>`,
    )}
  </div>
</section>`;
}

export function renderPage(d: PageData): string {
  const u = esc(d.username);
  const base = `/${u}`;
  const origin = esc(d.origin);
  const n = d.keys.length;
  const kinds = d.keys.map((k) => kindOf(k.kind));
  const count = (kind: KeyKind) => d.keys.filter((k) => k.kind === kind).length;

  const rows = d.keys
    .map((k, i) => {
      const kind = kinds[i];
      return `      <li class="key">
        <span class="kicon${kind.hw ? " hw" : ""}" aria-hidden="true">${kind.icon}</span>
        <div class="ktop"><span class="kname">${kind.label}</span><span class="kind${kind.hw ? " hw" : ""}">${esc(algorithm(k.type))}</span></div>
        <div class="kmeta">Added ${esc(fmtDate(k.addedAt))}</div>
        <div class="kfp">${esc(k.fingerprint)}</div>
        ${copyBtn(k.line, `Copy ${kind.label}, ${k.fingerprint}`, true)}
      </li>`;
    })
    .join("\n");

  const chips = [
    count("device") ? `<span class="chip hw">${I.chip}${count("device")} Device</span>` : "",
    count("synced") ? `<span class="chip">${I.key}${count("synced")} Synced</span>` : "",
    count("standard") ? `<span class="chip">${I.key}${count("standard")} Standard</span>` : "",
  ].join("");
  const oneLine = `curl -fsSL ${d.origin} >> ~/.ssh/authorized_keys`;
  const rc = d.revokedCount;
  const revoked = rc
    ? `<div class="revoked">${I.revoked}${rc} revoked ${rc === 1 ? "key" : "keys"}. The install script removes ${rc === 1 ? "it" : "them"} from servers. <a href="${base}/revoked">See list</a></div>`
    : "";

  const install = `<section class="card rise" aria-label="Install the keys">
  <div class="bar">
    <div class="seg" role="tablist" aria-label="Install method">
      <span class="thumb" aria-hidden="true"></span>
      <button type="button" role="tab" aria-selected="true" data-tab="0">Install script</button>
      <button type="button" role="tab" aria-selected="false" tabindex="-1" data-tab="1">One line</button>
    </div>
    <div class="kinds">${chips}</div>
  </div>
  <div data-pane="0" role="tabpanel" aria-label="Install script">
    <div class="cmdrow">
      <pre class="cmd"><span class="p">$ </span>${esc(d.install)}</pre>
      ${copyBtn(d.install, "Copy install command")}
    </div>
    <p class="hint">Checks the signature, adds new keys, removes revoked ones. Safe to run again.</p>
  </div>
  <div data-pane="1" role="tabpanel" aria-label="One line" hidden>
    <div class="cmdrow">
      <pre class="cmd"><span class="p">$ </span>${esc(oneLine)}</pre>
      ${copyBtn(oneLine, "Copy one-line command")}
    </div>
    <p class="hint">Appends the keys as they are. No signature check, and revoked keys stay. Prefer the install script.</p>
  </div>
  <div class="trust">
    <span class="sig">${I.shield}Signed on ${u}'s devices.<span>The server can't add keys.</span></span>
    <span>Updated ${esc(fmtDate(d.updated))} · <a href="${base}/authorized_keys.sig" title="Signed with ssh-keygen -Y sign">signature</a></span>
  </div>
</section>

<section class="sec rise" aria-labelledby="kh">
  <div class="sech"><h2 id="kh">Keys<small>${n}</small></h2><a href="${base}/keys.json">keys.json</a></div>
  <div class="card">
    <ul class="keys">
${rows}
    </ul>
    ${revoked}
  </div>
</section>`;

  const empty = `<section class="card rise">
  <div class="blank">
    <span class="glyph">${I.key}</span>
    <h3>No keys yet</h3>
    <p>When ${u} adds a key in Tessh and publishes it, it shows up here, signed, with a one-line install.</p>
  </div>
  ${revoked}
</section>`;

  const main = `<section class="hero">
  <div class="eyebrow rise"><span class="dot${n ? "" : " off"}"></span>${esc(d.host)}/${u}</div>
  <h1 class="rise">SSH keys of <b>@${u}</b></h1>
  <p class="lede rise">${n ? `Public keys from ${u}'s devices. Add them to a server with one command.` : `${u} has a key page, but hasn't published any keys yet.`}</p>
</section>

${n ? install : empty}

${faq(u, esc(d.host), origin, base, d.keys[0] ? esc(d.keys[0].name) : null)}`;

  const nav = `<nav><a href="${base}/authorized_keys">authorized_keys</a><a href="${base}/keys.json">keys.json</a><a href="${base}/install.sh">install.sh</a><a href="${base}/allowed_signers">allowed_signers</a></nav>`;
  return shell(`SSH keys of @${u}`, `Public SSH keys of @${u}. Add them to a server with one command.`, main, nav);
}

/** The 404 page for browsers. `username` is set when the path named a valid username with no key page. */
export function renderMissing(username: string | null, host = "this server"): string {
  const who = username ? `No key page for <b>@${esc(username)}</b>` : "Nothing here";
  const main = `<section class="hero lost">
  <p class="big rise">404<u></u></p>
  <h1 class="rise">${who}</h1>
  <p class="lede rise">${
    username
      ? "Nobody has published keys under this name. Check the spelling: names are lowercase letters, numbers and dashes."
      : `Key pages live at ${esc(host)}/&lt;username&gt;, in lowercase letters, numbers and dashes.`
  }</p>
  <a class="cta rise" href="https://tessh.dev">Make your own with Tessh${I.arrow}</a>
</section>`;
  return shell("No key page", "This Tessh key page doesn't exist.", main, "");
}

/** The server's home page (`/`). */
export function renderHome(name: string, host: string): string {
  const main = `<section class="hero lost">
  <div class="eyebrow rise"><span class="dot"></span>${esc(host)}</div>
  <h1 class="rise">${esc(name)}</h1>
  <p class="lede rise">A Tessh sync server. It stores end-to-end encrypted vaults it can't read, and serves signed public key pages at ${esc(host)}/&lt;username&gt;.</p>
  <p class="lede rise">To use it, choose <b>Custom server</b> when you sign in to Tessh and enter this address.</p>
  <a class="cta rise" href="https://tessh.dev">Get Tessh${I.arrow}</a>
</section>`;
  return shell(name, `${name}: a Tessh sync server.`, main, "");
}
