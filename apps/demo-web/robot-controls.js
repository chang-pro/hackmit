const host = document.createElement('section');
host.style.cssText='position:fixed;right:18px;top:18px;z-index:90;font:14px system-ui;color:#eef2ff;max-width:340px';
host.innerHTML=`<button id="dog-toggle" type="button">Control the dog</button>
<div id="dog-panel" hidden style="margin-top:8px;padding:18px;border-radius:16px;background:#20263a;box-shadow:0 8px 30px #0004">
<form id="dog-form" novalidate><label for="dog-destination">Saved destination</label>
<input id="dog-destination" list="dog-places" placeholder="table" required  style="display:block;margin:10px 0;padding:10px;width:90%" />
<datalist id="dog-places"></datalist><p>Navigate, scan, then choose what to sell or keep.</p>
<button id="dog-go" type="submit">Go and scan</button> <button id="dog-stop" type="button" disabled>Stop</button></form>
<p id="dog-status" role="status" aria-live="polite"></p><a id="dog-result" hidden style="color:#9de6ff">Review scanned items →</a></div>`;
document.body.append(host);
const el=id=>host.querySelector('#'+id);
let requestError = null;
let submitting = false;
let initializedDestination = false;
for (const b of host.querySelectorAll('button')) b.style.cssText='padding:10px 14px;border:1px solid #aaa;border-radius:10px;cursor:pointer;font:inherit';
el('dog-toggle').onclick=()=>{el('dog-panel').hidden=!el('dog-panel').hidden; refresh();};
async function request(path, body) {
 const options = body===undefined ? {cache:'no-store'} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
 options.signal=AbortSignal.timeout(8000);
 let r;
 try { r=await fetch('/api/robot/'+path,options); }
 catch(e){if(e.name==='TimeoutError')throw Error('Request timed out. Check mission status before retrying; close other ReLoop tabs.');throw e;}

 const data=await r.json(); if(!r.ok) throw Error(data.error||'Request failed'); return data;
}
function paint(data) {
 el('dog-status').textContent=requestError || data.message;
 const busy=['running','stopping'].includes(data.state);
 el('dog-go').disabled=busy || submitting; el('dog-stop').disabled=!busy||data.state==='stopping';
 el('dog-result').hidden=!(data.state==='complete'&&data.photoUrl);
 if(data.photoUrl) el('dog-result').href=data.photoUrl;
 if(data.waypoints) {
   el('dog-places').replaceChildren(...data.waypoints.map(name=>{const o=document.createElement('option');o.value=name;return o;}));
   if(!initializedDestination && data.waypoints.length) {
     if(!el('dog-destination').value) el('dog-destination').value=data.waypoints.includes('table')?'table':data.waypoints[0];
     initializedDestination=true;
   }
 }
}
async function refresh(){
 if(submitting) return;
 try{paint(await request('status'));}catch(e){requestError=e.message;el('dog-status').textContent=requestError;}
}
el('dog-destination').oninput=()=>{requestError=null;};
el('dog-form').onsubmit=async event=>{
 event.preventDefault();
 if(submitting) return;
 const destination=el('dog-destination').value.trim();
 if(!destination){requestError='Enter a saved destination, such as table.';el('dog-status').textContent=requestError;return;}
 if(!/^[a-zA-Z0-9_-]{1,40}$/.test(destination)){requestError='Use the saved name only, for example table.';el('dog-status').textContent=requestError;return;}
 submitting=true;requestError=null;el('dog-go').disabled=true;
 el('dog-status').textContent='Sending mission to the robot…';
 try{paint(await request('go',{destination,issued_at:Date.now()}));}
 catch(e){requestError=e.message;el('dog-status').textContent=requestError;}
 finally{submitting=false;await refresh();}
};
el('dog-stop').onclick=async()=>{try{requestError=null;paint(await request('stop',{}));}catch(e){requestError=e.message;el('dog-status').textContent=requestError;}};
setInterval(()=>{if(!el('dog-panel').hidden) refresh();},1000);
