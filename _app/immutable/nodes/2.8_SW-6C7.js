import{b as g,a as C,f as E}from"../chunks/C33n0AIb.js";import{o as k}from"../chunks/DI_Gt0Yd.js";import{N as M,h as m,d as b,f as p,l as v,k as S,R as $,e as _,C as A,g as q,T as R,U as T,V as O,W as P,X as F,L as H,O as I,Y as N,j as L,$ as D,Z as U,_ as j,a0 as B}from"../chunks/5PNbgHvK.js";import{e as G}from"../chunks/DGfE04GK.js";import{h as V}from"../chunks/BE2Nb2t9.js";import{b as J}from"../chunks/B7D882QT.js";import{b as w}from"../chunks/Cw3swMGC.js";function Q(h,u,l=!1,s=!1,o=!1,y=!1){var r=h,a="";if(l){var t=h;m&&(r=b(p(t)))}M(()=>{var i=S;if(a===(a=u()??"")){m&&v();return}if(l&&!m){i.nodes=null,t.innerHTML=a,a!==""&&g(p(t),t.lastChild);return}if(i.nodes!==null&&($(i.nodes.start,i.nodes.end),i.nodes=null),a!==""){if(m){_.data;for(var e=v(),n=e;e!==null&&(e.nodeType!==A||e.data!=="");)n=e,e=q(e);if(e===null)throw R(),T;g(_,n),r=b(e);return}var d=s?P:o?F:void 0,f=O(s?"svg":o?"math":"template",d);f.innerHTML=a;var c=s||o?f:f.content;if(g(p(c),c.lastChild),s||o)for(;p(c);)r.before(p(c));else r.before(c)}})}var W=E("<div></div>");function ae(h,u){H(u,!0);let l=B(""),s;k(async()=>{const a=await(await fetch(`${w}/site/index.html`)).text(),t=new DOMParser().parseFromString(a,"text/html");for(const i of t.querySelectorAll('link[rel="stylesheet"], link[href*=".css"]')){const e=document.createElement("link");e.rel="stylesheet",e.href=i.href,document.head.appendChild(e)}for(const i of t.querySelectorAll("style"))document.head.appendChild(document.createElement("style")).textContent=i.textContent;N(l,t.body.innerHTML.replace('<a href="#faq">FAQ</a>','<a href="#pricing">Pricing</a><a href="#faq">FAQ</a>').replace('<a href="/circle-engine/site/imprint.html">Imprint</a>','<a href="/circle-engine/site/imprint.html">Imprint</a><a href="https://github.com/circle-co-intelligence/circle-engine" rel="noopener" target="_blank">GitHub</a>').replace('<section class="ea-faq',`${o}<section class="ea-faq`),!0)});const o=`
<section class="ea-pricing ea-shell" id="pricing" aria-labelledby="pricing-h">
	<div class="ea-pricing-head">
		<p class="ea-eyebrow">Pricing</p>
		<h2 id="pricing-h">Free where it matters.<br/>Paid where it scales.</h2>
		<p class="ea-lead">Every plan is end-to-end encrypted, account-free, and yours — the circle runs in your browser, not on our servers. Free is everything a circle needs. Host is everything a host wants.</p>
	</div>
	<div class="ea-pricing-grid">
		<article class="ea-price-card">
			<h3>Circle</h3>
			<p class="ea-price"><b>$0</b><span>forever</span></p>
			<p class="ea-price-note">The whole circle — no trial, no card, no account.</p>
			<ul>
				<li>Unlimited circles, no time limit</li>
				<li>Up to 9 seats around the fire</li>
				<li>End-to-end encryption, always on</li>
				<li>Room secret lives in your URL — never on a server</li>
				<li>Talking stick: Circle, Open &amp; question rounds</li>
				<li>Live captions, translation &amp; voice — on-device</li>
				<li>Milo, the AI companion — local models</li>
				<li>Recordings &amp; notes saved to your device</li>
				<li>Breakouts, lobby &amp; password gates</li>
			</ul>
			<a class="ea-price-cta ea-price-ghost" href="${w}/join">Open a circle — free</a>
		</article>
		<article class="ea-price-card ea-price-host">
			<p class="ea-price-badge">Most generous host plan on the market</p>
			<h3>Circle Host</h3>
			<p class="ea-price"><b>$8</b><span>/host · month · or $79/yr</span></p>
			<p class="ea-price-note">Everything in Free, plus:</p>
			<ul>
				<li>Up to 30 seats — managed relay mesh keeps video smooth</li>
				<li>Reserved circle codes &amp; persistent rooms</li>
				<li>Cloud recording vault with shareable replay links</li>
				<li>Larger model packs — fuller Milo, faster captions</li>
				<li>Custom branding — your logo, your fire</li>
				<li>Priority human support</li>
				<li>Early access to V2 rituals &amp; tools</li>
			</ul>
			<a class="ea-btn ea-price-cta" href="#request">Become a founding host</a>
		</article>
	</div>
	<div class="ea-compare">
		<p class="ea-eyebrow">The honest math — monthly billing, per public pricing pages</p>
		<ul>
			<li><b>Zoom Pro</b><span>$15.99 / host / mo · E2EE optional, account required</span></li>
			<li><b>Butter Starter</b><span>$24 / member / mo · everyone pays, not just the host</span></li>
			<li><b>Whereby Pro</b><span>$10.99 / host / mo · free tier caps at 45 min</span></li>
			<li class="ea-compare-us"><b>Circle Host</b><span>$8 / host / mo · and Free is already E2EE, unlimited time</span></li>
		</ul>
	</div>
</section>`;function y(a){a.preventDefault();const t=a.target,i=new FormData(t).get("email");try{const n="cic.earlyAccess",d=JSON.parse(localStorage.getItem(n)??"[]");d.push({email:String(i??""),at:Date.now()}),localStorage.setItem(n,JSON.stringify(d))}catch{}const e=t.querySelector("button");e&&(e.textContent="Request noted — stored on this device")}var r=W();V("1uha8ag",a=>{L(()=>{D.title="Co-Intelligence Circle — Find coherence through human connection"})}),Q(r,()=>U(l),!0),j(r),J(r,a=>s=a,()=>s),G("submit",r,y),C(h,r),I()}export{ae as component};
