import http from 'node:http';
import fs from 'node:fs';
import { google } from 'googleapis';
import { config } from '../config.js';

const oauth2Client = new google.auth.OAuth2(
  config.youtube.clientId,
  config.youtube.clientSecret,
  config.youtube.redirectUri
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/youtube.upload']
});

console.log('\n1) Tarayıcıda şu linki aç ve izin ver:\n\n' + authUrl + '\n');

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth2callback')) return;
  const url = new URL(req.url, 'http://localhost:3000');
  const code = url.searchParams.get('code');
  if (!code) {
    res.end('Kod bulunamadi.');
    return;
  }
  const { tokens } = await oauth2Client.getToken(code);
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  fs.writeFileSync(config.youtube.tokenPath, JSON.stringify(tokens, null, 2));
  res.end('Basarili! Bu sekmeyi kapatabilirsiniz.');
  console.log('Token kaydedildi:', config.youtube.tokenPath);
  server.close();
});

server.listen(3000, () => console.log('Dinleniyor: http://localhost:3000/oauth2callback'));