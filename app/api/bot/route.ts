import { NextRequest, NextResponse } from 'next/server';
import Groq from 'groq-sdk';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// System prompt for the English tutor
const TUTOR_SYSTEM_PROMPT = `You are a friendly English tutor. Keep answers concise. Correct any major grammar mistakes gently. If the user speaks in another language, respond in English and encourage them to practice English.`;

// TTS Voice configuration
const TTS_VOICE = 'en-US-AndrewNeural';

/**
 * Fetches the file path from Telegram servers
 */
async function getTelegramFilePath(fileId: string): Promise<string> {
  const response = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const data = await response.json();
  
  if (!data.ok) {
    throw new Error(`Failed to get file path: ${data.description}`);
  }
  
  return data.result.file_path;
}

/**
 * Downloads a file from Telegram servers as ArrayBuffer
 */
async function downloadTelegramFile(filePath: string): Promise<ArrayBuffer> {
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const response = await fetch(fileUrl);
  
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }
  
  return response.arrayBuffer();
}

/**
 * Transcribes audio using Groq Whisper
 */
async function transcribeAudio(audioBuffer: ArrayBuffer): Promise<string> {
  // Convert ArrayBuffer to File object for Groq API
  const audioBlob = new Blob([audioBuffer], { type: 'audio/ogg' });
  const audioFile = new File([audioBlob], 'voice.ogg', { type: 'audio/ogg' });

  const transcription = await groq.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-large-v3',
    language: 'en',
  });

  return transcription.text;
}

/**
 * Gets AI tutor response using Groq LLM
 */
async function getTutorResponse(userMessage: string): Promise<string> {
  const completion = await groq.chat.completions.create({
    model: 'llama3-8b-8192',
    messages: [
      {
        role: 'system',
        content: TUTOR_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: userMessage,
      },
    ],
    max_tokens: 500,
    temperature: 0.7,
  });

  return completion.choices[0]?.message?.content || 'I apologize, I could not generate a response.';
}

/**
 * Generates speech audio using Microsoft Edge TTS (serverless-compatible)
 * Returns audio as Buffer for direct sending to Telegram
 */
async function generateSpeech(text: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(TTS_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

  // Collect stream chunks into a buffer (serverless-friendly, no disk write)
  const chunks: Buffer[] = [];
  const readable = tts.toStream(text);

  return new Promise((resolve, reject) => {
    readable.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    readable.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    readable.on('error', (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Sends voice message to Telegram chat
 */
async function sendVoiceToTelegram(chatId: number, audioBuffer: Buffer): Promise<void> {
  const formData = new FormData();
  formData.append('chat_id', chatId.toString());
  
  // Create a Blob from the buffer for multipart upload
  const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
  formData.append('voice', audioBlob, 'response.mp3');

  const response = await fetch(`${TELEGRAM_API}/sendVoice`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Failed to send voice: ${JSON.stringify(errorData)}`);
  }
}

/**
 * Sends a text message to Telegram chat (for fallback/errors)
 */
async function sendMessageToTelegram(chatId: number, text: string): Promise<void> {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

/**
 * Main POST handler - Telegram Webhook endpoint
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Log incoming update for debugging
    console.log('Received Telegram update:', JSON.stringify(body, null, 2));

    // Check if this is a voice message
    const message = body.message;
    if (!message || !message.voice) {
      // Not a voice message, acknowledge and return
      console.log('Not a voice message, skipping...');
      return NextResponse.json({ ok: true });
    }

    const chatId = message.chat.id;
    const fileId = message.voice.file_id;

    console.log(`Processing voice message from chat ${chatId}, file_id: ${fileId}`);

    // Step 1: Get file path from Telegram
    const filePath = await getTelegramFilePath(fileId);
    console.log(`File path: ${filePath}`);

    // Step 2: Download the audio file
    const audioBuffer = await downloadTelegramFile(filePath);
    console.log(`Downloaded audio: ${audioBuffer.byteLength} bytes`);

    // Step 3: Transcribe audio using Groq Whisper
    const transcribedText = await transcribeAudio(audioBuffer);
    console.log(`Transcription: ${transcribedText}`);

    if (!transcribedText || transcribedText.trim() === '') {
      await sendMessageToTelegram(chatId, "I couldn't understand the audio. Please try speaking more clearly.");
      return NextResponse.json({ ok: true });
    }

    // Step 4: Get AI tutor response
    const tutorResponse = await getTutorResponse(transcribedText);
    console.log(`Tutor response: ${tutorResponse}`);

    // Step 5: Generate speech from response
    const speechBuffer = await generateSpeech(tutorResponse);
    console.log(`Generated speech: ${speechBuffer.length} bytes`);

    // Step 6: Send voice response back to Telegram
    await sendVoiceToTelegram(chatId, speechBuffer);
    console.log('Voice response sent successfully!');

    return NextResponse.json({ ok: true });

  } catch (error) {
    console.error('Error processing webhook:', error);
    
    // Try to notify user of error if we have chat context
    try {
      const body = await request.clone().json();
      if (body?.message?.chat?.id) {
        await sendMessageToTelegram(
          body.message.chat.id,
          'Sorry, I encountered an error processing your message. Please try again.'
        );
      }
    } catch {
      // Ignore notification errors
    }

    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 });
  }
}

// Also export GET for webhook verification
export async function GET() {
  return NextResponse.json({ status: 'LinguaTutor Bot webhook is active' });
}
