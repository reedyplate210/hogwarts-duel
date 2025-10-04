const path = require('path'); // ✅ added
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }});

let waitingPlayer = null;
const battles = new Map(); // roomId -> state

// ✅ serve the client as a website (single deploy)
const CLIENT_DIR = path.join(__dirname, 'client');
app.use(express.static(CLIENT_DIR));
// 🔧 FIX: use '/*' instead of '*'
app.get('/*', (_, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));

// --- Characters ---
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

// --- Items ---
const ITEMS = {
  "Elder Wand":         { bonusDmg: 10 },
  "Invisibility Cloak": { dodgeChance: 0.25 },
  "Resurrection Stone": { reviveOnce: true },
  "Felix Felicis":      { critChance: 0.3, critMult: 2 },
  "Broomstick":         { speedBoost: 20 }
};

// --- Spells ---
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

// --- Spell usage limits ---
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

// Start-of-round effects (DoTs). Returns true if battle ended.
function applyStartOfRound(state, room){
  const p1 = state.players[0], p2 = state.players[1];

  const applyDots = (plr) => {
    if (!plr.dots || plr.dots.length === 0) return;
    let total = 0;
    plr.dots.forEach(d => { total += d.amount; d.turns -= 1; });
    plr.dots = plr.dots.filter(d => d.turns > 0);
    if (total > 0) {
      plr.currentHP = Math.max(0, plr.currentHP - total);
      io.to(room).emit('battleUpdate', { msg: `${plr.name} suffers ${total} damage from lingering curses!`, state });
    }
  };

  applyDots(p1);
  applyDots(p2);

  // KO checks with revive
  let p1Dead = p1.currentHP <= 0;
  let p2Dead = p2.currentHP <= 0;

  if (p1Dead) p1Dead = !tryRevive(p1, state, room) && p1.currentHP <= 0;
  if (p2Dead) p2Dead = !tryRevive(p2, state, room) && p2.currentHP <= 0;

  if (p1Dead && p2Dead) {
    state.gameOver = true; io.to(room).emit('battleUpdate', { msg: `Both wizards fall! It's a draw!`, state }); return true;
  }
  if (p1Dead) { state.gameOver = true; io.to(room).emit('battleUpdate', { msg: `${p2.name} wins!`, state }); return true; }
  if (p2Dead) { state.gameOver = true; io.to(room).emit('battleUpdate', { msg: `${p1.name} wins!`, state }); return true; }

  return false;
}

io.on('connection', socket => {
  console.log('player connected', socket.id);

  // --- Pair players (enter selection phase) ---
  if (waitingPlayer) {
    const room = `room_${waitingPlayer}_${socket.id}`;
    socket.join(room);
    io.sockets.sockets.get(waitingPlayer)?.join(room);

    const state = {
      room,
      selectionPhase: true,
      players: [
        { id: waitingPlayer, selectedKey: null, selectedItem: null },
        { id: socket.id,     selectedKey: null, selectedItem: null }
      ],
      gameOver: false
    };
    battles.set(room, state);

    const roster = Object.entries(CHARACTERS).map(([key, v]) => ({ key, ...v }));
    const itemList = Object.entries(ITEMS).map(([key, v]) => ({ key, ...v }));
    io.to(room).emit('selectPhase', { roster, items: itemList, state });
    waitingPlayer = null;
    console.log('Selection phase started', room);
  } else {
    waitingPlayer = socket.id;
    console.log('Waiting for second player...');
  }

  // --- Character choice ---
  socket.on('chooseCharacter', (charKey) => {
    const room = [...socket.rooms].find(r => r.startsWith('room_')); if (!room) return;
    const state = battles.get(room); if (!state || state.gameOver || !state.selectionPhase) return;
    if (!CHARACTERS[charKey]) return;

    const idx = state.players.findIndex(p => p.id === socket.id); if (idx === -1) return;
    state.players[idx].selectedKey = charKey;
    io.to(room).emit('selectionUpdate', { msg: `A player locked in ${CHARACTERS[charKey].name}.`, state });
    maybeStartAfterSelection(state, room);
  });

  // --- Item choice ---
  socket.on('chooseItem', (itemKey) => {
    const room = [...socket.rooms].find(r => r.startsWith('room_')); if (!room) return;
    const state = battles.get(room); if (!state || state.gameOver || !state.selectionPhase) return;
    if (!ITEMS[itemKey]) return;

    const idx = state.players.findIndex(p => p.id === socket.id); if (idx === -1) return;
    state.players[idx].selectedItem = itemKey;
    io.to(room).emit('selectionUpdate', { msg: `A player equipped ${itemKey}.`, state });
    maybeStartAfterSelection(state, room);
  });

  function maybeStartAfterSelection(state, room){
    const bothPickedEverything = state.players.every(p => p.selectedKey && p.selectedItem);
    if (!bothPickedEverything) return;

    const p1Key = state.players[0].selectedKey, p2Key = state.players[1].selectedKey;
    const i1Key = state.players[0].selectedItem, i2Key = state.players[1].selectedItem;
    const c1 = CHARACTERS[p1Key], c2 = CHARACTERS[p2Key];

    state.players = [
      {
        id: state.players[0].id, charKey: p1Key, ...c1,
        currentHP: c1.maxHP, chosenSpell: null, dots: [], stun: 0,
        itemKey: i1Key, item: ITEMS[i1Key], _revived: false,
        spellUses: { ...USAGE_LIMITS } // per-spell counters
      },
      {
        id: state.players[1].id, charKey: p2Key, ...c2,
        currentHP: c2.maxHP, chosenSpell: null, dots: [], stun: 0,
        itemKey: i2Key, item: ITEMS[i2Key], _revived: false,
        spellUses: { ...USAGE_LIMITS }
      }
    ];
    state.selectionPhase = false;
    state.round = 1;
    state.gameOver = false;

    io.to(room).emit('start', state);
    console.log('Battle started after selection', room);
  }

  // --- Battle choose spell (simultaneous) ---
  socket.on('chooseSpell', (spellName) => {
    const room = [...socket.rooms].find(r => r.startsWith('room_')); if (!room) return;
    const state = battles.get(room); if (!state || state.gameOver || state.selectionPhase) return;

    const playerIndex = state.players.findIndex(p => p.id === socket.id); if (playerIndex === -1) return;
    const player = state.players[playerIndex];

    // 1) Usage check (block if already at 0)
    const remaining = player.spellUses?.[spellName];
    if (remaining === 0) {
      // tell only this player
      io.to(socket.id).emit('battleUpdate', { msg: `❌ You can’t cast ${spellName} anymore!`, state });
      return;
    }

    // Save intention (we consume later when the action actually resolves & is not skipped)
    player.chosenSpell = spellName;

    io.to(room).emit('battleUpdate', { msg: `${player.name || CHARACTERS[player.charKey]?.name || 'Player'} has chosen a spell!`, state });

    const bothChosen = state.players.every(p => p.chosenSpell);
    if (!bothChosen) return;

    if (applyStartOfRound(state, room)) return;

    const p1 = state.players[0], p2 = state.players[1];

    // Build effective spells (respect stun)
    const effective = (plr) => {
      if (plr.stun && plr.stun > 0) return { name: "(Stunned)", dmg: 0, priority: 0, skip: true };
      const base = SPELLS[plr.chosenSpell] || { dmg: 20, priority: 0 };
      return { name: plr.chosenSpell, ...base };
    };

    const s1 = effective(p1), s2 = effective(p2);

    // Consume usage NOW for non-stunned actions (so Protego/Avada/etc. count)
    const consumeUse = (plr, spell) => {
      if (spell.skip) return; // stunned: do not consume
      const key = spell.name;
      const limit = plr.spellUses?.[key];
      if (limit !== undefined && limit > 0) {
        plr.spellUses[key] = limit - 1;
      }
      // If limit is undefined → unlimited, do nothing
    };
    consumeUse(p1, s1);
    consumeUse(p2, s2);

    // Order: (speed + item speedBoost) + priority
    const spd1 = (p1.speed + (p1.item?.speedBoost || 0)) + (s1.priority || 0);
    const spd2 = (p2.speed + (p2.item?.speedBoost || 0)) + (s2.priority || 0);

    let first = p1, firstSpell = s1;
    let second = p2, secondSpell = s2;
    if (spd2 > spd1 || (spd2 === spd1 && Math.random() < 0.5)) { first = p2; firstSpell = s2; second = p1; secondSpell = s1; }

    const announce = (msg) => io.to(room).emit('battleUpdate', { msg, state });

    // Returns {ko:true, dead:'caster'|'target'} or null
    const applySpell = (caster, target, spell, enemySpell) => {
      // stunned
      if (spell.skip) { announce(`${caster.name} is stunned and can't act!`); return null; }

      // protego cast
      if (spell.shield) { announce(`${caster.name} cast ${spell.name} and is protected!`); return null; }

      // instant KO (Avada)
      if (spell.instantKO) {
        if (enemySpell?.shield) {
          caster.currentHP = 0; clampHP(caster);
          if (!tryRevive(caster, state, room) && caster.currentHP <= 0) {
            announce(`${target.name}'s Protego reflected ${spell.name} back to ${caster.name}!`);
            return { ko:true, dead:'caster' };
          }
          announce(`${target.name}'s Protego reflected ${spell.name} back to ${caster.name}, but they revived!`);
          return null;
        } else {
          target.currentHP = 0; clampHP(target);
          if (!tryRevive(target, state, room) && target.currentHP <= 0) {
            announce(`${caster.name} cast ${spell.name}! It's fatal!`);
            return { ko:true, dead:'target' };
          }
          announce(`${caster.name} cast ${spell.name} — ${target.name} revived!`);
          return null;
        }
      }

      // heal
      if (spell.dmg < 0) {
        const heal = -spell.dmg;
        caster.currentHP = Math.min(caster.maxHP, caster.currentHP + heal);
        announce(`${caster.name} healed ${heal} HP with ${spell.name}!`);
        return null;
      }

      // damage path
      if (spell.dmg > 0) {
        // reflect
        if (enemySpell?.shield) {
          const reflected = spell.dmg + (caster.item?.bonusDmg || 0);
          caster.currentHP = Math.max(0, caster.currentHP - reflected);
          announce(`${target.name}'s Protego reflected ${reflected} damage back to ${caster.name}!`);
          if (!tryRevive(caster, state, room) && caster.currentHP <= 0) return { ko:true, dead:'caster' };
          return null;
        }

        // dodge (cloak)
        if (target.item?.dodgeChance && Math.random() < target.item.dodgeChance) {
          announce(`${target.name} dodged the attack with the Invisibility Cloak!`);
          return null;
        }

        // crit (Felix)
        let dmg = spell.dmg + (caster.item?.bonusDmg || 0);
        let crit = false;
        if (caster.item?.critChance && Math.random() < caster.item.critChance) {
          dmg = Math.floor(dmg * (caster.item?.critMult || 2));
          crit = true;
        }

        target.currentHP = Math.max(0, target.currentHP - dmg);
        announce(`${caster.name} used ${spell.name} for ${dmg} damage!${crit ? ' (CRIT!)' : ''}`);
        if (!tryRevive(target, state, room) && target.currentHP <= 0) return { ko:true, dead:'target' };
      } else {
        announce(`${caster.name} used ${spell.name}!`);
      }

      // stun
      if (spell.stun && !enemySpell?.shield) {
        target.stun = Math.max(target.stun || 0, spell.stun);
        announce(`${target.name} is stunned and will skip their next action!`);
      }
      // dot
      if (spell.dot && !enemySpell?.shield) {
        target.dots = target.dots || [];
        target.dots.push({ amount: spell.dot.amount, turns: spell.dot.turns, name: spell.name });
        announce(`${target.name} is afflicted by ${spell.name}! (${spell.dot.amount} dmg for ${spell.dot.turns} turns)`);
      }
      return null;
    };

    // Resolve first
    if (!state.gameOver) {
      const res1 = applySpell(first, second, firstSpell, secondSpell);
      if (res1?.ko) {
        state.gameOver = true;
        const winner = res1.dead === 'target' ? first : second;
        announce(`${winner.name} wins!`);
        return;
      }
    }
    // Resolve second
    if (!state.gameOver) {
      const res2 = applySpell(second, first, secondSpell, firstSpell);
      if (res2?.ko) {
        state.gameOver = true;
        const winner = res2.dead === 'target' ? second : first;
        announce(`${winner.name} wins!`);
        return;
      }
    }

    // tick stun
    if (p1.stun && p1.stun > 0) p1.stun -= 1;
    if (p2.stun && p2.stun > 0) p2.stun -= 1;

    state.players.forEach(p => { p.chosenSpell = null; clampHP(p); });
    state.round = (state.round || 1) + 1;

    if (!state.gameOver) io.to(room).emit('battleUpdate', { msg: `New turn! Both players choose a spell.`, state });
  });
}); // end connection

// ✅ use PORT env for easy deploys
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
