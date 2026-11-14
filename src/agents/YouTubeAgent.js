import fs from 'node:fs';
import { google } from 'googleapis';
import { config } from '../config.js';
import { log } from '../logger.js';

export class YouTubeAgent {
  getAuthClient() {
    const oauth2Client = new google.auth.OAuth2(
      config.youtube.clientId,
      config.youtube.clientSecret,
      config.youtube.redirectUri
    );

    if (!fs.existsSync(config.youtube.tokenPath)) {
      throw new Error('YouTube token yok! Önce "npm run youtube-auth" çalıştır.');
    }

    const tokens = JSON.parse(fs.readFileSync(config.youtube.tokenPath, 'utf8'));
    oauth2Client.setCredentials(tokens);

    oauth2Client.on('tokens', (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      fs.writeFileSync(config.youtube.tokenPath, JSON.stringify(merged, null, 2));
    });

    return oauth2Client;
  }

  async uploadVideo(videoPath, script) {
    const auth = this.getAuthClient();
    const youtube = google.youtube({ version: 'v3', auth });

    const res = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: script.title.slice(0, 100),
          description: script.description,
          tags: script.tags || ['shorts'],
          categoryId: '22',
          defaultLanguage: 'tr'
        },
        status: {
          privacyStatus: config.youtube.privacyStatus,
          selfDeclaredMadeForKids: false
        }
      },
      media: {
        body: fs.createReadStream(videoPath)
      }
    });

    const videoId = res.data.id;
    const url = `https://youtube.com/shorts/${videoId}`;
    log('YouTubeAgent', `Video yüklendi (${config.youtube.privacyStatus}): ${url}`);
    return { videoId, url };
  }
}