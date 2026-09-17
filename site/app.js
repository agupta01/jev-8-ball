import { API_BASE, TURNSTILE_SITE_KEY } from './config.js';

const form = document.querySelector('#question-form');
const questionInput = document.querySelector('#question');
const button = document.querySelector('#shake-button');
const buttonLabel = document.querySelector('#button-label');
const status = document.querySelector('#status');
const scene = document.querySelector('#oracle-scene');
const answerOutput = document.querySelector('#answer-output');
const chatLog = document.querySelector('#chat-log');
const motionButton = document.querySelector('#motion-button');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const MIN_REVEAL_MS = 2400;
let busy = false;
let hasAnswered = false;
let widgetId;
let verificationPromise;
let pendingVerification;

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('is-error', error);
}

function log(message, kind = '') {
  const line = document.createElement('p');
  line.textContent = message;
  if (kind) line.className = `chat-${kind}`;
  chatLog.append(line);
  while (chatLog.childElementCount > 80) chatLog.firstElementChild.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
}

function percentage(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function settleVerification(error, token) {
  if (!pendingVerification) return;
  const pending = pendingVerification;
  pendingVerification = undefined;
  clearTimeout(pending.timer);
  if (error) pending.reject(new Error(error));
  else pending.resolve(token);
}

function loadVerification() {
  if (verificationPromise) return verificationPromise;
  verificationPromise = new Promise((resolve, reject) => {
    if (!TURNSTILE_SITE_KEY) {
      reject(new Error('Security verification is not configured. Please try again later.'));
      return;
    }
    const script = document.createElement('script');
    let settled = false;
    const timeout = setTimeout(() => fail(), 15000);
    function fail() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error('Security verification could not load. Check your connection or content blocker, then reload.'));
    }
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onerror = fail;
    script.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        widgetId = window.turnstile.render('#verification', {
          sitekey: TURNSTILE_SITE_KEY,
          action: 'ask',
          execution: 'execute',
          appearance: 'interaction-only',
          theme: 'dark',
          retry: 'never',
          'refresh-expired': 'manual',
          'refresh-timeout': 'manual',
          callback: (token) => settleVerification(null, token),
          'error-callback': (errorCode) => {
            const code = String(errorCode || 'unknown');
            let message;
            if (code === '110200') {
              message = `Turnstile (${code}): add ${location.hostname} to this widget’s allowed hostnames in Cloudflare.`;
            } else if (['110100', '110110', '400020', '400070'].includes(code)) {
              message = `Turnstile (${code}): check that the site key is correct and the widget is enabled in Cloudflare.`;
            } else {
              message = `Turnstile could not verify this browser (${code}). Try again, or check browser extensions and your connection.`;
            }
            if (pendingVerification) {
              settleVerification(message);
            } else {
              setStatus(message, true);
              log(`Jev: ${message}`, 'error');
            }
            return true;
          },
          'expired-callback': () => settleVerification('Security verification expired. Please try again.'),
          'timeout-callback': () => settleVerification('Security verification timed out. Please try again.'),
        });
        resolve();
      } catch {
        reject(new Error('Security verification could not initialize. Please reload and try again.'));
      }
    };
    document.head.append(script);
  });
  return verificationPromise;
}

async function getVerificationToken() {
  await loadVerification();
  window.turnstile.reset(widgetId);
  return new Promise((resolve, reject) => {
    pendingVerification = {
      resolve,
      reject,
      timer: setTimeout(() => settleVerification('Security verification timed out. Please try again.'), 65000),
    };
    try {
      window.turnstile.execute(widgetId);
    } catch {
      settleVerification('Security verification could not start. Please reload and try again.');
    }
  });
}

function validateResponse(data) {
  if (!data || !Array.isArray(data.answers) || data.answers.length !== 8 ||
      !Number.isFinite(data.elapsed_ms) || data.elapsed_ms < 0 || typeof data.model !== 'string') {
    throw new Error('Jev sent an incomplete answer. Please try again.');
  }
  const ids = new Set();
  for (const answer of data.answers) {
    if (!answer || typeof answer.id !== 'string' || !answer.id || ids.has(answer.id) ||
        typeof answer.text !== 'string' || !answer.text.trim() ||
        !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) {
      throw new Error('Jev sent an invalid answer. Please try again.');
    }
    ids.add(answer.id);
  }
  return data;
}

async function submitQuestion(event) {
  event?.preventDefault();
  if (busy) return;
  const question = questionInput.value.trim();
  if (!question || question.length > 500) {
    questionInput.setAttribute('aria-invalid', 'true');
    setStatus(question ? 'Keep your question to 500 characters or fewer.' : 'First, give Jev a question to ponder.', true);
    questionInput.focus();
    return;
  }
  if (!API_BASE) {
    setStatus('The oracle is not connected to a service yet. Please try again later.', true);
    return;
  }

  busy = true;
  button.disabled = true;
  questionInput.removeAttribute('aria-invalid');
  buttonLabel.textContent = 'Shaking…';
  scene.dataset.state = 'thinking';
  answerOutput.textContent = '';
  document.querySelector('#scene-caption').textContent = 'A little suspense is part of the magic.';
  setStatus('Verifying your request…');
  log(`User: ${question}`, 'user');
  const startedAt = performance.now();
  let controller;
  let requestTimeout;
  let slowNotice;
  try {
    const token = await getVerificationToken();
    setStatus('Jev is weighing the possibilities…');
    controller = new AbortController();
    requestTimeout = setTimeout(() => controller.abort(), 60000);
    slowNotice = setTimeout(() => setStatus('Jev is taking a little longer. Still waiting on this request…'), 8000);
    const response = await fetch(`${API_BASE}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, turnstile_token: token }),
      signal: controller.signal,
      credentials: 'omit',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail :
        response.status === 429 ? 'The oracle is busy. Please wait a moment before asking again.' :
          'Jev is unavailable right now. Please try again later.';
      throw new Error(detail);
    }
    const result = validateResponse(data);
    clearTimeout(requestTimeout);
    clearTimeout(slowNotice);

    // The feed reflects network completion, independently of the theatrical reveal.
    log(`Jev: (answered in ${Math.round(result.elapsed_ms)}ms)`);
    for (const answer of result.answers) log(`Jev: ${answer.text.replace(/[.!?]$/, '')}: ${percentage(answer.probability)}`);
    const winner = result.answers.reduce((best, answer) => answer.probability > best.probability ? answer : best);
    setStatus('The answer is in. Let it rise…');
    const remaining = MIN_REVEAL_MS - (performance.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    document.querySelector('#triangle-answer').textContent = winner.text;
    scene.dataset.state = 'answered';
    document.querySelector('#scene-caption').textContent = 'The most likely of eight possibilities.';
    answerOutput.textContent = `${winner.text} · ${percentage(winner.probability)} probability`;
    setStatus('Another question? The ball is listening.');
    hasAnswered = true;
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Jev took too long to respond. No request was retried; you can try again.' :
      error instanceof TypeError ? 'Could not reach Jev. Check your connection and try again.' : error.message;
    scene.dataset.state = 'idle';
    document.querySelector('#scene-caption').textContent = 'Even oracles need a moment.';
    setStatus(message, true);
    log(`Jev: ${message}`, 'error');
  } finally {
    clearTimeout(requestTimeout);
    clearTimeout(slowNotice);
    if (widgetId !== undefined && window.turnstile) {
      try { window.turnstile.reset(widgetId); } catch { /* A failed widget is reported by the next explicit execution. */ }
    }
    busy = false;
    button.disabled = false;
    buttonLabel.textContent = hasAnswered ? 'Ask again' : 'Shake!';
  }
}

form.addEventListener('submit', submitQuestion);
questionInput.addEventListener('input', () => {
  document.querySelector('#character-count').textContent = `${questionInput.value.length} / 500`;
  questionInput.removeAttribute('aria-invalid');
});
questionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
document.querySelector('#chat-toggle').addEventListener('click', (event) => {
  const expanded = event.currentTarget.getAttribute('aria-expanded') === 'true';
  event.currentTarget.setAttribute('aria-expanded', String(!expanded));
  event.currentTarget.setAttribute('aria-label', expanded ? 'Expand request log' : 'Minimize request log');
  event.currentTarget.textContent = expanded ? '+' : '−';
  chatLog.hidden = expanded;
  if (!expanded) chatLog.scrollTop = chatLog.scrollHeight;
});

async function connect() {
  if (!API_BASE) {
    log('Jev: service not configured', 'error');
    setStatus('The oracle is not connected to a service yet.', true);
    return;
  }
  log('Jev: connecting…');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${API_BASE}/health`, { signal: controller.signal, credentials: 'omit', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || data.status !== 'ok') throw new Error('Unavailable');
    log('Jev: connected');
    document.querySelector('#connection-dot').classList.add('is-connected');
  } catch {
    log('Jev: connection unavailable; you can still try asking', 'error');
  } finally {
    clearTimeout(timeout);
  }
}
connect();
// Preload without executing a challenge. A load failure is shown when the user asks.
loadVerification().catch(() => {});

let motionEnabled = false;
let previousMagnitude;
let firstPeak = 0;
let lastPeak = 0;
let lastShake = 0;
function onMotion(event) {
  if (busy || document.hidden) return;
  const vector = event.acceleration?.x != null ? event.acceleration : event.accelerationIncludingGravity;
  if (!vector || vector.x == null || vector.y == null || vector.z == null) return;
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  const delta = previousMagnitude === undefined ? 0 : Math.abs(magnitude - previousMagnitude);
  previousMagnitude = magnitude;
  const now = performance.now();
  if (delta < 12 || now - lastPeak < 100 || now - lastShake < 2500) return;
  lastPeak = now;
  if (firstPeak && now - firstPeak < 700) {
    firstPeak = 0;
    lastShake = now;
    form.requestSubmit();
  } else {
    firstPeak = now;
  }
}
if ('DeviceMotionEvent' in window && window.isSecureContext &&
    (navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches)) {
  motionButton.hidden = false;
}
motionButton.addEventListener('click', async () => {
  if (motionEnabled) {
    window.removeEventListener('devicemotion', onMotion);
    motionEnabled = false;
    motionButton.textContent = 'Enable phone shake';
    motionButton.setAttribute('aria-pressed', 'false');
    if (!busy) setStatus('Phone shake off. The button still works.');
    return;
  }
  motionButton.disabled = true;
  try {
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const permission = await DeviceMotionEvent.requestPermission();
      if (permission !== 'granted') throw new Error('Motion permission was denied. You can still use the Shake! button.');
    }
    previousMagnitude = undefined;
    firstPeak = 0;
    lastShake = performance.now();
    window.addEventListener('devicemotion', onMotion, { passive: true });
    motionEnabled = true;
    motionButton.textContent = 'Phone shake on · Turn off';
    motionButton.setAttribute('aria-pressed', 'true');
    if (!busy) setStatus('Ask a question, then gently shake your phone.');
  } catch (error) {
    if (!busy) setStatus(error.message || 'Motion is unavailable. Use the Shake! button instead.', true);
  } finally {
    motionButton.disabled = false;
  }
});

// A low-resolution, deliberately stepped sphere. The liquid is a tiny metaball field.
const canvas = document.querySelector('#ball-canvas');
const context = canvas.getContext('2d', { alpha: true });
if (context) {
  const frame = context.createImageData(180, 180);
  const pixels = frame.data;
  const liquidCells = [];
  const blobs = Array.from({ length: 5 }, () => ({ x: 0, y: 0 }));
  const palette = [[43, 24, 59], [67, 34, 85], [99, 40, 109], [161, 52, 133], [232, 80, 161], [255, 126, 191], [251, 172, 212]];
  function paint(indices, color) {
    for (const offset of indices) {
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }
  for (let y = 0; y < 180; y += 2) {
    for (let x = 0; x < 180; x += 2) {
      const dx = x - 89;
      const dy = y - 87;
      const radius = Math.hypot(dx, dy);
      if (radius > 82) continue;
      const offsets = [(y * 180 + x) * 4, (y * 180 + x + 1) * 4, ((y + 1) * 180 + x) * 4, ((y + 1) * 180 + x + 1) * 4];
      const light = Math.max(0, 1 - Math.hypot(x - 57, y - 39) / 110);
      const noise = ((x * 31 + y * 17) % 13) < 3 ? 6 : 0;
      const shade = radius > 79 ? 22 : Math.round(23 + light * 35 + noise);
      let color = [shade, shade, Math.max(20, shade - 3)];
      if (radius < 59) color = [15, 15, 23];
      if (radius >= 57 && radius < 60 && dy < 24) color = [86, 74, 92];
      paint(offsets, color);
      if (radius < 54) liquidCells.push({ offsets, x: dx / 54, y: dy / 54, radius: radius / 54 });
      if (x > 38 && x < 72 && y > 22 && y < 28 && radius < 76) paint(offsets, [102, 100, 99]);
    }
  }
  let visible = true;
  let previousFrame = 0;
  function drawLiquid(time) {
    const t = time / (scene.dataset.state === 'thinking' ? 1700 : 5500);
    for (let i = 0; i < blobs.length; i++) {
      blobs[i].x = Math.sin(t * (.6 + i * .13) + i * 2.1) * .78;
      blobs[i].y = Math.cos(t * (.8 + i * .11) + i * 1.7) * .85;
    }
    for (const cell of liquidCells) {
      let field = 0;
      for (const blob of blobs) {
        const dx = cell.x - blob.x;
        const dy = cell.y - blob.y;
        field += .14 / (dx * dx + dy * dy + .09);
      }
      const level = Math.max(0, Math.min(6, Math.floor(field * 2.5 - cell.radius * 1.5)));
      paint(cell.offsets, palette[level]);
    }
    context.putImageData(frame, 0, 0);
  }
  function animate(time) {
    if (visible && !document.hidden && !reducedMotion.matches && time - previousFrame > 70) {
      drawLiquid(time);
      previousFrame = time;
    }
    requestAnimationFrame(animate);
  }
  drawLiquid(0);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(canvas);
  requestAnimationFrame(animate);
}
