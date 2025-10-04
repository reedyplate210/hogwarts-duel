import { io } from "socket.io-client";

// ✅ Auto-connect to the same origin (works locally & when deployed)
const socket = io(window.location.origin);

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const leftName = document.getElementById('left-name');
const rightName = document.getElementById('right-name');
const leftHPFill = document.getElementById('left-hpfill');
const rightHPFill = document.getElementById('right-hpfill');
const leftHPText = document.getElementById('left-hptext');
const rightHPText = document.getElementById('right-hptext');
const leftSlot = document.getElementById('left-slot');
const rightSlot = document.getElementById('right-slot');
const fxLayer = document.getElementById('fx-layer');
const endScreen = document.getElementById('end-screen');
const endText   = document.getElementById('end-text');

const USAGE_LIMITS = {
  "Sectumsempra":4, "Protego":4, "Petrificus Totalus":4, "Avada Kedavra":1, "Crucio":1
};

const selectOverlay = document.createElement('div');
selectOverlay.id = 'char-select';
selectOverlay.innerHTML = `
  <div id="char-card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <h2 style="margin:0;">Choose your wizard & item</h2>
      <div id="char-hint" style="opacity:.8;font-size:.95rem;">Pick one character and one item. Waiting for both players…</div>
    </div>
    <h3 style="margin:10px 0 4px;">Wizards</h3>
    <div id="char-grid"></div>
    <h3 style="margin:16px 0 4px;">Held Items</h3>
    <div id="item-grid"></div>
  </div>
`;
document.body.appendChild(selectOverlay);

const SPELL_NAMES = [
  "Alarte Ascendare","Aqua Eructo","Avada Kedavra","Bombarda Maxima",
  "Brackium Emendo","Petrificus Totalus","Protego","Sectumsempra","Crucio"
];
const buttonsWrap = document.getElementById('buttons');
buttonsWrap.innerHTML = '';
SPELL_NAMES.forEach(name => {
  const btn = document.createElement('button');
  btn.className = 'spell'; btn.dataset.spell = name; btn.textContent = name;
  buttonsWrap.appendChild(btn);
});

let myId = null;
let lastState = null;
let iChoseThisTurn = false;

function addLog(t){ const p=document.createElement('div'); p.textContent=t; logEl.appendChild(p); logEl.scrollTop=logEl.scrollHeight; }
function setStatus(t){ statusEl.textContent = t; }
function setButtonsEnabled(enabled){
  document.querySelectorAll('.spell').forEach(b => {
    if (b.dataset.spell in USAGE_LIMITS){
      const me = lastState?.players.find(p=>p.id===myId);
      const left = me?.spellUses?.[b.dataset.spell];
      if (left===0) { b.disabled = true; return; }
    }
    b.disabled = !enabled;
  });
}
function hpColor(r){ if (r<=.33) return 'hp-low'; if (r<=.66) return 'hp-mid'; return 'hp-high'; }
function updateHP(fillEl, textEl, cur, max){
  const r=Math.max(0,Math.min(1,cur/max));
  fillEl.style.width=`${r*100}%`;
  fillEl.classList.remove('hp-low','hp-mid','hp-high');
  fillEl.classList.add(hpColor(r));
  textEl.textContent=`${cur}/${max}`;
}

function updateSpellButtons(state){
  const me = state.players.find(p=>p.id===myId);
  document.querySelectorAll('.spell').forEach(btn=>{
    const spell=btn.dataset.spell;
    const max=USAGE_LIMITS[spell];
    const left=me?.spellUses?.[spell];
    if (max!==undefined && left!==undefined){
      btn.textContent=`${spell} (${left}/${max})`; // available/max
      btn.disabled = left===0 || btn.disabled;
    } else {
      btn.textContent=spell;
    }
  });
}

function updateUI(state){
  if (!state) return; lastState = state;
  const meIdx = state.players.findIndex(p => p.id === myId);
  const foeIdx = meIdx === 0 ? 1 : 0;
  const me = state.players[meIdx], foe = state.players[foeIdx];

  if (me?.name) leftName.innerHTML = `${me.name} (You) ${me.itemKey?`<span class="subtle">• ${me.itemKey}</span>`:''}`;
  if (foe?.name) rightName.innerHTML = `${foe.name} ${foe.itemKey?`<span class="subtle">• ${foe.itemKey}</span>`:''}`;

  if (me?.maxHP) updateHP(leftHPFill,leftHPText,me.currentHP,me.maxHP);
  if (foe?.maxHP) updateHP(rightHPFill,rightHPText,foe.currentHP,foe.maxHP);

  updateSpellButtons(state);
  setButtonsEnabled(!iChoseThisTurn && !state.gameOver && !state.selectionPhase);
}

function coordsFromTo(fromSlot,toSlot){
  const s=fromSlot.getBoundingClientRect(), t=toSlot.getBoundingClientRect(), p=fxLayer.getBoundingClientRect();
  return { sx:(s.left+s.width*0.65)-p.left, sy:(s.top+s.height*0.35)-p.top, tx:(t.left+t.width*0.35)-p.left, ty:(t.top+t.height*0.35)-p.top };
}
function slotCenter(slot){ const b=slot.getBoundingClientRect(), p=fxLayer.getBoundingClientRect(); return { cx:(b.left+b.width/2)-p.left, cy:(b.top+b.height/2)-p.top }; }
function animateFireballPath(fromSlot,toSlot,delay=0){
  const {sx,sy,tx,ty}=coordsFromTo(fromSlot,toSlot);
  const el=document.createElement('div'); el.className='fx-fireball';
  el.style.setProperty('--sx',sx+'px'); el.style.setProperty('--sy',sy+'px');
  el.style.setProperty('--tx',tx+'px'); el.style.setProperty('--ty',ty+'px');
  if (delay>0) el.style.animationDelay=`${delay}ms`;
  fxLayer.appendChild(el); setTimeout(()=>el.remove(),700+delay);
}
function animateCustomProjectile(fromSlot,toSlot,img,delay=0){
  const {sx,sy,tx,ty}=coordsFromTo(fromSlot,toSlot);
  const el=document.createElement('div'); el.className='fx-proj'; el.style.backgroundImage=`url('${img}')`;
  el.style.setProperty('--sx',sx+'px'); el.style.setProperty('--sy',sy+'px');
  el.style.setProperty('--tx',tx+'px'); el.style.setProperty('--ty',ty+'px');
  if (delay>0) el.style.animationDelay=`${delay}ms`;
  fxLayer.appendChild(el); setTimeout(()=>el.remove(),700+delay);
}
function spawnFX(className,cx,cy){ const el=document.createElement('div'); el.className=className; el.style.setProperty('--cx',cx+'px'); el.style.setProperty('--cy',cy+'px'); fxLayer.appendChild(el); setTimeout(()=>el.remove(),900); }
function spawnBeam(fromSlot,toSlot,color='lime'){
  const {sx,sy,tx,ty}=coordsFromTo(fromSlot,toSlot);
  const el=document.createElement('div'); el.className='fx-beam'; el.style.background=color;
  el.style.setProperty('--sx',sx+'px'); el.style.setProperty('--sy',sy+'px');
  el.style.setProperty('--tx',tx+'px'); el.style.setProperty('--ty',ty+'px');
  fxLayer.appendChild(el); setTimeout(()=>el.remove(),600);
}
function showEndScreen(win){ endScreen.classList.remove('hidden'); endText.textContent=win?"🎉 YOU WIN!":"💀 YOU LOSE!"; endText.className=win?'win':'lose'; }

document.addEventListener('click', e=>{
  const btn=e.target.closest('.spell'); if(!btn) return;
  if(iChoseThisTurn || !lastState || lastState.gameOver || lastState.selectionPhase) return;
  socket.emit('chooseSpell', btn.dataset.spell);
  iChoseThisTurn=true; setButtonsEnabled(false);
  setStatus(`You chose ${btn.dataset.spell}. Waiting for opponent…`);
});

socket.on('connect', ()=>{ myId = socket.id; });

socket.on('selectPhase', ({ roster, items, state }) => {
  addLog("👤 Character & Item selection started.");
  lastState = state;

  const grid = selectOverlay.querySelector('#char-grid');
  const itemGrid = selectOverlay.querySelector('#item-grid');
  const hint = selectOverlay.querySelector('#char-hint');
  grid.innerHTML=''; itemGrid.innerHTML='';

  roster.forEach(c=>{
    const el=document.createElement('div'); el.className='char'; el.dataset.key=c.key;
    el.innerHTML=`<div class="n">${c.name}</div><div class="s">HP ${c.maxHP} • Speed ${c.speed}</div>`;
    el.addEventListener('click', ()=>{
      grid.querySelectorAll('.char').forEach(x=>x.classList.remove('chosen'));
      el.classList.add('chosen');
      socket.emit('chooseCharacter', c.key);
      hint.textContent = `Locked ${c.name}. Now pick an item.`;
    });
    grid.appendChild(el);
  });

  items.forEach(i=>{
    const el=document.createElement('div'); el.className='item'; el.dataset.key=i.key;
    const tags = [];
    if (i.bonusDmg)    tags.push(`+${i.bonusDmg} dmg`);
    if (i.speedBoost)  tags.push(`+${i.speedBoost} speed`);
    if (i.critChance)  tags.push(`${Math.round(i.critChance*100)}% crit x${i.critMult||2}`);
    if (i.dodgeChance) tags.push(`${Math.round(i.dodgeChance*100)}% dodge`);
    if (i.reviveOnce)  tags.push(`revive once`);
    el.innerHTML = `<div class="n">${i.key}</div><div class="d">${tags.map(t=>`<span class="badge">${t}</span>`).join(' ')}</div>`;
    el.addEventListener('click', ()=>{
      itemGrid.querySelectorAll('.item').forEach(x=>x.classList.remove('chosen'));
      el.classList.add('chosen');
      socket.emit('chooseItem', i.key);
      hint.textContent = `Equipped ${i.key}. Waiting for opponent…`;
    });
    itemGrid.appendChild(el);
  });

  selectOverlay.classList.add('active');
  setButtonsEnabled(false);
});

socket.on('selectionUpdate', ({ msg, state }) => {
  addLog(msg); lastState = state;
});

socket.on('start', (state) => {
  selectOverlay.classList.remove('active');
  addLog("⚔️ Battle started! Lock in your move.");
  iChoseThisTurn = false; setButtonsEnabled(true);
  setStatus("Choose a spell…"); endScreen.classList.add('hidden');
  updateUI(state);
});

socket.on('battleUpdate', ({ msg, state }) => {
  const myName = state.players.find(p => p.id === myId)?.name;
  const firedByMe = msg.includes(myName);
  const fromSlot = firedByMe ? leftSlot : rightSlot;
  const toSlot   = firedByMe ? rightSlot : leftSlot;

  if (msg.includes('used Fireball'))            animateFireballPath(fromSlot, toSlot);
  if (msg.includes('used Bombarda Maxima'))     animateFireballPath(fromSlot, toSlot);
  if (msg.includes('used Sectumsempra'))        animateCustomProjectile(fromSlot, toSlot, '/assets/sectumsempra.png');
  if (msg.includes('used Alarte Ascendare'))    animateCustomProjectile(fromSlot, toSlot, '/assets/alarte_ascendare.png');
  if (msg.includes('used Aqua Eructo'))         animateFireballPath(fromSlot, toSlot);
  if (msg.includes('Avada Kedavra'))            spawnBeam(fromSlot, toSlot, 'lime');

  if (/healed/.test(msg)) { const {cx,cy}=slotCenter(firedByMe?leftSlot:rightSlot); spawnFX('fx-heal',cx,cy);}
  if (/is stunned/.test(msg)) { const targetIsMe = msg.includes(myName); const {cx,cy}=slotCenter(targetIsMe?leftSlot:rightSlot); spawnFX('fx-flash',cx,cy);}
  if (/afflicted by Crucio/.test(msg)) { const targetIsMe = msg.includes(myName); const {cx,cy}=slotCenter(targetIsMe?leftSlot:rightSlot); spawnFX('fx-curse',cx,cy);}
  if (/cast Protego/.test(msg)) { const {cx,cy}=slotCenter(firedByMe?leftSlot:rightSlot); spawnFX('fx-shield',cx,cy);}
  if (msg.includes("Protego reflected")) {
    const shieldByMe = msg.startsWith(myName);
    animateFireballPath(shieldByMe?rightSlot:leftSlot, shieldByMe?leftSlot:rightSlot);
    animateFireballPath(shieldByMe?leftSlot:rightSlot, shieldByMe?rightSlot:leftSlot, 350);
  }

  addLog(msg);
  updateUI(state);

  if (msg.startsWith('New turn!')) {
    iChoseThisTurn = false; setButtonsEnabled(true); setStatus("Choose a spell…");
  }
  if (state?.gameOver) {
    const me = state.players.find(p => p.id === myId);
    const winner = msg.includes(me.name);
    setButtonsEnabled(false); setStatus(winner ? "🎉 YOU WIN!" : "💀 YOU LOSE!");
    showEndScreen(winner);
  }
});
