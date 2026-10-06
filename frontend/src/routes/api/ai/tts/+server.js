import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

const GEMINI_API_KEY = env.GEMINI_API_KEY || '';

function cleanSpeechText(text) {
  if (!text) return '';
  return text
    .replace(/\[(.*?)\]\(.*?\)/g, '$1') // markdown links -> label only
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // code blocks
    .replace(/[*#_~>]/g, '') // formatting
    .replace(/<[^>]*>/g, '') // HTML
    .replace(/https?:\/\/\S+/g, '') // URLs
    .replace(/\/[\w\-\?=&]+/g, '') // paths
    .replace(/\s+/g, ' ')
    .trim();
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, cookies }) {
  // Allow authenticated users
  const jwtAccess = cookies.get('jwt_access');
  if (!jwtAccess) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { text = '', voice = 'Puck', engine = 'neural' } = await request.json();
    const cleanText = cleanSpeechText(text);

    if (!cleanText) {
      return json({ success: false, fallback: true, message: 'Empty text' });
    }

    // 1. If Gemini Studio engine requested
    if (engine === 'gemini' && GEMINI_API_KEY) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: cleanText.slice(0, 500) }] }],
              generationConfig: {
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: voice || 'Puck'
                    }
                  }
                }
              }
            })
          }
        );

        if (res.ok) {
          const data = await res.json();
          const part = data.candidates?.[0]?.content?.parts?.[0];
          if (part?.inlineData?.data) {
            return json({
              success: true,
              audio: part.inlineData.data,
              mimeType: part.inlineData.mimeType || 'audio/wav'
            });
          }
        } else {
          console.warn('Gemini Studio TTS returned non-200, falling back to Neural:', res.status);
        }
      } catch (err) {
        console.warn('Gemini Studio TTS error, falling back to Neural:', err.message);
      }
    }

    // 2. Default & Resilient Fallback: Google Neural TTS (Ultra-fast ~350ms, natural, warm, no rate limit)
    try {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText.slice(0, 300))}&tl=en&client=tw-ob`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (res.ok) {
        const ab = await res.arrayBuffer();
        const base64 = Buffer.from(ab).toString('base64');
        return json({
          success: true,
          audio: base64,
          mimeType: 'audio/mpeg'
        });
      }
    } catch (neuralErr) {
      console.warn('Google Neural TTS error:', neuralErr.message);
    }

    return json({ success: false, fallback: true, message: 'No audio generated' });
  } catch (err) {
    console.error('TTS endpoint error:', err);
    return json({ success: false, fallback: true, error: err.message });
  }
}
