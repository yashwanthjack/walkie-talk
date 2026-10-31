/**
 * audioEffects.ts — Zero-Asset Web Audio API Sound Synthesizer
 * 
 * Synthesizes authentic radio effects completely in-browser:
 * - PTT Chirp: Instant crisp dual-tone chirp on keying up.
 * - Roger Beep: Classic NASA / Motorola end-of-transmission beep.
 * - Squelch Tail: Filtered white noise burst on carrier loss.
 * - Buzzer / Pager Alert: Piercing multi-tone alert for calling partner.
 */

let sharedAudioCtx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

/**
 * Play an authentic two-tone PTT activation chirp (850Hz -> 1250Hz, 35ms total)
 */
export function playPttStartChirp() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    // Frequency sweep: 850Hz to 1250Hz
    osc.frequency.setValueAtTime(850, now);
    osc.frequency.exponentialRampToValueAtTime(1250, now + 0.035);

    // Fast envelope to avoid clicks
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.04);
  } catch (err) {
    console.warn('Audio effect error (chirp):', err);
  }
}

/**
 * Play a classic Motorola / NASA Roger Beep (1100Hz -> 1400Hz dual tone)
 */
export function playRogerBeep() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Tone 1: 1100Hz for 45ms
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(1100, now);
    gain1.gain.setValueAtTime(0.15, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.048);

    // Tone 2: 1400Hz for 55ms
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(1400, now + 0.048);
    gain2.gain.setValueAtTime(0.001, now + 0.048);
    gain2.gain.linearRampToValueAtTime(0.16, now + 0.052);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.105);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.048);
    osc2.stop(now + 0.11);
  } catch (err) {
    console.warn('Audio effect error (roger beep):', err);
  }
}

/**
 * Play a realistic 140ms burst of bandpass-filtered white noise (Squelch Tail)
 */
export function playSquelchTail() {
  try {
    const ctx = getAudioContext();
    const sampleRate = ctx.sampleRate;
    const duration = 0.13; // 130ms
    const bufferSize = Math.floor(sampleRate * duration);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, sampleRate);
    const output = noiseBuffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;

    // Bandpass filter to mimic walkie-talkie speaker horn acoustics (600Hz - 2800Hz)
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 1400;
    bandpass.Q.value = 1.2;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.14, now);
    // Rapid squelch cutoff
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    whiteNoise.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(ctx.destination);

    whiteNoise.start(now);
    whiteNoise.stop(now + duration + 0.02);
  } catch (err) {
    console.warn('Audio effect error (squelch):', err);
  }
}

/**
 * Play complete transmission close: Roger Beep followed immediately by Squelch Tail
 */
export function playTransmissionEnd() {
  playRogerBeep();
  setTimeout(() => {
    playSquelchTail();
  }, 110);
}

/**
 * Play high-priority pager / call alert buzz (loud, attention-grabbing pulsed tones)
 */
export function playBuzzerSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const frequencies = [880, 1320, 880, 1320, 1760];
    const stepDuration = 0.09;

    frequencies.forEach((freq, idx) => {
      const startTime = now + (idx * (stepDuration + 0.02));
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.linearRampToValueAtTime(0.22, startTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + stepDuration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + stepDuration + 0.01);
    });
  } catch (err) {
    console.warn('Audio effect error (buzzer):', err);
  }
}

