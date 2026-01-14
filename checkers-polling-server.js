import express from 'express';
import { nanoid } from 'nanoid';
const app=express();
app.use(express.json());
app.use(express.static('public'));

const rooms={};

function createInitialBoard(){
  const b=Array(8).fill(null).map(()=>Array(8).fill(null));
  for(let y=0;y<3;y++)for(let x=0;x<8;x++)if((x+y)%2)b[y][x]={color:'black',king:false};
  for(let y=5;y<8;y++)for(let x=0;x<8;x++)if((x+y)%2)b[y][x]={color:'white',king:false};
  return b;
}

function isClearDiagonal(board,from,to){
  const dx=Math.sign(to.x-from.x), dy=Math.sign(to.y-from.y);
  let x=from.x+dx, y=from.y+dy;
  while(x!==to.x){
    if(board[y][x]) return false;
    x+=dx; y+=dy;
  }
  return true;
}

function hasAnyCaptureOnBoard(board,pos,piece){
  const dirs=[[1,1],[1,-1],[-1,1],[-1,-1]];
  const inBounds=(x,y)=>x>=0&&x<8&&y>=0&&y<8;

  if(piece.king){
    for(const [dX,dY] of dirs){
      let x=pos.x+dX, y=pos.y+dY;
      while(inBounds(x,y)){
        const t=board[y][x];
        if(!t){
          x+=dX; y+=dY;
          continue;
        }
        if(t.color===piece.color) break;
        // нашли врага — нужна хотя бы одна пустая клетка за ним
        x+=dX; y+=dY;
        while(inBounds(x,y)){
          const t2=board[y][x];
          if(!t2) return true;
          break;
        }
        break;
      }
    }
    return false;
  }

  for(const [dX,dY] of dirs){
    const mx=pos.x+dX,my=pos.y+dY;
    const tx=pos.x+2*dX,ty=pos.y+2*dY;
    if(!inBounds(tx,ty)) continue;
    const mid=board?.[my]?.[mx];
    if(mid && mid.color!==piece.color && !board[ty][tx]) return true;
  }
  return false;
}

function getCaptures(room,pos,piece){
  const dirs=[[1,1],[1,-1],[-1,1],[-1,-1]];
  const res=[];
  if(piece.king){
    // Для дамки: после взятия можно приземлиться на любую клетку за битой шашкой.
    // Новое правило: если среди клеток приземления есть такие, с которых можно продолжить бой,
    // то разрешены ТОЛЬКО они (нельзя "остановиться раньше").

    const inBounds=(x,y)=>x>=0&&x<8&&y>=0&&y<8;
    const cloneBoard=(board)=>board.map(row=>row.map(p=>p?{...p}:null));

    for(const[dX,dY]of dirs){
      let x=pos.x+dX,y=pos.y+dY;
      let enemy=null;
      while(inBounds(x,y)){
        const t=room.board[y][x];
        if(t){
          if(t.color===piece.color) break;
          enemy={x,y};
          break;
        }
        x+=dX; y+=dY;
      }

      if(!enemy) continue;

      // все клетки приземления за enemy по этому направлению
      const landings=[];
      x=enemy.x+dX; y=enemy.y+dY;
      while(inBounds(x,y) && !room.board[y][x]){
        landings.push({x,y});
        x+=dX; y+=dY;
      }
      if(landings.length===0) continue;

      // проверяем, есть ли клетки, с которых можно продолжить бой после этого взятия
      const landingWithContinuation=[];
      for(const landing of landings){
        const sim=cloneBoard(room.board);
        // симулируем взятие
        sim[pos.y][pos.x]=null;
        sim[enemy.y][enemy.x]=null;
        sim[landing.y][landing.x]={...piece};
        if(hasAnyCaptureOnBoard(sim,{x:landing.x,y:landing.y},sim[landing.y][landing.x])) landingWithContinuation.push(landing);
      }

      const allowedLandings = landingWithContinuation.length>0 ? landingWithContinuation : landings;
      for(const landing of allowedLandings){
        res.push({from:pos,over:enemy,to:{x:landing.x,y:landing.y}});
      }
    }
  }else{
    for(const[dX,dY]of dirs){
      const mx=pos.x+dX,my=pos.y+dY;
      const tx=pos.x+2*dX,ty=pos.y+2*dY;
      if(tx<0||tx>7||ty<0||ty>7) continue;
      const mid=room.board[my][mx];
      if(mid&&mid.color!==piece.color&&!room.board[ty][tx])
        res.push({from:pos,over:{x:mx,y:my},to:{x:tx,y:ty}});
    }
  }
  return res;
}

function playerMustCapture(room,color){
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
    const p=room.board[y][x];
    if(p&&p.color===color&&getCaptures(room,{x,y},p).length) return true;
  }
  return false;
}

app.get('/room/create',(req,res)=>{
  const id=nanoid(6);
  rooms[id]={id,board:createInitialBoard(),players:{},turn:'white',mustContinue:null};
  res.json({roomId:id});
});

app.get('/room/:id/join',(req,res)=>{
  const room=rooms[req.params.id];
  if(!room) return res.status(404).json({error:'Room not found'});
  let color;
  if(!room.players.white) color='white';
  else if(!room.players.black) color='black';
  else return res.status(400).json({error:'Room full'});
  room.players[color]=true;
  res.json({color});
});

app.get('/room/:id/state',(req,res)=>{
  const room=rooms[req.params.id];
  if(!room) return res.status(404).json({error:'Room not found'});
  res.json(room);
});

// ===== Та самая версия move, как ты указал =====
app.post('/room/:id/move',(req,res)=>{
  const room=rooms[req.params.id];
  if(!room) return res.status(404).json({error:'Room not found'});

  const {from,to,player}=req.body;
  const piece=room.board[from.y][from.x];
  if(!piece||piece.color!==player) return res.status(400).json({error:'Не ваша шашка'});
  if(room.turn!==player) return res.status(400).json({error:'Не ваш ход'});

  const dx=to.x-from.x, dy=to.y-from.y;
  const absx=Math.abs(dx), absy=Math.abs(dy);
  const mustCapture=playerMustCapture(room,player);
  const captures=getCaptures(room,from,piece);
  const isCaptureMove=captures.some(c=>c.to.x===to.x&&c.to.y===to.y);

  if(isCaptureMove){
    const cap=captures.find(c=>c.to.x===to.x&&c.to.y===to.y);
    room.board[cap.over.y][cap.over.x]=null;
    room.board[to.y][to.x]=piece;
    room.board[from.y][from.x]=null;

    if(!piece.king&&((piece.color==='white'&&to.y===0)||(piece.color==='black'&&to.y===7))) piece.king=true;

    const more=getCaptures(room,{x:to.x,y:to.y},piece);
    if(more.length>0){
      room.mustContinue={x:to.x,y:to.y,player};
    }else{
      room.mustContinue=null;
      room.turn=player==='white'?'black':'white';
    }
    return res.json({ok:true,board:room.board,mustContinue:room.mustContinue,turn:room.turn});
  }

  if(mustCapture) return res.status(400).json({error:'Вы обязаны бить'});
  if(room.board[to.y][to.x]) return res.status(400).json({error:'Клетка занята'});
  if(absx!==absy) return res.status(400).json({error:'Ход только по диагонали'});

  if(!piece.king){
    const dir=piece.color==='white'?-1:1;
    if(absx!==1||dy!==dir) return res.status(400).json({error:'Обычная шашка ходит на 1 вперёд'});
  }else{
    if(!isClearDiagonal(room.board,from,to)) return res.status(400).json({error:'Путь не свободен'});
  }

  room.board[to.y][to.x]=piece;
  room.board[from.y][from.x]=null;

  if(!piece.king&&((piece.color==='white'&&to.y===0)||(piece.color==='black'&&to.y===7))) piece.king=true;

  room.turn=player==='white'?'black':'white';
  room.mustContinue=null;
  res.json({ok:true,board:room.board,mustContinue:room.mustContinue,turn:room.turn});
});

app.listen(3000,()=>console.log('Server on http://localhost:3000'));
