// ATE GitHub sign-in relay (Cloudflare Worker, free plan).
// Browsers cannot call github.com/login/* directly (GitHub sends no CORS headers there).
// This passes exactly two sign-in calls through. It holds no secrets, stores nothing and
// never sees anyone's code: only the public app ID, the sign-in code and the resulting pass.
const CLIENT_ID='Iv23li8BSDes04NZkw1o';
// The ATE web page, plus the installed apps' own built-in pages: iPhone/iPad (capacitor://localhost),
// Android (https://localhost), Mac and Linux (tauri://localhost) and Windows (http(s)://tauri.localhost).
const ALLOWED=['https://www.cuberoot-systems.com','https://cuberoot-systems.com','capacitor://localhost','https://localhost','tauri://localhost','http://tauri.localhost','https://tauri.localhost'];
export default {
  async fetch(request){
    const origin=request.headers.get('Origin')||'';
    const cors={'Access-Control-Allow-Origin':ALLOWED.includes(origin)?origin:ALLOWED[0],'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type, Accept','Access-Control-Max-Age':'86400','Vary':'Origin','Cache-Control':'no-store'};
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
    const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
    if(request.method!=='POST'||!ALLOWED.includes(origin))return json(403,{error:'not_allowed'});
    const path=new URL(request.url).pathname;
    let body={};try{body=await request.json()}catch{}
    let target,form;
    if(path==='/device/code'){target='https://github.com/login/device/code';form={client_id:CLIENT_ID};}
    else if(path==='/access_token'){
      if(typeof body.device_code!=='string'||body.device_code.length>200)return json(400,{error:'bad_request'});
      target='https://github.com/login/oauth/access_token';form={client_id:CLIENT_ID,device_code:body.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'};
    }else return json(404,{error:'not_found'});
    const r=await fetch(target,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded','User-Agent':'ATE-sign-in-relay'},body:new URLSearchParams(form)});
    const text=await r.text();let data;try{data=JSON.parse(text)}catch{return json(502,{error:'github_unavailable'})}
    // Pass on only the fields ATE needs.
    const keep=path==='/device/code'?['device_code','user_code','verification_uri','expires_in','interval','error']:['access_token','token_type','expires_in','error','interval'];
    return json(r.ok?200:502,Object.fromEntries(keep.filter(k=>k in data).map(k=>[k,data[k]])));
  }
};
