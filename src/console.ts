// A lightweight, self-contained test console — one HTML page that exercises the
// ENTIRE merchant surface from the browser: discovery, catalog CRUD, cart,
// order quote, checkout, AP2 payment (the buyer signs mandates client-side with
// Web Crypto), and the order lifecycle. Served by the Worker at GET /console.
//
// No build step, no external scripts — everything inlined so it works under the
// same origin as the merchant APIs it calls.

export function consolePage(merchantIds: string[]): string {
  const options = merchantIds.map((id) => `<option value="${id}">${id}</option>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UCP · AP2 · LCP — Test Console</title>
<style>
 :root{color-scheme:light dark}
 body{font:14px/1.5 system-ui,sans-serif;max-width:1080px;margin:1.2rem auto;padding:0 1rem;color:#111}
 h1{font-size:1.3rem} h2{font-size:1rem;margin:1.4rem 0 .4rem;border-bottom:1px solid #ddd;padding-bottom:.2rem}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
 @media(max-width:800px){.grid{grid-template-columns:1fr}}
 fieldset{border:1px solid #ccc;border-radius:8px;padding:.7rem;margin:0}
 legend{font-weight:600;padding:0 .3rem}
 label{display:block;margin:.25rem 0 .1rem;font-size:.82rem;color:#555}
 input,select,textarea{font:inherit;width:100%;box-sizing:border-box;padding:.35rem .5rem;border:1px solid #bbb;border-radius:6px;background:#fff;color:#111}
 button{font:inherit;padding:.4rem .7rem;margin:.3rem .3rem 0 0;border:1px solid #0b57d0;background:#0b57d0;color:#fff;border-radius:6px;cursor:pointer}
 button.sec{background:#fff;color:#0b57d0}
 code{background:#f2f2f2;padding:.05em .3em;border-radius:3px}
 .muted{color:#777;font-size:.8rem}
 #log{background:#0d1117;color:#c9d1d9;padding:.8rem;border-radius:8px;height:340px;overflow:auto;white-space:pre-wrap;font:12px/1.45 ui-monospace,Menlo,monospace;position:sticky;top:1rem}
 .row{display:flex;gap:.4rem} .row>*{flex:1}
 .state{font-size:.78rem;color:#0a7} .err{color:#e55}
 ul{padding-left:1.1rem;margin:.3rem 0} li{margin:.1rem 0}
</style></head><body>
<h1>UCP · AP2 · LCP — Test Console <span class="muted">(mock / testnet)</span></h1>
<p class="muted">Exercises every merchant surface. Payments are signed in your browser (Web Crypto) — no real value moves.</p>

<div class="row" style="align-items:end;max-width:420px">
  <div><label>Merchant</label><select id="merchant">${options}</select></div>
  <div><button class="sec" onclick="loadCatalog()">Refresh</button></div>
</div>
<div class="state" id="state"></div>

<div class="grid" style="margin-top:1rem">
 <div>
  <h2>1 · Discovery + LCP gate</h2>
  <button onclick="getJson('/.well-known/ucp','UCP manifest')">UCP manifest</button>
  <button onclick="getJson('/.well-known/legal-context.json','legal-context')">legal-context.json</button>
  <button onclick="verifyTerms()">Verify terms hash (recompute)</button>
  <button onclick="report()">Run conformance report</button>

  <h2>2 · Catalog management</h2>
  <div id="catalog" class="muted">Catalog…</div>
  <fieldset style="margin-top:.5rem"><legend>Add product</legend>
    <div class="row"><div><label>SKU</label><input id="p_sku" placeholder="desk-oak"></div>
      <div><label>Name</label><input id="p_name" placeholder="Oak Desk"></div></div>
    <div class="row"><div><label>Price (cents)</label><input id="p_price" type="number" value="45000"></div>
      <div><label>Shipping class</label><select id="p_ship"><option>standard</option><option>small_parcel</option><option>freight</option><option>digital</option></select></div></div>
    <button onclick="addProduct()">Create</button>
    <button class="sec" onclick="importSample()">Import 2 sample</button>
  </fieldset>

  <h2>3 · Cart</h2>
  <button onclick="newCart()">New cart</button> <span id="cartState" class="state"></span>
  <div class="row"><div><label>SKU</label><input id="c_sku" placeholder="rug-9x12"></div>
    <div><label>Variant (opt)</label><input id="c_var" placeholder="rug-9x12-ivory"></div>
    <div><label>Qty</label><input id="c_qty" type="number" value="1"></div></div>
  <button onclick="addToCart()">Add</button>
  <button class="sec" onclick="removeFromCart()">Remove SKU</button>
  <button class="sec" onclick="viewCart()">View cart</button>
 </div>
 <div>
  <h2>4 · Order options (shipping / tax / promo)</h2>
  <div class="row"><div><label>Ship option</label><input id="o_ship" placeholder="standard"></div>
    <div><label>Promo</label><input id="o_promo" placeholder="SAVE10"></div></div>
  <div class="row"><div><label>Ship-to region</label><input id="o_region" placeholder="NY"></div>
    <div><label>Items (sku:qty, …)</label><input id="o_items" placeholder="lamp-arc:1"></div></div>
  <button onclick="quote()">Quote (no signing)</button>
  <button onclick="checkoutOneShot()">Checkout (one-shot)</button>
  <button onclick="checkoutCart()">Checkout (from cart)</button>
  <div id="coState" class="state"></div>

  <h2>5 · Pay (AP2 — buyer signs in browser)</h2>
  <button onclick="pay()">Sign mandates + pay</button>
  <div id="payState" class="state"></div>

  <h2>6 · Order lifecycle</h2>
  <button class="sec" onclick="lifecycle('fulfill')">Fulfill</button>
  <button class="sec" onclick="lifecycle('ship')">Ship</button>
  <button class="sec" onclick="lifecycle('deliver')">Deliver</button>
  <button class="sec" onclick="lifecycle('cancel')">Cancel</button>
  <button onclick="getOrder()">Get order</button>
  <div id="orderState" class="state"></div>

  <h2>7 · x402 (pay-per-call)</h2>
  <div class="row"><div><label>SKU</label><input id="x_sku" placeholder="premium-call"></div></div>
  <button onclick="x402Request()">Request (expect 402)</button>
  <button onclick="x402Pay()">Pay (mock USDC)</button>
  <div id="x402State" class="state"></div>

  <h2>Log</h2>
  <div id="log"></div>
 </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const M = () => $('merchant').value;
let cartId=null, lastCheckout=null, lastOrderId=null;

function log(label, data){
  const el=$('log');
  el.textContent = '▶ '+label+'\\n'+(typeof data==='string'?data:JSON.stringify(data,null,2))+'\\n\\n'+el.textContent;
}
async function api(method, path, body){
  const r = await fetch('/'+M()+path, {method, headers:{'content-type':'application/json'}, body: body?JSON.stringify(body):undefined});
  const j = await r.json().catch(()=>({}));
  log(method+' '+path+' → '+r.status, j);
  if(!r.ok && r.status>=500) throw new Error(path+' '+r.status);
  return {status:r.status, json:j};
}
function parseItems(){
  const s=$('o_items').value.trim(); if(!s) return [];
  return s.split(',').map(x=>{const [sku,qty]=x.trim().split(':');return {sku:sku.trim(), qty:Number(qty||1)};});
}
function orderOpts(){
  const o={}; if($('o_ship').value)o.shippingOptionId=$('o_ship').value.trim();
  if($('o_promo').value)o.promoCode=$('o_promo').value.trim();
  if($('o_region').value)o.shippingAddress={name:'Test Buyer',line1:'1 Main',city:'City',region:$('o_region').value.trim(),postal:'00000',country:'US'};
  return o;
}

async function getJson(path,label){ const {json}=await api('GET',path); log(label,json); }

async function loadCatalog(){
  cartId=null; lastCheckout=null; lastOrderId=null;
  $('cartState').textContent=''; $('coState').textContent=''; $('payState').textContent=''; $('orderState').textContent='';
  const {json}=await api('GET','/catalog');
  const items=(json.items||[]);
  $('catalog').innerHTML = '<ul>'+items.map(p=>
    '<li><code>'+p.sku+'</code> '+p.name+' — $'+(p.price.amount/100).toFixed(2)+
    (p.variants&&p.variants.length?' <span class="muted">('+p.variants.length+' var)</span>':'')+
    ' <button class="sec" style="padding:.05rem .4rem" onclick="delProduct(\\''+p.sku+'\\')">×</button></li>').join('')+'</ul>';
  $('state').textContent = M()+': '+items.length+' products';
}
async function addProduct(){
  const body={sku:$('p_sku').value.trim(),name:$('p_name').value.trim(),price:{amount:Number($('p_price').value),currency:'USD'},
    shipping:{class:$('p_ship').value,freeShipping:true,estimatedDaysMin:3,estimatedDaysMax:7}};
  await api('POST','/products',body); loadCatalog();
}
async function delProduct(sku){ await api('DELETE','/products/'+sku); loadCatalog(); }
async function importSample(){
  await api('POST','/products/import',{products:[
    {sku:'sample-a',name:'Sample A',price:{amount:1500,currency:'USD'}},
    {sku:'sample-b',name:'Sample B',price:{amount:2500,currency:'USD'}}]}); loadCatalog();
}

async function newCart(){ const {json}=await api('POST','/cart'); cartId=json.session_id; $('cartState').textContent='cart '+cartId.slice(0,8)+'…'; }
async function addToCart(){ if(!cartId)return alert('New cart first');
  const b={sku:$('c_sku').value.trim(),qty:Number($('c_qty').value)}; if($('c_var').value)b.variantSku=$('c_var').value.trim();
  const {json}=await api('POST','/cart/'+cartId+'/items',b); if(json.subtotal)$('cartState').textContent='subtotal $'+(json.subtotal.amount/100).toFixed(2); }
async function removeFromCart(){ if(!cartId)return alert('New cart first');
  const v=$('c_var').value.trim(); await api('DELETE','/cart/'+cartId+'/items/'+$('c_sku').value.trim()+(v?'?variant='+v:'')); }
async function viewCart(){ if(!cartId)return alert('New cart first'); await api('GET','/cart/'+cartId); }

async function quote(){ await api('POST','/orders/quote',{items:parseItems(), ...orderOpts()}); }
function afterCheckout(json){
  lastCheckout=json; lastOrderId=json.order_id;
  $('coState').textContent='order '+(json.order_id||'').slice(0,8)+'… · total $'+((json.checkout?.total?.amount||0)/100).toFixed(2)+' · hash '+(json.checkout_hash||'').slice(0,10)+'…';
}
async function checkoutOneShot(){ const {json}=await api('POST','/checkout',{items:parseItems(), ...orderOpts()}); afterCheckout(json); }
async function checkoutCart(){ if(!cartId)return alert('New cart first'); const {json}=await api('POST','/cart/'+cartId+'/checkout',orderOpts()); afterCheckout(json); }

// --- client-side AP2: buyer signs the mandate bundle with Web Crypto ES256 ---
function b64u(buf){ let s=''; const b=new Uint8Array(buf); for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]); return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); }
function b64uStr(str){ return b64u(new TextEncoder().encode(str)); }
async function signJws(header,payload,key){
  const h=b64uStr(JSON.stringify({alg:'ES256',...header})), p=b64uStr(JSON.stringify(payload));
  const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(h+'.'+p));
  return h+'.'+p+'.'+b64u(sig);
}
async function pay(){
  if(!lastCheckout) return alert('Checkout first');
  const kp=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const pub=await crypto.subtle.exportKey('jwk',kp.publicKey);
  const co=lastCheckout, iat=1800000000;
  const checkout_mandate=await signJws({typ:'kb+sd-jwt'},{vct:'mandate.checkout.1',checkout_jwt:co.checkout_jwt,checkout_hash:co.checkout_hash,iat},kp.privateKey);
  const payment_mandate=await signJws({typ:'kb+sd-jwt'},{vct:'mandate.payment.1',transaction_id:co.checkout_hash,payee:co.checkout.merchant,payment_amount:co.checkout.total,payment_instrument:{type:'dev.ucp.mock_payment',id:'mock-instrument-1'},iat},kp.privateKey);
  const bundle={buyer_public_jwk:{kty:pub.kty,crv:pub.crv,x:pub.x,y:pub.y},checkout_mandate,payment_mandate};
  const {json}=await api('POST','/ap2/receipt',{checkout_jwt:co.checkout_jwt,bundle});
  $('payState').textContent = json.status==='authorized' ? ('AUTHORIZED · payment '+json.payment?.status+' · order '+json.order_status) : ('DECLINED: '+json.error);
  $('payState').className = json.status==='authorized' ? 'state' : 'state err';
}

let x402req=null;
async function x402Request(){
  const sku=$('x_sku').value.trim(); if(!sku)return alert('SKU?');
  const r=await fetch('/'+M()+'/x402/'+sku); const j=await r.json();
  log('GET /x402/'+sku+' → '+r.status, j);
  x402req=(j.accepts||[])[0]||null;
  $('x402State').textContent = r.status===402 ? ('402 · pay '+x402req.maxAmountRequired+' atomic USDC → '+x402req.payTo.slice(0,10)+'…') : ('unexpected '+r.status);
}
async function x402Pay(){
  if(!x402req)return alert('Request first');
  const payload={x402Version:1,scheme:'exact',network:x402req.network,payload:{signature:'0xmock',authorization:{from:'0x'+'ab'.repeat(20),to:x402req.payTo,value:x402req.maxAmountRequired,validAfter:'0',validBefore:'99999999999',nonce:'0x'+'0'.repeat(64)}}};
  const r=await fetch('/'+M()+'/x402/'+$('x_sku').value.trim(), {headers:{'X-PAYMENT':btoa(JSON.stringify(payload))}});
  const j=await r.json(); log('GET /x402 (X-PAYMENT) → '+r.status, j);
  $('x402State').textContent = r.status===200 ? ('PAID · settled '+(j.settlement?.transaction||'').slice(0,16)+'…') : ('failed '+r.status+': '+(j.error||''));
  $('x402State').className = r.status===200?'state':'state err';
}
async function lifecycle(action){ if(!lastOrderId)return alert('Pay first'); const {json}=await api('POST','/orders/'+lastOrderId+'/'+action); if(json.status)$('orderState').textContent='status: '+json.status; }
async function getOrder(){ if(!lastOrderId)return alert('Checkout first'); await api('GET','/orders/'+lastOrderId); }

async function report(){
  const {json}=await api('GET','/report');
  const total=(json.passed||0)+(json.failed||0);
  $('state').textContent = json.ok ? ('✓ conformance '+json.passed+'/'+total+' passed') : ('✗ conformance '+json.failed+' failed');
  $('state').className = json.ok ? 'state' : 'state err';
}
async function verifyTerms(){
  const {json:lc}=await api('GET','/.well-known/legal-context.json');
  const r=await fetch(lc.terms); const text=await r.text();
  const hash='0x'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const ok=hash===lc.atrHash;
  log('verify terms hash', {declared:lc.atrHash, recomputed:hash, match:ok});
  $('state').textContent = ok?'✓ terms hash verified':'✗ terms hash MISMATCH';
}

loadCatalog();
</script>
</body></html>`;
}
