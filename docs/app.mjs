import { createGame, applyAction, chooseBotAction, areaScore } from './go.mjs';
import { createBoard, coordinate } from './board.mjs';
import { createConnection } from './connection.mjs';

const $ = id => document.getElementById(id);
const modeNames = {practice:'연습 대국',bot:'봇 대국',friend:'친구 대국'};
const levelNames = {easy:'쉬움',normal:'보통',hard:'어려움'};
const stoneName = color => color === 1 ? '흑' : '백';
function read(key,fallback=null) {try{return JSON.parse(localStorage.getItem('sudam-go.'+key))??fallback;}catch{return fallback;}}
function save(key,value) {try{localStorage.setItem('sudam-go.'+key,JSON.stringify(value));}catch{/* The current game still works without persistent storage. */}}
function practiceRoom(size, difficulty) {
  return {code:'practice',revision:0,mode:'practice',difficulty,matchId:crypto.randomUUID(),size,you:1,
    players:{1:{name:'나'},2:{name:'연습 봇'}},game:createGame(size),rematch:[]};
}
let practice = read('practice.v1');
if(!practice?.game || ![9,13,19].includes(practice.size) || !Array.isArray(practice.game.history)) practice=practiceRoom(13,'normal');
let viewed=practice, currentOnline=null, profile=read('profile'), displayQueue=[], displayTimer=null, botTimer=null;
let localHistory=read('localHistory',[]), logState=read('log',{matchId:null,entries:[]});
let sounds=read('sounds',true), audio, toastTimer, setupBusy=false, confirming=null;
let mode='practice',size=practice.size,level=practice.difficulty;
let controlBusy=false;
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const invitedCode=(new URL(location.href).searchParams.get('room')||'').trim().toUpperCase();
const board=createBoard($('board'),clickBoard,boardEnabled);
const net=createConnection({onState:receive,onStatus:()=>{render();if($('settingsDialog').open && net.ready && $('setupStatus').dataset.waiting){$('setupStatus').textContent='서버에 연결되었습니다.';}},onError:notify});

function notify(message) {
  if($('settingsDialog').open) {$('setupStatus').textContent=message;return;}
  $('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>$('toast').hidden=true,3400);
}
function audioUnlock(){
  if(!sounds)return;
  try{audio ||= new (window.AudioContext||window.webkitAudioContext)();if(audio.state==='suspended')audio.resume().catch(()=>{});}catch{/* Audio is optional. */}
}
function tick(){
  if(!sounds||!audio||audio.state!=='running')return;
  const n=audio.currentTime,osc=audio.createOscillator(),gain=audio.createGain();
  osc.type='triangle';osc.frequency.setValueAtTime(1110,n);osc.frequency.exponentialRampToValueAtTime(310,n+.048);
  gain.gain.setValueAtTime(.18,n);gain.gain.exponentialRampToValueAtTime(.0001,n+.09);
  osc.connect(gain).connect(audio.destination);osc.start(n);osc.stop(n+.1);
}
document.addEventListener('pointerdown',audioUnlock,{once:true});
function available(){return viewed.mode==='practice'||(net.ready&&!net.busy&&currentOnline?.code===viewed.code&&currentOnline.revision===viewed.revision);}
function boardEnabled(){const g=viewed.game;return !controlBusy&&available()&&g&&(g.phase==='scoring'||(g.phase==='playing'&&g.turn===viewed.you));}
function clickBoard(x,y){
  if(!boardEnabled())return;
  void act(viewed.game.phase==='scoring'?{type:'markDead',x,y}:{type:'play',x,y});
}
function pushLog(room,playSound){
  if(logState.matchId!==room.matchId)logState={matchId:room.matchId,entries:[]};
  const g=room.game,last=g?.lastMove;
  if(last&&['pass','play'].includes(last.type)&&!logState.entries.some(x=>x.no===g.moveNumber)){
    logState.entries.unshift({no:g.moveNumber,color:last.color,label:last.type==='pass'?'한 수 쉼':coordinate(room.size,last.x,last.y)});
    logState.entries=logState.entries.slice(0,5);
    if(playSound&&last.type==='play')tick();
  }
  save('log',logState);
}
function show(room,playSound=true){viewed=room;pushLog(room,playSound);render();}
function drainQueue(){
  if(displayTimer!==null||!displayQueue.length)return;
  show(displayQueue.shift());
  displayTimer=setTimeout(()=>{displayTimer=null;drainQueue();},reduced.matches?0:380);
}
function receive(message,welcome) {
  const next=message.room;
  if(next && currentOnline?.code===next.code && next.revision<currentOnline.revision)return;
  profile=message.profile;save('profile',profile);
  if(!next){
    if(currentOnline||viewed.mode!=='practice'){
      displayQueue=[];clearTimeout(displayTimer);displayTimer=null;currentOnline=null;show(practice,false);scheduleBot();
    }
    render();return;
  }
  if(currentOnline?.code===next.code && currentOnline.revision===next.revision){render();return;}
  const changed=currentOnline?.code!==next.code;
  currentOnline=next;clearTimeout(botTimer);
  if(changed){displayQueue=[];clearTimeout(displayTimer);displayTimer=null;show(next,false);}
  else{displayQueue.push(next);drainQueue();}
  if(welcome && invitedCode===next.code && $('settingsDialog').open) $('settingsDialog').close();
}
function scheduleBot(){
  clearTimeout(botTimer);
  if(viewed.mode!=='practice'||practice.game.phase==='finished')return;
  const g=practice.game;
  if(g.phase==='playing'?g.turn!==2:g.confirmed.includes(2))return;
  const id=practice.matchId;
  botTimer=setTimeout(()=>{
    if(practice.matchId!==id||viewed.mode!=='practice')return;
    const move=chooseBotAction({...practice.game,turn:2},practice.difficulty);
    localAction(2,move);
  },reduced.matches?180:670);
}
function localAction(color,action){
  const game=applyAction(practice.game,color,action);
  practice={...practice,revision:practice.revision+1,game};save('practice.v1',practice);
  if(game.result&&!localHistory.some(row=>row.matchId===practice.matchId)){
    localHistory.unshift({matchId:practice.matchId,mode:'practice',difficulty:practice.difficulty,won:game.result.winner===practice.you,
      reason:game.result.reason,margin:game.result.margin,at:new Date().toISOString()});
    localHistory=localHistory.slice(0,50);save('localHistory',localHistory);
  }
  show(practice);scheduleBot();
}
function revisionFields(room=currentOnline){return {code:room.code,revision:room.revision,matchId:room.matchId};}
async function act(action){
  if(controlBusy||!available()||!viewed.game)return;
  audioUnlock();
  try{
    if(viewed.mode==='practice')localAction(viewed.you,action);
    else{controlBusy=true;render();await net.command('action',{...revisionFields(viewed),action});}
  }catch(e){notify(e.message);}finally{controlBusy=false;render();}
}
function setTextMetric(id,value,unit){const fragment=document.createDocumentFragment();fragment.append(String(value));const s=document.createElement('small');s.textContent=unit;fragment.append(s);$(id).replaceChildren(fragment);}
function resultText(result){return stoneName(result.winner)+' '+(result.reason==='resign'?'불계승':result.margin+'집 승');}
function render(){
  const g=viewed.game, offline=viewed.mode==='practice', waiting=!g;
  const onlineDown=!offline&&!net.ready, mine=viewed.you;
  $('boardSize').textContent=viewed.size+'줄';$('modeTag').textContent=modeNames[viewed.mode];
  for(const [color,id] of [[1,'Black'],[2,'White']]){
    const name=viewed.players[color]?.name || '입장 대기';
    $(id.toLowerCase()+'Name').textContent=name+(!offline&&viewed.players[color]&&color===mine?' · 나':'');
    $('seat'+id).classList.toggle('current',g?.phase==='playing'&&g.turn===color);
  }
  let status;
  if(onlineDown)status='서버에 다시 연결하고 있습니다.';
  else if(waiting)status='친구의 입장을 기다리고 있습니다.';
  else if(g.phase==='finished')status=resultText(g.result);
  else if(g.phase==='scoring')status=g.confirmed.includes(mine)?'상대의 계가 동의를 기다립니다.':'계가를 확인해 주세요.';
  else if(g.turn===mine)status=stoneName(mine)+'돌을 놓을 차례입니다.';
  else status=viewed.mode==='friend'?'상대가 다음 수를 생각 중입니다.':'봇이 다음 수를 생각 중입니다.';
  $('statusText').textContent=status;$('signal').classList.toggle('disconnected',onlineDown);
  setTextMetric('moves',g?.moveNumber??0,'수');setTextMetric('blackCaptures',g?.captures[1]??0,'개');setTextMetric('whiteCaptures',g?.captures[2]??0,'개');
  const tally=g && (g.phase==='scoring'||g.result?.reason==='score')?areaScore(g):null;
  const blocked=!available()||controlBusy;
  $('pass').parentElement.hidden=g?.phase==='finished'||g?.phase==='scoring';
  $('pass').disabled=blocked||waiting||g.turn!==mine;$('resign').disabled=blocked||waiting;
  $('scoringControls').hidden=g?.phase!=='scoring';
  $('confirmScore').disabled=blocked||g?.confirmed.includes(mine);$('resume').disabled=blocked;
  $('rematch').hidden=g?.phase!=='finished';$('rematch').disabled=blocked||viewed.rematch.includes(mine);
  $('rematch').textContent=offline?'다시 두기':viewed.rematch.includes(mine)?'상대의 재대전 동의를 기다리는 중':'재대전 신청';
  let note='';
  if(waiting)note='초대 링크나 방 코드를 친구에게 보내 주세요.';
  if(g?.phase==='scoring')note='흑 '+tally.black+'집 · 백 '+tally.white+'집. 죽은 돌을 눌러 표시한 뒤 계가에 동의하세요.';
  if(g?.phase==='finished'){
    const record=profile?.history?.find(entry=>entry.matchId===viewed.matchId);
    note=(g.result.reason==='score'?'흑 '+tally.black+'집 · 백 '+tally.white+'집':'기권으로 대국이 종료되었습니다.')+(record?' · '+(record.delta>0?'+':'')+record.delta+'코인':'');
  }
  $('phaseNote').textContent=note;$('phaseNote').hidden=!note;
  $('roomStrip').hidden=viewed.mode!=='friend';$('roomCode').textContent=viewed.mode==='friend'?viewed.code:'';
  $('copyRoom').disabled=onlineDown;
  const boardGame=g||emptyBoard(viewed.size);
  board(boardGame,tally?.territory);
  $('emptyLog').hidden=Boolean(logState.entries?.length);$('logCount').textContent=(g?.moveNumber??0)+'수';
  const rows=(logState.entries||[]).map(item=>{
    const li=document.createElement('li'),no=document.createElement('span'),dot=document.createElement('i'),color=document.createElement('b'),coord=document.createElement('span');
    no.className='move-no';no.textContent=item.no+'수';dot.className='dot-stone '+(item.color===1?'black':'white');color.textContent=stoneName(item.color);coord.className='coord';coord.textContent=item.label;li.append(no,dot,color,coord);return li;
  });$('moveLog').replaceChildren(...rows);
  const title=sounds?'착수 소리 끄기':'착수 소리 켜기';
  $('soundButton').setAttribute('aria-label',title);$('soundButton').title=title;$('soundButton').setAttribute('aria-pressed',String(sounds));
  $('soundButton').querySelector('use').setAttribute('href',sounds?'#i-sound':'#i-mute');
  if($('historyDialog').open)renderHistory();
}
const emptyBoards=new Map();
function emptyBoard(n){if(!emptyBoards.has(n))emptyBoards.set(n,createGame(n));return emptyBoards.get(n);}

function renderHistory(){
  const stats=$('profileStats');stats.replaceChildren();
  if(profile){const p=document.createElement('p');p.className='profile-line';p.textContent=profile.name+' · '+profile.coins+'코인 · '+profile.wins+'승 '+profile.losses+'패 · 누적 '+profile.score+'점';stats.append(p);}
  const data=[...(profile?.history||[]),...localHistory].sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,50);
  const rows=data.map(entry=>{const li=document.createElement('li'),left=document.createElement('div'),strong=document.createElement('strong'),date=document.createElement('small'),right=document.createElement('span');
    strong.textContent=modeNames[entry.mode]+' · '+(entry.won?'승리':'패배');date.textContent=new Intl.DateTimeFormat('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(entry.at));
    right.textContent=(entry.reason==='resign'?'불계':entry.margin+'집')+(entry.delta!=null?' · '+(entry.delta>0?'+':'')+entry.delta+'코인':'');left.append(strong,date);li.append(left,right);return li;});
  if(!rows.length){const li=document.createElement('li');li.className='history-empty';li.textContent='아직 완료한 대국이 없습니다.';rows.push(li);}
  $('historyList').replaceChildren(...rows);
}
function refreshSetup(){
  for(const b of document.querySelectorAll('[data-mode]')){const active=b.dataset.mode===mode;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));}
  for(const [id,value] of [['sizes',size],['levels',level]])for(const b of $(id).children){
    const active=b.dataset.value===String(value);b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));}
  $('levelsField').hidden=mode==='friend';$('onlineFields').hidden=mode==='practice';$('joinField').hidden=mode!=='friend';
  const rewards={easy:'승리 5코인 · 패배 최대 10코인',normal:'승리 10코인 · 패배 최대 10코인',hard:'승리 20코인 · 패배 최대 20코인'};
  $('setupHelp').textContent=mode==='practice'?'코인 부담 없이 이 기기에서 봇과 연습합니다.':mode==='friend'?'방을 만들고 초대 링크를 보내세요. 집 차이당 10코인, 기권은 10코인으로 정산하며 패자의 잔액은 음수가 될 수 있습니다.':'서버에서 봇과 대국하고 전적을 기록합니다. '+rewards[level]+'.';
  $('createGame').textContent=mode==='friend'?'친구 대국방 만들기':mode==='bot'?'봇 대국 시작':'연습 대국 시작';
  for(const input of $('settingsDialog').querySelectorAll('button:not(.modal-close), input'))input.disabled=setupBusy;
}
function openSettings(selected){
  mode=selected||viewed.mode;size=viewed.size;level=viewed.difficulty||'normal';
  $('nickname').value=profile?.name||read('nickname','');
  $('setupStatus').textContent='';delete $('setupStatus').dataset.waiting;
  refreshSetup();if(!$('settingsDialog').open)$('settingsDialog').showModal();
}
function confirmAction(title,description,label,callback){
  $('confirmTitle').textContent=title;$('confirmText').textContent=description;$('confirmYes').textContent=label;confirming=callback;$('confirmDialog').showModal();
}
function clearInvite(){const url=new URL(location.href);if(url.searchParams.has('room')){url.searchParams.delete('room');history.replaceState(null,'',url);}}
async function startSetup(join=false,replace=false){
  if(setupBusy)return;
  if(currentOnline?.game && currentOnline.game.phase!=='finished'){
    $('setupStatus').textContent='현재 온라인 대국을 마친 뒤 새 방을 열 수 있습니다.';return;
  }
  if(join && !/^[A-Z2-9]{6}$/.test($('joinCode').value.trim().toUpperCase())){$('setupStatus').textContent='친구가 보낸 여섯 자리 방 코드를 입력하세요.';return;}
  if(!replace&&mode==='practice'&&practice.game.moveNumber>0&&practice.game.phase!=='finished'){
    confirmAction('새 연습 대국을 시작할까요?','진행 중인 연습 대국의 바둑판이 초기화됩니다.','새 대국 시작',()=>startSetup(join,true));return;
  }
  setupBusy=true;refreshSetup();$('setupStatus').textContent=mode==='practice'?'':'서버에 연결하고 있습니다…';
  try{
    if(mode!=='practice'||currentOnline){
      const alias=$('nickname').value.trim();
      await net.connect(alias);delete $('setupStatus').dataset.waiting;
      if(currentOnline?.game&&currentOnline.game.phase!=='finished')throw new Error('복구한 대국이 진행 중입니다. 현재 대국을 마쳐 주세요.');
      if(currentOnline) await net.command('leave',revisionFields());
      if(mode!=='practice'){
        if(alias&&profile?.name!==alias)await net.command('rename',{name:alias});
        save('nickname',alias);
        if(join)await net.command('join',{code:$('joinCode').value.trim().toUpperCase()});
        else await net.command('create',{mode,size,difficulty:level});
      }
    }
    if(mode==='practice'){
      practice=practiceRoom(size,level);save('practice.v1',practice);show(practice,false);scheduleBot();
    }
    clearInvite();$('settingsDialog').close();
  }catch(e){$('setupStatus').textContent=e.message;if(!net.ready)$('setupStatus').dataset.waiting='1';}
  finally{setupBusy=false;refreshSetup();}
}
async function copyInvite(){
  if(viewed.mode!=='friend')return;
  const url=new URL(location.href);url.searchParams.set('room',viewed.code);
  try{await navigator.clipboard.writeText(url.href);notify('친구에게 보낼 초대 링크를 복사했습니다.');}
  catch{const field=document.createElement('textarea');field.value=url.href;document.body.append(field);field.select();const ok=document.execCommand('copy');field.remove();notify(ok?'초대 링크를 복사했습니다.':'친구에게 방 코드 '+viewed.code+'를 알려 주세요.');}
}
for(const dialog of document.querySelectorAll('dialog')){
  dialog.querySelector('.modal-close').onclick=()=>dialog.close();
  dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const rect=dialog.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)dialog.close();});
}
$('homeNav').onclick=()=>window.scrollTo({top:0,behavior:reduced.matches?'instant':'smooth'});
$('guideNav').onclick=()=>$('guideDialog').showModal();
$('historyNav').onclick=()=>{renderHistory();$('historyDialog').showModal();};
$('settingsOpen').onclick=()=>openSettings();$('friendQuick').onclick=()=>openSettings('friend');
for(const button of document.querySelectorAll('[data-mode]'))button.onclick=()=>{mode=button.dataset.mode;$('setupStatus').textContent='';refreshSetup();};
for(const b of $('sizes').children)b.onclick=()=>{size=Number(b.dataset.value);refreshSetup();};
for(const b of $('levels').children)b.onclick=()=>{level=b.dataset.value;refreshSetup();};
$('createGame').onclick=()=>startSetup();$('joinGame').onclick=()=>startSetup(true);$('joinCode').onkeydown=e=>{if(e.key==='Enter')void startSetup(true);};
$('pass').onclick=()=>act({type:'pass'});$('confirmScore').onclick=()=>act({type:'confirmScore'});$('resume').onclick=()=>act({type:'resume'});
$('resign').onclick=()=>confirmAction('기권하시겠어요?',viewed.mode==='practice'?'이 연습 대국은 봇의 불계승으로 끝납니다.':'상대의 불계승으로 대국이 종료되고 코인이 정산됩니다.','기권',()=>act({type:'resign'}));
$('confirmCancel').onclick=()=>$('confirmDialog').close();
$('confirmYes').onclick=()=>{const callback=confirming;confirming=null;$('confirmDialog').close();void callback?.();};
$('copyRoom').onclick=copyInvite;
$('rematch').onclick=async()=>{
  if(viewed.mode==='practice'){practice=practiceRoom(viewed.size,viewed.difficulty);save('practice.v1',practice);show(practice,false);scheduleBot();return;}
  try{await net.command('rematch',revisionFields(viewed));}catch(e){notify(e.message);}
};
$('soundButton').onclick=()=>{sounds=!sounds;save('sounds',sounds);audioUnlock();render();if(sounds)tick();};
show(practice,false);scheduleBot();
if(invitedCode){$('joinCode').value=invitedCode;openSettings('friend');}
if(net.hasAccount)net.connect().catch(e=>{if(viewed.mode!=='practice')notify(e.message);});
