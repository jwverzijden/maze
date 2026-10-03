'use strict';

/* ============================================================
   Hashing (ported from test.js — SplitMix64 over BigInt)
   ============================================================ */

const MASK = 0xFFFFFFFFFFFFFFFFn;

function splitmix64(x) {
  x = (x + 0x9e3779b97f4a7c15n) & MASK;
  let z = x;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

function mix(...args) {
  let h = 0n;
  for (const a of args) {
    h = splitmix64(h ^ (BigInt(a) & MASK));
  }
  return h;
}

const out_of_bounds = (c, L) => !c.every((x) => x >= 0 && x < L);

// --- The maze is a seeded spanning tree (a "perfect maze") ------------------
//
// Every tile except the all-zero root has exactly one "parent" — the tile
// with one positive coordinate decremented, chosen via a seeded hash. Because
// the coordinate sum always drops by 1 toward the parent, these links form a
// tree that reaches the root from every tile. Only these tree edges are open;
// every other neighbour is a wall. The whole D-dimensional grid is therefore
// always connected (so the finish is always reachable) and cycle-free.
//
// PARENT_TAG decorrelates the parent pick from any other hash use.
const PARENT_TAG = 0x6d1ce4e5b9f4a7c1n;

function coord_equal(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function parent_coord(seed, c) {
  const pos = [];
  for (let i = 0; i < c.length; i++) if (c[i] > 0) pos.push(i);
  if (pos.length === 0) return null; // root [0, ..., 0]
  const pick = Number(mix(seed, PARENT_TAG, ...c) % BigInt(pos.length));
  const p = c.slice();
  p[pos[pick]] -= 1;
  return p;
}

// a and b are adjacent tiles (differ in exactly one coordinate by ±1).
function is_backbone(seed, a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      const upper = a[i] > b[i] ? a : b;
      const lower = a[i] > b[i] ? b : a;
      const p = parent_coord(seed, upper);
      return p !== null && coord_equal(p, lower);
    }
  }
  return false;
}

function is_wall(seed, a, b, L) {
  if (out_of_bounds(a, L) || out_of_bounds(b, L)) return true;
  return !is_backbone(seed, a, b); // open only on tree edges
}

// Build a full D-dim coordinate from a 2D grid position.
// y / x are grid row / col; sy / sx are the dimensions those axes map to.
function mix_coords(y, x, sy, sx, p) {
  const c = p.slice();
  c[sy] = y;
  c[sx] = x;
  return c;
}

const is_player_here = (coord, p) => coord.every((c, i) => c === p[i]);

function build_tile_grid(seed, L, sx, sy, p) {
  const tiles = new Array(L);
  for (let y = 0; y < L; y++) {
    const row = new Array(L);
    for (let x = 0; x < L; x++) {
      row[x] = {
        y, x,
        player: is_player_here(mix_coords(y, x, sy, sx, p), p),
        left:  is_wall(seed, mix_coords(y, x - 1, sy, sx, p), mix_coords(y, x, sy, sx, p), L),
        right: is_wall(seed, mix_coords(y, x, sy, sx, p), mix_coords(y, x + 1, sy, sx, p), L),
        up:    is_wall(seed, mix_coords(y - 1, x, sy, sx, p), mix_coords(y, x, sy, sx, p), L),
        down:  is_wall(seed, mix_coords(y, x, sy, sx, p), mix_coords(y + 1, x, sy, sx, p), L)
      };
    }
    tiles[y] = row;
  }
  return tiles;
}

/* ============================================================
   Constants & state
   ============================================================ */

const SAVE_KEY = 'multidim-maze-save';
const FADE_MS = 180;
const DEFAULT_SEL_V = 0; // vertical selection -> grid rows
const DEFAULT_SEL_H = 1; // horizontal selection -> grid cols
const MIN_D = 2;
const MAX_D = 20;
const MIN_L = 2;
const MAX_L = 20;

let state = null;       // active game state
let tiles = null;       // LxL grid of tile info
let runStart = null;    // performance.now() while actively playing, else null
let currentScreen = 'main';
let connAlpha = 1;      // connection opacity (used by the fade animation)
let fade = null;        // { phase, start, onMidpoint }

// new-game setup values
let pendingD = MIN_D;
let pendingL = MIN_L;
let pendingSeed = 0n;
let pendingSelV = DEFAULT_SEL_V;
let pendingSelH = DEFAULT_SEL_H;

/* ============================================================
   DOM references
   ============================================================ */

const $ = (id) => document.getElementById(id);

const mainMenu = $('main-menu');
const newGameMenu = $('new-game-menu');
const gameScreen = $('game-screen');
const pauseMenu = $('pause-menu');
const finishMenu = $('finish-menu');

const btnContinue = $('btn-continue');

const valD = $('val-d');
const valL = $('val-l');
const valSeed = $('val-seed');

const hudProgress = $('hud-progress');
const hudCoords = $('hud-coords');
const hudSteps = $('hud-steps');
const hudTime = $('hud-time');
const board = $('board');
const vertSlider = $('vert-slider');
const canvas = $('maze-canvas');
const ctx = canvas.getContext('2d');

const selVert = $('sel-vert');
const selHoriz = $('sel-horiz');
const vertTag = $('vert-tag');
const horizTag = $('horiz-tag');
const finishStats = $('finish-stats');

let dpr = 1;
let sizeCss = 0;

/* ============================================================
   Palette (derived from the seed so each game gets its own tone)
   ============================================================ */

function paletteFromSeed(seed) {
  const hue = Number(splitmix64(seed ^ 0x5eed1234n) % 360n);
  const hsl = (h, s, l) => `hsl(${h}, ${s}%, ${l}%)`;
  return {
    bg: hsl(hue, 30, 8),
    path: hsl(hue, 34, 44),
    node: hsl(hue, 34, 62),
    player: hsl(hue, 80, 68),
    goal: hsl((hue + 150) % 360, 55, 60),
    start: hsl(hue, 18, 42),
    sliderTrack: hsl(hue, 25, 17),
    sliderThumb: hsl(hue, 45, 62)
  };
}

let palette = paletteFromSeed(0n);

/* ============================================================
   Rendering
   ============================================================ */

function resizeCanvas() {
  const rect = board.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  if (w <= 0 || h <= 0) return;
  const sliderW = vertSlider.offsetWidth || 40;
  const gap = 10; // keep in sync with .vert-slider margin-right
  const s = Math.floor(Math.max(1, Math.min(h, w - 2 * (sliderW + gap))));
  sizeCss = s;
  dpr = window.devicePixelRatio || 1;
  canvas.style.width = s + 'px';
  canvas.style.height = s + 'px';
  canvas.width = Math.floor(s * dpr);
  canvas.height = Math.floor(s * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function draw() {
  if (sizeCss <= 0 || !tiles || !state) return;

  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, sizeCss, sizeCss);

  const L = tiles.length;
  const cell = sizeCss / L;
  const cx = (i) => cell * i + cell / 2;
  const cy = (i) => cell * i + cell / 2;
  const nodeR = Math.max(2, cell * 0.16);
  const lineW = Math.max(1.5, cell * 0.07);

  // Connected paths (these fade in/out on dimension change).
  ctx.lineCap = 'round';
  ctx.lineWidth = lineW;
  ctx.strokeStyle = palette.path;
  ctx.globalAlpha = connAlpha;
  ctx.beginPath();
  for (let y = 0; y < L; y++) {
    for (let x = 0; x < L; x++) {
      const t = tiles[y][x];
      if (x + 1 < L && !t.right) { ctx.moveTo(cx(x), cy(y)); ctx.lineTo(cx(x + 1), cy(y)); }
      if (y + 1 < L && !t.down) { ctx.moveTo(cx(x), cy(y)); ctx.lineTo(cx(x), cy(y + 1)); }
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Node circles.
  ctx.fillStyle = palette.node;
  for (let y = 0; y < L; y++) {
    for (let x = 0; x < L; x++) {
      ctx.beginPath();
      ctx.arc(cx(x), cy(y), nodeR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  
  ctx.globalAlpha = connAlpha;
  // Start / goal markers, shown only when they lie in the current slice.
  const hidden = [];
  for (let i = 0; i < state.D; i++) {
    if (i !== state.selV && i !== state.selH) hidden.push(i);
  }
  const startVisible = hidden.every((i) => state.player[i] === 0);
  const goalVisible = hidden.every((i) => state.player[i] === L - 1);

  ctx.lineWidth = Math.max(1.5, cell * 0.04);
  if (startVisible) {
    ctx.strokeStyle = palette.start;
    ctx.beginPath();
    ctx.arc(cx(0), cy(0), nodeR * 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (goalVisible) {
    ctx.strokeStyle = palette.goal;
    ctx.beginPath();
    ctx.arc(cx(L - 1), cy(L - 1), nodeR * 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Player.
  const py = state.player[state.selV];
  const px = state.player[state.selH];
  ctx.save();
  ctx.shadowColor = palette.player;
  ctx.shadowBlur = cell * 0.25;
  ctx.fillStyle = palette.player;
  ctx.beginPath();
  ctx.arc(cx(px), cy(py), nodeR * 1.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ============================================================
   Fade animation on dimension change
   ============================================================ */

function startFade(onMidpoint) {
  if (fade) return;
  fade = { phase: 'out', start: performance.now(), onMidpoint };
  requestAnimationFrame(fadeLoop);
}

function fadeLoop(now) {
  if (!fade) return;
  const t = Math.min(1, (now - fade.start) / FADE_MS);

  if (fade.phase === 'out') {
    connAlpha = 1 - t;
    draw();
    if (t >= 1) {
      if (fade.onMidpoint) { fade.onMidpoint(); fade.onMidpoint = null; }
      fade.phase = 'in';
      fade.start = now;
    }
  } else {
    connAlpha = t;
    draw();
    if (t >= 1) {
      connAlpha = 1;
      fade = null;
      draw();
    }
  }

  if (fade) requestAnimationFrame(fadeLoop);
}

/* ============================================================
   Game state helpers
   ============================================================ */

function rebuildGrid() {
  tiles = build_tile_grid(state.seed, state.L, state.selH, state.selV, state.player);
}

function settleElapsed() {
  if (runStart != null) {
    state.elapsedMs += performance.now() - runStart;
    runStart = null;
  }
}

function resumeElapsed() {
  runStart = performance.now();
}

function effectiveElapsed() {
  return state.elapsedMs + (runStart != null ? performance.now() - runStart : 0);
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function saveGame() {
  if (!state) return;
  const data = {
    seed: state.seed.toString(),
    D: state.D,
    L: state.L,
    player: state.player,
    selV: state.selV,
    selH: state.selH,
    steps: state.steps,
    elapsedMs: Math.round(effectiveElapsed())
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
}

function loadGame() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return {
      seed: BigInt(d.seed),
      D: d.D,
      L: d.L,
      player: d.player,
      selV: d.selV,
      selH: d.selH,
      steps: d.steps,
      elapsedMs: d.elapsedMs || 0
    };
  } catch (e) {
    return null;
  }
}

function hasSave() {
  return !!localStorage.getItem(SAVE_KEY);
}

function updateContinueButton() {
  btnContinue.disabled = !hasSave();
}

/* ============================================================
   Screens
   ============================================================ */

function showScreen(name) {
  currentScreen = name;
  mainMenu.classList.toggle('hidden', name !== 'main');
  newGameMenu.classList.toggle('hidden', name !== 'newgame');
  const gameVisible = (name === 'game' || name === 'pause' || name === 'finish');
  gameScreen.classList.toggle('hidden', !gameVisible);
  pauseMenu.classList.toggle('hidden', name !== 'pause');
  finishMenu.classList.toggle('hidden', name !== 'finish');
  if (name === 'main') updateContinueButton();
}

/* ============================================================
   HUD
   ============================================================ */

function updateHud() {
  if (!state) return;
  hudCoords.textContent = '[' + state.player.join(', ') + ']';
  hudSteps.textContent = 'Steps ' + state.steps;
  hudTime.textContent = formatTime(effectiveElapsed());
  const reached = state.player.filter((c) => c === state.L - 1).length;
  hudProgress.textContent = 'Goal ' + reached + '/' + state.D;
}

/* ============================================================
   Dimension sliders
   ============================================================ */

function setupSliders() {
  selVert.min = '0';
  selVert.max = String(state.D - 1);
  selVert.step = '1';
  selHoriz.min = '0';
  selHoriz.max = String(state.D - 1);
  selHoriz.step = '1';
  selHoriz.style = `color: ${palette.bg}`;
  syncSliders();
}

function syncSliders() {
  selVert.value = String(state.selV);
  selHoriz.value = String(state.selH);
  vertTag.textContent = 'V ' + state.selV;
  horizTag.textContent = 'H ' + state.selH;
}

function setSelection(v, h) {
  pendingSelV = v;
  pendingSelH = h;

  if (!fade) {
    if (v === state.selV && h === state.selH) {
      syncSliders();
      return;
    }
    startFade(() => {
      if (state.selV !== pendingSelV || state.selH !== pendingSelH) {
        state.selV = pendingSelV;
        state.selH = pendingSelH;
        rebuildGrid();
        syncSliders();
        updateHud();
        saveGame();
      }
    });
  }
  // If a fade is already running, its midpoint applies the latest pending values.
}

/* ============================================================
   Movement
   ============================================================ */

function move(dir) {
  if (currentScreen !== 'game') return;
  const py = state.player[state.selV];
  const px = state.player[state.selH];
  const t = tiles[py][px];
  let moved = false;

  if (dir === 'up' && !t.up) { state.player[state.selV] -= 1; moved = true; }
  else if (dir === 'down' && !t.down) { state.player[state.selV] += 1; moved = true; }
  else if (dir === 'left' && !t.left) { state.player[state.selH] -= 1; moved = true; }
  else if (dir === 'right' && !t.right) { state.player[state.selH] += 1; moved = true; }

  if (moved) {
    state.steps += 1;
    rebuildGrid();
    draw();
    updateHud();
    saveGame();
    if (state.player.every((c) => c === state.L - 1)) finishGame();
  }
}

/* ============================================================
   Game flow
   ============================================================ */

function setupGameUI() {
  palette = paletteFromSeed(state.seed);
  document.documentElement.style.setProperty('--game-bg', palette.bg);
  document.documentElement.style.setProperty('--slider-track', palette.sliderTrack);
  document.documentElement.style.setProperty('--slider-thumb', palette.sliderThumb);
  setupSliders();
  updateHud();
}

function startNewGame() {
  state = {
    seed: pendingSeed,
    D: pendingD,
    L: pendingL,
    player: new Array(pendingD).fill(0),
    selV: DEFAULT_SEL_V,
    selH: DEFAULT_SEL_H,
    steps: 0,
    elapsedMs: 0
  };
  runStart = performance.now();
  setupGameUI();
  showScreen('game');
  rebuildGrid();
  requestAnimationFrame(() => resizeCanvas());
  saveGame();
}

function continueGame() {
  const d = loadGame();
  if (!d) return;
  state = d;
  runStart = performance.now();
  setupGameUI();
  showScreen('game');
  rebuildGrid();
  requestAnimationFrame(() => resizeCanvas());
}

function togglePause() {
  if (currentScreen === 'game') {
    settleElapsed();
    saveGame();
    showScreen('pause');
  } else if (currentScreen === 'pause') {
    resumeElapsed();
    updateHud();
    showScreen('game');
  }
}

function restartGame() {
  state.player = new Array(state.D).fill(0);
  state.selV = DEFAULT_SEL_V;
  state.selH = DEFAULT_SEL_H;
  state.steps = 0;
  state.elapsedMs = 0;
  runStart = performance.now();
  rebuildGrid();
  setupSliders();
  updateHud();
  draw();
  saveGame();
  showScreen('game');
}

function quitToMain() {
  settleElapsed();
  saveGame();
  showScreen('main');
}

function playAgain() {
  const D = state.D;
  const L = state.L;
  state = {
    seed: randomSeed(),
    D,
    L,
    player: new Array(D).fill(0),
    selV: DEFAULT_SEL_V,
    selH: DEFAULT_SEL_H,
    steps: 0,
    elapsedMs: 0
  };
  runStart = performance.now();
  setupGameUI();
  showScreen('game');
  rebuildGrid();
  requestAnimationFrame(() => resizeCanvas());
  saveGame();
}

function finishGame() {
  settleElapsed();
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  finishStats.textContent = 'Time ' + formatTime(effectiveElapsed()) + '  ·  Steps ' + state.steps;
  draw();
  showScreen('finish');
}

/* ============================================================
   Random seed
   ============================================================ */

function randomSeed() {
  if (window.crypto && crypto.getRandomValues) {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    return (BigInt(buf[0]) << 32n) | BigInt(buf[1]);
  }
  return (BigInt(Math.floor(Math.random() * 0x100000000)) << 32n) |
         BigInt(Math.floor(Math.random() * 0x100000000));
}

function seedLabel(seed) {
  const hex = seed.toString(16).toUpperCase();
  return hex;
}

/* ============================================================
   Wiring
   ============================================================ */

function wire(id, fn) {
  $(id).addEventListener('click', (e) => {
    fn(e);
    e.currentTarget.blur();
  });
}

function refreshSteppers() {
  valD.textContent = pendingD;
  valL.textContent = pendingL;
}

function refreshSeedLabel() {
  valSeed.textContent = seedLabel(pendingSeed);
}

function bindUI() {
  wire('btn-new-game', () => {
    pendingSeed = randomSeed();
    pendingD = MIN_D;
    pendingL = MIN_L;
    refreshSeedLabel();
    refreshSteppers();
    showScreen('newgame');
  });

  wire('btn-continue', () => continueGame());

  wire('d-dec', () => { pendingD = Math.max(MIN_D, pendingD - 1); refreshSteppers(); });
  wire('d-inc', () => { pendingD = Math.min(MAX_D, pendingD + 1); refreshSteppers(); });
  wire('l-dec', () => { pendingL = Math.max(MIN_L, pendingL - 1); refreshSteppers(); });
  wire('l-inc', () => { pendingL = Math.min(MAX_L, pendingL + 1); refreshSteppers(); });
  wire('btn-reroll', () => { pendingSeed = randomSeed(); refreshSeedLabel(); });
  wire('btn-start', () => startNewGame());
  wire('btn-back-main', () => showScreen('main'));

  wire('btn-pause', () => togglePause());
  wire('btn-up', () => move('up'));
  wire('btn-down', () => move('down'));
  wire('btn-left', () => move('left'));
  wire('btn-right', () => move('right'));

  wire('btn-resume', () => togglePause());
  wire('btn-restart', () => restartGame());
  wire('btn-quit', () => quitToMain());
  wire('btn-again', () => playAgain());
  wire('btn-finish-main', () => showScreen('main'));

  selVert.addEventListener('change', () => {
    let v = parseInt(selVert.value, 10);
    let h = parseInt(selHoriz.value, 10);
    if (v === h) h = state.selV; // give horizontal the old vertical axis
    setSelection(v, h);
    selVert.blur();
  });

  selHoriz.addEventListener('change', () => {
    let h = parseInt(selHoriz.value, 10);
    let v = parseInt(selVert.value, 10);
    if (h === v) v = state.selH; // give vertical the old horizontal axis
    setSelection(v, h);
    selHoriz.blur();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key;

    if (k === 'Escape') {
      if (currentScreen === 'game' || currentScreen === 'pause') togglePause();
      return;
    }

    if (currentScreen !== 'game') return;

    const el = document.activeElement;
    if (el && (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'range'))) return; // let sliders/dropdowns handle their keys

    switch (k) {
      case 'ArrowUp': case 'w': case 'W': e.preventDefault(); move('up'); break;
      case 'ArrowDown': case 's': case 'S': e.preventDefault(); move('down'); break;
      case 'ArrowLeft': case 'a': case 'A': e.preventDefault(); move('left'); break;
      case 'ArrowRight': case 'd': case 'D': e.preventDefault(); move('right'); break;
      case 'p': case 'P': togglePause(); break;
    }
  });

  window.addEventListener('resize', () => {
    if (currentScreen === 'game' || currentScreen === 'pause' || currentScreen === 'finish') {
      resizeCanvas();
    }
  });

  if (window.ResizeObserver) {
    new ResizeObserver(() => resizeCanvas()).observe(board);
  }

  window.addEventListener('beforeunload', () => saveGame());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && currentScreen === 'game') saveGame();
  });
}

/* ============================================================
   Boot
   ============================================================ */

function init() {
  pendingSeed = randomSeed();
  refreshSeedLabel();
  refreshSteppers();
  updateContinueButton();
  showScreen('main');
}

bindUI();
init();

// Keep the on-screen timer ticking while playing.
setInterval(() => {
  if (currentScreen === 'game') {
    hudTime.textContent = formatTime(effectiveElapsed());
  }
}, 500);
