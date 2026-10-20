/**
 * ttsService.js
 * -----------------------------------------------------------------------
 * Interview conduction — text-to-speech for interview questions
 * Owner: Siddhant Raikar
 *
 * Wraps `msedge-tts`, which talks to Microsoft Edge's free neural TTS
 * service over a WebSocket (api.msedgeservices.com) — no API key needed.
 *
 * Same reliability contract as the rest of the codebase: never throws.
 * If synthesis fails for any reason (no network, the host is blocked,
 * the service is down, etc.) this resolves to `null`, and the caller
 * (interviewController.getQuestionAudio) responds with 204 so the
 * frontend falls back to the browser's own speechSynthesis API, or to
 * silent/text-only mode. The interview flow is never blocked on TTS.
 * -----------------------------------------------------------------------
 */

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const VOICE = process.env.TTS_VOICE || 'en-US-GuyNeural';
const SYNTHESIS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS || 8000);

const MAX_ATTEMPTS = 2;

/**
 * msedge-tts drops the text straight into an SSML (XML) template without
 * escaping, so a question containing "&" or "<" (e.g. "Node.js & MongoDB",
 * "<div>") makes the service reject it. Escape it first.
 */
function escapeForSsml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Synthesises `text` to an MP3 Buffer using Edge TTS.
 * Returns null (never throws) on any failure — unreachable service,
 * timeout, empty input, etc. Retries once, since the WebSocket
 * occasionally drops mid-synthesis.
 */
async function generateSpeech(text) {
  const input = (text || '').trim();
  if (!input) return null;

  const ssmlSafe = escapeForSsml(input);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const audio = await synthesise(ssmlSafe);
    if (audio) return audio;
  }
  return null;
}

async function synthesise(input) {
  let tts;
  try {
    tts = new MsEdgeTTS({ connectionTimeoutMs: SYNTHESIS_TIMEOUT_MS, synthesisTimeoutMs: SYNTHESIS_TIMEOUT_MS });
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(input);

    const buffer = await new Promise((resolve, reject) => {
      const chunks = [];
      audioStream.on('data', (chunk) => chunks.push(chunk));
      audioStream.on('end', () => resolve(Buffer.concat(chunks)));
      audioStream.on('error', (err) => reject(err));
    });

    return buffer.length ? buffer : null;
  } catch (err) {
    return null;
  } finally {
    tts?.close();
  }
}

module.exports = { generateSpeech, VOICE };
