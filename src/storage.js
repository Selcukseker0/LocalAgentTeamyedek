import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { config } from './config.js';

mkdirSync(config.paths.dataDir, { recursive: true });

const defaultData = { usedTopics: [], videos: [] };

async function readDb() {
  if (!existsSync(config.paths.historyFile)) {
    await fs.writeFile(config.paths.historyFile, JSON.stringify(defaultData, null, 2));
    return structuredClone(defaultData);
  }
  const raw = await fs.readFile(config.paths.historyFile, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(data) {
  await fs.writeFile(config.paths.historyFile, JSON.stringify(data, null, 2), 'utf8');
}

export const storage = {
  async getUsedTopics() {
    const db = await readDb();
    return db.usedTopics;
  },
  async addRecord(record) {
    const db = await readDb();
    if (record.topic && !db.usedTopics.includes(record.topic)) {
      db.usedTopics.push(record.topic);
    }
    db.videos.push({ ...record, createdAt: new Date().toISOString() });
    await writeDb(db);
  }
};