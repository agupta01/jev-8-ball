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
      !Number.isFinite(data.yes_no_probability) || data.yes_no_probability < 0 || data.yes_no_probability > 1 ||
      !data.selected_answer ||
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
  const selected = data.selected_answer;
  if (typeof selected.id !== 'string' || !selected.id ||
      typeof selected.text !== 'string' || !selected.text.trim() ||
      !Number.isFinite(selected.probability) || selected.probability < 0 || selected.probability > 1) {
    throw new Error('Jev sent an invalid selected answer. Please try again.');
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
    log(`Jev: Yes/no question: ${percentage(result.yes_no_probability)}`);
    const winner = result.selected_answer;
    const needsYesNo = winner.id === 'not_yes_no';
    if (needsYesNo) log(`Jev: ${winner.text}`);
    setStatus('The answer is in. Let it rise…');
    const remaining = MIN_REVEAL_MS - (performance.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    const triangleAnswer = document.querySelector('#triangle-answer');
    triangleAnswer.textContent = winner.text;
    triangleAnswer.classList.toggle('is-long', winner.text.length > 24);
    scene.dataset.state = 'answered';
    document.querySelector('#scene-caption').textContent = needsYesNo ? 'Ask a yes-or-no question.' : 'The most likely of eight possibilities.';
    answerOutput.textContent = needsYesNo ? winner.text : `${winner.text} · ${percentage(winner.probability)} probability`;
    setStatus(needsYesNo ? 'Try a question the ball can answer yes or no.' : 'Another question? The ball is listening.');
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

// Sphere, liquid, and floating die share one pixel grid, beneath the glass and readable label.
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
      if (radius < 61) color = [12, 10, 20];
      if (radius >= 59 && radius < 61 && dy < 20) color = [76, 62, 86];
      if (radius >= 54 && radius < 56 && dy > -12) color = [51, 35, 64];
      paint(offsets, color);
      if (radius < 54) {
        const nx = dx / 54;
        const ny = dy / 54;
        liquidCells.push({
          offsets, x: nx, y: ny, radius: radius / 54,
          shade: 1 - .48 * (radius / 54) ** 3,
          grain: ((x * 31 + y * 17) % 7) - 3,
          reflection: Math.abs(Math.hypot(nx + .13, ny + .18) - .75) < .025 && ny < -.32 && nx < .25 ? .24 : 0,
        });
      }
      if (x > 38 && x < 72 && y > 22 && y < 28 && radius < 76) paint(offsets, [102, 100, 99]);
    }
  }
  let visible = true;
  let previousFrame = 0;
  let renderedState;
  let renderedReducedMotion;
  let revealStarted = 0;
  function drawLiquid(time, state, reveal) {
    const t = time / (state === 'thinking' ? 1700 : 5500);
    const scale = .82 + reveal * .18;
    const rise = (1 - reveal) * .22;
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
      const liquid = palette[level];
      const dim = 1 - .35 * reveal;
      let red = liquid[0] * dim;
      let green = liquid[1] * dim;
      let blue = liquid[2] * dim;
      if (reveal > 0) {
        const x = cell.x / scale;
        const y = (cell.y - rise) / scale;
        const faceY = -y;
        const halfWidth = (faceY + .74) / 1.28 * .74;
        const shadowY = -(y - .1);
        if (shadowY >= -.74 && shadowY <= .54 &&
            Math.abs(x - .06) <= (shadowY + .74) / 1.28 * .74) {
          const shadow = 1 - .6 * reveal;
          red *= shadow;
          green *= shadow;
          blue *= shadow;
        }
        if (faceY >= -.74 && faceY <= .54 && Math.abs(x) <= halfWidth) {
          // Light catches the top and left bevels of the downward-facing die.
          let faceRed = 128 - y * 18 + cell.grain;
          let faceGreen = 67 - y * 12 + cell.grain;
          let faceBlue = 157 - y * 12 + cell.grain;
          if (.54 - faceY < .075) {
            faceRed = 187; faceGreen = 111; faceBlue = 184;
          } else if (halfWidth + x < .065) {
            faceRed = 231; faceGreen = 153; faceBlue = 207;
          } else if (halfWidth - x < .065) {
            faceRed = 83; faceGreen = 42; faceBlue = 108;
          }
          const surface = .94 * reveal;
          red += (faceRed - red) * surface;
          green += (faceGreen - green) * surface;
          blue += (faceBlue - blue) * surface;
        }
      }
      // The same edge falloff and reflection cross both the liquid and the die.
      red = red * cell.shade + 205 * cell.reflection;
      green = green * cell.shade + 172 * cell.reflection;
      blue = blue * cell.shade + 233 * cell.reflection;
      for (const offset of cell.offsets) {
        pixels[offset] = red;
        pixels[offset + 1] = green;
        pixels[offset + 2] = blue;
      }
    }
    context.putImageData(frame, 0, 0);
  }
  function animate(time) {
    const state = scene.dataset.state;
    const reduced = reducedMotion.matches;
    const changed = state !== renderedState || reduced !== renderedReducedMotion;
    if (visible && !document.hidden && (changed || (!reduced && time - previousFrame > 70))) {
      if (state !== renderedState && state === 'answered') revealStarted = time;
      const progress = reduced ? 1 : Math.min(1, (time - revealStarted) / 1200);
      const reveal = state === 'answered' ? 1 - (1 - progress) ** 3 : 0;
      drawLiquid(reduced ? 0 : time, state, reveal);
      previousFrame = time;
      renderedState = state;
      renderedReducedMotion = reduced;
    }
    requestAnimationFrame(animate);
  }
  drawLiquid(0, 'idle', 0);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(canvas);
  requestAnimationFrame(animate);
}
