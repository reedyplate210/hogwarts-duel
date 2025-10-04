// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ✅ Serve client
const CLIENT_DIR = path.join(__dirname, 'client');
app.use(express.static(CLIENT_DIR));
app.get('*', (_, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));

// ===================== GAME LOGIC =====================

let waitingPlayer = null;
const battles = new Map(); // roomId -> state

const CHARACTERS = {
  harry:      { name: "Harry Potter",        maxHP: 200, speed: 50 },
  hermione:   { name: "Hermione Granger",    maxHP: 180, speed: 60 },
  draco:      { name: "Draco Malfoy",        maxHP: 220, speed: 40 },
  voldemort:  { name: "Lord Voldemort",      maxHP: 250, speed: 70 },
  snape:      { name: "Severus Snape",       maxHP: 190, speed: 45 },
  sirius:     { name: "Sirius Black",        maxHP: 210, speed: 55 },
  bellatrix:  { name: "Bellatrix Lestrange", maxHP: 230, speed: 65 },
  luna:       { name: "Luna Lovegood",       maxHP: 170, speed: 60 },
  neville:    { name: "Neville Longbottom",  maxHP: 240, speed: 35 },
  mcgonagall: { name: "Minerva McGonagall",  maxHP: 200, speed: 50 },
  dumbledore: { name: "Albus Dumbledore",    maxHP: 300, speed: 30 }
};

const ITEMS = {
  "Elder Wand":         { bonusDmg: 10 },
  "Invisibility Cloak": { dodgeChance: 0.25 },
  "Resurrection Stone": { reviveOnce: true },
  "Felix Felicis":      { critChance: 0.3, critMult: 2 },
  "Broomstick":         { speedBoost: 20 }
};

const SPELLS = {
  "Alarte Ascendare":   { dmg: 20,  priority: 0 },
  "Aqua Eructo":        { dmg: 20,  priority: 0 },
  "Avada Kedavra":      { dmg: 0,   priority: -1, instantKO: true },
  "Bombarda Maxima":    { dmg: 50,  priority: 0 },
  "Brackium Emendo":    { dmg: -30, priority: 1 },
  "Petrificus Totalus": { dmg: 0,   priority: 1, stun: 1 },
  "Protego":            { dmg: 0,   priority: 1, shield: true },
  "Sectumsempra":       { dmg: 80,  priority: 0 },
  "Crucio":             { dmg: 0,   priority: 0, dot: { amount: 10, turns: 3 } }
};

const USAGE_LIMITS = {
  "Sectumsempra": 4,
  "Protego": 4,
  "Petrificus Totalus": 4,
  "Avada Kedavra": 1,
  "Crucio": 1
};

function clampHP(p){ p.currentHP = Math.max(0, Math.min(p.maxHP, p.currentHP)); }

function tryRevive(target, state, room){
  if (target.item?.reviveOnce && !target._revived && target.currentHP <= 0) {
    target._revived = true;
    target.currentHP = Math.ceil(target.maxHP * 0.5);
    clampHP(target);
    io.to(room).emit('battleUpdate', { msg: `${target.name} returns from the brink using the Resurrection Stone!`, state });
    return true;
  }
  return false;
}

function applyStartOfRound(state, room){
  const p1 = state.players[0], p2 = state.players[1];
  const applyDots = (plr) => {
    if (!plr.dots?.length) return;
    let total = 0;
    plr.dots.forEach(d => { total += d.amount; d.turns -= 1; });
    plr.dots = plr.dots.filter(d => d.turns > 0);
    if (total>0){ plr.currentHP = Math.max(0,plr.currentHP-total);
      io.to(room).emit('battleUpdate',{msg:`${plr.name} suffers ${total} damage from lingering curses!`,state});
    }
  };
  applyDots(p1); applyDots(p2);
  let p1Dead = p1.currentHP<=0, p2Dead = p2.currentHP<=0;
  if(p1Dead) p1Dead=!tryRevive(p1,state,room)&&p1.currentHP<=0;
  if(p2Dead) p2Dead=!tryRevive(p2,state,room)&&p2.currentHP<=0;
  if(p1Dead&&p2Dead){state.gameOver=true;io.to(room).emit('battleUpdate',{msg:`Both wizards fall! It's a draw!`,state});return true;}
  if(p1Dead){state.gameOver=true;io.to(room).emit('battleUpdate',{msg:`${p2.name} wins!`,state});return true;}
  if(p2Dead){state.gameOver=true;io.to(room).emit('battleUpdate',{msg:`${p1.name} wins!`,state});return true;}
  return false;
}

io.on('connection', socket=>{
  console.log('player connected',socket.id);

  if(waitingPlayer){
    const room=`room_${waitingPlayer}_${socket.id}`;
    socket.join(room);
    io.sockets.sockets.get(waitingPlayer)?.join(room);
    const state={room,selectionPhase:true,players:[
      {id:waitingPlayer,selectedKey:null,selectedItem:null},
      {id:socket.id,selectedKey:null,selectedItem:null}
    ],gameOver:false};
    battles.set(room,state);
    const roster=Object.entries(CHARACTERS).map(([k,v])=>({key:k,...v}));
    const items=Object.entries(ITEMS).map(([k,v])=>({key:k,...v}));
    io.to(room).emit('selectPhase',{roster,items,state});
    waitingPlayer=null;
  }else waitingPlayer=socket.id;

  socket.on('chooseCharacter',charKey=>{
    const room=[...socket.rooms].find(r=>r.startsWith('room_'));if(!room)return;
    const state=battles.get(room);if(!state||state.gameOver||!state.selectionPhase)return;
    if(!CHARACTERS[charKey])return;
    const idx=state.players.findIndex(p=>p.id===socket.id);if(idx===-1)return;
    state.players[idx].selectedKey=charKey;
    io.to(room).emit('selectionUpdate',{msg:`A player locked in ${CHARACTERS[charKey].name}.`,state});
    maybeStart(state,room);
  });

  socket.on('chooseItem',itemKey=>{
    const room=[...socket.rooms].find(r=>r.startsWith('room_'));if(!room)return;
    const state=battles.get(room);if(!state||state.gameOver||!state.selectionPhase)return;
    if(!ITEMS[itemKey])return;
    const idx=state.players.findIndex(p=>p.id===socket.id);if(idx===-1)return;
    state.players[idx].selectedItem=itemKey;
    io.to(room).emit('selectionUpdate',{msg:`A player equipped ${itemKey}.`,state});
    maybeStart(state,room);
  });

  function maybeStart(state,room){
    if(!state.players.every(p=>p.selectedKey&&p.selectedItem))return;
    state.players=state.players.map(p=>{
      const c=CHARACTERS[p.selectedKey];return{
        id:p.id,charKey:p.selectedKey,...c,
        currentHP:c.maxHP,chosenSpell:null,dots:[],stun:0,
        itemKey:p.selectedItem,item:ITEMS[p.selectedItem],_revived:false,
        spellUses:{...USAGE_LIMITS}
      };
    });
    state.selectionPhase=false;state.round=1;state.gameOver=false;
    io.to(room).emit('start',state);
  }

  socket.on('chooseSpell',spellName=>{
    const room=[...socket.rooms].find(r=>r.startsWith('room_'));if(!room)return;
    const state=battles.get(room);if(!state||state.gameOver||state.selectionPhase)return;
    const idx=state.players.findIndex(p=>p.id===socket.id);if(idx===-1)return;
    const me=state.players[idx];
    if(me.spellUses?.[spellName]===0){
      io.to(socket.id).emit('battleUpdate',{msg:`❌ You can’t cast ${spellName} anymore!`,state});
      return;
    }
    me.chosenSpell=spellName;
    io.to(room).emit('battleUpdate',{msg:`${me.name||CHARACTERS[me.charKey].name} has chosen a spell!`,state});
    if(!state.players.every(p=>p.chosenSpell))return;
    if(applyStartOfRound(state,room))return;
    const [p1,p2]=state.players;
    const eff=p=>p.stun>0?{name:'(Stunned)',dmg:0,priority:0,skip:true}:{name:p.chosenSpell,...SPELLS[p.chosenSpell]};
    const s1=eff(p1),s2=eff(p2);
    const use=(pl,s)=>{if(!s.skip&&pl.spellUses?.[s.name]!==undefined&&pl.spellUses[s.name]>0)pl.spellUses[s.name]--;};
    use(p1,s1);use(p2,s2);
    const spd1=p1.speed+(p1.item?.speedBoost||0)+(s1.priority||0);
    const spd2=p2.speed+(p2.item?.speedBoost||0)+(s2.priority||0);
    let first=p1,fs=s1,second=p2,ss=s2;if(spd2>spd1||(spd2===spd1&&Math.random()<.5)){first=p2;fs=s2;second=p1;ss=s1;}
    const say=m=>io.to(room).emit('battleUpdate',{msg:m,state});
    const doSpell=(c,t,s,es)=>{
      if(s.skip){say(`${c.name} is stunned and can't act!`);return null;}
      if(s.shield){say(`${c.name} cast ${s.name} and is protected!`);return null;}
      if(s.instantKO){
        if(es?.shield){
          c.currentHP=0;clampHP(c);
          if(!tryRevive(c,state,room)&&c.currentHP<=0){say(`${t.name}'s Protego reflected ${s.name} back to ${c.name}!`);return{ko:true,dead:'caster'};}
          say(`${t.name}'s Protego reflected ${s.name} back to ${c.name}, but they revived!`);return null;
        }else{
          t.currentHP=0;clampHP(t);
          if(!tryRevive(t,state,room)&&t.currentHP<=0){say(`${c.name} cast ${s.name}! It's fatal!`);return{ko:true,dead:'target'};}
          say(`${c.name} cast ${s.name} — ${t.name} revived!`);return null;
        }
      }
      if(s.dmg<0){const heal=-s.dmg;c.currentHP=Math.min(c.maxHP,c.currentHP+heal);say(`${c.name} healed ${heal} HP with ${s.name}!`);return null;}
      if(s.dmg>0){
        if(es?.shield){const ref=s.dmg+(c.item?.bonusDmg||0);c.currentHP=Math.max(0,c.currentHP-ref);say(`${t.name}'s Protego reflected ${ref} damage back to ${c.name}!`);if(!tryRevive(c,state,room)&&c.currentHP<=0)return{ko:true,dead:'caster'};return null;}
        if(t.item?.dodgeChance&&Math.random()<t.item.dodgeChance){say(`${t.name} dodged the attack with the Invisibility Cloak!`);return null;}
        let dmg=s.dmg+(c.item?.bonusDmg||0),crit=false;if(c.item?.critChance&&Math.random()<c.item.critChance){dmg=Math.floor(dmg*(c.item?.critMult||2));crit=true;}
        t.currentHP=Math.max(0,t.currentHP-dmg);say(`${c.name} used ${s.name} for ${dmg} damage!${crit?' (CRIT!)':''}`);if(!tryRevive(t,state,room)&&t.currentHP<=0)return{ko:true,dead:'target'};
      }else say(`${c.name} used ${s.name}!`);
      if(s.stun&&!es?.shield){t.stun=Math.max(t.stun||0,s.stun);say(`${t.name} is stunned and will skip their next action!`);}
      if(s.dot&&!es?.shield){t.dots=t.dots||[];t.dots.push({...s.dot});say(`${t.name} is afflicted by ${s.name}! (${s.dot.amount} dmg for ${s.dot.turns} turns)`);}
      return null;
    };
    if(!state.gameOver){const r=doSpell(first,second,fs,ss);if(r?.ko){state.gameOver=true;say(`${r.dead==='target'?first:second}.name wins!`);return;}}
    if(!state.gameOver){const r=doSpell(second,first,ss,fs);if(r?.ko){state.gameOver=true;say(`${r.dead==='target'?second:first}.name wins!`);return;}}
    if(p1.stun>0)p1.stun--;if(p2.stun>0)p2.stun--;
    state.players.forEach(p=>{p.chosenSpell=null;clampHP(p);});
    state.round=(state.round||1)+1;
    if(!state.gameOver)io.to(room).emit('battleUpdate',{msg:`New turn! Both players choose a spell.`,state});
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log('Server running on',PORT));
