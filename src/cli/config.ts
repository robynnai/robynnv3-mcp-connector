import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.robynn');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface RobynnConfig {
  apiKey?: string;
  [key: string]: any;
}

export function readConfig(): RobynnConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading config file:', error);
    return {};
  }
}

export function writeConfig(config: RobynnConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}
