import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { config } from './config.js';

mkdirSync(config.paths.dataDir, { recursive: true });

const defaultData = { usedTopics: [], usedCategories: [], videos: [] };

async function readDb() {
  if (!existsSync(config.paths.historyFile)) {
    await fs.writeFile(config.paths.historyFile, JSON.stringify(defaultData, null, 2));
    return structuredClone(defaultData);
  }
  const raw = await fs.readFile(config.paths.historyFile, 'utf8');
  const db = JSON.parse(raw);
  // Eski kayıtlarla uyumluluk
  db.usedTopics = Array.isArray(db.usedTopics) ? db.usedTopics : [];
  db.usedCategories = Array.isArray(db.usedCategories) ? db.usedCategories : [];
  db.videos = Array.isArray(db.videos) ? db.videos : [];
  return db;
}

async function writeDb(data) {
  await fs.writeFile(config.paths.historyFile, JSON.stringify(data, null, 2), 'utf8');
}

export const storage = {
  async getUsedTopics() {
    const db = await readDb();
    return db.usedTopics;
  },
  /** Konu seçildiği anda işaretlenir; yayın iptal edilse de tekrar seçilmez. */
  async reserveTopic(topic, category = '') {
    if (!topic) return;
    const db = await readDb();
    const normalized = topic.trim().toLocaleLowerCase('tr');
    const exists = db.usedTopics.some(
      (item) => String(item).trim().toLocaleLowerCase('tr') === normalized
    );
    if (!exists) db.usedTopics.push(topic.trim());
    if (category && !db.usedCategories.includes(category)) db.usedCategories.push(category);
    await writeDb(db);
  },
  async getRecentCategories(limit = 5) {
    const db = await readDb();
    return db.usedCategories.slice(-limit);
  },
  async addRecord(record) {
    const db = await readDb();
    if (record.topic && !db.usedTopics.includes(record.topic)) {
      db.usedTopics.push(record.topic);
    }
    if (record.category && !db.usedCategories.includes(record.category)) {
      db.usedCategories.push(record.category);
    }
    db.videos.push({ ...record, createdAt: new Date().toISOString() });
    await writeDb(db);
  }
};