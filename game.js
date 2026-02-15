(() => {
  const tg = window.Telegram?.WebApp || null;
  if (tg) {
    tg.ready();
    tg.expand();
    tg.enableClosingConfirmation();
  }

  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d", { alpha: true });

  const timeEl = document.getElementById("time");
  const scoreEl = document.getElementById("score");
  const multEl = document.getElementById("mult");
  const bestEl = document.getElementById("best");
  const startBtn = document.getElementById("start");
  const hapticBtn = document.getElementById("haptic");
  const soundBtn = document.getElementById("sound");

  let W = 0, H = 0, dpr = 1;

  // ---- assets ----
  const img = {};
  const ASSETS = {
    hole: "assets/hole.png",
    iqos: "assets/iqos.png",
    sticks: "assets/sticks.png",
    hit: "assets/hit.png",
  };

  // ---- Sound (tiny synth via WebAudio) ----
  let audioCtx = null;
  let soundOn = true;

  function ensureAudio() {
    if (!soundOn) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  }

  function beep({ freq=420, dur=0.06, type="sine", gain=0.05, slide=0 }) {
    if (!soundOn) return;
    ensureAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.linearRampToValueAtTime(freq + slide, t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + dur);
  }

  const sfx = {
    hit: () => beep({ freq: 520, dur: 0.05, type: "triangle", gain: 0.06, slide: 180 }),
    bonus: () => {
      beep({ freq: 660, dur: 0.06, type: "square", gain: 0.045, slide: 220 });
      setTimeout(()=>beep({freq: 880, dur:0.07, type:"square", gain:0.04, slide:120}), 40);
    },
    miss: () => beep({ freq: 180, dur: 0.07, type: "sine", gain: 0.04, slide: -60 }),
    start: () => beep({ freq: 380, dur: 0.08, type: "triangle", gain: 0.05, slide: 160 }),
    end: () => beep({ freq: 240, dur: 0.12, type: "sine", gain: 0.04, slide: -80 }),
  };

  function resize() {
    dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    W = Math.floor(canvas.clientWidth * dpr);
    H = Math.floor(canvas.clientHeight * dpr);
    canvas.width = W;
    canvas.height = H;
  }
  window.addEventListener("resize", resize);

  function loadImages() {
    const entries = Object.entries(ASSETS);
    return Promise.all(entries.map(([k, src]) => new Promise((res) => {
      const im = new Image();
      im.onload = () => { img[k] = im; res(); };
      im.onerror = () => { console.warn("asset missing:", src); res(); };
      im.src = src;
    })));
  }

  // ---- layout: 3x2 + 1 bottom ----
  const GRID = [
    {x: 0.2, y: 0.25}, {x: 0.5, y: 0.25}, {x: 0.8, y: 0.25},
    {x: 0.2, y: 0.55}, {x: 0.5, y: 0.55}, {x: 0.8, y: 0.55},
    {x: 0.5, y: 0.83},
  ];

  // ---- game state ----
  let running = false;
  const durationMs = 30_000;
  let timeLeft = durationMs;
  let lastTs = 0;
  let score = 0;

  // local best
  const BEST_KEY = "miniapp_best_score_v1";
  let best = Number(localStorage.getItem(BEST_KEY) || 0);
  bestEl.textContent = `BEST: ${best}`;

  // x2 bonus
  let multiplier = 1;
  let multUntil = 0;

  // difficulty
  let intensity = 1.0;
  let baseSpawn = 0.016;

  // particles
  const particles = [];
  function spawnParticles(x, y, count, power, life, kind="hit") {
    for (let i=0; i<count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = power * (0.4 + Math.random()*0.6);
      particles.push({
        x, y,
        vx: Math.cos(a)*sp,
        vy: Math.sin(a)*sp - sp*0.25,
        r: (kind==="bonus" ? 7 : 5) * (0.6 + Math.random()*0.8),
        life,
        t: 0,
        kind
      });
    }
  }

  const holes = GRID.map((p) => ({
    ...p,
    type: null,      // "iqos" | "sticks" | null
    until: 0,
    cooldown: 0,
    justHit: 0,
    popT: 0,
    popDur: 160,
  }));

  let hapticOn = true;

  function now() { return performance.now(); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function easeOutBack(t){
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3*Math.pow(t-1,3) + c1*Math.pow(t-1,2);
  }

  function setMultiplier(x, duration) {
    multiplier = x;
    multUntil = now() + duration;
    multEl.textContent = `x${multiplier}`;
  }

  function addScore(base) {
    const total = base * multiplier;
    score += total;
    scoreEl.textContent = String(score);
  }

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function spawnLogic(ts) {
    const progress = 1 - (timeLeft / durationMs);
    intensity = 1.0 + progress * 1.2;
    const pSpawn = baseSpawn * intensity;

    for (const h of holes) {
      if (h.type && ts > h.until) h.type = null;
      if (ts < h.cooldown) continue;
      if (h.type) continue;

      if (Math.random() < pSpawn) {
        const isSticks = Math.random() < 0.16;
        h.type = isSticks ? "sticks" : "iqos";
        const life = (isSticks ? rand(650, 980) : rand(520, 900)) / intensity;
        h.until = ts + life;
        h.cooldown = ts + rand(220, 520) / intensity;
        h.popT = ts;
      }
    }
  }

  function drawBoard() {
    ctx.save();
    const g = ctx.createRadialGradient(W*0.5, H*0.45, Math.min(W,H)*0.1, W*0.5, H*0.55, Math.max(W,H)*0.8);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.35)");
    ctx.fillStyle = g;
    ctx.fillRect(0,0,W,H);

    ctx.globalAlpha = 0.30;
    ctx.lineWidth = 18 * dpr;
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.strokeRect(12*dpr, 12*dpr, W-24*dpr, H-24*dpr);
    ctx.restore();
  }

  function drawParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += 16.67;
      const t = p.t / p.life;
      if (t >= 1) { particles.splice(i, 1); continue; }
      p.vy += 0.12 * dpr;
      p.x += p.vx;
      p.y += p.vy;

      const alpha = 1 - t;
      ctx.save();
      ctx.globalAlpha = alpha * 0.9;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1 - t*0.4), 0, Math.PI*2);
      ctx.fillStyle = (p.kind === "bonus") ? "rgba(255,105,180,1)" : "rgba(255,255,255,1)";
      ctx.fill();
      ctx.restore();
    }
  }

  function draw(ts) {
    ctx.clearRect(0, 0, W, H);

    drawBoard();
    drawParticles();

    const holeSize = Math.min(W, H) * 0.18;
    const popSize = holeSize * 0.92;

    for (const h of holes) {
      const cx = h.x * W;
      const cy = h.y * H;

      if (img.hole) {
        ctx.drawImage(img.hole, cx - holeSize/2, cy - holeSize/2, holeSize, holeSize);
      }

      if (h.type) {
        const sprite = h.type === "sticks" ? img.sticks : img.iqos;
        const t = clamp((ts - h.popT) / h.popDur, 0, 1);
        const pop = easeOutBack(t);

        if (h.type === "iqos") {
          const w = popSize * 1.10 * pop;
          const hh = popSize * 2.05 * pop;
          const y = cy - hh + holeSize*0.28;

          ctx.save();
          ctx.globalAlpha = 0.35;
          ctx.filter = "blur(6px)";
          ctx.drawImage(sprite, cx - w/2 + 10*dpr, y + 14*dpr, w, hh);
          ctx.restore();

          ctx.drawImage(sprite, cx - w/2, y, w, hh);
        } else {
          const w = popSize * 1.35 * pop;
          const hh = popSize * 0.95 * pop;
          const y = cy - hh + holeSize*0.20;

          ctx.save();
          ctx.shadowColor = "rgba(255, 77, 196, 0.95)";
          ctx.shadowBlur = 36 * dpr;
          ctx.drawImage(sprite, cx - w/2, y, w, hh);
          ctx.restore();
        }
      }

      if (h.justHit && ts < h.justHit) {
        const a = (h.justHit - ts) / 160;
        ctx.save();
        ctx.globalAlpha = Math.max(0, a);
        if (img.hit) ctx.drawImage(img.hit, cx - popSize/2, cy - popSize/2, popSize, popSize);
        ctx.restore();
      }
    }

    if (multiplier > 1) {
      const remain = Math.max(0, multUntil - ts);
      if (remain <= 0) {
        multiplier = 1;
        multEl.textContent = "x1";
      }
    }
  }

  function loop(ts) {
    if (!running) return;

    if (!lastTs) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;

    timeLeft -= dt;
    timeEl.textContent = String(Math.max(0, Math.ceil(timeLeft / 1000)));

    spawnLogic(ts);
    draw(ts);

    if (timeLeft <= 0) endGame();
    else requestAnimationFrame(loop);
  }

  function startGame() {
    running = true;
    timeLeft = durationMs;
    score = 0;
    scoreEl.textContent = "0";
    setMultiplier(1, 0);
    lastTs = 0;
    particles.length = 0;

    for (const h of holes) {
      h.type = null;
      h.until = 0;
      h.cooldown = 0;
      h.justHit = 0;
      h.popT = 0;
    }

    if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.selectionChanged();
    sfx.start();
    requestAnimationFrame(loop);
  }

  function endGame() {
    running = false;
    sfx.end();

    if (score > best) {
      best = score;
      localStorage.setItem(BEST_KEY, String(best));
      bestEl.textContent = `BEST: ${best}`;
    }

    tg?.showPopup?.({
      title: "Игра окончена",
      message: `Счёт: ${score}\nРекорд: ${best}`,
      buttons: [{type: "ok"}]
    });
  }

  function hitAt(clientX, clientY) {
    if (!running) return;

    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * dpr;
    const y = (clientY - rect.top) * dpr;

    const holeSize = Math.min(W, H) * 0.18;
    let didHit = false;

    for (const h of holes) {
      const cx = h.x * W;
      const cy = h.y * H;

      const dx = x - cx;
      const dy = y - (cy - holeSize*0.18);
      const r = holeSize * 0.55;

      if (dx*dx + dy*dy <= r*r) {
        if (h.type) {
          didHit = true;

          if (h.type === "sticks") {
            setMultiplier(2, 8000);
            spawnParticles(cx, cy - holeSize*0.25, 16, 10*dpr, 420, "bonus");
            sfx.bonus();
            if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.impactOccurred("medium");
          } else {
            addScore(30);
            spawnParticles(cx, cy - holeSize*0.25, 10, 8*dpr, 320, "hit");
            sfx.hit();
            if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.impactOccurred("light");
          }

          h.type = null;
          h.until = 0;
          h.justHit = now() + 160;
          break;
        }
      }
    }

    if (!didHit) {
      sfx.miss();
      if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.notificationOccurred("warning");
    }
  }

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    hitAt(e.clientX, e.clientY);
  });

  startBtn.addEventListener("click", () => {
    ensureAudio();
    startGame();
  });

  hapticBtn.addEventListener("click", () => {
    hapticOn = !hapticOn;
    hapticBtn.textContent = `Вибро: ${hapticOn ? "ON" : "OFF"}`;
    if (tg?.HapticFeedback && hapticOn) tg.HapticFeedback.selectionChanged();
  });

  soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    soundBtn.textContent = `Звук: ${soundOn ? "ON" : "OFF"}`;
    if (soundOn) ensureAudio();
  });

  // init
  resize();
  loadImages().then(() => {
    // ready
  });
})();