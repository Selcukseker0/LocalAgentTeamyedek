import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.paths.logFile), { recursive: true });

export function log(agent, message, level = 'INFO') {
  const line = `[${new Date().toISOString()}] [${level}] [${agent}] ${message}`;
  console.log(line);
  fs.appendFileSync(config.paths.logFile, line + '\n', 'utf8');
}