import express from 'express';
import { nanoid } from 'nanoid';
const app=express();
app.use(express.json());

// Чтобы браузер не держал старые версии index.html/style.css в кеше,
// иначе кажется что "ничего не поменялось".
app.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  next();
});

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
  rooms[id]={
    id,
    board:createInitialBoard(),
    // Сеансы игроков: seat=1/2 (Игрок 1/2) НЕ меняется.
    // Цвет (white/black) может меняться после rematch.
    clientToSeat:{},
    connected:{p1:false,p2:false},
    colors:{p1:'white',p2:'black'},
    profiles:{
      p1:{avatar:'🙂', name:''},
      p2:{avatar:'🙂', name:''},
    },
    turn:'white',
    mustContinue:null,
    gameId:1,
  };
  res.json({roomId:id});
});

app.get('/room/:id/join',(req,res)=>{
  const room=rooms[req.params.id];
  if(!room) return res.status(404).json({error:'Room not found'});

  const clientId=(req.query.clientId||'').toString().trim();
  if(!clientId) return res.status(400).json({error:'clientId required'});

  // Уже есть seat для этого clientId
  const existingSeat=room.clientToSeat[clientId];
  if(existingSeat===1){
    room.connected.p1=true;
    return res.json({seat:1,color:room.colors.p1});
  }
  if(existingSeat===2){
    room.connected.p2=true;
    return res.json({seat:2,color:room.colors.p2});
  }

  // Новый клиент — выдаём свободное место
  if(!room.connected.p1){
    room.clientToSeat[clientId]=1;
    room.connected.p1=true;
    return res.json({seat:1,color:room.colors.p1});
  }
  if(!room.connected.p2){
    room.clientToSeat[clientId]=2;
    room.connected.p2=true;
    return res.json({seat:2,color:room.colors.p2});
  }

  return res.status(400).json({error:'Room full'});
});

app.post('/room/:id/profile',(req,res)=>{
  const room=rooms[req.params.id];
  if(!room) return res.status(404).json({error:'Room not found'});

  const {clientId,name,avatar}=req.body||{};
  const cid=(clientId||'').toString().trim();
  if(!cid) return res.status(400).json({error:'clientId required'});

  const seat=room.clientToSeat[cid];
  if(seat!==1 && seat!==2) return res.status(400).json({error:'Not joined'});
  const seatKey = seat===1 ? 'p1' : 'p2';

  // name — это ДОПОЛНИТЕЛЬНОЕ имя, может быть пустым (тогда в UI не показываем)
  const safeName=(name||'').toString().trim().slice(0,32);
  const safeAvatar=(avatar||'').toString().trim().slice(0,4);
  room.profiles[seatKey]={
    name: safeName,
    avatar: safeAvatar || room.profiles[seatKey]?.avatar || '🙂',
  };

  res.json({ok:true,seat,profile:room.profiles[seatKey]});
});

app.get('/room/:id/state',(req,res)=>{
  const room=rooms[req.params.id];
  if(!room) return res.status(404).json({error:'Room not found'});
  // отдаём только публичные поля
  res.json({
    id:room.id,
    board:room.board,
    turn:room.turn,
    mustContinue:room.mustContinue,
    connected:room.connected,
    profiles:room.profiles,
    colors:room.colors,
    gameId:room.gameId,
  });
});

app.post('/room/:id/rematch',(req,res)=>{
  const room=rooms[req.params.id];
  if(!room) return res.status(404).json({error:'Room not found'});

  // Новая игра в этой же комнате + обмен цветов игроков.
  const prevP1=room.colors.p1;
  room.colors.p1=room.colors.p2;
  room.colors.p2=prevP1;

  room.board=createInitialBoard();
  room.turn='white';
  room.mustContinue=null;
  room.gameId=(room.gameId||1)+1;

  res.json({ok:true,gameId:room.gameId});
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
