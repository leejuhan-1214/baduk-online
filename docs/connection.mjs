import { WS_URL } from './config.mjs';

const accountKey = 'sudam-go.account.v1';
const pendingKey = 'sudam-go.pending.v1';
function read(storage, key) { try {return storage.getItem(key);} catch {return null;} }
function write(storage, key, value) {try {if(value==null)storage.removeItem(key);else storage.setItem(key,value);}catch{/* Private browser storage may be unavailable. */}}

export function createConnection({ onState, onStatus, onError }) {
  let token = read(localStorage,accountKey), socket = null, ready = false, wanted = false, fatal = false;
  let retryTimer, timer, pingTimer, pongTimer, tries=0, name='', status='idle';
  let httpActive=false, generation=0, cursor=0, nextHttp=false;
  const httpOrigin=WS_URL ? new URL(WS_URL,location.href).origin.replace(/^ws/,'http') : '';
  const waiters=new Set(), pending=new Map();
  try {
    const saved=JSON.parse(read(sessionStorage,pendingKey) || '[]');
    if(token && Array.isArray(saved)) for(const command of saved) pending.set(command.id,{command});
  } catch {/* Ignore incomplete writes from old sessions. */}
  function savePending() {write(sessionStorage,pendingKey,JSON.stringify([...pending.values()].map(entry=>entry.command)));}
  function updateStatus(value) {status=value;onStatus(value);}
  function settled(id,failure) {
    const entry=pending.get(id);
    if(!entry) return;
    pending.delete(id);savePending();
    if(failure){if(entry.reject)entry.reject(failure);else onError(failure.message);}
    else entry.resolve?.();
    onStatus(status);
  }
  function welcome(message) {
    ready=true;tries=0;
    if(message.token){token=message.token;write(localStorage,accountKey,token);}
    onState(message,true);updateStatus('ready');
    for(const entry of pending.values()) transmit(entry.command);
    for(const waiter of waiters)waiter.resolve();waiters.clear();
  }
  function retry(useHttp){
    ready=false;clearTimeout(timer);clearInterval(pingTimer);clearTimeout(pongTimer);
    if(!wanted||fatal)return;
    nextHttp=useHttp;updateStatus('reconnecting');
    clearTimeout(retryTimer);retryTimer=setTimeout(open,Math.min(12000,600*2**Math.min(tries++,4)));
  }
  function badHello(error){
    fatal=true;clearTimeout(timer);
    for(const waiter of waiters)waiter.reject(error);waiters.clear();
    updateStatus('unavailable');onError(error.message);
  }
  async function request(path,method,body,timeout=16000){
    const controller=new AbortController(),cutoff=setTimeout(()=>controller.abort(),timeout);
    try{
      const response=await fetch(httpOrigin+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},
        ...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,cache:'no-store',credentials:'omit'});
      const message=await response.json();
      if(!response.ok||message.type==='error'){
        throw Object.assign(new Error(message.message||'서버 요청에 실패했습니다.'),{code:message.code,httpStatus:response.status});
      }
      return message;
    }finally{clearTimeout(cutoff);}
  }
  function endHttp(epoch){
    if(epoch!==generation)return;generation++;httpActive=false;retry(false);
  }
  async function openHttp() {
    const epoch=++generation;httpActive=true;nextHttp=false;
    try{
      const first=await request('/api/hello','POST',{type:'hello',...(token?{token}:{name})},9000);
      if(epoch!==generation)return;
      if(first.type!=='welcome')throw new Error('온라인 접속 상태를 확인해 주세요.');
      cursor=first.cursor||0;welcome(first);
      while(httpActive&&epoch===generation){
        const page=await request('/api/events?after='+cursor+'&wait=15','GET',null,23000);
        if(epoch!==generation)return;
        for(const state of page.events||[]){if(state.type==='state')onState(state,false);}
        cursor=Math.max(cursor,page.cursor||0);
      }
    }catch(e){
      if(epoch!==generation)return;
      if(e.code==='invalid_token'){httpActive=false;badHello(e);return;}
      endHttp(epoch);
    }
  }
  function transmit(command){
    if(!httpActive){
      try{socket.send(JSON.stringify(command));}catch{socket?.close();}
      return;
    }
    const epoch=generation;
    request('/api/command','POST',command).then(message=>{
      if(epoch!==generation)return;
      if(message.reply?.type==='ack')settled(command.id);
      // The subscription owns the cursor, including moves received while this request was in flight.
    }).catch(e=>{
      if(epoch!==generation)return;
      if(e.code && e.httpStatus<500)settled(command.id,e);
      else endHttp(epoch);
    });
  }
  function open() {
    if(!wanted||fatal||socket||httpActive||!WS_URL) return;
    clearTimeout(retryTimer);updateStatus(tries?'reconnecting':'connecting');
    if(nextHttp){void openHttp();return;}
    let active;
    try {active=new WebSocket(WS_URL);} catch {retry(true);return;}
    socket=active;
    timer=setTimeout(()=>{if(socket===active&&!ready)active.close();},4800);
    active.onopen=()=>{if(socket!==active)return;active.send(JSON.stringify({type:'hello',...(token?{token}:{name})}));};
    active.onmessage=event=>{
      if(socket!==active)return;
      let msg;try {msg=JSON.parse(event.data);}catch{return;}
      if(msg.type==='welcome'){
        clearTimeout(timer);welcome(msg);
        clearInterval(pingTimer);clearTimeout(pongTimer);
        pingTimer=setInterval(()=>{
          if(socket!==active||active.readyState!==WebSocket.OPEN)return;
          try{active.send(JSON.stringify({type:'ping'}));}catch{active.close();return;}
          clearTimeout(pongTimer);pongTimer=setTimeout(()=>{if(socket===active) active.close();},15000);
        },18000);
      } else if(msg.type==='pong'){
        clearTimeout(pongTimer);
      } else if(msg.type==='state' && ready) onState(msg,false);
      else if(msg.type==='ack') settled(msg.id);
      else if(msg.type==='error'){
        const error=Object.assign(new Error(msg.message || '요청을 처리할 수 없습니다.'),{code:msg.code});
        if(msg.id){settled(msg.id,error);return;}
        if(!ready){badHello(error);active.close();}else onError(error.message);
      }
    };
    active.onclose=()=>{
      if(socket!==active)return;const hadSession=ready;socket=null;retry(!hadSession);
    };
    active.onerror=()=>{/* The close event schedules recovery with the same private token. */};
  }
  async function connect(alias='') {
    if(ready)return;
    if(!WS_URL)throw new Error('온라인 서버 주소가 설정되지 않았습니다. 연습 대국을 이용해 주세요.');
    if(fatal)throw new Error('계정 접속 정보를 확인할 수 없습니다. 같은 브라우저에서 다시 열어 주세요.');
    wanted=true;name=alias;open();
    await new Promise((resolve,reject)=>{
      const waiter={resolve:()=>{clearTimeout(timeout);resolve();},reject:error=>{clearTimeout(timeout);reject(error);}};
      const timeout=setTimeout(()=>{waiters.delete(waiter);reject(new Error('서버 연결을 기다리고 있습니다. 연결되면 다시 시도해 주세요.'));},12000);
      waiters.add(waiter);
    });
  }
  function command(op, fields={}) {
    if(!ready||(!httpActive&&socket?.readyState!==WebSocket.OPEN))return Promise.reject(new Error('서버에 재접속하고 있습니다.'));
    const id=crypto.randomUUID(), command={...fields,type:'command',id,op};
    return new Promise((resolve,reject)=>{pending.set(id,{command,resolve,reject});savePending();onStatus(status);transmit(command);});
  }
  window.addEventListener('offline',()=>{if(socket)socket.close();else if(httpActive)endHttp(generation);});
  window.addEventListener('online',()=>{if(wanted&&!socket&&!httpActive){clearTimeout(retryTimer);open();}});
  return {connect,command,get ready(){return ready;},get busy(){return pending.size>0;},get status(){return status;},get hasAccount(){return Boolean(token);}};
}
