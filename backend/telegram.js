'use strict';
const crypto=require('node:crypto');
const BOT_TOKEN=(process.env.TELEGRAM_BOT_TOKEN||'').trim();
const GAME_URL=process.env.GAME_ORIGIN||'https://perekup-simulator-game.onrender.com';
const API_URL=process.env.PUBLIC_API_URL||'https://perekup-control-api.onrender.com';
const HOOK_SECRET=BOT_TOKEN?crypto.createHash('sha256').update('perekup-webhook:'+BOT_TOKEN).digest('hex'):'';
const WEB_APP_URL=GAME_URL+'/?tg=1';

function safeEqual(a,b){
  if(typeof a!=='string'||typeof b!=='string')return false;
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length===right.length&&crypto.timingSafeEqual(left,right);
}
function validateInitData(initData,now=Date.now()){
  if(!BOT_TOKEN||typeof initData!=='string'||initData.length<20||initData.length>8192)return null;
  const params=new URLSearchParams(initData);
  const hash=params.get('hash');
  if(!hash||!(/^[0-9a-f]{64}$/i).test(hash))return null;
  const values=[...params.entries()];
  if(new Set(values.map(([k])=>k)).size!==values.length)return null;
  const authDate=Number(params.get('auth_date'));
  const current=Math.floor(now/1000);
  if(!Number.isSafeInteger(authDate)||authDate>current+60||current-authDate>86400)return null;
  const checkString=values.filter(([k])=>k!=='hash'&&k!=='signature')
    .sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([k,v])=>k+'='+v).join('\n');
  const key=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
  const expected=crypto.createHmac('sha256',key).update(checkString).digest('hex');
  if(!safeEqual(expected,hash.toLowerCase()))return null;
  let user;
  try{user=JSON.parse(params.get('user')||'null')}catch(_){return null}
  if(!user||!Number.isSafeInteger(user.id)||user.id<1)return null;
  return {id:String(user.id),firstName:String(user.first_name||'Игрок').slice(0,50),
    lastName:String(user.last_name||'').slice(0,50),username:String(user.username||'').slice(0,32),
    photoUrl:String(user.photo_url||'').slice(0,1000)};
}
async function telegramApi(method,body){
  if(!BOT_TOKEN)throw Error('TELEGRAM_BOT_TOKEN not configured');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/'+method,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
    const data=await r.json();
    if(!r.ok||!data.ok)throw Error('Telegram '+method+': '+(data.description||r.status));
    return data.result;
  }finally{clearTimeout(timer)}
}
function telegramWebhookAllowed(req){return !!HOOK_SECRET&&safeEqual(req.headers['x-telegram-bot-api-secret-token']||'',HOOK_SECRET)}
function openGameKeyboard(){
  return {inline_keyboard:[[{'text':'🚗 Играть в «Перекупа»','web_app':{url:WEB_APP_URL}}]]};
}
async function handleTelegramUpdate(update){
  const message=update?.message;
  if(!message||message.chat?.type!=='private'||!message.chat?.id)return;
  const command=String(message.text||'').split(' ')[0].toLowerCase().replace(/@\w+$/,'');
  if(!['/start','/play','/help','/game','/menu'].includes(command))return;
  const text=command==='/help'
    ?'🚗 «Симулятор перекупа» — покупай машины, торгуйся, чини, продавай и развивай собственную СТО.\n\nНажми кнопку ниже или открой игру через меню бота. Прогресс сохраняется в Telegram-аккаунте.'
    :'🚗 Добро пожаловать в «Симулятор перекупа»!\n\n💰 Начни с небольшого капитала, ищи выгодные авто, торгуйся с продавцами, ремонтируй машины и открывай свой автосалон.\n\n👇 Нажми кнопку, чтобы играть прямо внутри Telegram.';
  await telegramApi('sendMessage',{chat_id:message.chat.id,text,reply_markup:openGameKeyboard()});
}
async function configureBot(){
  if(!BOT_TOKEN){console.log('Telegram bot disabled: set TELEGRAM_BOT_TOKEN in Render Environment');return}
  const bot=await telegramApi('getMe',{});
  await telegramApi('setMyCommands',{commands:[
    {command:'start',description:'Открыть Симулятор перекупа'},
    {command:'play',description:'Играть внутри Telegram'},
    {command:'help',description:'Как играть'}
  ]});
  await telegramApi('setChatMenuButton',{menu_button:{type:'web_app',text:'🚗 Играть',web_app:{url:WEB_APP_URL}}});
  await telegramApi('setWebhook',{url:API_URL+'/api/telegram/webhook',secret_token:HOOK_SECRET,
    allowed_updates:['message'],drop_pending_updates:false});
  console.log('Telegram bot configured: @'+bot.username+'; Mini App '+WEB_APP_URL);
}
module.exports={BOT_TOKEN,WEB_APP_URL,validateInitData,telegramWebhookAllowed,handleTelegramUpdate,configureBot};
