const columns = 'ABCDEFGHJKLMNOPQRST';
export const coordinate = (size, x, y) => columns[x] + (size - y);

export function createBoard(canvas, select, canSelect) {
  const context = canvas.getContext('2d');
  const backdrop = document.createElement('canvas');
  let game, territory, hover, focus, geometry, imageKey = '', focusVisible = false;

  function background(size, width, scale) {
    const key = [size, width, scale].join('/');
    if (key === imageKey) return;
    imageKey = key;
    backdrop.width = canvas.width = Math.round(width * scale);
    backdrop.height = canvas.height = canvas.width;
    const brush = backdrop.getContext('2d');
    brush.scale(scale, scale);
    const pad = Math.max(16, width * (size === 19 ? .052 : .061));
    const gap = (width - 2 * pad) / (size - 1);
    geometry = { width, pad, gap, at: value => pad + gap * value, scale };
    const glaze = brush.createLinearGradient(0, 0, width, width * .22);
    for (const [stop, color] of [[0,'#dfb174'],[.13,'#e6ba7e'],[.36,'#edc88a'],[.55,'#e8bd7e'],[.78,'#f0cd94'],[1,'#dfb77b']]) glaze.addColorStop(stop, color);
    brush.fillStyle = glaze; brush.fillRect(0, 0, width, width);
    let seed = 173;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < Math.floor(width * 1.7); i++) {
      const x = random() * (width + 10) - 5, bend = (random() - .5) * 10;
      brush.strokeStyle = i % 3 ? 'rgba(115,73,33,' + (random() * .041) + ')' : 'rgba(255,240,184,.076)';
      brush.lineWidth = .35 + random() * 1.4;
      brush.beginPath(); brush.moveTo(x, 0); brush.bezierCurveTo(x + bend, width * .3, x - bend, width * .67, x + bend * .35, width); brush.stroke();
    }
    const { at } = geometry;
    brush.strokeStyle = '#624924'; brush.lineWidth = Math.max(.72, width / 720);
    brush.beginPath();
    for (let i = 0; i < size; i++) {
      brush.moveTo(at(i), pad); brush.lineTo(at(i), width - pad);
      brush.moveTo(pad, at(i)); brush.lineTo(width - pad, at(i));
    }
    brush.stroke(); brush.lineWidth = Math.max(1.12, width / 390); brush.strokeRect(pad, pad, width - 2 * pad, width - 2 * pad);
    const stars = size === 19 ? [3,9,15] : size === 13 ? [3,6,9] : [2,4,6];
    brush.fillStyle = '#48351b';
    for (const x of stars) for (const y of stars) {
      if (size !== 19 && ((x === stars[1]) !== (y === stars[1]))) continue;
      brush.beginPath(); brush.arc(at(x), at(y), Math.max(2.3, gap * .10), 0, Math.PI * 2); brush.fill();
    }
    brush.fillStyle = '#65502f'; brush.textAlign = 'center'; brush.textBaseline = 'middle';
    brush.font = '600 ' + Math.max(8, Math.min(13, pad * .41)) + 'px Georgia, serif';
    for (let i = 0; i < size; i++) {
      brush.fillText(columns[i], at(i), pad * .38); brush.fillText(columns[i], at(i), width - pad * .36);
      brush.fillText(String(size - i), pad * .38, at(i)); brush.fillText(String(size - i), width - pad * .38, at(i));
    }
  }
  function stone(px, py, color, radius, opacity = 1) {
    context.save(); context.globalAlpha = opacity;
    const fill = context.createRadialGradient(px - radius * .3, py - radius * .4, radius * .02, px, py, radius * 1.1);
    const tones = color === 1 ? ['#676963','#3b403d','#212621','#111612'] : ['#fffef4','#f4f2e6','#deded2','#b8b9ab'];
    for (const [i, stop] of [0,.4,.78,1].entries()) fill.addColorStop(stop,tones[i]);
    context.fillStyle=fill; context.shadowColor='#49351e91'; context.shadowBlur=radius*.28; context.shadowOffsetX=radius*.08; context.shadowOffsetY=radius*.20;
    context.beginPath(); context.ellipse(px, py, radius, radius * .98, 0, 0, Math.PI * 2); context.fill();
    context.shadowColor='transparent'; context.strokeStyle=color===1?'#181c19':'#b1b1a2'; context.lineWidth=Math.max(.55,radius*.042);context.stroke();context.restore();
  }
  function draw() {
    if (!game) return;
    const width = canvas.getBoundingClientRect().width;
    if (width < 1) return;
    background(game.size, width, Math.min(window.devicePixelRatio || 1, 3));
    const { at, gap, scale } = geometry, radius = gap * .467;
    context.setTransform(1, 0, 0, 1, 0, 0); context.drawImage(backdrop, 0, 0); context.scale(scale, scale);
    const dead = new Set(game.dead || []), reviewing = game.phase === 'scoring', finishedScore = game.result?.reason === 'score';
    game.board.forEach((color, index) => {
      const px=at(index%game.size), py=at(Math.floor(index/game.size));
      const markedDead = dead.has(index);
      if (color && !(markedDead && finishedScore)) stone(px,py,color,radius,markedDead?.38:1);
      if ((reviewing || finishedScore) && territory?.[index] && (!color || finishedScore && markedDead)) {
        const side = Math.max(3,radius*.53), left = px-side/2, top = py-side/2;
        context.fillStyle = territory[index] === 1 ? '#282d27' : '#fffeee'; context.fillRect(left,top,side,side);
        if (territory[index] === 2) {
          context.lineWidth = Math.max(.55,radius*.055); context.strokeStyle='#746746'; context.strokeRect(left,top,side,side);
        }
      }
      if (markedDead && reviewing) {
        const r=radius*.33;context.strokeStyle='#9a332a';context.lineWidth=Math.max(1.4,radius*.13);context.beginPath();context.moveTo(px-r,py-r);context.lineTo(px+r,py+r);context.moveTo(px-r,py+r);context.lineTo(px+r,py-r);context.stroke();
      }
    });
    const last = game.lastMove;
    if (game.phase === 'playing' && last?.type === 'play' && game.board[last.y*game.size + last.x] === last.color) {
      context.strokeStyle= last.color === 1 ? '#eeedda' : '#435044';context.lineWidth=Math.max(1,radius*.12);context.beginPath();context.arc(at(last.x),at(last.y),radius*.27,0,Math.PI*2);context.stroke();
    }
    const point = focusVisible ? focus : hover;
    if (!point || !canSelect()) return;
    const px = at(point.x), py=at(point.y);
    if (!game.board[point.y*game.size+point.x] && game.phase==='playing') stone(px,py,game.turn,radius,.43);
    if (focusVisible) {context.strokeStyle='#34613e';context.lineWidth=2;context.setLineDash([3,2]);context.strokeRect(px-radius,py-radius,2*radius,2*radius);context.setLineDash([]);}
  }
  function pointAt(event) {
    if (!geometry || !game) return null;
    const bounds=canvas.getBoundingClientRect(),{pad,gap}=geometry;
    const x=Math.round((event.clientX-bounds.left-pad)/gap),y=Math.round((event.clientY-bounds.top-pad)/gap);
    return x>=0 && y>=0 && x<game.size && y<game.size ? {x,y} : null;
  }
  canvas.addEventListener('pointermove', event => {if (event.pointerType!=='mouse') return; const next=pointAt(event);if (next?.x===hover?.x && next?.y===hover?.y && !focusVisible)return;focusVisible=false;hover=next;draw();});
  canvas.addEventListener('pointerleave',()=>{hover=null;draw();});
  canvas.addEventListener('click',event=>{const point=pointAt(event);focusVisible=false;if(point)select(point.x,point.y);draw();});
  canvas.addEventListener('focus',()=>{if (game) {focus ||= {x:Math.floor(game.size/2),y:Math.floor(game.size/2)};focusVisible=canvas.matches(':focus-visible');draw();}});
  canvas.addEventListener('blur',()=>{focusVisible=false;draw();});
  canvas.addEventListener('keydown', event => {
    if (!game) return;
    const offset = {ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0]}[event.key];
    if (offset) {
      event.preventDefault();focusVisible=true;focus||={x:0,y:0};
      focus.x=Math.max(0,Math.min(game.size-1,focus.x+offset[0]));focus.y=Math.max(0,Math.min(game.size-1,focus.y+offset[1]));
      canvas.setAttribute('aria-label','바둑판 '+coordinate(game.size,focus.x,focus.y)+' 교차점. Enter로 선택');draw();
    } else if(event.key==='Enter'||event.key===' ') {event.preventDefault();if(focus)select(focus.x,focus.y);}
  });
  new ResizeObserver(draw).observe(canvas);
  return (nextGame, nextTerritory) => {
    if(game?.size!==nextGame.size){
      hover=null;
      focus=null;
      canvas.setAttribute('aria-label',nextGame.size+'줄 바둑판. 방향키로 이동하고 Enter로 착수하세요.');
    }
    game=nextGame;
    territory=nextTerritory;
    draw();
  };
}
