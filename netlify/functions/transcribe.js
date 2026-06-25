// Netlify Serverless Function: 语音识别
// 接收前端上传的 16kHz mono PCM 数据，直接转发给 Google Speech API
// 不需要 ffmpeg，不做任何音频格式转换

const https = require('https');

// Google Speech API key（Chrome 内置的公共 key）
const GOOGLE_API_KEY = 'AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw';

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: '只接受 POST 请求' })
    };
  }

  try {
    // 解析 multipart form data，提取音频
    const boundary = extractBoundary(event.headers['content-type'] || event.headers['Content-Type']);
    if (!boundary) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: '需要 multipart/form-data 格式' })
      };
    }

    const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8');
    const audioData = extractAudioData(bodyBuffer, boundary);

    if (!audioData || audioData.length < 100) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: '音频数据为空或太短' })
      };
    }

    console.log(`[Transcribe] 收到PCM: ${audioData.length} bytes, 时长约 ${(audioData.length / 2 / 16000).toFixed(2)}s`);

    // 检测音量（RMS）
    const rms = calculateRMS(audioData);
    console.log(`[Audio] RMS=${rms.toFixed(1)}`);

    if (rms < 50) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: '没有检测到声音，请按住麦克风大声朗读' })
      };
    }

    // 直接转发 raw PCM 给 Google Speech API
    // Content-Type: audio/l16; rate=16000 (16-bit PCM, 16kHz)
    const text = await recognizeWithGoogle(audioData);

    if (text) {
      console.log(`[Transcribe] 识别成功: "${text}"`);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, text: text, confidence: 0.9 })
      };
    } else {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: '未能识别语音，请说话更清晰后重试' })
      };
    }

  } catch (err) {
    console.error('[Transcribe Error]', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: '服务器错误: ' + err.message })
    };
  }
};

// 提取 multipart boundary
function extractBoundary(contentType) {
  const match = contentType.match(/boundary=([^;]+)/);
  return match ? match[1] : null;
}

// 从 multipart body 中提取音频数据
function extractAudioData(body, boundary) {
  const boundaryBuffer = Buffer.from('--' + boundary);
  const positions = [];

  let start = 0;
  while (true) {
    const idx = body.indexOf(boundaryBuffer, start);
    if (idx === -1) break;
    positions.push(idx);
    start = idx + boundaryBuffer.length;
  }

  for (let i = 0; i < positions.length - 1; i++) {
    const partStart = positions[i] + boundaryBuffer.length;
    const partEnd = positions[i + 1];
    const part = body.slice(partStart, partEnd);

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) continue;

    const headers = part.slice(0, headerEnd).toString();
    if (headers.includes('filename=')) {
      let fileData = part.slice(headerEnd + 4);
      // 去掉结尾 \r\n
      if (fileData.length >= 2 && fileData[fileData.length - 2] === 0x0D && fileData[fileData.length - 1] === 0x0A) {
        fileData = fileData.slice(0, -2);
      }
      return fileData;
    }
  }
  return null;
}

// 计算 RMS 音量（判断是否有声音）
function calculateRMS(pcmData) {
  // PCM 是 16-bit little-endian
  let sumSq = 0;
  const sampleCount = Math.floor(pcmData.length / 2);
  // 采样检测（每 10 个样本取 1 个，加速计算）
  let count = 0;
  for (let i = 0; i < pcmData.length - 1; i += 20) {
    const sample = pcmData.readInt16LE(i);
    sumSq += sample * sample;
    count++;
  }
  if (count === 0) return 0;
  return Math.sqrt(sumSq / count);
}

// 调用 Google Speech API v2
function recognizeWithGoogle(pcmData) {
  return new Promise((resolve) => {
    const url = `https://www.google.com/speech-api/v2/recognize?output=json&lang=en-US&key=${GOOGLE_API_KEY}&client=chromium`;

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/l16; rate=16000',
        'Content-Length': pcmData.length
      }
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        console.log('[Google API] 响应长度: ' + data.length + ', 内容: ' + data.substring(0, 300));
        try {
          const lines = data.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('{')) {
              const parsed = JSON.parse(line);
              if (parsed.result && parsed.result.length > 0) {
                const alternatives = parsed.result[0].alternative || [];
                if (alternatives.length > 0) {
                  resolve(alternatives[0].transcript || '');
                  return;
                }
              }
            }
          }
          resolve('');
        } catch (e) {
          console.error('[Google API] 解析失败:', e.message);
          resolve('');
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Google API] 请求失败:', e.message);
      resolve('');
    });

    req.setTimeout(10000, () => {
      console.error('[Google API] 超时');
      req.destroy();
      resolve('');
    });

    req.write(pcmData);
    req.end();
  });
}
