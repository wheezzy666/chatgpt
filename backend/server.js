'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {promisify}=require('node:util');
const {Pool}=require('pg');
const scrypt=promisify(crypto.scrypt);
const PORT=Number(process.env.PORT)||10000;
const ORIGIN=process.env.GAME_ORIGIN||'https://perekup-simulator-game.onrender.com';
const SETUP=process.env.ADMIN_SETUP_TOKEN||'';
const dbUrl=process.env.DATABASE_URL||'';
const pool=dbUrl?new Pool({connectionString:dbUrl,max:6,connectionTimeoutMillis:8000,ssl:dbUrl.includes('localhost')?false:{rejectUnauthorized:false}}):null;
const adminHtml=fs.readFileSync(path.join(__dirname,'admin.html'));
const modelText=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const models=Array.from(modelText.matchAll(/\['([^']+)','([^']+)',(\d+),'(sedan|suv|hatch|coupe|wagon)',([0-3])\]/g)).map((m,i)=>({id:i,name:m[1]==='3'||m[1]==='6'?m[1]:m[1],brand:m[1],model:m[2],price:Number(m[3]),body:m[4],tier:Number(m[5])}));
const attempts=new Map();
let dbReady=false,dbError='';
function respond(res,status,obj,extra={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra});res.end(JSON.stringify(obj))}
function textResponse(res,status,message){respond(res,status,{error:message})}
function isOriginAllowed(req){return req.headers.origin===ORIGIN}
function cors(res){res.setHeader('Access-Control-Allow-Origin',ORIGIN);res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Vary','Origin')}
function safeName(s){return typeof s==='string'&&/^[a-zA-Z0-9_\u0400-\u04FF.-]{3,24}$/.test(s.trim())}
function safePassword(s){return typeof s==='string'&&s.length>=10&&s.length<=128}
async function passwordHash(password,salt){return (await scrypt(password,salt,64)).toString('hex')}
async function passValid(p,hash,salt){const a=Buffer.from(await passwordHash(p,salt),'hex'),b=Buffer.from(hash,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)}
function secretMatch(a,b){const ha=crypto.createHash('sha256').update(String(a)).digest(),hb=crypto.createHash('sha256').update(String(b)).digest();return crypto.timingSafeEqual(ha,hb)}
function token(){return crypto.randomBytes(32).toString('hex')}
function sha(t){return crypto.createHash('sha256').update(t).digest('hex')}
function validGame(g){return g&&g.version===1&&Number.isFinite(g.money)&&Math.abs(g.money)<1e13&&Number.isInteger(g.day)&&g.day>=1&&Array.isArray(g.market)&&g.market.length<300&&Array.isArray(g.inventory)&&g.inventory.length<80&&Array.isArray(g.missions)}
function clientIp(req){return req.socket.remoteAddress||'unknown'}
function limitLogin(req){const key=clientIp(req),now=Date.now(),v=attempts.get(key)||{at:now,count:0};if(now-v.at>15*60*1000){v.at=now;v.count=0}v.count++;attempts.set(key,v);return v.count<=25}
function adminOriginOk(req){const origin=req.headers.origin;return !origin||origin==='https://'+req.headers.host||origin==='http://'+req.headers.host}
function jsonBody(req){return new Promise((resolve,reject)=>{if(!String(req.headers['content-type']||'').startsWith('application/json'))return reject(new Error('JSON required'));let str='';req.on('data',chunk=>{str+=chunk;if(str.length>1500000){reject(new Error('Request too large'));req.destroy()}});req.on('end',()=>{try{resolve(JSON.parse(str||'{}'))}catch(e){reject(new Error('Invalid JSON'))}});req.on('error',reject)})}
async function init(){
 if(!pool){dbError='DATABASE_URL отсутствует';return}
 try{
  await pool.query("CREATE TABLE IF NOT EXISTS admins(id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())");
  await pool.query("CREATE TABLE IF NOT EXISTS players(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, game JSONB NOT NULL, next_id INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now())");
  await pool.query("CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, role TEXT NOT NULL, subject TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)");
  await pool.query("CREATE TABLE IF NOT EXISTS admin_actions(id BIGSERIAL PRIMARY KEY, player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE, type TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now())");
  await pool.query("CREATE INDEX IF NOT EXISTS admin_actions_player ON admin_actions(player_id,id)");
  dbReady=true;dbError='';
 }catch(e){dbError=String(e.message).slice(0,180);console.error('DB init:',dbError)}
}
async function sessionCreate(role,subject){const raw=token();await pool.query("INSERT INTO sessions(hash,role,subject,expires_at) VALUES($1,$2,$3,now()+interval '30 days')",[sha(raw),role,String(subject)]);return raw}
async function actor(req,role){let key='';
 if(role==='admin'){const cookies=String(req.headers.cookie||'').split(';').map(s=>s.trim());const c=cookies.find(s=>s.startsWith('perekup_admin='));if(c)key=c.slice('perekup_admin='.length)}
 else {const m=/^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization||''));if(m)key=m[1]}
 if(!/^[a-f0-9]{64}$/.test(key))return null;
 const found=await pool.query("SELECT subject FROM sessions WHERE hash=$1 AND role=$2 AND expires_at>now()",[sha(key),role]);return found.rows[0]?.subject||null;
}
function adminCookie(raw){return 'perekup_admin='+raw+'; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax'}
async function userState(id){
 const p=await pool.query("SELECT id,username,game,next_id,revision FROM players WHERE id=$1",[id]);if(!p.rows.length)return null;
 const row=p.rows[0],last=Math.max(0,Number(row.game._adminSeq)||0);
 const events=await pool.query("SELECT id,type,payload FROM admin_actions WHERE player_id=$1 AND id>$2 ORDER BY id ASC LIMIT 300",[id,last]);
 return {username:row.username,game:row.game,nextId:row.next_id,rev:row.revision,actions:events.rows.map(x=>({id:Number(x.id),type:x.type,payload:x.payload}))};
}
function adminSafe(obj){const seq=Math.max(0,Number(obj.game?._adminSeq)||0);return {...obj,pendingDelta:obj.actions.filter(x=>x.type==='balance').reduce((s,x)=>s+Number(x.payload.amount||0),0),pendingCount:obj.actions.length,appliedSeq:seq}}
async function route(req,res){
 const url=new URL(req.url,'https://backend.local'),p=url.pathname,method=req.method;
 if(p.startsWith('/api/players')||p.startsWith('/api/me')||p==='/api/register'||p==='/api/login'){cors(res);if(method==='OPTIONS')return respond(res,204,{})}
 if(method==='GET'&&p==='/'){res.writeHead(302,{Location:'/admin'});return res.end()}
 if(method==='GET'&&p==='/admin'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"});return res.end(adminHtml)}
 if(method==='GET'&&p==='/api/health'){return respond(res,200,{online:dbReady,dbConfigured:!!pool,error:dbReady?'':dbError,service:'perekup-admin-api'})}
 if(!dbReady)return textResponse(res,503,'База данных ещё не подключена. Настрой DATABASE_URL в Render.');
 if(p.startsWith('/api/admin')){
  if(method==='POST'&&!adminOriginOk(req))return textResponse(res,403,'Invalid origin');
  if(p==='/api/admin/status'&&method==='GET'){const cnt=await pool.query("SELECT COUNT(*)::int AS n FROM admins");return respond(res,200,{configured:cnt.rows[0].n>0})}
  if(p==='/api/admin/setup'&&method==='POST'){
   if(!limitLogin(req))return textResponse(res,429,'Слишком много попыток');
   const b=await jsonBody(req);
   if(!SETUP||SETUP.length<25||!secretMatch(b.setupToken||'',SETUP))return textResponse(res,403,'Неверный одноразовый ключ');
   if(!safeName(b.username)||!safePassword(b.password))return textResponse(res,400,'Логин 3–24 символа, пароль минимум 10 символов');
   const admins=await pool.query("SELECT count(*)::int AS n FROM admins");if(admins.rows[0].n>0)return textResponse(res,409,'Администратор уже создан');
   const salt=crypto.randomBytes(16).toString('hex'),hash=await passwordHash(b.password,salt);
   const created=await pool.query("INSERT INTO admins(username,salt,password_hash) VALUES($1,$2,$3) RETURNING id",[b.username.trim().toLowerCase(),salt,hash]);
   const t=await sessionCreate('admin',created.rows[0].id);
   return respond(res,200,{ok:true},{'Set-Cookie':adminCookie(t)})
  }
  if(p==='/api/admin/login'&&method==='POST'){
   if(!limitLogin(req))return textResponse(res,429,'Слишком много попыток');
   const b=await jsonBody(req),u=String(b.username||'').toLowerCase().trim();
   const q=await pool.query("SELECT * FROM admins WHERE username=$1",[u]);
   if(!q.rows[0]||!safePassword(b.password)||!(await passValid(b.password,q.rows[0].password_hash,q.rows[0].salt)))return textResponse(res,401,'Неверный логин или пароль');
   const t=await sessionCreate('admin',q.rows[0].id);return respond(res,200,{ok:true},{'Set-Cookie':adminCookie(t)})
  }
  const adminId=await actor(req,'admin');if(!adminId)return textResponse(res,401,'Требуется вход администратора');
  if(p==='/api/admin/me'&&method==='GET')return respond(res,200,{ok:true});
  if(p==='/api/admin/logout'&&method==='POST'){const c=String(req.headers.cookie||'').match(/perekup_admin=([a-f0-9]{64})/);if(c)await pool.query("DELETE FROM sessions WHERE hash=$1",[sha(c[1])]);return respond(res,200,{ok:true},{'Set-Cookie':'perekup_admin=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax'})}
  if(p==='/api/admin/models'&&method==='GET')return respond(res,200,{models});
  if(p==='/api/admin/players'&&method==='GET'){
   const q=String(url.searchParams.get('q')||'').slice(0,60),players=await pool.query("SELECT id,username,game,revision,last_seen FROM players WHERE username ILIKE $1 OR coalesce(game->'profile'->>'nickname','') ILIKE $1 ORDER BY last_seen DESC LIMIT 150",['%'+q+'%']);
   const ids=players.rows.map(x=>x.id), events=ids.length?await pool.query("SELECT player_id,id,type,payload FROM admin_actions WHERE player_id=ANY($1::uuid[]) ORDER BY id ASC",[ids]):{rows:[]};
   const list=players.rows.map(row=>{
    const last=Number(row.game._adminSeq)||0,pend=events.rows.filter(e=>e.player_id===row.id&&Number(e.id)>last);
    return {id:row.id,username:row.username,nickname:row.game.profile?.nickname||row.username,money:Number(row.game.money)||0,pendingDelta:pend.filter(e=>e.type==='balance').reduce((s,e)=>s+Number(e.payload.amount),0),pendingDeals:pend.filter(e=>e.type==='deal').length,day:row.game.day,sold:row.game.sold||0,rev:row.revision,lastSeen:row.last_seen}
   });
   return respond(res,200,{players:list});
  }
  const match=/^\/api\/admin\/players\/([a-f0-9-]{36})(?:\/(balance|deal))?$/.exec(p);
  if(match){
   const id=match[1];const player=await pool.query("SELECT id,username,game,revision,last_seen FROM players WHERE id=$1",[id]);if(!player.rows.length)return textResponse(res,404,'Игрок не найден');
   if(method==='GET'&&!match[2]){
    const acts=await pool.query("SELECT id,type,payload,created_at FROM admin_actions WHERE player_id=$1 ORDER BY id DESC LIMIT 50",[id]);
    return respond(res,200,{player:{id,username:player.rows[0].username,game:player.rows[0].game,revision:player.rows[0].revision,lastSeen:player.rows[0].last_seen},history:acts.rows});
   }
   if(method==='POST'&&match[2]){
    const b=await jsonBody(req);let payload,type=match[2];
    if(type==='balance'){
      const amount=Number(b.amount);
      if(!Number.isSafeInteger(amount)||amount===0||Math.abs(amount)>100000000)return textResponse(res,400,'Сумма должна быть от −100 000 000 до 100 000 000 ₽');
      payload={amount};
    }else{
      const modelId=Number(b.modelId),price=Number(b.price),year=Number(b.year),mileage=Number(b.mileage),condition=Number(b.condition);
      if(!Number.isInteger(modelId)||modelId<0||modelId>=models.length||!Number.isSafeInteger(price)||price<1000||price>500000000||!Number.isInteger(year)||year<1980||year>2026||!Number.isInteger(mileage)||mileage<0||mileage>1000000||!Number.isInteger(condition)||condition<10||condition>100)return textResponse(res,400,'Проверь параметры автомобиля');
      payload={modelId,price,year,mileage,condition};
    }
    const action=await pool.query("INSERT INTO admin_actions(player_id,type,payload) VALUES($1,$2,$3) RETURNING id,created_at",[id,type,payload]);
    return respond(res,200,{ok:true,id:Number(action.rows[0].id),notice:'Команда отправлена игроку. Применится при онлайн-синхронизации.'});
   }
  }
  return textResponse(res,404,'Не найдено');
 }
 if(p==='/api/register'&&method==='POST'){
  if(!limitLogin(req))return textResponse(res,429,'Слишком много запросов');
  const b=await jsonBody(req);
  if(!safeName(b.username)||!safePassword(b.password)||!validGame(b.game))return textResponse(res,400,'Проверь логин, пароль и сохранение. Пароль от 10 символов.');
  const username=b.username.trim().toLowerCase(),salt=crypto.randomBytes(16).toString('hex'),hash=await passwordHash(b.password,salt);
  let row;
  try{row=await pool.query("INSERT INTO players(username,salt,password_hash,game,next_id) VALUES($1,$2,$3,$4,$5) RETURNING id",[username,salt,hash,b.game,Math.max(1,Math.floor(Number(b.nextId)||1))])}catch(e){if(e.code==='23505')return textResponse(res,409,'Этот логин уже занят');throw e}
  const t=await sessionCreate('player',row.rows[0].id);return respond(res,200,{token:t,id:row.rows[0].id,rev:1});
 }
 if(p==='/api/login'&&method==='POST'){
  if(!limitLogin(req))return textResponse(res,429,'Слишком много попыток');
  const b=await jsonBody(req),username=String(b.username||'').toLowerCase().trim();
  const q=await pool.query("SELECT id,salt,password_hash FROM players WHERE username=$1",[username]);
  if(!q.rows[0]||!safePassword(b.password)||!(await passValid(b.password,q.rows[0].password_hash,q.rows[0].salt)))return textResponse(res,401,'Неверный логин или пароль');
  const t=await sessionCreate('player',q.rows[0].id);return respond(res,200,{token:t,id:q.rows[0].id});
 }
 if(p.startsWith('/api/me')){
  const id=await actor(req,'player');if(!id)return textResponse(res,401,'Войди в онлайн-аккаунт');
  if(p==='/api/me'&&method==='GET'){await pool.query("UPDATE players SET last_seen=now() WHERE id=$1",[id]);const result=await userState(id);return respond(res,200,result)}
  if(p==='/api/me/sync'&&method==='POST'){
   const b=await jsonBody(req);
   if(!validGame(b.game)||!Number.isInteger(b.rev)||b.rev<1)return textResponse(res,400,'Неверное сохранение');
   const cn=await pool.connect();try{
    await cn.query('BEGIN');
    const current=await cn.query("SELECT revision,game FROM players WHERE id=$1 FOR UPDATE",[id]);
    if(!current.rows.length){await cn.query('ROLLBACK');return textResponse(res,404,'Нет аккаунта')}
    if(current.rows[0].revision!==b.rev){await cn.query('ROLLBACK');return respond(res,409,{error:'Изменения на другом устройстве',state:await userState(id)})}
    // Не позволяем клиенту утверждать, что он применил несуществующие команды администратора.
    const max=await cn.query("SELECT COALESCE(max(id),0)::bigint AS seq FROM admin_actions WHERE player_id=$1",[id]);
    const seq=Number(b.game._adminSeq)||0;
    if(seq>Number(max.rows[0].seq)){await cn.query('ROLLBACK');return textResponse(res,400,'Неверный номер действия')}
    if(seq<(Number(current.rows[0].game._adminSeq)||0)){await cn.query('ROLLBACK');return textResponse(res,409,'Нельзя отменить уже применённые команды администратора')}
    const r=await cn.query("UPDATE players SET game=$2,next_id=$3,revision=revision+1,last_seen=now() WHERE id=$1 RETURNING revision",[id,b.game,Math.max(1,Math.floor(Number(b.nextId)||1))]);
    await cn.query('COMMIT');
    const result=await userState(id);return respond(res,200,{rev:r.rows[0].revision,actions:result.actions});
   }catch(e){try{await cn.query('ROLLBACK')}catch(_){}throw e}finally{cn.release()}
  }
 }
 return textResponse(res,404,'Не найдено');
}
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='OPTIONS'&&req.url?.startsWith('/api/')&&!req.url?.startsWith('/api/admin')){cors(res);res.writeHead(204);return res.end()}
  if(req.url?.startsWith('/api/')&&!req.url?.startsWith('/api/admin')&&req.headers.origin&&!isOriginAllowed(req))return textResponse(res,403,'Origin blocked');
  await route(req,res);
 }catch(e){console.error('Request failed:',e.message);if(!res.headersSent)textResponse(res,e.message==='Request too large'?413:500,'Ошибка сервера');else res.end()}
});
init().finally(()=>server.listen(PORT,'0.0.0.0',()=>console.log('Admin API on '+PORT+'; database: '+dbReady)));
