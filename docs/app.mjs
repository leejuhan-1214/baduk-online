import { createGame, applyAction, chooseBotAction, scoreGame } from './go.mjs?v=deadreview1';
import { createBoard } from './board.mjs?v=deadreview1';
import { createConnection } from './connection.mjs';

const $ = id => document.getElementById(id);
const modeNames = {practice:'연습 대국',bot:'봇 대국',friend:'친구 대국'};
const levelNames = {easy:'쉬움',normal:'보통',hard:'어려움'};
const stoneName = color => color === 1 ? '흑' : '백';
function read(key,fallback=null) {try{return JSON.parse(localStorage.getItem('sudam-go.'+key))??fallback;}catch{return fallback;}}
function save(key,value) {try{localStorage.setItem('sudam-go.'+key,JSON.stringify(value));}catch{/* The current game still works without persistent storage. */}}
function practiceRoom(difficulty) {
  return {code:'practice',revision:0,mode:'practice',difficulty,matchId:crypto.randomUUID(),size:19,you:1,
    players:{1:{name:'나'},2:{name:'연습 봇'}},game:createGame(),rematch:[]};
}
let practice = read('practice.v1');
if(practice?.size!==19 || practice.game?.size!==19 || practice.game.board?.length!==361 || !Array.isArray(practice.game.history)) {
  practice=practiceRoom(Object.hasOwn(levelNames,practice?.difficulty)?practice.difficulty:'normal');
}else if(practice.game.phase!=='finished' && (practice.game.scoringRule==null || practice.game.scoringRule==='area-v1')){
  // Local practice has no settlement. Retain the board and review the new proposal afresh.
  practice={...practice,revision:practice.revision+1,game:{...practice.game,scoringRule:'territory-v1',confirmed:[]}};
  save('practice.v1',practice);
}
let viewed=practice, currentOnline=null, profile=read('profile'), displayQueue=[], displayTimer=null, botTimer=null;
let localHistory=read('localHistory',[]), historyPage=0;
let sounds=read('sounds',true), audio, toastTimer, setupBusy=false, confirming=null;
let mode='practice',level=practice.difficulty;
let controlBusy=false;
let reviewFeedback='', calculatedGame=null, calculatedScore=null;
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
function scoreFor(room){
  const game=room.game;
  if(!game || (game.phase!=='scoring' && game.result?.reason!=='score'))return null;
  if(game.phase==='scoring' && room.scorePreview)return room.scorePreview;
  if(calculatedGame!==game){
    calculatedScore=scoreGame(game);
    calculatedGame=game;
  }
  return calculatedScore;
}
function show(room,playSound=true){
  const game=room.game, last=game?.lastMove;
  if(room.matchId===viewed.matchId && viewed.game?.phase==='scoring' && game?.phase==='playing'
    && last?.type==='resume' && room.mode!=='friend' && last.color!==room.you){
    notify('봇이 사석 판정에 동의하지 않아 대국을 재개했습니다.');
  }
  if(room.matchId!==viewed.matchId || game?.phase!=='scoring')reviewFeedback='';
  else if(room.revision!==viewed.revision && last?.type==='markDead'){
    const point=last.y*game.size+last.x;
    if(room.mode!=='friend' && last.color!==room.you){
      reviewFeedback=game.dead.includes(point)?'봇이 사석 후보를 추가했습니다.':'봇이 사석 표시를 해제했습니다. 이견은 대국 재개로 확인하세요.';
    }else if(viewed.game?.confirmed?.length){
      reviewFeedback='사석 표시 변경 · 양측 동의 초기화';
    }else reviewFeedback='';
  }
  if(playSound && room.game?.lastMove?.type==='play'
    && (viewed.matchId!==room.matchId || viewed.game?.moveNumber!==room.game.moveNumber)) tick();
  viewed=room;
  render();
}
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
  if(action.type==='confirmScore' && !action.scoringRule)action={...action,scoringRule:scoreFor(practice).rule};
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
function resultText(result){return stoneName(result.winner)+' '+(result.reason==='resign'?'불계승':result.margin+'집 승');}
function showScoreRow(side,color,game,preview,visible){
  const total=$(side+'Total'), vote=$(side+'Vote'), parts=$(side+'Parts');
  const reviewing=game?.phase==='scoring';
  total.hidden=parts.hidden=!visible;
  vote.hidden=!reviewing;
  if(!visible)return;
  total.textContent=(reviewing?preview[side]:game.result[side])+'집';
  total.setAttribute('aria-label',stoneName(color)+' 합계 '+total.textContent);
  const agreed=game.confirmed.includes(color);
  vote.textContent=agreed?'동의':'검토 중';
  vote.classList.toggle('agreed',agreed);
  vote.setAttribute('aria-label',stoneName(color)+' '+vote.textContent);
  const sideScore=preview.breakdown[color];
  const deadLabel=reviewing?'사석 후보':'확정 사석';
  const terms=preview.rule==='territory-v1'
    ? ['집 '+sideScore.territory,'따낸 돌 '+sideScore.captures,deadLabel+' '+sideScore.dead]
    : ['집 '+sideScore.territory,'산 돌 '+sideScore.stones];
  if(sideScore.komi)terms.push('덤 '+sideScore.komi);
  parts.textContent=terms.join(' + ');
  if(preview.rule==='territory-v1'){
    const opponent=stoneName(3-color);
    parts.title='따낸 돌은 대국 중 잡은 '+opponent+'돌, '+deadLabel+'은 계가 때 표시한 '+opponent+'돌입니다.';
    parts.setAttribute('aria-label',stoneName(color)+'의 집 '+sideScore.territory+'집, 대국 중 따낸 '+opponent+'돌 '+sideScore.captures+'개, 판 위의 '+opponent+' '+deadLabel+' '+sideScore.dead+'개, 덤 '+sideScore.komi+'집');
  }else{parts.removeAttribute('title');parts.removeAttribute('aria-label');}
}
function showDeadLegend(game){
  const legend=$('deadLegend');
  if(game?.phase!=='scoring' || game.scoringRule!=='territory-v1' || !Array.isArray(game.suggestedDead)){
    legend.hidden=true;
    return false;
  }
  const selected=new Set(game.dead);
  let automatic=0;
  for(const point of game.suggestedDead)if(selected.has(point))automatic++;
  const excluded=game.suggestedDead.length-automatic, added=selected.size-automatic;
  for(const [id,count] of [['autoMarks',automatic],['editedMarks',added],['excludedMarks',excluded]]){
    $(id).hidden=count===0;
    $(id).querySelector('b').textContent=String(count);
  }
  legend.hidden=!(automatic || added || excluded);
  return !legend.hidden;
}
function render(){
  const g=viewed.game, offline=viewed.mode==='practice', waiting=!g;
  const onlineDown=!offline&&!net.ready, mine=viewed.you;
  const tally=scoreFor(viewed), reviewing=g?.phase==='scoring';
  const settledParts=g?.phase==='finished' && g.result.reason==='score' && tally.rule==='territory-v1'
    && tally.black===g.result.black && tally.white===g.result.white;
  const showParts=reviewing || settledParts;
  const ruleLabel=tally?.rule==='area-v1'?'기존 면적 계가':'집 계가';
  const seats=$('seatBlack').parentElement;
  seats.classList.toggle('review',showParts);
  seats.classList.toggle('final-score',settledParts);
  $('boardSize').textContent=(g?.size??19)+'줄';$('modeTag').textContent=modeNames[viewed.mode];
  for(const [color,id] of [[1,'Black'],[2,'White']]){
    const name=viewed.players[color]?.name || '입장 대기';
    $(id.toLowerCase()+'Name').textContent=name+(!offline&&viewed.players[color]&&color===mine?' · 나':'');
    $('seat'+id).classList.toggle('current',g?.phase==='playing'&&g.turn===color);
    showScoreRow(id.toLowerCase(),color,g,tally,showParts);
  }
  let status;
  if(onlineDown)status='서버에 다시 연결하고 있습니다.';
  else if(waiting)status='친구의 입장을 기다리고 있습니다.';
  else if(g.phase==='finished')status=resultText(g.result);
  else if(reviewing)status=ruleLabel+(g.confirmed.includes(mine)?' · 상대 동의를 기다립니다.':' 미리보기');
  else if(g.turn===mine)status=stoneName(mine)+'돌을 놓을 차례입니다.';
  else status=viewed.mode==='friend'?'상대가 다음 수를 생각 중입니다.':'봇이 다음 수를 생각 중입니다.';
  $('statusText').textContent=status;$('signal').classList.toggle('disconnected',onlineDown);
  $('moves').textContent=(g?.moveNumber??0)+'수';
  const blocked=!available()||controlBusy;
  $('pass').parentElement.hidden=waiting||g.phase!=='playing';
  $('pass').disabled=blocked||waiting||g.turn!==mine;$('resign').disabled=blocked||waiting;
  $('scoringControls').hidden=g?.phase!=='scoring';
  $('confirmScore').disabled=blocked||g?.confirmed.includes(mine);$('resume').disabled=blocked;
  $('rematch').hidden=g?.phase!=='finished';$('rematch').disabled=blocked||viewed.rematch.includes(mine);
  $('rematch').textContent=offline?'다시 두기':viewed.rematch.includes(mine)?'상대의 재대전 동의를 기다리는 중':'재대전 신청';
  let note='';
  const hasLegend=showDeadLegend(g);
  if(reviewing){
    if(reviewFeedback)note=reviewFeedback;
    else if(hasLegend)note='무리를 눌러 후보를 바꿀 수 있습니다.';
    else if(Array.isArray(g.suggestedDead) && tally.rule==='territory-v1')note='자동 후보 없음 · 사석은 눌러 표시하세요.';
    else note=tally.needsReview?'열린 경계를 확인하고 사석을 표시하세요.':'돌을 눌러 사석 표시를 바꾸세요.';
  }
  if(g?.phase==='finished'){
    const record=profile?.history?.find(entry=>entry.matchId===viewed.matchId);
    const total=settledParts?'집 계가 확정':g.result.reason==='score'?ruleLabel+' · 흑 '+g.result.black+'집 · 백 '+g.result.white+'집':'';
    const coins=record?(record.delta>0?'+':'')+record.delta+'코인':'';
    note=[total,coins].filter(Boolean).join(' · ');
  }
  $('phaseMessage').textContent=note;$('phaseNote').hidden=!note&&!hasLegend;
  $('roomStrip').hidden=viewed.mode!=='friend';$('roomCode').textContent=viewed.mode==='friend'?viewed.code:'';
  $('copyRoom').disabled=onlineDown;
  board(g||waitingBoard,tally?.territory);
  const title=sounds?'착수 소리 끄기':'착수 소리 켜기';
  $('soundButton').setAttribute('aria-label',title);$('soundButton').title=title;$('soundButton').setAttribute('aria-pressed',String(sounds));
  $('soundText').textContent=title;
  $('soundButton').querySelector('use').setAttribute('href',sounds?'#i-sound':'#i-mute');
  if($('historyDialog').open)renderHistory();
}
const waitingBoard=createGame();
const compactHistory=matchMedia('(max-height: 520px)');
compactHistory.addEventListener('change',()=>{if($('historyDialog').open)renderHistory();});

function renderHistory(){
  const stats=$('profileStats');stats.replaceChildren();
  if(profile){const p=document.createElement('p');p.className='profile-line';p.textContent=profile.name+' · '+profile.coins+'코인 · '+profile.wins+'승 '+profile.losses+'패 · 누적 '+profile.score+'점';stats.append(p);}
  const data=[...(profile?.history||[]),...localHistory].sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,50);
  const perPage=compactHistory.matches?3:4, pages=Math.max(1,Math.ceil(data.length/perPage));
  historyPage=Math.max(0,Math.min(historyPage,pages-1));
  $('historyPager').hidden=pages===1;
  $('historyPage').textContent=(historyPage+1)+' / '+pages;
  $('historyPrev').disabled=historyPage===0;
  $('historyNext').disabled=historyPage===pages-1;
  const rows=data.slice(historyPage*perPage,(historyPage+1)*perPage).map(entry=>{const li=document.createElement('li'),left=document.createElement('div'),strong=document.createElement('strong'),date=document.createElement('small'),right=document.createElement('span');
    strong.textContent=modeNames[entry.mode]+' · '+(entry.won?'승리':'패배');date.textContent=new Intl.DateTimeFormat('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(entry.at));
    right.textContent=(entry.reason==='resign'?'불계':entry.margin+'집')+(entry.delta!=null?' · '+(entry.delta>0?'+':'')+entry.delta+'코인':'');left.append(strong,date);li.append(left,right);return li;});
  if(!rows.length){const li=document.createElement('li');li.className='history-empty';li.textContent='아직 완료한 대국이 없습니다.';rows.push(li);}
  $('historyList').replaceChildren(...rows);
}
function refreshSetup(){
  for(const b of document.querySelectorAll('[data-mode]')){const active=b.dataset.mode===mode;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));}
  for(const b of $('levels').children){
    const active=b.dataset.value===level;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));}
  $('levelsField').hidden=mode==='friend';$('onlineFields').hidden=mode==='practice';$('joinField').hidden=mode!=='friend';
  const rewards={easy:'승리 5코인 · 패배 최대 10코인',normal:'승리 10코인 · 패배 최대 10코인',hard:'승리 20코인 · 패배 최대 20코인'};
  $('setupHelp').textContent=mode==='practice'?'코인 정산 없이 연습합니다.':mode==='friend'?'집 차이당 10코인 · 기권 10코인':rewards[level];
  $('createGame').textContent=mode==='friend'?'친구 대국방 만들기':mode==='bot'?'봇 대국 시작':'연습 대국 시작';
  for(const input of $('settingsDialog').querySelectorAll('button:not(.modal-close), input'))input.disabled=setupBusy;
}
function openSettings(selected){
  mode=selected||viewed.mode;level=viewed.difficulty||'normal';
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
        else await net.command('create',{mode,size:19,difficulty:level});
      }
    }
    if(mode==='practice'){
      practice=practiceRoom(level);save('practice.v1',practice);show(practice,false);scheduleBot();
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
const moreTools=$('moreTools');
function closeMoreTools(restoreFocus=false){
  if(!moreTools.open)return;
  moreTools.open=false;
  if(restoreFocus)$('moreToggle').focus();
}
document.addEventListener('pointerdown',event=>{if(!moreTools.contains(event.target))closeMoreTools();});
document.addEventListener('focusin',event=>{if(!moreTools.contains(event.target))closeMoreTools();});
moreTools.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();closeMoreTools(true);}
});
$('guideNav').onclick=()=>{closeMoreTools(true);$('guideDialog').showModal();};
$('historyNav').onclick=()=>{closeMoreTools(true);historyPage=0;renderHistory();$('historyDialog').showModal();};
$('historyPrev').onclick=()=>{historyPage--;renderHistory();};
$('historyNext').onclick=()=>{historyPage++;renderHistory();};
$('settingsOpen').onclick=()=>openSettings();$('friendQuick').onclick=()=>openSettings('friend');
for(const button of document.querySelectorAll('[data-mode]'))button.onclick=()=>{mode=button.dataset.mode;$('setupStatus').textContent='';refreshSetup();};
for(const b of $('levels').children)b.onclick=()=>{level=b.dataset.value;refreshSetup();};
$('createGame').onclick=()=>startSetup();$('joinGame').onclick=()=>startSetup(true);$('joinCode').onkeydown=e=>{if(e.key==='Enter')void startSetup(true);};
$('pass').onclick=()=>act({type:'pass'});
$('confirmScore').onclick=()=>{const preview=scoreFor(viewed);if(preview)void act({type:'confirmScore',scoringRule:preview.rule});};
$('resume').onclick=()=>act({type:'resume'});
$('resign').onclick=()=>confirmAction('기권하시겠어요?',viewed.mode==='practice'?'이 연습 대국은 봇의 불계승으로 끝납니다.':'상대의 불계승으로 대국이 종료되고 코인이 정산됩니다.','기권',()=>act({type:'resign'}));
$('confirmCancel').onclick=()=>$('confirmDialog').close();
$('confirmYes').onclick=()=>{const callback=confirming;confirming=null;$('confirmDialog').close();void callback?.();};
$('copyRoom').onclick=copyInvite;
$('rematch').onclick=async()=>{
  if(viewed.mode==='practice'){practice=practiceRoom(viewed.difficulty);save('practice.v1',practice);show(practice,false);scheduleBot();return;}
  try{await net.command('rematch',revisionFields(viewed));}catch(e){notify(e.message);}
};
$('soundButton').onclick=()=>{sounds=!sounds;save('sounds',sounds);audioUnlock();render();if(sounds)tick();closeMoreTools(true);};
const fullscreenButton=$('fullscreenButton');
function syncFullscreen(){
  const active=Boolean(document.fullscreenElement);
  fullscreenButton.hidden=!document.fullscreenEnabled;
  fullscreenButton.title=active?'전체 화면 종료':'전체 화면';
  fullscreenButton.setAttribute('aria-label',fullscreenButton.title);
  fullscreenButton.setAttribute('aria-pressed',String(active));
  fullscreenButton.querySelector('use').setAttribute('href',active?'#i-contract':'#i-expand');
}
fullscreenButton.onclick=async()=>{
  try{
    if(document.fullscreenElement)await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  }catch{notify('이 브라우저에서는 전체 화면을 열 수 없습니다.');}
};
document.addEventListener('fullscreenchange',syncFullscreen);
syncFullscreen();
show(practice,false);scheduleBot();
if(invitedCode){$('joinCode').value=invitedCode;openSettings('friend');}
if(net.hasAccount)net.connect().catch(e=>{if(viewed.mode!=='practice')notify(e.message);});
